"""Tests for the engine's scripts/doctor.py (stdlib, no network).

Run from the repo root:  python3 -m pytest -q tests
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator"
DOCTOR = ENGINE / "scripts" / "doctor.py"
sys.path.insert(0, str(ENGINE / "scripts"))

import doctor  # noqa: E402


def run(*args, cwd=None, env_extra=None):
    env = {k: v for k, v in os.environ.items() if k != "SALESNAV_WORKSPACE"}
    env.update(env_extra or {})
    return subprocess.run([sys.executable, str(DOCTOR), *args], capture_output=True, text=True,
                          cwd=cwd, env=env)


class RequiredLists(unittest.TestCase):
    def test_lists_match_the_engine_folders(self):
        self.assertEqual(sorted(p.name for p in (ENGINE / "page").glob("*.js")), sorted(doctor.REQUIRED_PAGE))
        self.assertEqual(sorted(p.name for p in (ENGINE / "scripts").glob("*.py")), sorted(doctor.REQUIRED_SCRIPTS))
        for rel in doctor.REQUIRED_OTHER:
            self.assertTrue((ENGINE / rel).is_file(), rel)


class DoctorRuns(unittest.TestCase):
    def test_passes_from_the_repo_root_and_from_an_unrelated_folder(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            for cwd in (str(ROOT), elsewhere):
                with self.subTest(cwd=cwd):
                    r = run(cwd=cwd)
                    self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                    self.assertIn("engine: %s" % ENGINE.resolve(), r.stdout)
                    self.assertIn("python: %d.%d" % sys.version_info[:2], r.stdout)
                    self.assertIn("workspace:", r.stdout)
                    self.assertIn("OK: engine complete.", r.stdout)
                    self.assertNotIn("MISSING", r.stdout)

    def test_reports_the_workspace_and_how_it_was_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = run("--workspace", tmp, cwd=tmp)
            self.assertEqual(r.returncode, 0, r.stdout)
            self.assertIn("workspace: %s (source: flag)" % tmp, r.stdout)
            r = run(cwd=tmp, env_extra={"SALESNAV_WORKSPACE": tmp})
            self.assertIn("(source: env)", r.stdout)

    def test_an_unset_workspace_is_a_note_not_a_failure(self):
        with tempfile.TemporaryDirectory() as home:
            r = run(cwd=home, env_extra={"HOME": home})
            self.assertEqual(r.returncode, 0, r.stdout)
            self.assertIn("workspace: NOTE not set up", r.stdout)
            self.assertIn("workspace.py init", r.stdout)

    def test_a_missing_file_fails_closed_with_a_clear_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "sales-navigator"
            shutil.copytree(ENGINE, broken, ignore=shutil.ignore_patterns("__pycache__"))
            (broken / "page" / "count.js").unlink()
            (broken / "scripts" / "run_log.py").unlink()
            r = run("--engine", str(broken), cwd=tmp)
            self.assertEqual(r.returncode, 1, r.stdout)
            self.assertIn("MISSING: page/count.js", r.stdout)
            self.assertIn("MISSING: scripts/run_log.py", r.stdout)
            self.assertIn("FAIL:", r.stdout)
            self.assertIn("Do not drive the Sales Navigator UI by hand", r.stdout)
            self.assertNotIn("OK: engine complete", r.stdout)

    def test_an_engine_folder_that_does_not_exist_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = run("--engine", str(Path(tmp) / "nope"), cwd=tmp)
            self.assertEqual(r.returncode, 1)
            self.assertIn("engine folder not found", r.stdout)
            self.assertIn("Do not drive the Sales Navigator UI by hand", r.stdout)

    def test_check_engine_lists_what_is_present_and_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            present, missing = doctor.check_engine(tmp)
            self.assertEqual(present, [])
            self.assertEqual(missing, doctor.required_paths())
        present, missing = doctor.check_engine(ENGINE)
        self.assertEqual(missing, [])
        self.assertEqual(present, doctor.required_paths())

    def test_works_when_run_from_a_copy_of_the_engine_installed_elsewhere(self):
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "plugin" / "skills" / "sales-navigator"
            shutil.copytree(ENGINE, copy, ignore=shutil.ignore_patterns("__pycache__"))
            r = subprocess.run([sys.executable, str(copy / "scripts" / "doctor.py")], capture_output=True,
                               text=True, cwd=tmp)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("engine: %s" % copy.resolve(), r.stdout)


if __name__ == "__main__":
    unittest.main()
