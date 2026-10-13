"""Tests for scripts/tam_tracker.py: the sub-list checklist for a TAM pulled under the cap.

Run from the repo root:  python3 -m pytest -q tests
"""
import contextlib
import csv
import io
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "sales-navigator" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import tam_tracker  # noqa: E402
import workspace  # noqa: E402

TODAY = date.today().isoformat()


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = tam_tracker.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


def read(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


class TrackerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name)
        self.log = self.ws / "tam_tracker.csv"

    def t(self, *argv):
        return run([argv[0], "--workspace", str(self.ws), *argv[1:]])

    def add(self, list_id, count, master="m1", delta="state=X", *extra):
        if "--cap" not in extra and "--kind" not in extra:
            extra += ("--kind", "account")
        return self.t("add", "--list-id", list_id, "--master", master, "--filters-delta", delta,
                      "--count", str(count), *extra)


class AddAndUpdate(TrackerCase):
    def test_add_writes_the_documented_columns_with_status_new(self):
        code, out, _ = self.add("tx-c", 840, delta="state=Texas; headcount=C")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.log.read_text(encoding="utf-8").splitlines()[0],
                         "list_id,master,filters_delta,count,pulled,status,last_pulled,file")
        row = read(self.log)[0]
        self.assertEqual((row["list_id"], row["master"], row["filters_delta"], row["count"], row["pulled"],
                          row["status"], row["last_pulled"], row["file"]),
                         ("tx-c", "m1", "state=Texas; headcount=C", "840", "0", "new", "", ""))

    def test_duplicate_id_is_refused_with_exit_3_and_changes_nothing(self):
        self.add("a", 10)
        before = self.log.read_bytes()
        code, _, err = self.add("a", 99)
        self.assertEqual(code, 3)
        self.assertIn("already", err)
        self.assertEqual(self.log.read_bytes(), before)

    def test_cap_refuses_an_oversize_list_with_exit_5_not_the_argparse_code(self):
        code, _, err = self.add("big", 1500, "m1", "state=X", "--cap", "1000")
        self.assertEqual(code, 5)
        self.assertIn("split", err)
        self.assertFalse(self.log.exists())
        self.assertEqual(self.add("ok", 1000, "m1", "state=X", "--cap", "1000")[0], 0)
        self.assertEqual(self.t("update", "--master", "m1", "--list-id", "ok", "--status", "finished")[0], 2)  # usage error

    def test_kind_sets_the_cap_and_one_of_kind_or_cap_is_required(self):
        self.assertEqual(self.add("acc", 1001, "m1", "state=X", "--kind", "account")[0], 5)
        self.assertEqual(self.add("acc", 1000, "m1", "state=X", "--kind", "account")[0], 0)
        self.assertEqual(self.add("lead1", 2501, "m1", "state=X", "--kind", "lead")[0], 5)
        self.assertEqual(self.add("lead2", 2500, "m1", "state=X", "--kind", "lead")[0], 0)
        self.assertEqual(self.add("low", 600, "m1", "state=X", "--kind", "lead", "--cap", "500")[0], 5)  # --cap only lowers
        before = self.log.read_bytes()
        code, _, err = self.t("add", "--list-id", "nocap", "--master", "m1", "--filters-delta", "x", "--count", "5")
        self.assertEqual(code, 1)
        self.assertIn("--kind", err)
        self.assertEqual(self.log.read_bytes(), before)

    def test_a_cap_of_zero_or_less_is_refused(self):
        for cap in ("0", "-5"):
            with self.subTest(cap=cap):
                code, _, err = self.add("a", 5, "m1", "state=X", "--cap", cap)
                self.assertEqual(code, 1)
                self.assertIn("positive", err)
        self.assertFalse(self.log.exists())

    def test_the_same_list_id_under_two_masters_is_two_lists(self):
        self.assertEqual(self.add("tx-c", 800, "acme")[0], 0)
        self.assertEqual(self.add("tx-c", 300, "globex")[0], 0)
        self.assertEqual(self.add("tx-c", 5, "acme")[0], 3)   # same master, same id: still refused
        self.t("update", "--master", "globex", "--list-id", "tx-c", "--pulled", "300", "--file", "g.csv")
        acme, globex = read(self.log)
        self.assertEqual((acme["master"], acme["pulled"], acme["status"], acme["file"]), ("acme", "0", "new", ""))
        self.assertEqual((globex["master"], globex["pulled"], globex["status"], globex["file"]),
                         ("globex", "300", "done", "g.csv"))
        self.assertEqual(self.t("update", "--master", "initech", "--list-id", "tx-c", "--pulled", "1")[0], 3)
        code, _, _ = run(["update", "--workspace", str(self.ws), "--list-id", "tx-c", "--pulled", "1"])
        self.assertEqual(code, 2)   # --master is required on update

    def test_a_raised_count_reopens_a_done_list(self):
        self.add("a", 840)
        self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "840")
        self.assertEqual(read(self.log)[0]["status"], "done")
        self.t("update", "--master", "m1", "--list-id", "a", "--count", "990")
        row = read(self.log)[0]
        self.assertEqual((row["count"], row["pulled"], row["status"]), ("990", "840", "partial"))
        self.t("update", "--master", "m1", "--list-id", "a", "--count", "800")   # fewer than pulled: done again
        self.assertEqual(read(self.log)[0]["status"], "done")
        self.t("update", "--master", "m1", "--list-id", "a", "--count", "900", "--status", "done")   # explicit wins
        self.assertEqual(read(self.log)[0]["status"], "done")

    def test_update_with_kind_rechecks_the_new_count_against_the_cap(self):
        self.add("a", 100)
        code, _, _ = self.t("update", "--master", "m1", "--list-id", "a", "--count", "1200", "--kind", "account")
        self.assertEqual((code, read(self.log)[0]["count"]), (5, "100"))
        self.assertEqual(self.t("update", "--master", "m1", "--list-id", "a", "--count", "1200", "--kind", "lead")[0], 0)
        self.assertEqual(self.t("update", "--master", "m1", "--list-id", "a", "--kind", "lead")[0], 1)

    def test_bad_count_is_exit_1(self):
        self.assertEqual(self.add("a", "many")[0], 1)
        self.assertEqual(self.add("a", -3)[0], 1)

    def test_commas_and_quotes_round_trip(self):
        self.add("a", 5, delta='metro="Dallas, TX"; band=C')
        self.assertEqual(read(self.log)[0]["filters_delta"], 'metro="Dallas, TX"; band=C')

    def test_pulled_sets_partial_then_done_and_stamps_the_date(self):
        self.add("a", 100, "m1", "state=X", "--file", "results/a.csv")
        code, out, _ = self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "25")
        self.assertEqual(code, 0, out)
        row = read(self.log)[0]
        self.assertEqual((row["pulled"], row["status"], row["last_pulled"], row["file"]),
                         ("25", "partial", TODAY, "results/a.csv"))
        self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "100", "--date", "2026-01-02")
        row = read(self.log)[0]
        self.assertEqual((row["status"], row["last_pulled"]), ("done", "2026-01-02"))

    def test_explicit_status_wins_and_count_and_file_can_change(self):
        self.add("a", 100)
        self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "100", "--status", "partial", "--count", "120",
               "--file", "results/b.csv")
        row = read(self.log)[0]
        self.assertEqual((row["status"], row["count"], row["file"]), ("partial", "120", "results/b.csv"))

    def test_unknown_id_is_exit_3_and_bad_date_or_status_is_refused(self):
        self.add("a", 10)
        self.assertEqual(self.t("update", "--master", "m1", "--list-id", "zzz", "--pulled", "1")[0], 3)
        self.assertEqual(self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "1", "--date", "01/02/2026")[0], 1)
        self.assertEqual(self.t("update", "--master", "m1", "--list-id", "a", "--status", "finished")[0], 2)  # argparse error
        self.assertEqual(read(self.log)[0]["pulled"], "0")

    def test_no_temp_files_are_left_beside_the_tracker(self):
        self.add("a", 10)
        self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "5")
        self.assertEqual(sorted(p.name for p in self.ws.iterdir()), ["tam_tracker.csv"])


