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

    def default_ws(self):
        ws = self.home / "Claude" / "sales-navigator"
        ws.mkdir(parents=True)
        return ws


class WorkspaceResolution(TmpCase):
    def test_flag_beats_env_beats_profile_beats_default_beats_cwd(self):
        default = self.default_ws()
        profile = "- **workspace:** %s\n" % (self.root / "from-profile")
        env = {workspace.ENV_VAR: str(self.root / "from-env")}
        r = workspace.resolve(str(self.root / "from-flag"), env=env, profile_text=profile, home=self.home)
        self.assertEqual((r.path, r.source, r.persistent), (self.root / "from-flag", "flag", True))
        r = workspace.resolve(None, env=env, profile_text=profile, home=self.home)
        self.assertEqual((r.path, r.source), (self.root / "from-env", "env"))
        r = workspace.resolve(None, env={}, profile_text=profile, home=self.home)
        self.assertEqual((r.path, r.source), (self.root / "from-profile", "profile"))
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
        ws = self.root / "ws"
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
        env_ws = self.root / "envws"
        with mock.patch.dict(os.environ, {workspace.ENV_VAR: str(env_ws)}):
            run_main(run_log, ["add", "--pages", "1"])
            self.assertTrue((env_ws / "run_log.csv").is_file())
            override = self.root / "elsewhere.csv"
            run_main(run_log, ["add", "--pages", "1", "--log", str(override)])
            self.assertTrue(override.is_file())
            self.assertEqual(len(read_csv(env_ws / "run_log.csv")), 1)
            # --workspace beats the env var
            flag_ws = self.root / "flagws"
            run_main(run_log, ["add", "--pages", "1", "--workspace", str(flag_ws)])
            self.assertTrue((flag_ws / "run_log.csv").is_file())

    def test_default_folder_is_used_when_it_exists(self):
        ws = self.default_ws()
        code, _, err = run_main(run_log, ["add", "--pages", "2"])
        self.assertEqual((code, err), (0, ""))
        self.assertTrue((ws / "run_log.csv").is_file())
        self.assertFalse((self.cwd / "run_log.csv").exists())

    def test_cwd_fallback_warns_that_caps_will_not_persist(self):
        code, out, err = run_main(run_log, ["add", "--pages", "2"])
        self.assertEqual(code, 0)
        self.assertIn("WARNING", err)
        self.assertIn("will NOT persist", err)
        self.assertTrue((self.cwd / "run_log.csv").is_file())

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
        ws = self.root / "ws"
        run_main(run_log, ["add", "--pages", "3", "--workspace", str(ws)])
        (ws / "salesnav_run_log.jsonl").write_text(
            json.dumps({"ts": datetime.now().astimezone().isoformat(), "pages": 99}) + "\n")
        run_main(run_log, ["add", "--pages", "1", "--workspace", str(ws)])
        self.assertEqual([r["pages"] for r in read_csv(ws / "run_log.csv")], ["3", "1"])


class QuotaFile(TmpCase):
    def seed(self, ws):
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
        ws = self.root / "empty"
        code, out, _ = run_main(run_log, ["quota", "--workspace", str(ws)])
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("Today: 0/150 calls · 0/40 pages · 0/20 invites · week 0/100"))
        self.assertIn("no outreach ledger yet", out)
        self.assertIn("No `outreach_log.csv` in the workspace yet", (ws / "quota.md").read_text(encoding="utf-8"))

    def test_quota_flags_limits_that_are_reached(self):
        ws = self.root / "ws"
        run_main(run_log, ["add", "--pages", "41", "--workspace", str(ws)])
        _, out, _ = run_main(run_log, ["quota", "--workspace", str(ws)])
        self.assertIn("!! pages OVER DEFAULT", out)
        self.assertIn("| pages | 41 | 40 | 80 | OVER DEFAULT | 41 |", (ws / "quota.md").read_text(encoding="utf-8"))

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

    def test_an_existing_ledger_in_the_fallback_folder_still_works_but_warns(self):
        (self.cwd / "outreach_log.csv").write_text(",".join(outreach_log.COLUMNS) + "\n")
        code, _, err = run_main(outreach_log, ["check", "--lead-id", ID1])
        self.assertEqual(code, 0)
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

    def test_every_doc_names_the_workspace_and_its_files(self):
        for rel in ("SKILL.md", "references/guardrails.md", "references/output.md", "references/run-my-day.md",
                    "runtime/local.md", "templates/company-profile.md"):
            with self.subTest(doc=rel):
                self.assertIn("workspace", self.read(rel).lower())
        skill = self.read("SKILL.md")
        for needle in ("~/Claude/sales-navigator", "SALESNAV_WORKSPACE", "run_log.csv", "outreach_log.csv",
                       "quota.md", "run_log.py quota", "workspace.py", "ask the user ONCE"):
            self.assertIn(needle, skill, needle)

    def test_profile_template_has_workspace_and_outreach_started_fields(self):
        t = self.read("templates/company-profile.md")
        self.assertRegex(t, r"(?m)^- \*\*workspace:\*\*")
        self.assertEqual(workspace.profile_workspace(t), None)  # blank in the template
        self.assertRegex(t, r"(?m)^- \*\*Outreach started")
        self.assertIn("workspace:", self.read("templates/company-profile.example.md"))

    def test_outreach_and_guardrails_state_the_refuse_rule(self):
        for rel in ("references/outreach.md", "references/guardrails.md"):
            with self.subTest(doc=rel):
                text = self.read(rel)
                self.assertIn("--first-send", text)
                self.assertRegex(text, r"(?i)refus")

    def test_local_runtime_note_is_vendored_identically(self):
        self.assertIn("~/Claude", self.read("runtime/local.md"))
        self.assertEqual(self.read("runtime/local.md"),
                         (ROOT / "packages" / "browser-runtime" / "local.md").read_text(encoding="utf-8"))

    def test_every_script_documented_in_skill_md_exists(self):
        skill = self.read("SKILL.md")
        for name in re.findall(r"`scripts/([a-z_]+\.py)`", skill):
            self.assertTrue((SCRIPTS / name).is_file(), name)
        self.assertIn("scripts/workspace.py", skill)


if __name__ == "__main__":
    unittest.main()
