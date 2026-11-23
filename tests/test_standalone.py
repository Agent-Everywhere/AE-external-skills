"""Generated standalone plugin folders (scripts/build-standalone.py, manifest scripts/standalone.json).

The slim folder plugins/linkedin-job-signals is generated from the source skill and the shared linkedin engine; these
tests pin that it is up to date, that it holds exactly the whitelisted engine files and none of the people-search,
outreach or replies tools, that its SKILL.md is the source's byte for byte, and that it runs on its own. No network.

Run from the repo root:  python3 -m pytest -q tests
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "scripts" / "build-standalone.py"
ZIP_SCRIPT = ROOT / "scripts" / "build-plugin-zip.sh"
OUT = ROOT / "plugins" / "linkedin-job-signals"
SRC_SKILL = ROOT / "plugins" / "linkedin" / "skills" / "linkedin-job-signals"
SRC_ENGINE = ROOT / "plugins" / "linkedin" / "skills" / "linkedin"
WHITELIST = ["scripts/job_signals.py", "scripts/li_common.py", "scripts/search_jobs.js",
             "references/job_signal_presets.json", "references/job_endpoints.md"]
FORBIDDEN = ["find_people.py", "outreach.py", "replies.py", "poll.js", "search_people.js", "endpoints.md"]


def run_build(*args, root=None):
    cmd = [sys.executable, "-I", str(BUILD), *args] + (["--root", str(root)] if root else [])
    return subprocess.run(cmd, capture_output=True, text=True, env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"})


def files_under(folder):
    return sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*")
                  if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc" and p.name != ".DS_Store")


def manifest():
    return json.loads((ROOT / "scripts" / "standalone.json").read_text(encoding="utf-8"))["plugins"]


def mini_repo(tmp):
    """A small copy of the repo parts the generator reads, to change freely."""
    repo = Path(tmp) / "repo"
    for rel in ("scripts/standalone.json", ".claude-plugin/marketplace.json"):
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, repo / rel)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")
    shutil.copytree(ROOT / "plugins" / "linkedin", repo / "plugins" / "linkedin", ignore=ignore)
    shutil.copytree(OUT, repo / "plugins" / "linkedin-job-signals", ignore=ignore)
    return repo


def snapshot(folder):
    """{relative path: ('file', sha256) | ('dir',) | ('link', target)} of everything under folder, links not followed."""
    snap = {}
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        for name in dirnames + filenames:
            path = Path(dirpath) / name
            rel = path.relative_to(folder).as_posix()
            if path.is_symlink():
                snap[rel] = ("link", os.readlink(path))
            elif path.is_dir():
                snap[rel] = ("dir",)
            else:
                snap[rel] = ("file", hashlib.sha256(path.read_bytes()).hexdigest())
    return snap


def edit_manifest(repo, change):
    path = repo / "scripts" / "standalone.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    change(doc["plugins"][0])
    path.write_text(json.dumps(doc), encoding="utf-8")


class CommittedFolder(unittest.TestCase):
    def test_check_passes_on_the_committed_tree(self):
        r = run_build("--check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("ok: plugins/linkedin-job-signals", r.stdout)

    def test_the_manifest_whitelist_is_the_tested_one(self):
        entry = next(e for e in manifest() if e["name"] == "linkedin-job-signals")
        self.assertEqual(entry["skill_source"], "plugins/linkedin/skills/linkedin-job-signals")
        self.assertEqual(entry["engine_source"], "plugins/linkedin/skills/linkedin")
        self.assertEqual(entry["output"], "plugins/linkedin-job-signals")
        self.assertEqual(sorted(entry["engine_files"]), sorted(WHITELIST))

    def test_engine_folder_holds_exactly_the_whitelisted_files(self):
        engine = OUT / "skills" / "linkedin"
        self.assertEqual(files_under(engine), sorted(WHITELIST))
        names = {Path(f).name for f in files_under(OUT)}
        for forbidden in FORBIDDEN:
            self.assertNotIn(forbidden, names)
        for rel in WHITELIST:
            self.assertEqual((engine / rel).read_bytes(), (SRC_ENGINE / rel).read_bytes(), rel)

    def test_the_whole_folder_is_the_expected_set(self):
        self.assertEqual(files_under(OUT), sorted(
            [".claude-plugin/plugin.json", "GENERATED.md",
             "skills/linkedin-job-signals/SKILL.md", "skills/linkedin-job-signals/skill.yaml"]
            + ["skills/linkedin/" + rel for rel in WHITELIST]))

    def test_the_skill_folder_is_a_byte_copy_of_the_source(self):
        self.assertEqual(files_under(OUT / "skills" / "linkedin-job-signals"), files_under(SRC_SKILL))
        for rel in files_under(SRC_SKILL):
            self.assertEqual((OUT / "skills" / "linkedin-job-signals" / rel).read_bytes(), (SRC_SKILL / rel).read_bytes(), rel)

    def test_plugin_json_matches_the_marketplace_entry_and_says_generated(self):
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
        entry = next(p for p in market["plugins"] if p["name"] == "linkedin-job-signals")
        self.assertEqual((entry["source"], entry["skills"], entry["strict"]),
                         ("./plugins/linkedin-job-signals", ["./skills/linkedin-job-signals"], False))
        pj = json.loads((OUT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual((pj["name"], pj["version"], pj["description"], pj["keywords"]),
                         (entry["name"], entry["version"], entry["description"], entry["tags"]))
        self.assertEqual(pj["author"], {"name": "Agent Everywhere", "url": "https://github.com/Agent-Everywhere"})
        note = (OUT / "GENERATED.md").read_text(encoding="utf-8")
        self.assertIn("scripts/build-standalone.py", note)
        self.assertIn("do not edit", note.lower())

    def test_the_unchanged_engine_lookup_resolves_next_to_the_skill(self):
        # SKILL.md looks for "<skill folder>/../linkedin/scripts/li_common.py" first
        self.assertTrue((OUT / "skills" / "linkedin-job-signals" / ".." / "linkedin" / "scripts" / "li_common.py").is_file())

    def test_the_job_endpoints_reference_is_jobs_only(self):
        text = (OUT / "skills" / "linkedin" / "references" / "job_endpoints.md").read_text(encoding="utf-8")
        for word in ("Job postings", "seeMoreJobPostings", "voyagerJobsDashJobCards", "Status markers"):
            self.assertIn(word, text)
        for word in ("People search", "Replies and acceptance", "sentInvitationViewsV2", "Writes (UI only)", "messengerConversations"):
            self.assertNotIn(word, text)
        full = (SRC_ENGINE / "references" / "endpoints.md").read_text(encoding="utf-8")
        self.assertIn("job_endpoints.md", full)           # the pointer left where the section was
        self.assertNotIn("seeMoreJobPostings", full)      # one fact, one home


class Runs(unittest.TestCase):
    def test_the_standalone_tool_runs_from_a_temp_folder(self):
        tool = OUT / "skills" / "linkedin" / "scripts" / "job_signals.py"
        with tempfile.TemporaryDirectory() as tmp:
            r = subprocess.run([sys.executable, "-I", str(tool), "presets"], cwd=tmp, capture_output=True, text=True,
                               env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("physical-ai-data", r.stdout)
            self.assertEqual(os.listdir(tmp), [], "presets writes nothing")

    def test_profile_preset_and_check_work_offline_with_only_the_whitelisted_files(self):
        tool = OUT / "skills" / "linkedin" / "scripts" / "job_signals.py"
        env = {"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"}
        with tempfile.TemporaryDirectory() as tmp:
            for cmd in (["profile", "--preset", "physical-ai-data"], ["profile", "--check"]):
                r = subprocess.run([sys.executable, "-I", str(tool), *cmd], cwd=tmp, capture_output=True, text=True, env=env)
                self.assertEqual(r.returncode, 0, "%s: %s%s" % (cmd, r.stdout, r.stderr))


@unittest.skipUnless(shutil.which("zip") and shutil.which("bash"), "zip or bash binary not installed")
class PluginZip(unittest.TestCase):
    def test_the_zip_has_none_of_the_forbidden_files(self):
        dist = ROOT / "dist"
        existed = dist.exists()
        mine = [dist / "linkedin-job-signals.zip", dist / "linkedin-job-signals.plugin"]
        self.addCleanup(lambda: [p.unlink() for p in mine if p.exists()])
        if not existed:
            self.addCleanup(lambda: dist.exists() and not any(dist.iterdir()) and dist.rmdir())
        run = subprocess.run(["bash", str(ZIP_SCRIPT), "linkedin-job-signals"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        with zipfile.ZipFile(dist / "linkedin-job-signals.zip") as z:
            names = z.namelist()
            plugin_json = json.loads(z.read(".claude-plugin/plugin.json"))
        self.assertEqual(plugin_json["name"], "linkedin-job-signals")
        base = {Path(n).name for n in names}
        for forbidden in FORBIDDEN:
            self.assertNotIn(forbidden, base)
        self.assertIn("skills/linkedin-job-signals/SKILL.md", names)
        for rel in WHITELIST:
            self.assertIn("skills/linkedin/" + rel, names)
        self.assertEqual(sorted(n for n in names if not n.endswith("/")), sorted(files_under(OUT)))


class Generator(unittest.TestCase):
    def test_check_detects_drift_and_a_rebuild_repairs_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            self.assertEqual(run_build("--check", root=repo).returncode, 0)
            out = repo / "plugins" / "linkedin-job-signals"
            (out / "skills" / "linkedin" / "scripts" / "li_common.py").write_text("# hand edit\n")
            (out / "skills" / "linkedin" / "scripts" / "outreach.py").write_text("# stray\n")
            (out / "GENERATED.md").unlink()
            r = run_build("--check", root=repo)
            self.assertEqual(r.returncode, 1)
            self.assertIn("differs: plugins/linkedin-job-signals/skills/linkedin/scripts/li_common.py", r.stdout)
            self.assertIn("stale (not generated): plugins/linkedin-job-signals/skills/linkedin/scripts/outreach.py", r.stdout)
            self.assertIn("missing: plugins/linkedin-job-signals/GENERATED.md", r.stdout)
            self.assertTrue((out / "skills" / "linkedin" / "scripts" / "outreach.py").exists(), "--check writes nothing")
            fix = run_build(root=repo)
            self.assertEqual(fix.returncode, 0, fix.stdout + fix.stderr)
            self.assertFalse((out / "skills" / "linkedin" / "scripts" / "outreach.py").exists())
            self.assertEqual(run_build("--check", root=repo).returncode, 0)

    def test_a_source_edit_makes_check_fail_until_rebuilt(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            src = repo / "plugins" / "linkedin" / "skills" / "linkedin-job-signals" / "SKILL.md"
            src.write_text(src.read_text(encoding="utf-8") + "\nedited\n", encoding="utf-8")
            r = run_build("--check", root=repo)
            self.assertEqual(r.returncode, 1)
            self.assertIn("differs: plugins/linkedin-job-signals/skills/linkedin-job-signals/SKILL.md", r.stdout)
            self.assertEqual(run_build(root=repo).returncode, 0)
            self.assertEqual(run_build("--check", root=repo).returncode, 0)

    def test_a_missing_whitelisted_file_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            (repo / "plugins" / "linkedin" / "skills" / "linkedin" / "scripts" / "search_jobs.js").unlink()
            for args in ((), ("--check",)):
                r = run_build(*args, root=repo)
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertIn("whitelisted engine file missing", r.stderr)
                self.assertIn("search_jobs.js", r.stderr)

    def test_a_marketplace_entry_pointing_elsewhere_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            path = repo / ".claude-plugin" / "marketplace.json"
            doc = json.loads(path.read_text(encoding="utf-8"))
            next(p for p in doc["plugins"] if p["name"] == "linkedin-job-signals")["source"] = "./plugins/linkedin"
            path.write_text(json.dumps(doc), encoding="utf-8")
            r = run_build("--check", root=repo)
            self.assertEqual(r.returncode, 2)
            self.assertIn("must have source ./plugins/linkedin-job-signals", r.stderr)


class Refusals(unittest.TestCase):
    """Bad manifests and symlinks exit 2 with a clear message and leave the whole tree byte for byte as it was."""

    def refused(self, repo, message_part):
        # make a write observable: the output has a missing file, so an accepted run would change the tree
        (repo / "plugins" / "linkedin-job-signals" / "GENERATED.md").unlink(missing_ok=True)
        (repo / "KEEP.txt").write_text("repo root sentinel\n")
        (repo / "plugins" / "KEEP.txt").write_text("plugins sentinel\n")
        before = snapshot(repo)
        for args in ((), ("--check",)):
            r = run_build(*args, root=repo)
            self.assertEqual(r.returncode, 2, "%s: %s%s" % (args, r.stdout, r.stderr))
            self.assertIn(message_part, r.stderr)
            self.assertEqual(snapshot(repo), before, "%s changed the tree" % (args,))

    def test_a_name_that_climbs_out_is_refused(self):
        for name in ("linkedin-job-signals/../..", "x/..", ".", "..", "Upper", "-x", "a b", ""):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                repo = mini_repo(tmp)

                def change(e, name=name):
                    e["name"] = name
                    e["output"] = "plugins/" + name
                edit_manifest(repo, change)
                self.refused(repo, "name must match")

    def test_an_output_other_than_plugins_name_is_refused(self):
        for output in ("plugins", ".", "plugins/linkedin-job-signals/..", "plugins/other", "/tmp/x", "../x"):
            with self.subTest(output=output), tempfile.TemporaryDirectory() as tmp:
                repo = mini_repo(tmp)
                edit_manifest(repo, lambda e, output=output: e.update(output=output))
                self.refused(repo, "output of linkedin-job-signals must be plugins/linkedin-job-signals")

    def test_an_engine_file_that_climbs_out_is_refused(self):
        for rel in ("../../../../KEEP.txt", "scripts/../../x", "/etc/passwd", "scripts//li_common.py", "./scripts/li_common.py", "scripts/"):
            with self.subTest(rel=rel), tempfile.TemporaryDirectory() as tmp:
                repo = mini_repo(tmp)
                edit_manifest(repo, lambda e, rel=rel: e["engine_files"].append(rel))
                self.refused(repo, "engine_files entry must be a clean relative path")

    def test_an_absolute_or_climbing_source_is_refused(self):
        for key in ("skill_source", "engine_source"):
            for value in ("/etc", "../outside", "plugins/linkedin/../linkedin/skills/linkedin", "plugins/linkedin/skills//linkedin"):
                with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as tmp:
                    repo = mini_repo(tmp)
                    edit_manifest(repo, lambda e, key=key, value=value: e.update({key: value}))
                    self.refused(repo, "%s must be a clean relative path" % key)

    def test_a_source_that_overlaps_the_output_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            edit_manifest(repo, lambda e: e.update(skill_source="plugins/linkedin-job-signals/skills/linkedin-job-signals"))
            self.refused(repo, "overlaps its output folder")

    def test_a_symlinked_skill_source_file_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            skill = repo / "plugins" / "linkedin" / "skills" / "linkedin-job-signals"
            (skill / "skill.yaml").unlink()
            (skill / "skill.yaml").symlink_to(repo / "scripts" / "standalone.json")
            self.refused(repo, "contains a symlink")

    def test_a_symlinked_engine_file_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            target = repo / "plugins" / "linkedin" / "skills" / "linkedin" / "scripts" / "search_jobs.js"
            real = repo / "real_search_jobs.js"
            shutil.move(str(target), str(real))
            target.symlink_to(real)
            self.refused(repo, "symlink")

    def test_a_symlinked_engine_folder_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            engine = repo / "plugins" / "linkedin" / "skills" / "linkedin"
            real = repo / "real_engine"
            shutil.move(str(engine), str(real))
            engine.symlink_to(real, target_is_directory=True)
            self.refused(repo, "symlink")

    def test_a_symlinked_output_folder_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            out = repo / "plugins" / "linkedin-job-signals"
            elsewhere = repo / "elsewhere"
            shutil.move(str(out), str(elsewhere))
            out.symlink_to(elsewhere, target_is_directory=True)
            self.refused(repo, "symlink")

    def test_a_symlink_inside_the_output_folder_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            out = repo / "plugins" / "linkedin-job-signals"
            (out / "skills" / "linkedin" / "scripts" / "job_signals.py").unlink()
            (out / "skills" / "linkedin" / "scripts" / "job_signals.py").symlink_to(repo / "scripts" / "standalone.json")
            self.refused(repo, "symlink")

    def test_a_symlinked_plugins_folder_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = mini_repo(tmp)
            real = repo / "real_plugins"
            shutil.move(str(repo / "plugins"), str(real))
            (repo / "plugins").symlink_to(real, target_is_directory=True)
            self.refused(repo, "symlink")


class Deterministic(unittest.TestCase):
    def test_two_builds_into_fresh_outputs_are_identical(self):
        trees = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as tmp:
                repo = mini_repo(tmp)
                out = repo / "plugins" / "linkedin-job-signals"
                shutil.rmtree(out)
                r = run_build(root=repo)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                trees.append(snapshot(out))
        self.assertEqual(trees[0], trees[1])
        self.assertTrue(any(k.endswith("li_common.py") for k in trees[0]))


class EngineSnippet(unittest.TestCase):
    def test_the_skill_md_engine_snippet_resolves_to_the_slim_engine_folder(self):
        text = (OUT / "skills" / "linkedin-job-signals" / "SKILL.md").read_text(encoding="utf-8")
        block = re.search(r"```sh\n(ENGINE=.*?)\n```", text, re.S)
        self.assertIsNotNone(block, "the ENGINE snippet is in SKILL.md")
        snippet = block.group(1)
        placeholder = "<absolute folder of this SKILL.md>"
        self.assertIn(placeholder, snippet)
        ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            home.mkdir()
            plugin = Path(tmp) / "a folder with spaces" / "linkedin-job-signals"
            shutil.copytree(OUT, plugin, ignore=ignore)
            skill = plugin / "skills" / "linkedin-job-signals"
            script = snippet.replace(placeholder, str(skill)) + '\nprintf "%s" "$ENGINE"\n'
            env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home)}    # no CLAUDE_PLUGIN_ROOT, no other engines
            r = subprocess.run(["sh", "-c", script], capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertEqual(r.stderr, "", "no warning and no 'engine not found'")
            self.assertEqual(os.path.realpath(r.stdout), os.path.realpath(plugin / "skills" / "linkedin"))
            self.assertEqual(sorted(files_under(Path(r.stdout))), sorted(WHITELIST))


if __name__ == "__main__":
    unittest.main()