class StatusAndNext(TrackerCase):
    def test_status_reports_counts_and_coverage(self):
        self.add("a", 100)
        self.add("b", 300)
        self.add("c", 600, "m2")
        self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "100")
        self.t("update", "--master", "m1", "--list-id", "b", "--pulled", "100")
        code, out, _ = self.t("status")
        self.assertEqual(code, 0)
        self.assertIn("lists: 3 (new 1, partial 1, done 1)", out)
        self.assertIn("pulled 200 of 1000 counted (20%)", out)
        self.assertIn("dedupe.py", out)
        self.assertIn("partial  b", out)
        self.assertNotIn("done     a", out)

    def test_status_can_be_limited_to_one_master(self):
        self.add("a", 100, "m1")
        self.add("c", 600, "m2")
        out = self.t("status", "--master", "m2")[1]
        self.assertIn("lists: 1", out)
        self.assertIn("pulled 0 of 600", out)
        self.assertIn("no lists tracked", self.t("status", "--master", "nope")[1])

    def test_next_prefers_the_oldest_partial_then_the_first_new(self):
        self.add("a", 100)
        self.add("b", 100)
        self.add("c", 100)
        self.assertIn("next: a (new", self.t("next")[1])
        self.t("update", "--master", "m1", "--list-id", "c", "--pulled", "10", "--date", "2026-02-01")
        self.t("update", "--master", "m1", "--list-id", "b", "--pulled", "10", "--date", "2026-01-01")
        self.assertIn("next: b (partial", self.t("next")[1])
        self.t("update", "--master", "m1", "--list-id", "b", "--pulled", "100")
        self.t("update", "--master", "m1", "--list-id", "c", "--pulled", "100")
        self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "100")
        code, out, _ = self.t("next")
        self.assertEqual(code, 0)
        self.assertIn("next: none", out)
        self.assertIn("all lists done", self.t("status")[1])

    def test_next_shows_the_file_when_there_is_one(self):
        self.add("a", 100, "m1", "state=X", "--file", "results/a.csv")
        self.assertIn("file: results/a.csv", self.t("next")[1])


