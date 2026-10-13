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


class OutreachLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = str(Path(self.tmp.name) / "outreach_log.csv")

    def cli(self, *argv):
        return run([argv[0], "--log", self.log] + list(argv[1:]))

    def rows(self):
        with open(self.log, newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def add(self, lead=ID1, kind="connection", msg="Hi there", day="2026-10-12"):
        return self.cli("add", "--lead-id", lead, "--kind", kind, "--message", msg, "--date", day)

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
        self.assertEqual(self.cli("status", "--lead-id", ID1, "--status", "sent")[0], 2)  # argparse choice error

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
        _, out, _ = self.cli("summary", "--stale-days", "1", "--today", "2026-10-12", "--max-touches", "4")
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


class CapsMatchGuardrails(unittest.TestCase):
    def test_constants_match_guardrails_md(self):
        md = (SKILL / "references" / "guardrails.md").read_text(encoding="utf-8")
        section = md.split("## Outreach caps and stop rules", 1)[1]
        rows = {}
        for line in section.splitlines():
            if line.startswith("|") and not re.match(r"\|[-| ]+\|$", line.strip()):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                rows[cells[0]] = cells[1]
        num = lambda label: int(re.match(r"\d+", rows[label]).group())  # noqa: E731
        self.assertEqual(num("Connection requests per day"), outreach_log.DAILY_CONNECTION_CAP)
        self.assertEqual(num("Connection requests per 7 days"), outreach_log.WEEKLY_CONNECTION_CAP)
        self.assertEqual(num("Follow-up messages to people who accepted, per day"), outreach_log.DAILY_FOLLOWUP_CAP)
        self.assertEqual(num("Messages to one person (first message plus follow-ups)"), outreach_log.MAX_TOUCHES)


if __name__ == "__main__":
    unittest.main()
