"""Repo-level checks: skill.yaml manifests, marketplace entries, and vendored runtime copies.

Run from the repo root:  python3 -m pytest -q tests
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "build"))

import sync_runtime  # noqa: E402

KNOWN_RUNTIMES = {"local", "agent-browser"}
SEMVER = r"\d+\.\d+\.\d+"


def skill_dirs():
    return sorted(p for p in (ROOT / "skills").iterdir() if p.is_dir())


class SkillManifests(unittest.TestCase):
    def test_every_skill_has_a_valid_skill_yaml(self):
        import re
        for d in skill_dirs():
            with self.subTest(skill=d.name):
                self.assertTrue((d / "skill.yaml").is_file(), "missing skill.yaml")
                m = sync_runtime.load_manifest(d)
                self.assertEqual(m.get("name"), d.name)
                self.assertRegex(m.get("version", ""), "^" + SEMVER + "$")
                self.assertTrue(m.get("category"))
                self.assertIsInstance(m.get("runtimes"), list)
                self.assertTrue(set(m["runtimes"]) <= KNOWN_RUNTIMES, m["runtimes"])
                self.assertTrue((d / "SKILL.md").is_file())
                self.assertIsNotNone(re.search(r"^name: %s$" % re.escape(d.name),
                                               (d / "SKILL.md").read_text(), re.M))

    def test_runtime_expectations(self):
        self.assertEqual(sync_runtime.load_manifest(ROOT / "skills" / "grokbot")["runtimes"], [])
        self.assertEqual(sync_runtime.load_manifest(ROOT / "skills" / "grokbot-box")["runtimes"], [])
        self.assertEqual(sync_runtime.load_manifest(ROOT / "skills" / "sales-navigator")["runtimes"],
                         ["local", "agent-browser"])

    def test_every_skill_has_a_matching_marketplace_entry(self):
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
        entries = {p["name"]: p for p in market["plugins"]}
        self.assertEqual(sorted(entries), [d.name for d in skill_dirs()])
        for d in skill_dirs():
            with self.subTest(skill=d.name):
                m = sync_runtime.load_manifest(d)
                e = entries[d.name]
                self.assertEqual(e["source"], "./skills/%s" % d.name)
                self.assertEqual(e["category"], m["category"])
                self.assertTrue(e.get("description"))

    def test_marketplace_describes_both_sales_navigator_runtimes(self):
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
        desc = {p["name"]: p["description"] for p in market["plugins"]}["sales-navigator"].lower()
        self.assertIn("local", desc)
        self.assertIn("agent browser", desc)

    def test_parser_rejects_malformed_yaml(self):
        for bad in ("just text", "  indented: x", "runtimes: [a, b"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                sync_runtime.parse_skill_yaml(bad)
        self.assertEqual(sync_runtime.parse_skill_yaml("a: 1  # c\n# full\nb: []\nc: [x, 'y']"),
                         {"a": "1", "b": [], "c": ["x", "y"]})


class RuntimeVendoring(unittest.TestCase):
    def test_check_passes_on_the_repo(self):
        proc = subprocess.run([sys.executable, str(ROOT / "build" / "sync_runtime.py"), "--check"],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("sales-navigator/runtime", proc.stdout)

    def test_only_runtime_skills_are_vendored(self):
        for d in skill_dirs():
            wants = bool(sync_runtime.load_manifest(d)["runtimes"])
            self.assertEqual((d / "runtime").is_dir(), wants, d.name)

    def test_check_detects_drift_and_sync_repairs_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            shutil.copytree(ROOT / "packages", repo / "packages")
            shutil.copytree(ROOT / "skills" / "sales-navigator", repo / "skills" / "sales-navigator",
                            ignore=shutil.ignore_patterns("__pycache__"))
            script = str(ROOT / "build" / "sync_runtime.py")

            def check():
                return subprocess.run([sys.executable, script, "--check", "--root", tmp],
                                      capture_output=True, text=True)

            self.assertEqual(check().returncode, 0)
            runtime = repo / "skills" / "sales-navigator" / "runtime"
            (runtime / "session.py").write_text("# edited copy\n")
            r = check()
            self.assertEqual(r.returncode, 1)
            self.assertIn("differs: session.py", r.stdout)
            (runtime / "extra.md").write_text("stale")
            (runtime / "local.md").unlink()
            r = check()
            self.assertIn("stale: extra.md", r.stdout)
            self.assertIn("missing: local.md", r.stdout)
            fix = subprocess.run([sys.executable, script, "--root", tmp], capture_output=True, text=True)
            self.assertEqual(fix.returncode, 0, fix.stderr)
            self.assertEqual(check().returncode, 0)

    def test_source_change_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            shutil.copytree(ROOT / "packages", repo / "packages")
            shutil.copytree(ROOT / "skills" / "sales-navigator", repo / "skills" / "sales-navigator",
                            ignore=shutil.ignore_patterns("__pycache__"))
            with open(repo / "packages" / "browser-runtime" / "README.md", "a") as fh:
                fh.write("\nchanged at the source\n")
            r = subprocess.run([sys.executable, str(ROOT / "build" / "sync_runtime.py"), "--check", "--root", tmp],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("differs: README.md", r.stdout)


class PublicRepoHygiene(unittest.TestCase):
    """The runtime package and sales-navigator skill ship publicly: no identities or secrets."""

    FORBIDDEN = ("pureflow", "andideng", "glu@", "li_at", "agent-everywhere.com")

    def test_no_identities_or_cookies(self):
        roots = [ROOT / "packages", ROOT / "skills" / "sales-navigator"]
        for root in roots:
            for path in root.rglob("*"):
                if not path.is_file() or "__pycache__" in path.parts:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore").lower()
                for needle in self.FORBIDDEN:
                    with self.subTest(file=str(path.relative_to(ROOT)), needle=needle):
                        self.assertNotIn(needle, text)


if __name__ == "__main__":
    unittest.main()