class DamagedFilesAndLocking(TrackerCase):
    HEADER = ",".join(tam_tracker.COLUMNS) + "\n"

    def test_foreign_rows_are_a_clean_error_not_a_traceback(self):
        bad_rows = {
            "non-numeric count": "a,m1,x,lots,0,new,,\n",
            "negative pulled": "a,m1,x,5,-1,new,,\n",
            "short row": "a,m1,x,5\n",
            "long row": "a,m1,x,5,0,new,,,extra\n",
            "unknown status": "a,m1,x,5,0,finished,,\n",
            "empty list_id": ",m1,x,5,0,new,,\n",
            "duplicate key": "a,m1,x,5,0,new,,\na,m1,y,5,0,new,,\n",
        }
        for label, body in bad_rows.items():
            with self.subTest(label):
                self.log.write_text(self.HEADER + body, encoding="utf-8")
                for cmd in (("status",), ("next",), ("update", "--master", "m1", "--list-id", "a", "--pulled", "1"),
                            ("update", "--master", "m1", "--list-id", "a", "--count", "9")):
                    code, _, err = self.t(*cmd)
                    self.assertEqual(code, 1, (cmd, err))
                    self.assertNotIn("Traceback", err)
                self.assertEqual(self.log.read_text(encoding="utf-8"), self.HEADER + body)   # nothing rewritten

    def test_a_thousands_separator_is_read_and_normalised(self):
        self.log.write_text(self.HEADER + 'a,m1,x,"1,000",0,new,,\n', encoding="utf-8")
        self.assertIn("pulled 0 of 1000", self.t("status")[1])

    def test_a_zero_byte_tracker_is_an_empty_tracker(self):
        self.log.write_text("", encoding="utf-8")
        self.assertIn("no lists tracked", self.t("status")[1])
        self.assertEqual(self.add("a", 5)[0], 0)
        self.assertEqual(len(read(self.log)), 1)

    def test_the_lock_serialises_concurrent_writers_and_leaves_nothing_behind(self):
        import threading
        self.add("seed", 1)
        results = []

        def cli(n):
            results.append(tam_tracker.main(["add", "--workspace", str(self.ws), "--list-id", "w%d" % n,
                                             "--master", "m1", "--filters-delta", "x", "--count", "5",
                                             "--kind", "account"]))

        with contextlib.redirect_stdout(io.StringIO()):
            threads = [threading.Thread(target=cli, args=(n,)) for n in range(12)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(sorted(results), [0] * 12)
        self.assertEqual(len(read(self.log)), 13)   # no lost update
        self.assertEqual(sorted(p.name for p in self.ws.iterdir()), ["tam_tracker.csv"])

    def test_a_held_lock_is_refused_cleanly_and_a_stale_one_is_cleared(self):
        self.add("a", 5)
        lock = Path(str(self.log) + ".lock")
        lock.write_text("123")
        with mock.patch.object(tam_tracker, "LOCK_WAIT_SECONDS", 0.2):
            code, _, err = self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "1")
        self.assertEqual(code, 1)
        self.assertIn("held by another task", err)
        self.assertEqual(read(self.log)[0]["pulled"], "0")
        old = lock.stat().st_mtime - tam_tracker.LOCK_STALE_SECONDS - 5
        os.utime(lock, (old, old))
        self.assertEqual(self.t("update", "--master", "m1", "--list-id", "a", "--pulled", "1")[0], 0)
        self.assertFalse(lock.exists())


class WorkspaceGate(TrackerCase):
    def test_missing_tracker_is_exit_4_except_for_add(self):
        for cmd in (("status",), ("next",), ("update", "--master", "m1", "--list-id", "a", "--pulled", "1")):
            with self.subTest(cmd=cmd):
                code, _, err = self.t(*cmd)
                self.assertEqual(code, 4)
                self.assertIn("no tracker", err)
        self.assertFalse(self.log.exists())

    def test_no_workspace_located_is_exit_4(self):
        nowhere = Path(self.tmp.name) / "no-such-home" / "Claude" / "sales-navigator"
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(workspace, "default_dir",
                                                                           lambda home=None: nowhere):
            os.environ.pop(workspace.ENV_VAR, None)
            code, _, err = run(["status"])
        self.assertEqual(code, 4)
        self.assertIn("could not be located", err)

    def test_log_flag_overrides_the_workspace(self):
        path = self.ws / "elsewhere.csv"
        code, _, _ = run(["add", "--log", str(path), "--list-id", "a", "--master", "m", "--filters-delta", "x",
                          "--count", "5", "--kind", "lead"])
        self.assertEqual(code, 0)
        self.assertTrue(path.is_file())
        self.assertFalse(self.log.exists())

    def test_a_foreign_header_is_refused_not_overwritten(self):
        self.log.write_text("a,b,c\n1,2,3\n", encoding="utf-8")
        code, _, err = self.add("a", 5)
        self.assertEqual(code, 1)
        self.assertIn("header", err)
        self.assertEqual(self.log.read_text(encoding="utf-8"), "a,b,c\n1,2,3\n")


if __name__ == "__main__":
    unittest.main()
