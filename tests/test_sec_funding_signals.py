"""sec-funding-signals plugin: manifests agree, the bundle ships and runs, and the public text stays neutral.

The plugin's own behaviour tests are Node tests:  cd plugins/sec-funding-signals/skills/sec-funding-signals/cli && node --test tests/*.test.js
Run from the repo root:  python3 -m pytest -q tests
"""
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

PLUGIN = ROOT / "plugins" / "sec-funding-signals"
SKILL = PLUGIN / "skills" / "sec-funding-signals"
CLI = SKILL / "cli"
BUNDLE = CLI / "dist" / "sec-funding-signals.mjs"


def shipped():
    return [p for p in sorted(PLUGIN.rglob("*")) if p.is_file() and "tests" not in p.relative_to(PLUGIN).parts and "node_modules" not in p.parts]


class SecFundingSignals(unittest.TestCase):
    def test_manifests_agree_with_the_marketplace(self):
        market = {p["name"]: p for p in json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())["plugins"]}
        entry = market["sec-funding-signals"]
        plugin = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
        skill = sync_runtime.load_manifest(SKILL)
        self.assertEqual(entry["source"], "./plugins/sec-funding-signals")
        self.assertEqual(entry["skills"], ["./skills/sec-funding-signals"])
        self.assertEqual(entry["category"], "sales")
        self.assertEqual(plugin["name"], "sec-funding-signals")
        self.assertEqual({entry["version"], plugin["version"], skill["version"], json.loads((CLI / "package.json").read_text())["version"]}, {"0.1.0"})
        self.assertEqual(skill["runtimes"], [])
        self.assertRegex((SKILL / "SKILL.md").read_text(), r"(?m)^name: sec-funding-signals$")

    def test_the_readme_lists_it_with_a_one_line_install(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("Install the sec-funding-signals skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/sec-funding-signals and set it up for me.", readme)
        self.assertRegex(readme, r"(?m)^/plugin install sec-funding-signals@ae-external-skills\s*$")

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_the_committed_bundle_runs_and_is_current(self):
        out = subprocess.run(["node", str(BUNDLE), "--version"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "0.1.0")
        text = BUNDLE.read_text()
        for needle in ("efts.sec.gov", "www.sec.gov", "a series of", "sec-funding-signals "):
            self.assertIn(needle, text)
        self.assertNotRegex(text, r"https?://(?!efts\.sec\.gov|www\.sec\.gov|github\.com)[a-z0-9.-]+\.[a-z]{2,}/", "the bundle talks to no other host")

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_without_an_email_the_cli_refuses_to_touch_the_network(self):
        with __import__("tempfile").TemporaryDirectory() as tmp:
            env = {k: v for k, v in __import__("os").environ.items() if not k.startswith("SEC_FUNDING")}
            out = subprocess.run(["node", str(BUNDLE), "search", "--keywords", "x", "--since", "7d"], capture_output=True, text=True, cwd=tmp, env=env)
        self.assertEqual(out.returncode, 2)
        self.assertIn("ask the user for THEIR email", out.stderr)

    def test_no_email_address_is_hardcoded_in_the_plugin(self):
        pattern = re.compile(r"[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")
        for path in shipped():
            if path.suffix in (".js", ".mjs", ".md", ".json", ".yaml"):
                text = path.read_text(encoding="utf-8", errors="ignore")
                text = re.sub(r"@ae-external-skills", "", text)
                self.assertIsNone(pattern.search(text), str(path.relative_to(ROOT)))

    def test_public_text_is_a_neutral_data_source_playbook(self):
        banned = re.compile(r"\bPVP\b|angle bank|Agent Everywhere internal|aettio|grok|hiring|\bjobs?\b.*\b(check|signal)", re.I)
        for path in shipped():
            if path.suffix in (".md", ".yaml", ".json") and path.name != "plugin.json":
                for n, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                    if banned.search(line) and "no hiring or jobs check" not in line and "makes no hiring" not in line:
                        self.fail("%s:%d: %s" % (path.relative_to(ROOT), n, line.strip()))

    def test_plugin_zip_builds(self):
        if not shutil.which("zip"):
            self.skipTest("zip not installed")
        proc = subprocess.run(["bash", str(ROOT / "scripts" / "build-plugin-zip.sh"), "sec-funding-signals", "0.1.0"], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        listing = subprocess.run(["unzip", "-Z1", str(ROOT / "dist" / "sec-funding-signals.zip")], capture_output=True, text=True).stdout
        self.assertIn("skills/sec-funding-signals/cli/dist/sec-funding-signals.mjs", listing)
        self.assertNotIn("/tests/", listing)


if __name__ == "__main__":
    unittest.main()
