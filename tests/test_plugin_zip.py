"""Build the Claude Desktop "Upload plugin" zip with scripts/build-plugin-zip.sh and check what it ships.

Run from the repo root:  python3 -m pytest -q tests   (or python3 -m unittest discover -s tests)
"""
import json
import posixpath
import shutil
import subprocess
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = "sales-navigator"
SCRIPT = ROOT / "scripts" / "build-plugin-zip.sh"
DIST = ROOT / "dist"


def marketplace_entry():
    market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
    return next(p for p in market["plugins"] if p["name"] == PLUGIN)


@unittest.skipUnless(shutil.which("zip") and shutil.which("bash"), "zip or bash binary not installed")
class PluginZipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        run = subprocess.run(["bash", str(SCRIPT), PLUGIN], cwd=ROOT, capture_output=True, text=True)
        assert run.returncode == 0, f"build-plugin-zip.sh failed:\n{run.stdout}\n{run.stderr}"
        cls.zip_path = DIST / f"{PLUGIN}.zip"
        with zipfile.ZipFile(cls.zip_path) as z:
            cls.names = z.namelist()
            cls.plugin_json = json.loads(z.read(".claude-plugin/plugin.json"))
        cls.entry = marketplace_entry()

    def test_plugin_json_at_zip_root_matches_marketplace(self):
        self.assertIn(".claude-plugin/plugin.json", self.names)
        self.assertEqual(self.plugin_json["name"], self.entry["name"])
        self.assertEqual(self.plugin_json["version"], self.entry["version"])

    def test_plugin_file_is_identical_copy(self):
        self.assertEqual(self.zip_path.read_bytes(), (DIST / f"{PLUGIN}.plugin").read_bytes())

    def test_zip_has_no_dev_junk(self):
        junk = [n for n in self.names
                if set(n.rstrip("/").split("/")) & {".DS_Store", "__pycache__", "node_modules", "tests"}
                or n.endswith(".pyc")]
        self.assertEqual(junk, [])

    def test_zip_ships_the_sales_navigator_field_notes_kb(self):
        kb = "skills/sales-navigator/references/salesnav-kb/"
        shipped = sorted(n[len(kb):] for n in self.names if n.startswith(kb) and n.endswith(".md"))
        source = sorted(p.name for p in (ROOT / "plugins" / PLUGIN / kb).glob("*.md"))
        self.assertEqual(len(shipped), 16)
        self.assertIn("00-index.md", shipped)
        self.assertEqual(shipped, source)

    def test_zip_skills_equal_marketplace_declared_skills(self):
        in_zip = {n.split("/")[1] for n in self.names
                  if n.startswith("skills/") and n.endswith("/SKILL.md") and n.count("/") == 2}
        source = ROOT / self.entry["source"]
        declared_paths = self.entry.get("skills") or ["."]
        if declared_paths == ["."]:
            declared = {p.parent.name for p in (source / "skills").glob("*/SKILL.md")}
        else:
            declared = {posixpath.basename(posixpath.normpath(p)) for p in declared_paths}
            for p in declared_paths:
                self.assertTrue((source / p / "SKILL.md").is_file(), f"declared skill {p} has no SKILL.md")
        self.assertTrue(declared, "no skills declared")
        self.assertEqual(in_zip, declared)


if __name__ == "__main__":
    unittest.main()
