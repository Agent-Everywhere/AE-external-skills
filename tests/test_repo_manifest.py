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
# skill dir -> marketplace plugin name, where they differ ("claude-" is a reserved plugin prefix)
PLUGIN_NAMES = {"claude-desktop": "desktop-cowork"}


PLUGIN = ROOT / "plugins" / "sales-navigator"
PLUGIN_SKILLS = PLUGIN / "skills"
ENGINE = PLUGIN_SKILLS / "sales-navigator"
PURPOSE = ("salesnav-tam-accounts", "salesnav-tam-people", "salesnav-tam-tracker", "salesnav-outreach")


def skill_dirs():
    """Every skill folder: the standalone plugins under skills/ and the sales-navigator plugin's five."""
    return sorted((p for root in (ROOT / "skills", PLUGIN_SKILLS) for p in root.iterdir() if p.is_dir()),
                  key=lambda p: p.name)


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
        self.assertEqual(sync_runtime.load_manifest(ENGINE)["runtimes"], ["local", "agent-browser"])
        for name in PURPOSE:   # purpose skills carry no runtime of their own: they run the engine's
            m = sync_runtime.load_manifest(PLUGIN_SKILLS / name)
            self.assertEqual(m["runtimes"], [], name)
            self.assertEqual(m["engine"], "sales-navigator", name)

    def test_every_skill_has_a_matching_marketplace_entry(self):
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
        entries = {p["name"]: p for p in market["plugins"]}
        bundle = entries["sales-navigator"]
        self.assertEqual(bundle["source"], "./plugins/sales-navigator")
        self.assertEqual(bundle["category"], "sales")
        self.assertEqual(bundle["version"], sync_runtime.load_manifest(ENGINE)["version"],
                         "bump the marketplace version with the engine so clients see an update")
        newest = tuple(int(x) for x in bundle["version"].split("."))
        for d in sorted(PLUGIN_SKILLS.iterdir()):   # never older than any skill it ships
            v = tuple(int(x) for x in sync_runtime.load_manifest(d)["version"].split("."))
            self.assertGreaterEqual(newest, v, d.name)
        self.assertTrue(bundle.get("description"))
        bundled = set()
        for ref in bundle["skills"]:
            self.assertTrue(ref.startswith("./skills/"), ref)
            bundled.add(ref[len("./skills/"):])
        for d in skill_dirs():
            with self.subTest(skill=d.name):
                m = sync_runtime.load_manifest(d)
                if m["category"] == "sales":
                    self.assertIn(d.name, bundled)
                    self.assertEqual(sum(1 for e in entries.values() if e["name"] == d.name),
                                     1 if d.name == "sales-navigator" else 0)
                else:
                    plugin_name = PLUGIN_NAMES.get(d.name, d.name)
                    e = entries[plugin_name]
                    self.assertEqual(e["source"], "./skills/%s" % d.name)
                    self.assertEqual(e["category"], m["category"])
                    self.assertTrue(e.get("description"))
        for name in bundled:   # explicit skills list is relative to the plugin source folder
            self.assertTrue((PLUGIN_SKILLS / name / "SKILL.md").is_file(), name)
        self.assertEqual(sorted(entries), sorted(
            [PLUGIN_NAMES.get(d.name, d.name) for d in skill_dirs()
             if sync_runtime.load_manifest(d)["category"] != "sales"]
            + ["sales-navigator"]))

    def test_sales_navigator_plugin_ships_only_its_skills(self):
        """The marketplace source folder is what installs: it must not drag in tests, build scripts or packages."""
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
        source = ROOT / {p["name"]: p for p in market["plugins"]}["sales-navigator"]["source"]
        self.assertEqual(source.resolve(), PLUGIN.resolve())
        self.assertNotEqual(source.resolve(), ROOT.resolve(), "source must not be the repo root")
        top = {p.name for p in source.iterdir() if p.name != ".DS_Store"}
        for forbidden in ("tests", "build", "packages", "plugins", "dist", "README.md"):
            self.assertNotIn(forbidden, top)
        self.assertLessEqual(top, {"skills", ".claude-plugin"})
        self.assertEqual(sorted(p.name for p in (source / "skills").iterdir() if p.is_dir()),
                         sorted(("sales-navigator",) + PURPOSE))
        banned = {"tests", "build", "packages", "__pycache__"}
        for path in source.rglob("*"):
            if "__pycache__" in path.parts or path.suffix in (".pyc", ".pyo"):
                continue   # bytecode from running the scripts is not shipped content (and is not tracked)
            self.assertFalse(banned & set(path.relative_to(source).parts), str(path))

    def test_purpose_skills_hold_no_copies_of_the_engine(self):
        for name in PURPOSE:
            with self.subTest(skill=name):
                self.assertEqual(sorted(p.name for p in (PLUGIN_SKILLS / name).iterdir() if p.name != ".DS_Store"),
                                 ["SKILL.md", "skill.yaml"])

    def test_readme_install_lines_name_marketplace_plugins(self):
        import re
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
        plugins = {p["name"] for p in market["plugins"]}
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        installs = re.findall(r"^/plugin install (\S+)@ae-external-skills\s*$", readme, re.M)
        self.assertTrue(installs)
        for name in installs:
            with self.subTest(plugin=name):
                self.assertIn(name, plugins)
        self.assertEqual(sorted(installs), sorted(plugins), "README must install every plugin once")

    def test_marketplace_describes_both_sales_navigator_runtimes(self):
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
        desc = {p["name"]: p["description"] for p in market["plugins"]}["sales-navigator"].lower()
        self.assertIn("your own browser", desc)
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
            shutil.copytree(ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator", repo / "plugins" / "sales-navigator" / "skills" / "sales-navigator",
                            ignore=shutil.ignore_patterns("__pycache__"))
            script = str(ROOT / "build" / "sync_runtime.py")

            def check():
                return subprocess.run([sys.executable, script, "--check", "--root", tmp],
                                      capture_output=True, text=True)

            self.assertEqual(check().returncode, 0)
            runtime = repo / "plugins" / "sales-navigator" / "skills" / "sales-navigator" / "runtime"
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
            shutil.copytree(ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator", repo / "plugins" / "sales-navigator" / "skills" / "sales-navigator",
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
        shutil.copytree(ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator", self.repo / "plugins" / "sales-navigator" / "skills" / "sales-navigator",
                        ignore=shutil.ignore_patterns("__pycache__"))
        self.script = str(ROOT / "build" / "sync_runtime.py")
        self.runtime = self.repo / "plugins" / "sales-navigator" / "skills" / "sales-navigator" / "runtime"

    def run_script(self, *args):
        return subprocess.run([sys.executable, self.script, *args, "--root", str(self.repo)],
                              capture_output=True, text=True)

    def add_skill(self, name, runtimes):
        skill = self.repo / "skills" / name
        skill.mkdir(parents=True)
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

    def test_a_stray_runtime_copy_in_a_plugin_skill_is_an_orphan(self):
        """Purpose skills run the engine's runtime: a runtime/ copy inside one must fail the check."""
        skill = self.repo / "plugins" / "sales-navigator" / "skills" / "salesnav-demo"
        skill.mkdir(parents=True)
        (skill / "skill.yaml").write_text("name: salesnav-demo\nversion: 0.2.0\ncategory: sales\n"
                                          "engine: sales-navigator\nruntimes: []\n")
        self.assertEqual(self.run_script("--check").returncode, 0)
        (skill / "runtime").mkdir()
        result = self.run_script("--check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("ORPHAN salesnav-demo/runtime", result.stdout)

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
        roots = [ROOT / "packages", PLUGIN]
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
