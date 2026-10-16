"""quickbooks plugin: manifest, marketplace entry, shipped files, bundled CLI and offline node tests."""
import json
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "build"))
import sync_runtime  # noqa: E402

PLUGIN = ROOT / "plugins" / "quickbooks"
SKILL = PLUGIN / "skills" / "quickbooks"
CLI = SKILL / "cli"


class QuickbooksManifest(unittest.TestCase):
    def test_skill_yaml_and_skill_md(self):
        m = sync_runtime.load_manifest(SKILL)
        self.assertEqual(m["name"], "quickbooks")
        self.assertRegex(m["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(m["category"], "finance")
        self.assertEqual(m["runtimes"], ["local", "agent-browser"])
        md = (SKILL / "SKILL.md").read_text()
        self.assertRegex(md, r"(?m)^name: quickbooks$")
        self.assertIn("Hard rules", md)
        self.assertIn("--yes", md)

    def test_versions_agree(self):
        market = {p["name"]: p for p in json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())["plugins"]}
        e = market["quickbooks"]
        v = sync_runtime.load_manifest(SKILL)["version"]
        self.assertEqual(e["version"], v)
        self.assertEqual(json.loads((CLI / "package.json").read_text())["version"], v)
        self.assertIn('VERSION = "%s"' % v, (CLI / "src" / "cli.js").read_text())
        self.assertEqual(e["source"], "./plugins/quickbooks")
        self.assertEqual(e["skills"], ["./skills/quickbooks"])
        self.assertEqual(e["category"], "finance")

    def test_plugin_ships_only_its_skill(self):
        top = {p.name for p in PLUGIN.iterdir() if p.name != ".DS_Store"}
        self.assertLessEqual(top, {"skills", ".claude-plugin"})
        self.assertEqual([p.name for p in (PLUGIN / "skills").iterdir() if p.is_dir()], ["quickbooks"])

    def test_runtime_is_vendored(self):
        self.assertTrue((SKILL / "runtime" / "session.py").is_file())

    def test_bundle_is_committed_and_current(self):
        dist = CLI / "dist" / "qbo.mjs"
        self.assertTrue(dist.is_file())
        self.assertTrue(dist.read_text().startswith("#!/usr/bin/env node"))
        newest_src = max(p.stat().st_mtime for p in list((CLI / "src").glob("*.js")) + list((SKILL / "page").glob("*.js")))
        self.assertGreaterEqual(dist.stat().st_mtime + 1, newest_src, "rebuild dist/qbo.mjs (npm run build)")

    def test_no_secrets_or_session_artifacts_in_skill(self):
        pat = re.compile(r"prdak[a-z0-9]{10,}|ius_session=|BW_SESSION=", re.I)
        for path in SKILL.rglob("*"):
            if path.is_file() and "node_modules" not in path.parts and path.suffix in (".js", ".mjs", ".md", ".json", ".yaml"):
                with self.subTest(path=str(path.relative_to(ROOT))):
                    self.assertIsNone(pat.search(path.read_text(errors="ignore")))


@unittest.skipUnless(shutil.which("node"), "node not installed")
class QuickbooksCli(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(["node", str(CLI / "dist" / "qbo.mjs"), *args], capture_output=True, text=True, timeout=60)

    def test_help_lists_commands(self):
        r = self.run_cli("--help")
        self.assertEqual(r.returncode, 0, r.stderr)
        for cmd in ("doctor", "list", "search", "report", "create", "void", "delete", "bench"):
            self.assertIn(cmd, r.stdout)

    def test_routes_offline_json(self):
        r = self.run_cli("--json", "routes")
        self.assertEqual(r.returncode, 0, r.stderr)
        v = json.loads(r.stdout)
        self.assertIn("customers", v["lists"])
        self.assertEqual(v["apiReports"]["ap-aging"], "AgedPayables")

    def test_snippets_in_sync(self):
        r = subprocess.run(["node", str(CLI / "scripts" / "gen-snippets.mjs"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    @unittest.skipUnless((CLI / "node_modules").is_dir(), "run npm install in the cli folder for node tests")
    def test_node_unit_tests(self):
        r = subprocess.run(["npm", "test", "--silent"], cwd=CLI, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
