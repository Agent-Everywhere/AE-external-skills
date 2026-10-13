"""Tests for skills/sales-navigator/scripts/outreach_log.py (stdlib unittest, no network).

Run from the repo root:  python3 -m pytest -q tests
"""
import contextlib
import csv
import io
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "sales-navigator"
SCRIPT = SKILL / "scripts" / "outreach_log.py"
sys.path.insert(0, str(SKILL / "scripts"))

import outreach_log  # noqa: E402

ID1 = "ACwAAAexample1"
ID2 = "ACwAAAexample2"
URN = "urn:li:fs_salesProfile:(%s,NAME_SEARCH,abcd)" % ID1
URL = "https://www.linkedin.com/sales/lead/%s,NAME_SEARCH,abcd?_ntb=x" % ID1


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = outreach_log.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


class LogCase(unittest.TestCase):
    """A temp ledger plus small helpers; the tests live in the subclasses."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = str(Path(self.tmp.name) / "outreach_log.csv")
        # an existing ledger (header only): a missing ledger is refused, see LedgerGate
        Path(self.log).write_text(",".join(outreach_log.COLUMNS) + "\n", encoding="utf-8")

    def cli(self, *argv):
        args = list(argv)
        # add / followup refuse a --date more than 2 days old; these tests replay a fixed calendar, so
        # run each of them "on" its own date (the hidden --today)
        if args[0] in ("add", "followup") and "--date" in args and "--today" not in args:
            args += ["--today", args[args.index("--date") + 1]]
        return run([args[0], "--log", self.log] + args[1:])

    def rows(self):
        with open(self.log, newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def add(self, lead=ID1, kind="connection", msg="Hi there", day="2026-10-12", *extra):
        return self.cli("add", "--lead-id", lead, "--kind", kind, "--message", msg, "--date", day, *extra)


class OutreachLogTests(LogCase):

    # --- keys and hashes
    def test_lead_key_accepts_id_url_and_urn(self):
        for value in (ID1, URN, URL, "  " + ID1 + " "):
            self.assertEqual(outreach_log.lead_key(value), ID1, value)
        for bad in ("", "x", "not an id", "https://example.com/"):
            with self.subTest(bad=bad), self.assertRaises(outreach_log.LogError):
                outreach_log.lead_key(bad)

    def test_message_hash_ignores_whitespace_and_never_stores_text(self):
        self.assertEqual(outreach_log.message_hash("Hi  there\n"), outreach_log.message_hash(" Hi there"))
        self.assertNotEqual(outreach_log.message_hash("Hi there"), outreach_log.message_hash("Hi there!"))
        self.assertRegex(outreach_log.message_hash("x"), r"^[0-9a-f]{12}$")
        self.add(msg="A very private sentence")
        self.assertNotIn("private", Path(self.log).read_text())

    # --- add and check
    def test_add_then_check_exits_nonzero_for_a_contacted_person(self):
        self.assertEqual(self.cli("check", "--lead-id", ID1)[0], 0)  # no file yet: clear
        self.assertEqual(self.add()[0], 0)
        code, out, _ = self.cli("check", "--lead-id", ID1)
        self.assertEqual(code, outreach_log.EXIT_CONTACTED)
        self.assertIn("CONTACTED " + ID1, out)
        self.assertEqual(self.cli("check", "--lead-id", ID2)[0], 0)
        # URL and urn forms resolve to the same person
        self.assertEqual(self.cli("check", "--lead-id", URL)[0], 3)
        self.assertEqual(self.cli("check", "--lead-id", URN)[0], 3)

    def test_check_flags_any_contacted_among_several_and_reads_ids_file(self):
        self.add()
        self.assertEqual(self.cli("check", "--lead-id", ID2, "--lead-id", ID1)[0], 3)
        ids = Path(self.tmp.name) / "ids.txt"
        ids.write_text("# batch\n%s\n%s  # second\n" % (ID2, "ACwAAAexample3"))
        self.assertEqual(self.cli("check", "--ids-file", str(ids))[0], 0)
        ids.write_text(ID2 + "\n" + URL + "\n")
        self.assertEqual(self.cli("check", "--ids-file", str(ids))[0], 3)

    def test_add_refuses_a_second_first_message_to_the_same_person(self):
        self.assertEqual(self.add()[0], 0)
        code, _, err = self.add(msg="Another note")
        self.assertEqual(code, outreach_log.EXIT_CONTACTED)
        self.assertIn("already in the log", err)
        self.assertEqual(len(self.rows()), 1)

    def test_check_needs_an_id_and_bad_input_is_exit_1(self):
        self.assertEqual(self.cli("check")[0], 1)
        self.assertEqual(self.cli("check", "--lead-id", "bad id")[0], 1)
        self.assertEqual(self.add(msg="  ")[0], 1)
        self.assertEqual(self.add(day="12/10/2026")[0], 1)

    # --- status transitions
    def test_status_updates_the_current_state_and_enforces_order(self):
        self.add(day="2026-10-01")
        self.assertEqual(self.cli("status", "--lead-id", ID1, "--status", "accepted", "--date", "2026-10-03")[0], 0)
        last = self.rows()[-1]
        self.assertEqual((last["status"], last["sent_at"], last["status_at"], last["touches"]),
                         ("accepted", "2026-10-01", "2026-10-03", "1"))
        self.assertEqual(self.cli("status", "--lead-id", ID1, "--status", "replied", "--date", "2026-10-04")[0], 0)
        # replied is final
        code, _, err = self.cli("status", "--lead-id", ID1, "--status", "withdrawn")
        self.assertEqual(code, 1)
        self.assertIn("already replied", err)
        # still counts as contacted
        self.assertEqual(self.cli("check", "--lead-id", ID1)[0], 3)

    def test_status_needs_a_prior_send_and_a_sane_date(self):
        code, _, err = self.cli("status", "--lead-id", ID1, "--status", "accepted")
        self.assertEqual(code, 1)
        self.assertIn("not in the log", err)
        self.add(day="2026-10-05")
        self.assertEqual(self.cli("status", "--lead-id", ID1, "--status", "accepted", "--date", "2026-10-01")[0], 1)
        self.assertEqual(self.cli("status", "--lead-id", ID1, "--status", "bogus")[0], 2)  # argparse choice error

    def test_withdrawn_person_is_still_never_recontacted(self):
        self.add()
        self.cli("status", "--lead-id", ID1, "--status", "withdrawn")
        self.assertEqual(self.add(msg="again")[0], 3)

    # --- follow-ups
    def test_followup_counts_touches_restarts_the_clock_and_stops_at_the_max(self):
        self.add(day="2026-10-01")
        self.cli("status", "--lead-id", ID1, "--status", "accepted", "--date", "2026-10-02")
        for n, day in ((2, "2026-10-05"), (3, "2026-10-09")):
            code, out, _ = self.cli("followup", "--lead-id", ID1, "--message", "Following up %d" % n, "--date", day)
            self.assertEqual(code, 0, out)
            self.assertEqual((self.rows()[-1]["status"], self.rows()[-1]["touches"]), ("accepted", str(n)))
        code, _, err = self.cli("followup", "--lead-id", ID1, "--message", "Once more", "--date", "2026-10-12")
        self.assertEqual(code, 1)
        self.assertIn("maximum 3", err)

    def test_followup_only_for_accepted_people(self):
        self.add()
        code, _, err = self.cli("followup", "--lead-id", ID1, "--message", "x")
        self.assertEqual(code, 1)
        self.assertIn("only logged for someone who accepted", err)
        self.assertEqual(self.cli("followup", "--lead-id", ID2, "--message", "x")[0], 1)

    # --- caps
    def test_caps_report_today_and_rolling_week_and_exit_2_at_a_cap(self):
        today = "2026-10-12"
        for i in range(19):
            self.add(lead="ACwAAAperson%02d" % i, day=today)
        code, out, _ = self.cli("caps", "--date", today)
        self.assertEqual(code, 0, out)
        self.assertIn("19 / 20", out)
        self.assertIn("NEAR", out)
        self.add(lead="ACwAAAperson19", day=today)
        code, out, _ = self.cli("caps", "--date", today)
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertIn("CAP REACHED", out)
        self.assertIn("can still send today: 0", out)

    def test_caps_week_window_is_rolling_seven_days_and_ignores_status_rows(self):
        for i, day in enumerate(["2026-10-05", "2026-10-06", "2026-10-06", "2026-10-12"]):
            self.add(lead="ACwAAAperson%02d" % i, day=day)
        self.cli("status", "--lead-id", "ACwAAAperson00", "--status", "accepted", "--date", "2026-10-12")
        code, out, _ = self.cli("caps", "--date", "2026-10-12")
        self.assertEqual(code, 0)
        self.assertRegex(out, r"today\s+1 / 20")
        self.assertRegex(out, r"last 7 d\s+3 / 100")  # 10-05 is outside the window (10-06..10-12)
        # a sent row from the future or another kind is not a connection request
        self.add(lead="ACwAAAinmail01", kind="inmail", day="2026-10-12")
        _, out, _ = self.cli("caps", "--date", "2026-10-12")
        self.assertRegex(out, r"today\s+1 / 20")
        self.assertIn("InMails sent: 1 today", out)

    def test_weekly_cap_stops_even_when_today_is_clear(self):
        for i in range(100):
            self.add(lead="ACwAAAperson%03d" % i, day="2026-10-%02d" % (6 + i % 6))
        code, out, _ = self.cli("caps", "--date", "2026-10-12")
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertIn("100 / 100", out)

    def test_caps_limits_can_be_lowered_and_raising_is_flagged(self):
        self.add(day="2026-10-12")
        self.assertEqual(self.cli("caps", "--date", "2026-10-12", "--daily", "1")[0], 2)
        code, out, _ = self.cli("caps", "--date", "2026-10-12", "--daily", "50")
        self.assertEqual(code, 0)
        self.assertIn("explicit go", out)
        self.assertRegex(out, r"today\s+1 / 20")  # the raised limit was ignored
        _, out, _ = self.cli("caps", "--date", "2026-10-12", "--daily", "50", "--allow-over-cap")
        self.assertRegex(out, r"today\s+1 / 50")
        self.assertEqual(self.cli("caps", "--daily", "-1")[0], 1)

    def test_followup_cap_and_scope(self):
        self.add(day="2026-10-01")
        self.cli("status", "--lead-id", ID1, "--status", "accepted", "--date", "2026-10-02")
        self.cli("followup", "--lead-id", ID1, "--message", "x", "--date", "2026-10-12")
        code, out, _ = self.cli("caps", "--date", "2026-10-12", "--followup-daily", "1")
        self.assertEqual(code, 2)
        self.assertRegex(out, r"today\s+1 / 1")
        self.assertEqual(self.cli("caps", "--date", "2026-10-12", "--followup-daily", "1", "--for", "connection")[0], 0)

    def test_caps_with_no_log_is_clear(self):
        code, out, _ = self.cli("caps")
        self.assertEqual(code, 0)
        self.assertIn("0 / 20", out)

    # --- summary
    def test_summary_lists_accepted_no_reply_after_n_days(self):
        self.add(lead=ID1, day="2026-10-01")
        self.add(lead=ID2, day="2026-10-01")
        self.add(lead="ACwAAAexample3", kind="inmail", day="2026-10-01")
        self.cli("status", "--lead-id", ID1, "--status", "accepted", "--date", "2026-10-02")
        self.cli("status", "--lead-id", ID2, "--status", "accepted", "--date", "2026-10-10")
        self.cli("status", "--lead-id", "ACwAAAexample3", "--status", "replied", "--date", "2026-10-02")
        code, out, _ = self.cli("summary", "--stale-days", "3", "--today", "2026-10-12")
        self.assertEqual(code, 0)
        self.assertIn("3 people in the log", out)
        self.assertIn(ID1, out)
        self.assertNotIn(ID2, out)  # accepted only 2 days ago
        self.assertNotIn("ACwAAAexample3", out)  # replied
        self.assertIn("connection", out)

    def test_summary_leaves_out_people_at_max_touches(self):
        self.add(day="2026-10-01")
        self.cli("status", "--lead-id", ID1, "--status", "accepted", "--date", "2026-10-02")
        self.cli("followup", "--lead-id", ID1, "--message", "a", "--date", "2026-10-03")
        self.cli("followup", "--lead-id", ID1, "--message", "b", "--date", "2026-10-04")
        _, out, _ = self.cli("summary", "--stale-days", "1", "--today", "2026-10-12")
        self.assertNotIn(ID1 + " (", out)
        # raising the maximum is ignored (with a note) unless --allow-over-cap is given
        code, out, err = self.cli("summary", "--stale-days", "1", "--today", "2026-10-12", "--max-touches", "4")
        self.assertNotIn(ID1 + " (", out)
        self.assertIn("--allow-over-cap", err)
        _, out, _ = self.cli("summary", "--stale-days", "1", "--today", "2026-10-12", "--max-touches", "4",
                             "--allow-over-cap")
        self.assertIn(ID1 + " (", out)

    # --- file handling
    def test_header_and_corrupt_files_are_rejected_not_overwritten(self):
        Path(self.log).write_text("lead_id,status\nx,sent\n")
        before = Path(self.log).read_text()
        self.assertEqual(self.add()[0], 1)
        self.assertEqual(Path(self.log).read_text(), before)
        Path(self.log).write_text(",".join(outreach_log.COLUMNS) + "\n" + "ACwAAAbad1,connection,sent,notadate,2026-10-01,1,h,\n")
        self.assertEqual(self.cli("caps")[0], 1)

    def test_it_is_a_stdlib_script_with_help(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("usage:", proc.stdout)
        for sub in ("check", "add", "status", "followup", "caps", "summary"):
            proc = subprocess.run([sys.executable, str(SCRIPT), sub, "--help"], capture_output=True, text=True, timeout=30)
            self.assertEqual(proc.returncode, 0, sub + proc.stderr)
        src = SCRIPT.read_text()
        for banned in ("import requests", "urllib.request", "import socket", "http.client"):
            self.assertNotIn(banned, src)


class AddAndFollowupEnforceCaps(LogCase):
    TODAY = "2026-10-12"

    def fill(self, n, day=None, kind="connection", prefix="ACwAAAfill"):
        for i in range(n):
            code = self.add(lead="%s%03d" % (prefix, i), kind=kind, day=day or self.TODAY)[0]
            self.assertEqual(code, 0, i)

    def test_add_stops_at_the_daily_cap_with_exit_2_and_the_same_count_as_caps(self):
        self.fill(20)
        code, out, _ = self.cli("caps", "--date", self.TODAY)
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertRegex(out, r"today\s+20 / 20")
        code, _, err = self.add(lead="ACwAAAover01")
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertIn("daily connection cap", err)
        self.assertEqual(len(self.rows()), 20)  # nothing was written

    def test_add_stops_at_the_seven_day_cap_even_when_today_is_clear(self):
        with open(self.log, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=outreach_log.COLUMNS, lineterminator="\n")
            w.writeheader()
            for i in range(100):
                day = "2026-10-%02d" % (6 + i % 6)  # 10-06 .. 10-11: inside the window, none today
                w.writerow({"lead_id": "ACwAAAweek%03d" % i, "kind": "connection", "status": "sent",
                            "sent_at": day, "status_at": day, "touches": 1, "message_hash": "h", "note": ""})
        code, out, _ = self.cli("caps", "--date", self.TODAY)
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertRegex(out, r"last 7 d\s+100 / 100")
        self.assertRegex(out, r"today\s+0 / 20")
        code, _, err = self.add(lead="ACwAAAover02")
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertIn("7-day", err)

    def test_allow_over_cap_is_the_only_way_past_a_reached_cap(self):
        self.fill(20)
        code, _, _ = self.cli("add", "--lead-id", "ACwAAAover03", "--kind", "connection", "--message", "x",
                              "--date", self.TODAY, "--allow-over-cap")
        self.assertEqual(code, 0)
        self.assertEqual(len(self.rows()), 21)

    def test_inmails_are_not_capped_by_the_connection_caps(self):
        self.fill(20)
        self.assertEqual(self.add(lead="ACwAAAinmail9", kind="inmail")[0], 0)

    def test_lowering_a_limit_is_enforced_and_raising_it_is_ignored(self):
        self.assertEqual(self.cli("add", "--lead-id", "ACwAAAlow001", "--kind", "connection", "--message", "a",
                                  "--date", self.TODAY, "--daily", "1")[0], 0)
        code, _, _ = self.cli("add", "--lead-id", "ACwAAAlow002", "--kind", "connection", "--message", "b",
                              "--date", self.TODAY, "--daily", "1")
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.fill(19, prefix="ACwAAAraise")  # 20 today
        code, _, err = self.cli("add", "--lead-id", "ACwAAAlow003", "--kind", "connection", "--message", "c",
                                "--date", self.TODAY, "--daily", "50")
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertIn("--allow-over-cap", err)

    def accepted_people(self, n, prefix="ACwAAAfup"):
        for i in range(n):
            lead = "%s%03d" % (prefix, i)
            self.add(lead=lead, day="2026-10-09" if i % 2 else "2026-10-10")  # two days: under the daily cap
            self.cli("status", "--lead-id", lead, "--status", "accepted", "--date", "2026-10-10")

    def test_followup_stops_at_the_daily_follow_up_cap_with_the_same_count_as_caps(self):
        self.accepted_people(21)
        for i in range(20):
            self.assertEqual(self.cli("followup", "--lead-id", "ACwAAAfup%03d" % i, "--message", "f",
                                      "--date", self.TODAY)[0], 0)
        code, out, _ = self.cli("caps", "--date", self.TODAY, "--for", "followup")
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertRegex(out, r"Follow-up messages\s+today\s+20 / 20")
        code, _, err = self.cli("followup", "--lead-id", "ACwAAAfup020", "--message", "f", "--date", self.TODAY)
        self.assertEqual(code, outreach_log.EXIT_CAP)
        self.assertIn("follow-up cap", err)
        self.assertEqual(self.rows()[-1]["lead_id"], "ACwAAAfup019")
        code, _, _ = self.cli("followup", "--lead-id", "ACwAAAfup020", "--message", "f", "--date", self.TODAY,
                              "--allow-over-cap")
        self.assertEqual(code, 0)

    def test_caps_scope_follows_the_kind_of_batch(self):
        self.fill(20)
        self.assertEqual(self.cli("caps", "--date", self.TODAY, "--for", "connection")[0], outreach_log.EXIT_CAP)
        self.assertEqual(self.cli("caps", "--date", self.TODAY, "--for", "followup")[0], 0)
        self.assertEqual(self.cli("caps", "--date", self.TODAY, "--for", "all")[0], outreach_log.EXIT_CAP)

    def test_max_touches_is_clamped_unless_allowed(self):
        self.accepted_people(1)
        for day in ("2026-10-10", "2026-10-11"):
            self.assertEqual(self.cli("followup", "--lead-id", "ACwAAAfup000", "--message", "f" + day,
                                      "--date", day)[0], 0)
        code, _, err = self.cli("followup", "--lead-id", "ACwAAAfup000", "--message", "again",
                                "--date", self.TODAY, "--max-touches", "9")
        self.assertEqual(code, 1)
        self.assertIn("maximum 3", err)
        self.assertIn("--allow-over-cap", err)
        code, _, _ = self.cli("followup", "--lead-id", "ACwAAAfup000", "--message", "again", "--date", self.TODAY,
                              "--max-touches", "9", "--allow-over-cap")
        self.assertEqual(code, 0)
        self.assertEqual(self.rows()[-1]["touches"], "4")
        # lowering is always fine
        self.accepted_people(1, prefix="ACwAAAlow")
        self.assertEqual(self.cli("followup", "--lead-id", "ACwAAAlow000", "--message", "a", "--date", self.TODAY)[0], 0)
        code, _, _ = self.cli("followup", "--lead-id", "ACwAAAlow000", "--message", "b", "--date", self.TODAY,
                              "--max-touches", "2")
        self.assertEqual(code, 1)


class DateWindow(LogCase):
    TODAY = "2026-10-12"

    def attempt(self, date_value, command="add", lead=ID1):
        if command == "add":
            return self.cli("add", "--lead-id", lead, "--kind", "connection", "--message", "x",
                            "--date", date_value, "--today", self.TODAY)
        return self.cli("followup", "--lead-id", lead, "--message", "x", "--date", date_value, "--today", self.TODAY)

    def test_add_rejects_future_dates_and_dates_more_than_two_days_back(self):
        for bad in ("2026-10-13", "2027-01-01", "2026-10-09", "2025-10-12"):
            with self.subTest(date=bad):
                code, _, err = self.attempt(bad)
                self.assertEqual(code, 1)
                self.assertTrue("future" in err or "days in the past" in err, err)
        self.assertEqual(self.rows(), [])
        for good, lead in (("2026-10-12", ID1), ("2026-10-11", ID2), ("2026-10-10", "ACwAAAexample3")):
            with self.subTest(date=good):
                self.assertEqual(self.attempt(good, lead=lead)[0], 0)

    def test_followup_rejects_future_and_old_dates_too(self):
        self.add(day="2026-10-05")
        self.cli("status", "--lead-id", ID1, "--status", "accepted", "--date", "2026-10-06")
        for bad in ("2026-10-13", "2026-10-09"):
            with self.subTest(date=bad):
                self.assertEqual(self.attempt(bad, "followup")[0], 1)
        self.assertEqual(self.attempt("2026-10-11", "followup")[0], 0)

    def test_without_the_test_hook_the_real_calendar_applies(self):
        code, _, err = run(["add", "--log", self.log, "--lead-id", ID1, "--kind", "connection", "--message", "x",
                            "--date", "2020-01-01"])
        self.assertEqual(code, 1)
        self.assertIn("days in the past", err)


class PendingIntent(LogCase):
    TODAY = "2026-10-12"

    def pending(self, lead=ID1, day=None, kind="connection"):
        return self.cli("add", "--lead-id", lead, "--kind", kind, "--message", "Hello", "--date", day or self.TODAY,
                        "--pending")

    def test_pending_is_written_before_the_send_and_counts_as_contacted(self):
        code, out, _ = self.pending()
        self.assertEqual(code, 0)
        self.assertIn("PENDING", out)
        row = self.rows()[-1]
        self.assertEqual((row["status"], row["touches"], row["sent_at"]), ("pending", "0", self.TODAY))
        code, out, _ = self.cli("check", "--lead-id", ID1)
        self.assertEqual(code, outreach_log.EXIT_CONTACTED)
        self.assertIn("pending", out)
        self.assertIn("rule 8", out)  # the check points at the pending-invite look
        self.assertEqual(self.add(msg="again")[0], outreach_log.EXIT_CONTACTED)
        self.assertEqual(self.pending()[0], outreach_log.EXIT_CONTACTED)

    def test_status_sent_confirms_it_once_and_the_caps_count_it_once(self):
        self.pending()
        _, out, _ = self.cli("caps", "--date", self.TODAY)
        self.assertRegex(out, r"today\s+1 / 20")  # the intent already counts
        self.assertEqual(self.cli("status", "--lead-id", ID1, "--status", "sent", "--date", self.TODAY)[0], 0)
        row = self.rows()[-1]
        self.assertEqual((row["status"], row["touches"], row["sent_at"]), ("sent", "1", self.TODAY))
        self.assertTrue(row["message_hash"])
        _, out, _ = self.cli("caps", "--date", self.TODAY)
        self.assertRegex(out, r"today\s+1 / 20")  # not 2
        self.assertEqual(self.cli("status", "--lead-id", ID1, "--status", "accepted", "--date", self.TODAY)[0], 0)

    def test_pending_rows_count_toward_the_cap(self):
        for i in range(20):
            self.assertEqual(self.pending(lead="ACwAAApend%03d" % i)[0], 0)
        self.assertEqual(self.pending(lead="ACwAAApend999")[0], outreach_log.EXIT_CAP)

    def test_a_pending_row_cannot_skip_to_accepted_or_be_followed_up(self):
        self.pending()
        code, _, err = self.cli("status", "--lead-id", ID1, "--status", "accepted")
        self.assertEqual(code, 1)
        self.assertIn("already pending", err)
        code, _, _ = self.cli("followup", "--lead-id", ID1, "--message", "x", "--date", self.TODAY)
        self.assertEqual(code, 1)

    def test_withdrawing_a_pending_row_means_never_sent_frees_the_cap_but_blocks_a_resend(self):
        self.pending()
        self.assertEqual(self.cli("status", "--lead-id", ID1, "--status", "withdrawn", "--date", self.TODAY,
                                  "--note", "not sent")[0], 0)
        self.assertEqual(self.rows()[-1]["touches"], "0")
        _, out, _ = self.cli("caps", "--date", self.TODAY)
        self.assertRegex(out, r"today\s+0 / 20")
        self.assertEqual(self.add(msg="again")[0], outreach_log.EXIT_CONTACTED)

    def test_summary_lists_pending_rows(self):
        self.pending()
        self.pending(lead=ID2)
        self.cli("status", "--lead-id", ID2, "--status", "sent", "--date", self.TODAY)
        _, out, _ = self.cli("summary", "--today", self.TODAY)
        listing = out.split("pending (send intended", 1)[1]
        self.assertIn(ID1, listing)
        self.assertNotIn(ID2, listing)

    def test_touches_zero_is_only_valid_for_pending_or_withdrawn_rows(self):
        header = ",".join(outreach_log.COLUMNS) + "\n"
        Path(self.log).write_text(header + "ACwAAAzero01,connection,sent,2026-10-12,2026-10-12,0,h,\n")
        self.assertEqual(self.cli("caps")[0], 1)
        Path(self.log).write_text(header + "ACwAAAzero01,connection,pending,2026-10-12,2026-10-12,0,h,\n")
        self.assertEqual(self.cli("caps", "--date", self.TODAY)[0], 0)


class FileLock(LogCase):
    TODAY = "2026-10-12"

    def spawn(self, *args):
        return subprocess.Popen([sys.executable, str(SCRIPT), args[0], "--log", self.log] + list(args[1:]),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def add_args(self, lead, *extra):
        return ["add", "--lead-id", lead, "--kind", "connection", "--message", "m" + lead, "--date", self.TODAY,
                "--today", self.TODAY] + list(extra)

    @staticmethod
    def finish(procs):
        codes = []
        for proc in procs:
            proc.communicate(timeout=60)
            codes.append(proc.returncode)
        return sorted(codes)

    def test_a_writer_waits_while_another_run_holds_the_lock(self):
        with outreach_log.locked(self.log):
            proc = self.spawn(*self.add_args(ID1))
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait(timeout=1.0)
            self.assertEqual(self.rows(), [])  # blocked before writing anything
        self.assertEqual(self.finish([proc]), [0])
        self.assertEqual(len(self.rows()), 1)

    def test_concurrent_adds_of_the_same_person_log_exactly_one(self):
        codes = self.finish([self.spawn(*self.add_args(ID1)) for _ in range(6)])
        self.assertEqual(codes, [0, 3, 3, 3, 3, 3])
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(Path(self.log).read_text().count("lead_id,kind"), 1)

    def test_concurrent_adds_cannot_slip_past_a_cap(self):
        codes = self.finish([self.spawn(*self.add_args("ACwAAAconc%03d" % i, "--daily", "3")) for i in range(8)])
        self.assertEqual(codes, [0, 0, 0, 2, 2, 2, 2, 2])
        self.assertEqual(len(self.rows()), 3)
        self.assertEqual(Path(self.log).read_text().count("lead_id,kind"), 1)

    def test_status_takes_the_lock_too(self):
        self.add(day=self.TODAY)
        with outreach_log.locked(self.log):
            proc = self.spawn("status", "--lead-id", ID1, "--status", "accepted", "--date", self.TODAY)
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait(timeout=1.0)
        self.assertEqual(self.finish([proc]), [0])
        self.assertEqual(self.rows()[-1]["status"], "accepted")


class CapsMatchGuardrails(unittest.TestCase):
    def test_constants_match_reference_md(self):
        md = (SKILL / "reference.md").read_text(encoding="utf-8")
        section = md.split("### Outreach caps and stop rules", 1)[1].split("\n#", 1)[0]
        rows = {}
        for line in section.splitlines():
            if line.startswith("|") and not re.match(r"\|[-| ]+\|$", line.strip()):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                rows[cells[0]] = cells[1]
        num = lambda label: int(re.match(r"\d+", rows[label]).group())  # noqa: E731
        self.assertEqual(num("Connection requests per day"), outreach_log.DAILY_CONNECTION_CAP)
        self.assertEqual(num("Connection requests per 7 days"), outreach_log.WEEKLY_CONNECTION_CAP)
        self.assertEqual(num("Follow-up messages per day"), outreach_log.DAILY_FOLLOWUP_CAP)
        self.assertEqual(num("Messages to one person (first plus follow-ups)"), outreach_log.MAX_TOUCHES)


if __name__ == "__main__":
    unittest.main()
