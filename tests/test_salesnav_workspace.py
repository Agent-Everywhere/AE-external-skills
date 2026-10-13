"""Tests for the persistent workspace: workspace.py, the CSV run log + jsonl migration, quota.md,
and the outreach ledger gate (stdlib unittest, no network).

Run from the repo root:  python3 -m pytest -q tests
"""
import contextlib
import csv
import io
import json
import os
import re
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "sales-navigator"
SCRIPTS = SKILL / "scripts"
sys.path.insert(0, str(SCRIPTS))

import outreach_log  # noqa: E402
import run_log  # noqa: E402
import workspace  # noqa: E402

ID1 = "ACwAAAexample1"
ID2 = "ACwAAAexample2"
TODAY = date.today().isoformat()


def run_main(module, argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = module.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


class TmpCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.cwd = self.root / "cwd"
        self.cwd.mkdir()
        # no SALESNAV_WORKSPACE, a fake HOME, and a known cwd for every test
        env = {k: v for k, v in os.environ.items() if k != workspace.ENV_VAR}
        env["HOME"] = str(self.home)
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        old = os.getcwd()
        os.chdir(self.cwd)
        self.addCleanup(os.chdir, old)

    def new_ws(self, name="ws"):
        """An existing workspace folder (run_log.py refuses a folder that does not exist)."""
        ws = self.root / name
        ws.mkdir(exist_ok=True)
        return ws

    def default_ws(self):
        ws = self.home / "Claude" / "sales-navigator"
        ws.mkdir(parents=True)
        return ws


class WorkspaceResolution(TmpCase):
    def test_flag_beats_profile_beats_env_beats_default_beats_cwd(self):
        default = self.default_ws()
        profile = "- **workspace:** %s\n" % (self.root / "from-profile")
        env = {workspace.ENV_VAR: str(self.root / "from-env")}
        r = workspace.resolve(str(self.root / "from-flag"), env=env, profile_text=profile, home=self.home)
        self.assertEqual((r.path, r.source, r.persistent), (self.root / "from-flag", "flag", True))
        r = workspace.resolve(None, env=env, profile_text=profile, home=self.home)
        self.assertEqual((r.path, r.source), (self.root / "from-profile", "profile"))
        r = workspace.resolve(None, env=env, profile_text="workspace:\n", home=self.home)
        self.assertEqual((r.path, r.source), (self.root / "from-env", "env"))
        r = workspace.resolve(None, env={}, profile_text="workspace:\n", home=self.home)
        self.assertEqual((r.path, r.source, r.persistent), (default, "default", True))
        r = workspace.resolve(None, env={}, home=self.root / "nobody", cwd=self.cwd)
        self.assertEqual((r.path, r.source, r.persistent), (self.cwd, "cwd", False))

    def test_default_is_used_only_when_the_folder_exists(self):
        r = workspace.resolve(None, env={}, home=self.home, cwd=self.cwd)
        self.assertEqual(r.source, "cwd")
        self.default_ws()
        self.assertEqual(workspace.resolve(None, env={}, home=self.home, cwd=self.cwd).source, "default")

    def test_blank_env_is_ignored_and_tilde_is_expanded(self):
        self.assertEqual(workspace.resolve(None, env={workspace.ENV_VAR: "  "}, home=self.home, cwd=self.cwd).source, "cwd")
        r = workspace.resolve("~/Claude/x")
        self.assertEqual(r.path, self.home / "Claude" / "x")

    def test_profile_field_parsing(self):
        for text, want in (("workspace: /a/b", "/a/b"), ("- workspace: `/a b/c`", "/a b/c"),
                           ("- **Workspace:** \"/q\"", "/q"), ("workspace:", None), ("workspace: skip", None),
                           ("- Working folder for CSVs: /x", None), ("", None)):
            self.assertEqual(workspace.profile_workspace(text), want, text)

    def test_state_file_uses_workspace_and_warns_only_on_the_cwd_fallback(self):
        err = io.StringIO()
        path, located = workspace.state_file("run_log.csv", stream=err)
        self.assertEqual((path, located), (str(self.cwd / "run_log.csv"), False))
        self.assertIn("WARNING", err.getvalue())
        self.assertIn("will NOT persist", err.getvalue())
        ws = self.default_ws()
        err = io.StringIO()
        path, located = workspace.state_file("run_log.csv", stream=err)
        self.assertEqual((path, located, err.getvalue()), (str(ws / "run_log.csv"), True, ""))
        path, located = workspace.state_file("run_log.csv", log="/x/y.csv", stream=err)
        self.assertEqual((path, located), ("/x/y.csv", True))

    def test_init_and_locate_cli(self):
        code, out, _ = run_main(workspace, ["locate"])
        self.assertEqual(code, workspace.EXIT_NOT_FOUND)
        self.assertIn("NOT FOUND", out)
        self.assertIn("Ask the user ONCE", out)
        code, out, _ = run_main(workspace, ["init", str(self.root / "Cowork")])
        self.assertEqual(code, 0)
        ws = self.root / "Cowork" / "sales-navigator"
        for sub in ("lists", "drafts", "results"):
            self.assertTrue((ws / sub).is_dir(), sub)
        self.assertIn("workspace: %s" % ws, out)
        # init on a folder that already is the workspace does not nest
        code, out, _ = run_main(workspace, ["init", str(ws)])
        self.assertEqual(workspace.init_workspace(str(ws)), ws)
        code, out, _ = run_main(workspace, ["locate", "--workspace", str(ws)])
        self.assertEqual(code, 0)
        self.assertIn("source: flag", out)
        profile = self.root / "company-profile.md"
        profile.write_text("- workspace: %s\n" % ws)
        code, out, _ = run_main(workspace, ["locate", "--profile", str(profile)])
        self.assertEqual((code, "source: profile" in out), (0, True))


class RunLogCsvAndWorkspace(TmpCase):
    def test_add_writes_run_log_csv_in_the_workspace_flag_folder(self):
        ws = self.new_ws()
        code, out, err = run_main(run_log, ["add", "--pages", "4", "--small-calls", "9", "--note", "t", "--workspace", str(ws)])
        self.assertEqual((code, err), (0, ""))
        rows = read_csv(ws / "run_log.csv")
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["pages"], rows[0]["small_calls"], rows[0]["note"], rows[0]["date"]), ("4", "9", "t", TODAY))
        self.assertRegex(rows[0]["time"], r"^\d\d:\d\d:\d\d$")
        self.assertEqual(list(rows[0]), ["date", "time", "pages", "profiles", "accounts", "saved_searches", "small_calls", "note"])
        # a second task, same folder: the totals carry over
        code, out, _ = run_main(run_log, ["today", "--workspace", str(ws)])
        self.assertIn("4", [l for l in out.splitlines() if l.startswith("pages")][0].split())

    def test_env_workspace_and_log_override(self):
        env_ws = self.new_ws("envws")
        with mock.patch.dict(os.environ, {workspace.ENV_VAR: str(env_ws)}):
            run_main(run_log, ["add", "--pages", "1"])
            self.assertTrue((env_ws / "run_log.csv").is_file())
            override = self.root / "elsewhere.csv"
            run_main(run_log, ["add", "--pages", "1", "--log", str(override)])
            self.assertTrue(override.is_file())
            self.assertEqual(len(read_csv(env_ws / "run_log.csv")), 1)
            # --workspace beats the env var
            flag_ws = self.new_ws("flagws")
            run_main(run_log, ["add", "--pages", "1", "--workspace", str(flag_ws)])
            self.assertTrue((flag_ws / "run_log.csv").is_file())

    def test_default_folder_is_used_when_it_exists(self):
        ws = self.default_ws()
        code, _, err = run_main(run_log, ["add", "--pages", "2"])
        self.assertEqual((code, err), (0, ""))
        self.assertTrue((ws / "run_log.csv").is_file())
        self.assertFalse((self.cwd / "run_log.csv").exists())

    def test_unlocated_workspace_refuses_every_run_log_command_and_writes_nothing(self):
        for argv in (["add", "--pages", "2"], ["today"], ["quota"]):
            with self.subTest(command=argv[0]):
                code, out, err = run_main(run_log, argv)
                self.assertEqual(code, run_log.EXIT_NO_WORKSPACE)
                self.assertIn("WARNING", err)
                self.assertIn("could not be located", err)
                self.assertEqual(sorted(p.name for p in self.cwd.iterdir()), [])

    def test_a_workspace_folder_that_does_not_exist_is_refused_not_read_as_zero_usage(self):
        typo = self.root / "typo"
        for argv in (["add", "--pages", "2"], ["today"], ["quota"]):
            with self.subTest(command=argv[0]):
                code, out, err = run_main(run_log, argv + ["--workspace", str(typo)])
                self.assertEqual(code, run_log.EXIT_NO_WORKSPACE)
                self.assertIn("does not exist", err)
                self.assertFalse(typo.exists())
        # an env var or a profile that points at a missing folder is refused the same way
        with mock.patch.dict(os.environ, {workspace.ENV_VAR: str(typo)}):
            self.assertEqual(run_main(run_log, ["today"])[0], run_log.EXIT_NO_WORKSPACE)
        profile = self.root / "company-profile.md"
        profile.write_text("- **workspace:** %s\n" % typo)
        self.assertEqual(run_main(run_log, ["today", "--profile", str(profile)])[0], run_log.EXIT_NO_WORKSPACE)

    def test_an_existing_folder_without_a_log_is_a_new_workspace_and_says_so(self):
        ws = self.new_ws()
        for argv in (["today"], ["quota"]):
            code, _, err = run_main(run_log, argv + ["--workspace", str(ws)])
            self.assertEqual(code, 0)
            self.assertIn("no run_log.csv found at %s" % (ws / "run_log.csv"), err)
        code, _, err = run_main(run_log, ["add", "--pages", "1", "--workspace", str(ws)])
        self.assertEqual((code, err), (0, ""))
        code, _, err = run_main(run_log, ["today", "--workspace", str(ws)])
        self.assertEqual((code, err), (0, ""))

    def test_the_profile_workspace_beats_the_env_var_and_the_default_in_both_scripts(self):
        self.default_ws()
        prof_ws, env_ws = self.new_ws("fromprofile"), self.new_ws("fromenv")
        profile = self.root / "company-profile.md"
        profile.write_text("- **workspace:** %s\n" % prof_ws)
        with mock.patch.dict(os.environ, {workspace.ENV_VAR: str(env_ws)}):
            code, _, err = run_main(run_log, ["add", "--pages", "3", "--profile", str(profile)])
            self.assertEqual((code, err), (0, ""))
            self.assertTrue((prof_ws / "run_log.csv").is_file())
            self.assertFalse((env_ws / "run_log.csv").exists())
            code, _, _ = run_main(outreach_log, ["add", "--lead-id", ID1, "--kind", "connection", "--message", "hi",
                                                 "--profile", str(profile), "--first-send"])
            self.assertEqual(code, 0)
            self.assertTrue((prof_ws / "outreach_log.csv").is_file())
            self.assertFalse((env_ws / "outreach_log.csv").exists())
            # --workspace still beats the profile
            code, _, _ = run_main(run_log, ["add", "--pages", "1", "--profile", str(profile), "--workspace", str(env_ws)])
            self.assertEqual(code, 0)
            self.assertTrue((env_ws / "run_log.csv").is_file())
        code, _, err = run_main(run_log, ["today", "--profile", str(self.root / "no-such-profile.md")])
        self.assertEqual(code, 1)
        self.assertIn("No such file", err)

    def test_a_bom_in_a_resaved_csv_does_not_break_the_logs(self):
        ws = self.new_ws()
        run_main(run_log, ["add", "--pages", "2", "--workspace", str(ws)])
        log = ws / "run_log.csv"
        log.write_bytes(b"\xef\xbb\xbf" + log.read_bytes())
        code, out, err = run_main(run_log, ["today", "--workspace", str(ws)])
        self.assertEqual((code, err), (0, ""))
        run_main(outreach_log, ["add", "--lead-id", ID1, "--kind", "connection", "--message", "hi",
                                "--workspace", str(ws), "--first-send"])
        led = ws / "outreach_log.csv"
        led.write_bytes(b"\xef\xbb\xbf" + led.read_bytes())
        code, out, _ = run_main(outreach_log, ["check", "--lead-id", ID1, "--workspace", str(ws)])
        self.assertEqual(code, outreach_log.EXIT_CONTACTED)

    def test_concurrent_first_writes_migrate_the_legacy_log_once(self):
        import threading
        ws = self.new_ws()
        local_now = datetime.now().astimezone().isoformat(timespec="seconds")
        legacy = ws / "salesnav_run_log.jsonl"
        legacy.write_text("".join(json.dumps({"ts": local_now, "pages": n}) + "\n" for n in (1, 2, 3)))
        log = ws / "run_log.csv"
        threads = [threading.Thread(target=run_log.append_entry, args=(log, {a: 1 for a in run_log.LIMITS}))
                   for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        text = log.read_text(encoding="utf-8")
        self.assertEqual(text.count("date,time,"), 1)
        self.assertEqual(len(read_csv(log)), 3 + 6)
        self.assertFalse((ws / ".run_log.csv.tmp").exists())

    def test_a_crashed_first_write_leaves_no_half_migrated_csv(self):
        ws = self.new_ws()
        (ws / "salesnav_run_log.jsonl").write_text(
            json.dumps({"ts": datetime.now().astimezone().isoformat(), "pages": 7}) + "\n")
        with mock.patch.object(run_log.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                run_log.append_entry(ws / "run_log.csv", {a: 1 for a in run_log.LIMITS})
        self.assertFalse((ws / "run_log.csv").exists())
        run_log.append_entry(ws / "run_log.csv", {a: 1 for a in run_log.LIMITS})
        self.assertEqual([r["pages"] for r in read_csv(ws / "run_log.csv")], ["7", "1"])

    def test_legacy_jsonl_is_read_before_and_migrated_on_first_write_keeping_the_old_file(self):
        ws = self.root / "ws"
        ws.mkdir()
        legacy = ws / "salesnav_run_log.jsonl"
        local_now = datetime.now().astimezone()
        lines = [json.dumps({"ts": local_now.isoformat(timespec="seconds"), "pages": 30, "profiles": 2, "accounts": 0,
                             "saved_searches": 0, "small_calls": 5}),
                 "garbage",
                 json.dumps({"ts": (local_now - timedelta(days=1)).isoformat(timespec="seconds"), "pages": 11})]
        legacy.write_text("\n".join(lines) + "\n")
        before = legacy.read_text()
        # read-only: counted from the legacy file, nothing created
        code, out, err = run_main(run_log, ["today", "--workspace", str(ws)])
        self.assertEqual(code, 0)
        self.assertIn("line 2 skipped", err)
        pages = [l for l in out.splitlines() if l.startswith("pages")][0].split()
        self.assertEqual(pages[1], "30")
        self.assertFalse((ws / "run_log.csv").exists())
        # first write: migrate, then append
        code, out, _ = run_main(run_log, ["add", "--pages", "5", "--workspace", str(ws)])
        self.assertEqual(code, 0)
        rows = read_csv(ws / "run_log.csv")
        self.assertEqual([r["pages"] for r in rows], ["30", "11", "5"])
        self.assertEqual(rows[0]["date"], local_now.date().isoformat())
        self.assertEqual(rows[0]["small_calls"], "5")
        pages = [l for l in out.splitlines() if l.startswith("pages")][0].split()
        self.assertEqual(pages[1], "35")
        self.assertEqual(legacy.read_text(), before)  # old file kept untouched
        # second write does not migrate again
        run_main(run_log, ["add", "--pages", "1", "--workspace", str(ws)])
        self.assertEqual(len(read_csv(ws / "run_log.csv")), 4)

    def test_existing_csv_wins_over_a_stale_legacy_file(self):
        ws = self.new_ws()
        run_main(run_log, ["add", "--pages", "3", "--workspace", str(ws)])
        (ws / "salesnav_run_log.jsonl").write_text(
            json.dumps({"ts": datetime.now().astimezone().isoformat(), "pages": 99}) + "\n")
        run_main(run_log, ["add", "--pages", "1", "--workspace", str(ws)])
        self.assertEqual([r["pages"] for r in read_csv(ws / "run_log.csv")], ["3", "1"])


class QuotaFile(TmpCase):
    def seed(self, ws):
        ws.mkdir(exist_ok=True)
        run_main(run_log, ["add", "--small-calls", "87", "--pages", "12", "--workspace", str(ws)])
        # outreach: 12 connection requests today, 29 more earlier this week
        led = ws / "outreach_log.csv"
        for i in range(12):
            code, _, err = run_main(outreach_log, ["add", "--workspace", str(ws), "--lead-id", "ACwAAAtoday%03d" % i,
                                                   "--kind", "connection", "--message", "m%d" % i, "--first-send"])
            self.assertEqual(code, 0, err)
        rows = read_csv(led)
        earlier = date.today() - timedelta(days=3)
        with open(led, "a", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=outreach_log.COLUMNS, lineterminator="\n")
            for i in range(29):
                w.writerow({"lead_id": "ACwAAAold%04d" % i, "kind": "connection", "status": "sent",
                            "sent_at": earlier.isoformat(), "status_at": earlier.isoformat(), "touches": 1,
                            "message_hash": "abc", "note": ""})
        self.assertEqual(len(rows), 12)

    def test_quota_rewrites_quota_md_and_prints_the_one_line_summary(self):
        ws = self.root / "ws"
        self.seed(ws)
        code, out, err = run_main(run_log, ["quota", "--workspace", str(ws)])
        self.assertEqual((code, err), (0, ""))
        first = out.splitlines()[0]
        self.assertEqual(first, "Today: 87/150 calls · 12/40 pages · 12/20 invites · week 41/100")
        md = (ws / "quota.md").read_text(encoding="utf-8")
        self.assertRegex(md, r"Last updated: \d{4}-\d\d-\d\d \d\d:\d\d")
        self.assertIn("**%s**" % first, md)
        self.assertIn("| small calls | 87 | 150 | 200 | OK | 87 |", md)
        self.assertIn("| pages | 12 | 40 | 80 | OK | 12 |", md)
        self.assertIn("| Connection requests today | 12 | 20 | OK |", md)
        self.assertIn("| Connection requests, last 7 days | 41 | 100 | OK |", md)
        self.assertIn("local CSV files stay the source of truth", md)
        # rewritten, not appended
        run_main(run_log, ["quota", "--workspace", str(ws)])
        self.assertEqual((ws / "quota.md").read_text(encoding="utf-8").count("# Sales Navigator quota"), 1)

    def test_quota_without_any_logs_is_zeros_and_says_there_is_no_ledger(self):
        ws = self.new_ws("empty")
        code, out, _ = run_main(run_log, ["quota", "--workspace", str(ws)])
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("Today: 0/150 calls · 0/40 pages · 0/20 invites · week 0/100"))
        self.assertIn("no outreach ledger yet", out)
        self.assertIn("No `outreach_log.csv` in the workspace yet", (ws / "quota.md").read_text(encoding="utf-8"))

    def test_quota_flags_limits_that_are_reached(self):
        ws = self.new_ws()
        run_main(run_log, ["add", "--pages", "41", "--workspace", str(ws)])
        _, out, _ = run_main(run_log, ["quota", "--workspace", str(ws)])
        self.assertIn("!! pages OVER DEFAULT", out)
        self.assertIn("| pages | 41 | 40 | 80 | OVER DEFAULT | 41 |", (ws / "quota.md").read_text(encoding="utf-8"))

    def test_quota_shows_the_users_lowered_invite_caps(self):
        ws = self.root / "ws"
        self.seed(ws)  # 12 invites today, 41 this week
        code, out, err = run_main(run_log, ["quota", "--workspace", str(ws), "--daily", "10", "--weekly", "50"])
        self.assertEqual((code, err), (0, ""))
        self.assertTrue(out.splitlines()[0].startswith("Today: 87/150 calls · 12/40 pages · 12/10 invites · week 41/50"))
        self.assertIn("daily invite cap reached", out)
        md = (ws / "quota.md").read_text(encoding="utf-8")
        self.assertIn("| Connection requests today | 12 | 10 | CAP REACHED |", md)
        # a raised cap is ignored, as in outreach_log.py
        _, out, err = run_main(run_log, ["quota", "--workspace", str(ws), "--daily", "99"])
        self.assertIn("12/20 invites", out)
        self.assertIn("was ignored", err)

    def test_quota_reads_the_ledger_of_the_named_workspace_even_when_the_run_log_is_elsewhere(self):
        ws = self.root / "ws"
        self.seed(ws)
        elsewhere = self.new_ws("elsewhere") / "mine.csv"
        run_main(run_log, ["add", "--pages", "1", "--log", str(elsewhere)])
        code, out, _ = run_main(run_log, ["quota", "--log", str(elsewhere), "--workspace", str(ws)])
        self.assertEqual(code, 0)
        self.assertIn("12/20 invites", out)
        self.assertNotIn("no outreach ledger", out)

    def test_quota_with_a_log_override_writes_beside_it_and_reads_the_sibling_ledger(self):
        d = self.root / "x"
        d.mkdir()
        log = d / "mine.csv"
        run_main(run_log, ["add", "--pages", "1", "--log", str(log)])
        code, out, _ = run_main(run_log, ["quota", "--log", str(log)])
        self.assertEqual(code, 0)
        self.assertTrue((d / "quota.md").is_file())
        elsewhere = self.root / "q" / "quota.md"
        run_main(run_log, ["quota", "--log", str(log), "--quota-file", str(elsewhere)])
        self.assertTrue(elsewhere.is_file())

    def test_a_corrupt_ledger_stops_the_quota_instead_of_showing_zeros(self):
        ws = self.root / "ws"
        ws.mkdir()
        (ws / "outreach_log.csv").write_text("wrong,header\n1,2\n")
        code, _, err = run_main(run_log, ["quota", "--workspace", str(ws)])
        self.assertEqual(code, 1)
        self.assertIn("header must be", err)


class LedgerGate(TmpCase):
    ARGS = ["--lead-id", ID1, "--kind", "connection", "--message", "hi"]

    def test_missing_ledger_refuses_add_check_followup_status_caps_summary(self):
        ws = self.root / "ws"
        ws.mkdir()
        for argv in (["add"] + self.ARGS, ["check", "--lead-id", ID1], ["caps"], ["summary"],
                     ["status", "--lead-id", ID1, "--status", "accepted"],
                     ["followup", "--lead-id", ID1, "--message", "x"]):
            with self.subTest(command=argv[0]):
                code, _, err = run_main(outreach_log, argv + ["--workspace", str(ws)])
                self.assertEqual(code, outreach_log.EXIT_NO_LEDGER, err)
                self.assertIn("no outreach ledger", err)
                self.assertIn("Do not send", err)
                self.assertFalse((ws / "outreach_log.csv").exists())  # nothing was started

    def test_a_zero_byte_ledger_counts_as_missing(self):
        ws = self.root / "ws"
        ws.mkdir()
        (ws / "outreach_log.csv").write_text("")
        code, _, _ = run_main(outreach_log, ["add"] + self.ARGS + ["--workspace", str(ws)])
        self.assertEqual(code, outreach_log.EXIT_NO_LEDGER)

    def test_first_send_creates_the_ledger_explicitly_and_says_so(self):
        ws = self.root / "fresh"
        code, out, _ = run_main(outreach_log, ["add"] + self.ARGS + ["--workspace", str(ws), "--first-send"])
        self.assertEqual(code, 0)
        self.assertIn("first send ever: creating a new outreach ledger", out)
        self.assertEqual(len(read_csv(ws / "outreach_log.csv")), 1)
        # from then on the flag is no longer needed, and a lost file is refused again
        code, _, _ = run_main(outreach_log, ["check", "--lead-id", ID2, "--workspace", str(ws)])
        self.assertEqual(code, 0)
        (ws / "outreach_log.csv").unlink()
        code, _, _ = run_main(outreach_log, ["check", "--lead-id", ID2, "--workspace", str(ws)])
        self.assertEqual(code, outreach_log.EXIT_NO_LEDGER)

    def test_first_send_flag_does_not_help_status_or_followup(self):
        ws = self.root / "ws"
        ws.mkdir()
        code, _, err = run_main(outreach_log, ["status", "--lead-id", ID1, "--status", "accepted", "--workspace", str(ws)])
        self.assertEqual(code, outreach_log.EXIT_NO_LEDGER)

    def test_unlocated_workspace_refuses_even_with_first_send(self):
        code, _, err = run_main(outreach_log, ["add"] + self.ARGS + ["--first-send"])  # cwd fallback, no workspace
        self.assertEqual(code, outreach_log.EXIT_NO_LEDGER)
        self.assertIn("workspace could not be located", err)
        self.assertIn("WARNING", err)
        self.assertFalse((self.cwd / "outreach_log.csv").exists())

    def test_a_stray_ledger_in_the_fallback_folder_is_not_trusted(self):
        (self.cwd / "outreach_log.csv").write_text(",".join(outreach_log.COLUMNS) + "\n")
        for argv in (["check", "--lead-id", ID1], ["caps"], ["summary"], ["add"] + self.ARGS):
            with self.subTest(command=argv[0]):
                code, _, err = run_main(outreach_log, argv)
                self.assertEqual(code, outreach_log.EXIT_NO_LEDGER)
                self.assertIn("could not be located", err)
                self.assertIn("will NOT persist", err)

    def test_default_workspace_ledger_is_found_without_flags(self):
        ws = self.default_ws()
        code, _, _ = run_main(outreach_log, ["add"] + self.ARGS + ["--first-send"])
        self.assertEqual(code, 0)
        self.assertTrue((ws / "outreach_log.csv").is_file())
        code, out, _ = run_main(outreach_log, ["check", "--lead-id", ID1])
        self.assertEqual(code, outreach_log.EXIT_CONTACTED)

    def test_explicit_log_path_is_trusted_as_located(self):
        log = self.root / "mine" / "outreach_log.csv"
        code, _, _ = run_main(outreach_log, ["add"] + self.ARGS + ["--log", str(log)])
        self.assertEqual(code, outreach_log.EXIT_NO_LEDGER)  # missing, no --first-send
        code, _, _ = run_main(outreach_log, ["add"] + self.ARGS + ["--log", str(log), "--first-send"])
        self.assertEqual(code, 0)


class DocsAgreeWithTheScripts(unittest.TestCase):
    def read(self, rel):
        return (SKILL / rel).read_text(encoding="utf-8")

    def test_profile_template_has_workspace_and_outreach_started_fields(self):
        t = self.read("templates/company-profile.md")
        self.assertRegex(t, r"(?m)^- \*\*workspace:\*\*")
        self.assertEqual(workspace.profile_workspace(t), None)  # blank in the template
        self.assertRegex(t, r"(?m)^- \*\*Outreach started")
        self.assertIn("workspace:", self.read("templates/company-profile.example.md"))

    def test_the_resolution_order_is_documented_in_the_code(self):
        # flag, then the profile, then the env var, then the default folder
        def in_order(text, markers):
            positions = [text.index(m) for m in markers]
            self.assertEqual(positions, sorted(positions), markers)
        doc = workspace.__doc__.split("Resolution order", 1)[1].split("workspace.py locate", 1)[0]
        in_order(doc, ["--workspace DIR", "`workspace:` field", "$SALESNAV_WORKSPACE", "~/Claude/sales-navigator"])
        for module in (run_log, outreach_log):
            self.assertIn("--profile", module.__doc__)
            self.assertLess(module.__doc__.index("the `workspace:` field"), module.__doc__.index("$SALESNAV_WORKSPACE"))

    def test_runtime_docs_are_vendored_identically(self):
        for name in ("README.md", "session.py"):
            self.assertEqual((SKILL / "runtime" / name).read_bytes(),
                             (ROOT / "packages" / "browser-runtime" / name).read_bytes(), name)

    def test_the_skill_documents_the_workspace_and_its_scripts(self):
        skill = self.read("SKILL.md")
        for needle in ("~/Claude/sales-navigator", "run_log.csv", "outreach_log.csv", "quota.md",
                       "run_log.py", "workspace.py", "ask the user once"):
            self.assertIn(needle, skill, needle)
        for name in re.findall(r"`scripts/([a-z_]+\.py)`", skill):
            self.assertTrue((SCRIPTS / name).is_file(), name)


if __name__ == "__main__":
    unittest.main()
