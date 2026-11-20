"""texas-bids plugin: manifests agree, the bundle ships and runs, and the public text stays neutral.

The plugin's own behaviour tests are Node tests:  cd plugins/texas-bids/skills/texas-bids/cli && node --test tests/*.test.js
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

PLUGIN = ROOT / "plugins" / "texas-bids"
SKILL = PLUGIN / "skills" / "texas-bids"
CLI = SKILL / "cli"
BUNDLE = CLI / "dist" / "texas-bids.mjs"


def shipped():
    skip = {"tests", "node_modules"}
    return [p for p in sorted(PLUGIN.rglob("*")) if p.is_file() and not (skip & set(p.relative_to(PLUGIN).parts))]


class TexasBids(unittest.TestCase):
    def test_manifests_agree_with_the_marketplace(self):
        market = {p["name"]: p for p in json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())["plugins"]}
        entry = market["texas-bids"]
        plugin = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
        skill = sync_runtime.load_manifest(SKILL)
        self.assertEqual(entry["source"], "./plugins/texas-bids")
        self.assertEqual(entry["skills"], ["./skills/texas-bids"])
        self.assertEqual(entry["category"], "sales")
        self.assertEqual(plugin["name"], "texas-bids")
        self.assertEqual({entry["version"], plugin["version"], skill["version"], json.loads((CLI / "package.json").read_text())["version"]}, {"0.1.0"})
        self.assertEqual(skill["runtimes"], [])
        self.assertRegex((SKILL / "SKILL.md").read_text(), r"(?m)^name: texas-bids$")

    def test_the_readme_lists_it_with_a_one_line_install(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("Install the texas-bids skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/texas-bids and set it up for me.", readme)
        self.assertRegex(readme, r"(?m)^/plugin install texas-bids@ae-external-skills\s*$")

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_the_committed_bundle_runs_and_talks_to_one_host(self):
        out = subprocess.run(["node", str(BUNDLE), "--version"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "0.1.0")
        text = BUNDLE.read_text()
        self.assertIn("www.txsmartbuy.gov", text)
        self.assertIn("ESBD.Service.ss", text)
        self.assertNotRegex(text, r"https?://(?!www\.txsmartbuy\.gov|github\.com|adaptivecards\.io)[a-z0-9.-]+\.[a-z]{2,}/", "the bundle talks to no other host")

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_without_keywords_the_cli_refuses_to_touch_the_network(self):
        out = subprocess.run(["node", str(BUNDLE), "search"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 2)
        self.assertIn("--keywords is required", out.stderr)

    def test_no_email_address_or_webhook_url_is_hardcoded_in_the_plugin(self):
        email = re.compile(r"[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")
        hook = re.compile(r"logic\.azure\.com|webhook\.office\.com|powerplatform\.com", re.I)
        for path in shipped():
            if path.suffix in (".js", ".mjs", ".md", ".json", ".yaml"):
                text = path.read_text(encoding="utf-8", errors="ignore")
                text = re.sub(r"@ae-external-skills", "", text)
                self.assertIsNone(email.search(text), str(path.relative_to(ROOT)))
                self.assertIsNone(hook.search(text), str(path.relative_to(ROOT)))

    def test_the_skill_never_searches_the_whole_disk_for_the_bundle(self):
        text = (SKILL / "SKILL.md").read_text()
        self.assertNotRegex(text, r"find\s+/(\s|\))")
        self.assertIn("-maxdepth", text)

    def test_plugin_zip_builds_and_ships_the_bundle_without_tests(self):
        if not shutil.which("zip"):
            self.skipTest("zip not installed")
        proc = subprocess.run(["bash", str(ROOT / "scripts" / "build-plugin-zip.sh"), "texas-bids", "0.1.0"], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        listing = subprocess.run(["unzip", "-Z1", str(ROOT / "dist" / "texas-bids.zip")], capture_output=True, text=True).stdout
        self.assertIn("skills/texas-bids/cli/dist/texas-bids.mjs", listing)
        self.assertIn("skills/texas-bids/SKILL.md", listing)
        self.assertNotIn("/tests/", listing)


if __name__ == "__main__":
    unittest.main()
