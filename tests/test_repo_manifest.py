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
from unittest import mock

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
            (runtime / "README.md").unlink()
            r = check()
            self.assertIn("stale: extra.md", r.stdout)
            self.assertIn("missing: README.md", r.stdout)
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


class SyncHardening(unittest.TestCase):
    """build/sync_runtime.py: orphan runtime dirs, OS litter, and atomic replacement."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        shutil.copytree(ROOT / "packages", self.repo / "packages")
        shutil.copytree(ROOT / "skills" / "sales-navigator", self.repo / "skills" / "sales-navigator",
                        ignore=shutil.ignore_patterns("__pycache__"))
        self.script = str(ROOT / "build" / "sync_runtime.py")
        self.runtime = self.repo / "skills" / "sales-navigator" / "runtime"

    def run_script(self, *args):
        return subprocess.run([sys.executable, self.script, *args, "--root", str(self.repo)],
                              capture_output=True, text=True)

    def add_skill(self, name, runtimes):
        skill = self.repo / "skills" / name
        skill.mkdir()
        (skill / "skill.yaml").write_text("name: %s\nversion: 0.1.0\ncategory: x\nruntimes: %s\n" % (name, runtimes))
        (skill / "SKILL.md").write_text("---\nname: %s\n---\n" % name)
        return skill

    def test_a_runtime_folder_on_a_skill_with_no_runtimes_fails_the_check(self):
        self.assertEqual(self.run_script("--check").returncode, 0)
        skill = self.add_skill("plain", "[]")
        self.assertEqual(self.run_script("--check").returncode, 0)
        (skill / "runtime").mkdir()
        (skill / "runtime" / "session.py").write_text("# stray copy\n")
        result = self.run_script("--check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("ORPHAN plain/runtime", result.stdout)
        # a plain sync reports it but does not delete anything the user may care about
        fix = self.run_script()
        self.assertEqual(fix.returncode, 0)
        self.assertIn("plain/runtime", fix.stdout)
        self.assertTrue((skill / "runtime" / "session.py").exists())
        shutil.rmtree(skill / "runtime")
        self.assertEqual(self.run_script("--check").returncode, 0)

    def test_os_litter_is_ignored_in_the_package_and_in_the_copy(self):
        litter = [".DS_Store", "._session.py", "Thumbs.db", "notes.txt~", "session.py.swp"]
        for name in litter:
            (self.runtime / name).write_text("junk")
            (self.repo / "packages" / "browser-runtime" / name).write_text("junk")
        (self.runtime / "__pycache__").mkdir()
        (self.runtime / "__pycache__" / "session.cpython-312.pyc").write_bytes(b"\0")
        self.assertEqual(self.run_script("--check").returncode, 0)
        self.assertEqual(self.run_script().returncode, 0)
        for name in litter:
            self.assertFalse((self.runtime / name).exists(), name)  # never vendored, and swept out of the copy
        self.assertEqual(self.run_script("--check").returncode, 0)

    def test_sync_builds_in_a_temp_dir_and_leaves_the_old_copy_when_it_fails(self):
        (self.runtime / "session.py").write_text("# stale\n")
        source = self.repo / "packages" / "browser-runtime"
        before = {p.name: p.read_bytes() for p in self.runtime.iterdir() if p.is_file()}
        real_copy2 = sync_runtime.shutil.copy2
        calls = []

        def flaky(src, dst, *a, **k):
            calls.append(dst)
            if len(calls) == 2:
                raise OSError("disk full")
            return real_copy2(src, dst, *a, **k)

        with mock.patch.object(sync_runtime.shutil, "copy2", flaky):
            with self.assertRaises(OSError):
                sync_runtime.sync(source, self.runtime)
        after = {p.name: p.read_bytes() for p in self.runtime.iterdir() if p.is_file()}
        self.assertEqual(after, before)  # the old copy is intact, not half replaced
        leftovers = [p.name for p in self.runtime.parent.iterdir() if p.name.startswith(".runtime-")]
        self.assertEqual(leftovers, [])  # and no staging dirs are left behind

    def test_a_good_sync_swaps_in_the_new_copy_and_removes_staging(self):
        (self.runtime / "extra.md").write_text("stale file removed from the package")
        sync_runtime.sync(self.repo / "packages" / "browser-runtime", self.runtime)
        self.assertFalse((self.runtime / "extra.md").exists())
        self.assertEqual(self.run_script("--check").returncode, 0)
        self.assertEqual([p.name for p in self.runtime.parent.iterdir() if p.name.startswith(".runtime-")], [])


class PublicRepoHygiene(unittest.TestCase):
    """The runtime package and sales-navigator skill ship publicly: no identities or secrets."""

    FORBIDDEN = ("pureflow", "andideng", "glu@", "li_at", "agent-everywhere.com")
    # The one legitimate mention of a cookie name: the runner's scrub pattern in session.py (and its
    # vendored copy). Only the single line carrying this marker is exempt, only from the cookie needle.
    ALLOW_MARK = "hygiene-allow: cookie-name scrub pattern"

    def test_no_identities_or_cookies(self):
        roots = [ROOT / "packages", ROOT / "skills" / "sales-navigator"]
        for root in roots:
            for path in root.rglob("*"):
                if not path.is_file() or "__pycache__" in path.parts:
                    continue
                lines = path.read_text(encoding="utf-8", errors="ignore").lower().splitlines()
                for needle in self.FORBIDDEN:
                    if needle == "li_at" and path.name == "session.py":
                        lines_for_needle = [l for l in lines if self.ALLOW_MARK not in l]
                        marked = len(lines) - len(lines_for_needle)
                        self.assertLessEqual(marked, 1, "only one line may carry the allow marker")
                        text = "\n".join(lines_for_needle)
                    else:
                        text = "\n".join(lines)
                    with self.subTest(file=str(path.relative_to(ROOT)), needle=needle):
                        self.assertNotIn(needle, text)


if __name__ == "__main__":
    unittest.main()
