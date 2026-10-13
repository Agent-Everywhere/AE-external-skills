"""Regression tests for the browser-runtime review fixes (packages/browser-runtime/session.py).

No browser, no network: fake pages, a fake Playwright and a patched post_json.
Run from the repo root:  python3 -m pytest -q tests
"""
import contextlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import test_browser_runtime as base

session = base.session
ROOT = base.ROOT
PKG = base.PKG
NODE = shutil.which("node")
PAGE = ROOT / "skills" / "sales-navigator" / "page"

CLAIM = "claim-secret-123456"
CDP = "wss://cloud-7f3a.example.net/devtools/browser/0a1b2c3d-feed-beef-cafe-123456789abc"
HB = "hb-token-abcdef123456"


# ----------------------------------------------------------------------------- fakes for main()

class FakeContext:
    def __init__(self, pages):
        self.pages = pages
        self.created = []

    def new_page(self):
        page = base.FakePage(lambda e, a: {"status": 200, "rows": 0}, url="about:blank")
        page.goto = lambda url, wait_until=None, _p=page: setattr(_p, "url", url)
        self.pages.append(page)
        self.created.append(page)
        return page


class FakeBrowser:
    def __init__(self, pages):
        self.contexts = [FakeContext(pages)]


def fake_playwright(browser, connect_error=None):
    class Chromium:
        def connect_over_cdp(self, url):
            if connect_error:
                raise connect_error
            return browser

    pw = types.SimpleNamespace(chromium=Chromium(), stop=lambda: None)
    return lambda: types.SimpleNamespace(start=lambda: pw)


def http_error(code, body=b""):
    return urllib.error.HTTPError("https://connector.example/x", code, "err", {}, io.BytesIO(body))


def simple_plan(**extra):
    the_plan = {"start_url": "https://www.linkedin.com/sales/home", "settle_ms": 0,
                "calls": [{"id": "one", "js": "async () => 'search'", "params": {}}]}
    the_plan.update(extra)
    return the_plan


class MainHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.out = self.dir / "out.jsonl"
        self.plan_path = self.dir / "plan.json"
        self.plan_path.write_text(json.dumps(simple_plan()))

    def main(self, argv, post=None, playwright=None, env_claim=True):
        """Run session.main in-process. Return (code, stdout, stderr, posts)."""
        posts = []

        def fake_post(base_url, path, body, timeout=30):
            posts.append((path, body))
            if post:
                return post(path, body)
            if path == "/browser/claim":
                return {"cdp_url": CDP, "heartbeat_token": HB, "session_id": "sess-1"}
            return {}

        out, err = io.StringIO(), io.StringIO()
        playwright = playwright or fake_playwright(FakeBrowser([self.sales_page()]))
        with mock.patch.object(session, "post_json", fake_post), \
                mock.patch.object(session, "import_playwright", lambda: playwright), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = session.main(argv)
        return code, out.getvalue(), err.getvalue(), posts

    def sales_page(self, responder=None):
        return base.FakePage(responder or (lambda e, a: {"status": 200, "rows": 0}),
                             url="https://www.linkedin.com/sales/home")

    def ab_args(self, *extra, base_url="https://connector.example"):
        return ["--runtime", "agent-browser", "--claim", CLAIM, "--base", base_url,
                "--plan", str(self.plan_path), "--out", str(self.out)] + list(extra)


# ----------------------------------------------------------------------------- A: startup order and exit codes

class StartupOrder(MainHarness):
    def test_missing_playwright_exits_2_before_the_claim_is_posted(self):
        posts = []
        err = io.StringIO()
        with mock.patch.object(session, "post_json", lambda *a, **k: posts.append(a) or {}), \
                mock.patch.object(session, "import_playwright", side_effect=ImportError("no playwright")), \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = session.main(self.ab_args())
        self.assertEqual(code, session.EXIT_USAGE)
        self.assertEqual(posts, [])  # the one-use claim was never spent
        self.assertIn("playwright", err.getvalue())
        self.assertIn("pip install playwright", err.getvalue())

    def test_claim_failures_exit_6_with_a_message_not_a_traceback(self):
        cases = {"HTTP 410": http_error(410), "request failed": urllib.error.URLError("dns down"),
                 "request failed ": OSError("reset"), "request failed  ": ValueError("not json")}
        for label, exc in cases.items():
            def refuse(path, body, _e=exc):
                raise _e
            with self.subTest(label=label):
                code, out, err, _ = self.main(self.ab_args(), post=refuse)
                self.assertEqual(code, session.EXIT_BROWSER)
                self.assertNotIn("Traceback", err)
                self.assertNotIn(CLAIM, out + err)
                self.assertIn("claim", err)

    def test_a_claim_response_missing_fields_exits_6(self):
        code, _, err, _ = self.main(self.ab_args(), post=lambda path, body: {"cdp_url": CDP})
        self.assertEqual(code, session.EXIT_BROWSER)
        self.assertIn("missing", err)

    def test_auth_report_4xx_or_auth_required_exits_3(self):
        for exc in (http_error(403, b'{"error":"auth_required"}'), http_error(401), http_error(422, b"auth_required")):
            def refuse(path, body, _e=exc):
                if path == "/browser/auth":
                    raise _e
                return {"cdp_url": CDP, "heartbeat_token": HB, "session_id": "sess-1"} if path == "/browser/claim" else {}
            with self.subTest(code=exc.code):
                code, _, err, _ = self.main(self.ab_args(), post=refuse)
                self.assertEqual(code, session.EXIT_AUTH)
                self.assertIn("auth report rejected", err)
        self.assertEqual([json.loads(l).get("event") for l in self.out.read_text().splitlines()][-1], "auth_rejected")

    def test_auth_report_network_or_5xx_failure_does_not_masquerade_as_signed_out(self):
        for exc in (urllib.error.URLError("down"), http_error(502), OSError("reset")):
            def flaky(path, body, _e=exc):
                if path == "/browser/auth":
                    raise _e
                return {"cdp_url": CDP, "heartbeat_token": HB, "session_id": "sess-1"} if path == "/browser/claim" else {}
            with self.subTest(exc=type(exc).__name__):
                self.out.write_text("")
                code, _, _, _ = self.main(self.ab_args(), post=flaky)
                self.assertEqual(code, session.EXIT_OK)

    def test_a_clean_agent_browser_run_exits_0_with_a_summary(self):
        code, out, err, posts = self.main(self.ab_args())
        self.assertEqual(code, 0, err)
        summary = json.loads(out)
        self.assertEqual((summary["executed"], summary["failed"], summary["truncated"]), (1, 0, 0))
        self.assertEqual([p for p, _ in posts][:2], ["/browser/claim", "/browser/auth"])

    def test_base_must_be_https(self):
        for bad in ("http://connector.example", "connector.example", "ftp://x.example", "https://"):
            with self.subTest(base=bad):
                code, _, err, posts = self.main(self.ab_args(base_url=bad))
                self.assertEqual(code, session.EXIT_USAGE)
                self.assertIn("https", err)
                self.assertEqual(posts, [])

    def test_a_bad_plan_is_rejected_before_anything_is_claimed(self):
        self.plan_path.write_text(json.dumps(simple_plan(delay_ms=[0, 0])))
        code, _, err, posts = self.main(self.ab_args())
        self.assertEqual(code, session.EXIT_USAGE)
        self.assertIn("delay_ms", err)
        self.assertEqual(posts, [])
        self.plan_path.write_text("{not json")
        code, _, err, posts = self.main(self.ab_args())
        self.assertEqual((code, posts), (session.EXIT_USAGE, []))

    def test_claim_on_the_command_line_gets_a_ps_warning_the_env_var_does_not(self):
        _, _, err, _ = self.main(self.ab_args())
        self.assertIn("AB_CLAIM", err)
        self.assertNotIn(CLAIM, err)
        argv = [a for a in self.ab_args() if a not in ("--claim", CLAIM)]
        with mock.patch.dict("os.environ", {"AB_CLAIM": CLAIM}):
            code, _, err, _ = self.main(argv)
        self.assertEqual(code, 0, err)
        self.assertNotIn("note: --claim", err)

    def test_help_prefers_the_env_var(self):
        text = subprocess.run([sys.executable, str(PKG / "session.py"), "--help"], capture_output=True, text=True).stdout
        self.assertIn("AB_CLAIM", text)
        self.assertIn("ps", text)


# ----------------------------------------------------------------------------- C: redaction

class Redaction(unittest.TestCase):
    def test_scrub_removes_cookie_shaped_and_url_shaped_text(self):
        text = ('Cookie: JSESSIONID="ajax:0123456789"; li_at=AQEDATexample123; '
                'csrf-token: ajax:99887766 and {"csrf_token":"xyz-123"} wss://h.example/devtools/x?t=1')
        out = session.scrub(text)
        for leaked in ("0123456789", "AQEDATexample123", "99887766", "xyz-123", "h.example", "devtools"):
            self.assertNotIn(leaked, out)
        self.assertIn("JSESSIONID", out)  # the name stays, the value goes

    def test_redact_runs_before_truncation(self):
        secret = "S3cretValue-ABCDEFGHIJ"
        text = "x" * 190 + secret
        clipped = session.clip(text, [secret], 200)
        self.assertNotIn("S3cret", clipped)  # truncating first would have left "S3cretValue-" behind
        self.assertNotIn(secret[:8], session.clip("y" * 195 + secret, [secret], 200))

    def test_cdp_url_host_and_path_are_redacted_wherever_they_appear(self):
        secrets = session.url_secrets(CDP)
        for text in ("connect to %s failed" % CDP, "host cloud-7f3a.example.net refused",
                     "path /devtools/browser/0a1b2c3d-feed-beef-cafe-123456789abc not found",
                     "id 0a1b2c3d-feed-beef-cafe-123456789abc"):
            out = session.redact(text, secrets)
            self.assertNotIn("cloud-7f3a", out)
            self.assertNotIn("0a1b2c3d", out)

    def test_redact_obj_handles_secrets_that_json_would_escape(self):
        secret = 'se"cret\\vaü-12345'
        obj = {"note": "x %s y" % secret, "list": [secret], secret: 1}
        out = json.dumps(session.redact_obj(obj, [secret]))
        self.assertNotIn("cret", out.replace("[redacted]", ""))  # a text-level replace would miss the escaped form
        self.assertIn("[redacted]", out)


class EmitScrub(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "r.jsonl"

    def run_with(self, result, secrets=()):
        the_plan = base.plan()
        the_plan["calls"] = [{"id": "x", "js": "async () => 1", "params": {}}]
        base.run(base.FakePage(lambda e, a: result), the_plan, self.out, secrets=list(secrets))
        return self.out.read_text()

    def test_cookie_shaped_content_in_a_result_never_reaches_the_file(self):
        result = {"status": 200, "rows": 0, "debug": 'document.cookie was JSESSIONID="ajax:424242"; li_at=AQEDsecret99',
                  "nested": [{"csrf-token": "ajax:313131"}], "cdp": "wss://leak.example/devtools/browser/zzz"}
        text = self.run_with(result)
        for leaked in ("424242", "AQEDsecret99", "313131", "leak.example", "zzz"):
            self.assertNotIn(leaked, text)
        for line in text.splitlines():
            json.loads(line)  # every line is still valid JSON

    def test_a_secret_that_looks_like_a_json_number_cannot_break_the_line(self):
        text = self.run_with({"status": 200, "rows": 123456}, secrets=["123456"])
        for line in text.splitlines():
            json.loads(line)

    def test_error_event_redacts_before_truncating(self):
        secret = "ZZsecretTailValue-0123456789"

        def boom(expression, arg):
            raise RuntimeError("q" * 290 + secret)
        the_plan = base.plan()
        the_plan["calls"] = [{"id": "x", "js": "async () => 1", "params": {}}]
        base.run(base.FakePage(boom), the_plan, self.out, secrets=[secret])
        text = self.out.read_text()
        self.assertNotIn("ZZsecret", text)
        self.assertNotIn("TailValue", text)


# ----------------------------------------------------------------------------- B and F: the auth probe

class AuthProbe(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "r.jsonl"

    def test_not_signed_in_event_records_two_path_segments_only(self):
        url = "https://www.linkedin.com/checkpoint/challenge/AbC123?token=SECRETTOK&next=%2Fsales"
        page = base.FakePage(base.pager(5), url=url)
        page.goto = lambda u, wait_until=None: None
        _, code = base.run(page, base.plan(), self.out)
        self.assertEqual(code, session.EXIT_AUTH)
        event = base.records(self.out)[0]
        self.assertEqual(event, {"event": "not_signed_in", "path": "/checkpoint/challenge"})
        self.assertNotIn("SECRETTOK", self.out.read_text())
        self.assertNotIn("linkedin.com", self.out.read_text())

    def test_safe_path_drops_ids_and_hosts(self):
        self.assertEqual(session.safe_path("https://www.linkedin.com/in/jane-doe-123/details?x=1"), "/in/*")
        self.assertEqual(session.safe_path("https://www.linkedin.com/login?session_redirect=%2Fsales"), "/login")
        self.assertEqual(session.safe_path("https://www.linkedin.com/"), "/")

    def test_signed_in_matches_path_segments_not_substrings_of_the_whole_url(self):
        cases = {
            "https://www.linkedin.com/sales/home": True,
            "https://www.linkedin.com/sales/people/uas-brands": True,  # "uas" inside a segment is not /uas/
            "https://www.linkedin.com/sales/search/people?query=(login)": True,  # query text is not the path
            "https://evil.example/?next=/sales/home": False,  # /sales/ only in the query
            "https://evil.example/login/sales/x": False,
            "https://www.linkedin.com/uas/login?session_redirect=/sales/": False,
            "https://www.linkedin.com/sales/login": False,
            "https://www.linkedin.com/salesforce/home": False,  # "sales" must be a whole segment
            "about:blank": False,
            "": False,
        }
        for url, want in cases.items():
            with self.subTest(url=url):
                self.assertEqual(session.signed_in(url, None), want)

    def test_host_suffix_option(self):
        auth = {"host_suffix": "linkedin.com"}
        self.assertTrue(session.signed_in("https://www.linkedin.com/sales/home", auth))
        self.assertTrue(session.signed_in("https://linkedin.com/sales/home", auth))
        self.assertFalse(session.signed_in("https://evil.example/sales/home", auth))
        self.assertFalse(session.signed_in("https://notlinkedin.com/sales/home", auth))


# ----------------------------------------------------------------------------- C and D: snippets and tabs

class SnippetOrderAndTabs(unittest.TestCase):
    def test_vetted_page_dir_wins_over_plan_dir_and_extras(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = Path(tmp) / "skill"
            (skill / "runtime").mkdir(parents=True)
            (skill / "page").mkdir()
            (skill / "page" / "count.js").write_text("async () => 'vetted'")
            plan_dir, extra = Path(tmp) / "plans", Path(tmp) / "extra"
            for d in (plan_dir, extra):
                d.mkdir()
                (d / "count.js").write_text("async () => 'impostor'")
            (plan_dir / "plan.json").write_text("{}")
            dirs = session.default_snippet_dirs([str(extra)], str(plan_dir / "plan.json"), here=skill / "runtime")
            self.assertEqual(dirs[0], skill / "page")
            self.assertEqual(dirs[2], plan_dir.resolve())  # the plan's folder is second after the vetted ones
            self.assertEqual(dirs[3], extra)
            self.assertEqual(session.load_snippet("count.js", dirs), "async () => 'vetted'")
            (plan_dir / "mine.js").write_text("async () => 'plan-local'")
            self.assertEqual(session.load_snippet("mine.js", dirs), "async () => 'plan-local'")  # still found after

    def test_snippet_names_cannot_climb_out_of_a_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "a").mkdir()
            (Path(tmp) / "secret.js").write_text("async () => 1")
            with self.assertRaises(ValueError):
                session.load_snippet("../secret.js", [Path(tmp) / "a"])

    def test_cdp_with_no_sales_tab_opens_a_new_page_and_leaves_other_tabs_alone(self):
        other = base.FakePage(lambda e, a: None, url="https://mail.example.com/inbox")
        went = []
        other.goto = lambda u, wait_until=None: went.append(u)
        browser = FakeBrowser([other])
        page = session.pick_page(browser)
        self.assertIsNot(page, other)
        self.assertEqual(browser.contexts[0].created, [page])
        self.assertEqual((went, other.url), ([], "https://mail.example.com/inbox"))

    def test_cdp_reuses_an_open_sales_tab(self):
        other = base.FakePage(lambda e, a: None, url="https://mail.example.com/")
        sales = base.FakePage(lambda e, a: None, url="https://www.linkedin.com/sales/search/people?x=1")
        browser = FakeBrowser([other, sales])
        self.assertIs(session.pick_page(browser), sales)
        self.assertEqual(browser.contexts[0].created, [])

    def test_a_lookalike_url_is_not_a_sales_tab(self):
        fake = base.FakePage(lambda e, a: None, url="https://evil.example/linkedin.com/sales/x?u=linkedin.com/sales")
        browser = FakeBrowser([fake])
        self.assertIsNot(session.pick_page(browser), fake)

    def test_cloud_browser_reuses_its_own_first_blank_tab(self):
        blank = base.FakePage(lambda e, a: None, url="about:blank")
        browser = FakeBrowser([blank])
        self.assertIs(session.pick_page(browser, reuse_first=True), blank)
        self.assertEqual(browser.contexts[0].created, [])

    def test_main_cdp_runtime_does_not_navigate_an_unrelated_tab(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.json"
            plan_path.write_text(json.dumps(simple_plan()))
            other = base.FakePage(lambda e, a: None, url="https://mail.example.com/inbox")
            went = []
            other.goto = lambda u, wait_until=None: went.append(u)
            browser = FakeBrowser([other])
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.object(session, "import_playwright", lambda: fake_playwright(browser)), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = session.main(["--runtime", "cdp", "--cdp-url", "http://127.0.0.1:9222",
                                     "--plan", str(plan_path), "--out", str(Path(tmp) / "o.jsonl")])
            self.assertEqual(code, 0, err.getvalue())
            self.assertEqual(went, [])
            self.assertEqual(len(browser.contexts[0].created), 1)


class MainSecrets(MainHarness):
    def test_connect_failure_never_prints_the_cdp_url_or_claim(self):
        boom = RuntimeError("connect_over_cdp failed for %s (host cloud-7f3a.example.net)" % CDP)
        code, out, err, _ = self.main(self.ab_args(), playwright=fake_playwright(FakeBrowser([]), connect_error=boom))
        self.assertEqual(code, session.EXIT_BROWSER)
        for leaked in ("0a1b2c3d", "cloud-7f3a", CLAIM, HB):
            self.assertNotIn(leaked, out + err)

    def test_results_that_echo_the_cdp_url_are_redacted_in_the_file(self):
        page = self.sales_page(lambda e, a: {"status": 200, "rows": 0, "echo": "on %s" % CDP})
        code, _, err, _ = self.main(self.ab_args(), playwright=fake_playwright(FakeBrowser([page])))
        self.assertEqual(code, 0, err)
        text = self.out.read_text()
        self.assertNotIn("0a1b2c3d", text)
        self.assertNotIn("cloud-7f3a", text)


# ----------------------------------------------------------------------------- E: heartbeat loss

class HeartbeatLoss(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "r.jsonl"

    def test_a_4xx_answer_marks_the_session_lost(self):
        def refuse(stage, rows):
            raise http_error(410)
        hb = session.Heartbeat(refuse)
        hb.beat()
        self.assertTrue(hb.lost)
        self.assertIn("410", hb.lost_reason)

    def test_three_failures_in_a_row_mark_it_lost_and_a_success_resets_the_count(self):
        results = iter([OSError("a"), OSError("b"), None, OSError("c"), OSError("d"), OSError("e")])

        def flaky(stage, rows):
            outcome = next(results)
            if outcome:
                raise outcome
        hb = session.Heartbeat(flaky)
        for _ in range(3):
            hb.beat()
        self.assertFalse(hb.lost)  # two failures, then a success
        self.assertEqual(hb.consecutive, 0)
        for _ in range(3):
            hb.beat()
        self.assertTrue(hb.lost)
        self.assertIn("3", hb.lost_reason)

    def test_a_5xx_is_a_blip_until_it_repeats(self):
        def blip(stage, rows):
            raise http_error(503)
        hb = session.Heartbeat(blip)
        hb.beat()
        hb.beat()
        self.assertFalse(hb.lost)
        hb.beat()
        self.assertTrue(hb.lost)

    def test_runner_checkpoints_and_exits_4_when_the_heartbeat_is_lost_mid_run(self):
        hb = session.Heartbeat(lambda s, r: None)
        state = {"n": 0}

        def respond(expression, arg):
            state["n"] += 1
            if state["n"] == 1:
                hb.lost, hb.lost_reason = True, "HTTP 410"  # the connector reclaimed the browser
            return base.pager(500)(expression, arg)
        runner, code = base.run(base.FakePage(respond), base.plan(), self.out, heartbeat=hb)
        self.assertEqual(code, session.EXIT_CHECKPOINT)
        recs = base.records(self.out)
        cp = [r for r in recs if r.get("event") == "checkpoint"][0]
        self.assertIn("heartbeat", cp["reason"])
        self.assertEqual(cp["next_id"], "leads#25")
        self.assertEqual([r["id"] for r in recs if "id" in r], ["leads#0"])  # no work on a dead browser
        self.assertEqual(state["n"], 1)

    def test_runner_does_not_start_when_the_heartbeat_was_already_lost(self):
        hb = session.Heartbeat(lambda s, r: None)
        hb.lost, hb.lost_reason = True, "HTTP 403"
        page = base.FakePage(base.pager(10))
        _, code = base.run(page, base.plan(), self.out, heartbeat=hb)
        self.assertEqual(code, session.EXIT_CHECKPOINT)
        self.assertEqual(page.calls, [])


# ----------------------------------------------------------------------------- G: exit codes

class ExitCodes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "r.jsonl"

    def last(self):
        return base.records(self.out)[-1]

    def test_a_failed_call_makes_the_run_exit_8_and_the_summary_says_so(self):
        _, code = base.run(base.FakePage(base.pager(30, fail_at=0, status=400)), base.plan(), self.out)
        self.assertEqual(code, session.EXIT_INCOMPLETE)
        end = self.last()
        self.assertEqual((end["event"], end["code"], end["failed"]), ("ended", 8, 1))

    def test_a_cap_truncated_paged_call_exits_8(self):
        the_plan = base.plan()
        the_plan["calls"][0]["pages"]["cap"] = 50
        runner, code = base.run(base.FakePage(base.pager(5000)), the_plan, self.out)
        self.assertEqual(code, session.EXIT_INCOMPLETE)
        self.assertEqual(runner.truncated, ["leads"])
        self.assertTrue([r for r in base.records(self.out) if r.get("event") == "truncated"])
        self.assertEqual(self.last()["truncated"], 1)

    def test_a_page_limited_call_exits_8_and_an_exhausted_one_exits_0(self):
        the_plan = base.plan()
        the_plan["calls"][0]["pages"]["max_pages"] = 2
        _, code = base.run(base.FakePage(base.pager(500)), the_plan, self.out)
        self.assertEqual(code, session.EXIT_INCOMPLETE)
        self.out.unlink()
        runner, code = base.run(base.FakePage(base.pager(60)), base.plan(), self.out)
        self.assertEqual((code, runner.truncated, self.last()["event"]), (session.EXIT_OK, [], "done"))

    def test_an_early_empty_page_is_truncation_not_completion(self):
        def respond(expression, arg):
            if arg["start"] >= 25:
                return {"status": 200, "total": 100, "rows": 0, "elements": []}
            return base.pager(100)(expression, arg)
        _, code = base.run(base.FakePage(respond), base.plan(), self.out)
        self.assertEqual(code, session.EXIT_INCOMPLETE)

    def test_a_clean_run_still_exits_0(self):
        _, code = base.run(base.FakePage(base.pager(40)), base.plan(), self.out)
        self.assertEqual(code, session.EXIT_OK)

    def test_a_sample_plan_that_stops_early_on_purpose_exits_0(self):
        the_plan = base.plan(sample=True)
        the_plan["calls"][0]["pages"]["max_pages"] = 2
        runner, code = base.run(base.FakePage(base.pager(5000)), the_plan, self.out)
        self.assertEqual((code, runner.truncated, runner.sampled), (session.EXIT_OK, [], ["leads"]))
        events = [r.get("event") for r in base.records(self.out)]
        self.assertIn("sampled", events)
        self.assertNotIn("truncated", events)
        end = self.last()
        self.assertEqual((end["event"], end["sampled"], end["truncated"]), ("done", 1, 0))

    def test_sample_can_be_set_on_one_call_and_a_call_overrides_the_plan(self):
        the_plan = base.plan()
        the_plan["calls"][0]["sample"] = True
        the_plan["calls"][0]["pages"]["max_pages"] = 2
        _, code = base.run(base.FakePage(base.pager(5000)), the_plan, self.out)
        self.assertEqual(code, session.EXIT_OK)
        self.out.unlink()
        the_plan = base.plan(sample=True)
        the_plan["calls"][0]["sample"] = False
        the_plan["calls"][0]["pages"]["max_pages"] = 2
        _, code = base.run(base.FakePage(base.pager(5000)), the_plan, self.out)
        self.assertEqual(code, session.EXIT_INCOMPLETE)

    def test_a_sample_does_not_hide_a_failed_call_or_an_empty_page(self):
        _, code = base.run(base.FakePage(base.pager(30, fail_at=0, status=400)), base.plan(sample=True), self.out)
        self.assertEqual(code, session.EXIT_INCOMPLETE)
        self.out.unlink()

        def respond(expression, arg):
            if arg["start"] >= 25:
                return {"status": 200, "total": 100, "rows": 0, "elements": []}
            return base.pager(100)(expression, arg)
        runner, code = base.run(base.FakePage(respond), base.plan(sample=True), self.out)
        self.assertEqual((code, runner.truncated), (session.EXIT_INCOMPLETE, ["leads"]))

    def test_plan_without_sample_still_truncates(self):
        the_plan = base.plan()
        the_plan["calls"][0]["pages"]["max_pages"] = 2
        runner, code = base.run(base.FakePage(base.pager(5000)), the_plan, self.out)
        self.assertEqual((code, runner.sampled), (session.EXIT_INCOMPLETE, []))


# ----------------------------------------------------------------------------- H: plan validation and budgets

class PlanValidation(unittest.TestCase):
    def check(self, **extra):
        the_plan = simple_plan()
        the_plan.update(extra)
        return session.validate_plan(the_plan)

    def test_a_good_plan_has_no_problems(self):
        self.assertEqual(session.validate_plan(base.plan()), [])
        self.assertEqual(self.check(delay_ms=[2000, 2500], stop_on_status=[403, 429, 599]), [])

    def test_sample_must_be_boolean_on_the_plan_and_on_a_call(self):
        self.assertEqual(self.check(sample=True), [])
        the_plan = base.plan()
        the_plan["calls"][0]["sample"] = "yes"
        self.assertTrue(any("sample" in p for p in session.validate_plan(the_plan)))
        the_plan["calls"][0]["sample"] = True
        self.assertEqual(session.validate_plan(the_plan), [])

    def test_each_unsafe_setting_is_rejected(self):
        bad = {
            "empty stop_on_status": {"stop_on_status": []},
            "non-list stop_on_status": {"stop_on_status": "403"},
            "zero delay": {"delay_ms": [0, 0]},
            "delay under the minimum": {"delay_ms": [1000, 5000]},
            "inverted delay": {"delay_ms": [5000, 3000]},
            "http start_url": {"start_url": "http://www.linkedin.com/sales/home"},
            "tiny evaluate timeout": {"evaluate_timeout_ms": 10},
            "total pages over the hard ceiling": {"max_pages_total": 81},
            "no calls": {"calls": []},
            "non-boolean sample": {"sample": "yes"},
        }
        for label, extra in bad.items():
            with self.subTest(label=label):
                self.assertTrue(self.check(**extra), label)

    def test_call_level_problems(self):
        def with_call(**call):
            the_plan = simple_plan()
            the_plan["calls"] = [dict({"id": "c", "js": "async () => 1"}, **call)]
            return session.validate_plan(the_plan)
        self.assertEqual(with_call(), [])
        self.assertTrue(with_call(id=""))
        self.assertTrue(with_call(id="a#1"))
        self.assertTrue(with_call(snippet="count.js"))  # both snippet and js
        self.assertTrue(with_call(js=None))  # neither
        self.assertTrue(with_call(params={"delayMs": 0}))
        self.assertTrue(with_call(pages={"max_pages": 81}))
        self.assertTrue(with_call(pages={"step": 26}))
        self.assertTrue(with_call(pages={"step": 0}))
        self.assertEqual(with_call(pages={"max_pages": 80, "step": 25}), [])
        dup = simple_plan()
        dup["calls"] = [{"id": "c", "js": "async () => 1"}, {"id": "c", "js": "async () => 2"}]
        self.assertTrue([p for p in session.validate_plan(dup) if "duplicate" in p])
        noid = simple_plan()
        noid["calls"] = [{"js": "async () => 1"}]
        self.assertTrue(session.validate_plan(noid))

    def test_named_snippets_must_exist(self):
        the_plan = simple_plan()
        the_plan["calls"] = [{"id": "c", "snippet": "csrf_ready.js"}, {"id": "d", "snippet": "nope.js"}]
        problems = session.validate_plan(the_plan, [PAGE])
        self.assertEqual(len(problems), 1)
        self.assertIn("nope.js", problems[0])

    def test_every_plan_example_in_the_docs_is_valid(self):
        text = (ROOT / "skills" / "sales-navigator" / "references" / "fast-path.md").read_text()
        block = re.search(r"```json\n(\{\n  \"start_url\".*?\n\})\n```", text, re.S).group(1)
        self.assertEqual(session.validate_plan(json.loads(block)), [])

    def test_page_budget_constants_match_guardrails(self):
        md = (ROOT / "skills" / "sales-navigator" / "references" / "guardrails.md").read_text()
        row = [l for l in md.splitlines() if l.startswith("| Search result pages read")][0]
        cells = [c.strip() for c in row.strip("|").split("|")]
        self.assertEqual(int(re.match(r"\d+", cells[1]).group()), session.DEFAULT_MAX_PAGES)
        self.assertEqual(int(re.match(r"\d+", cells[2]).group()), session.HARD_MAX_PAGES)


class PageBudget(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "r.jsonl"

    def pages_run(self, page):
        return len([c for c in page.calls if c[1] and "start" in c[1]])

    def test_default_cap_is_the_guardrails_daily_default_not_cap_over_step(self):
        page = base.FakePage(base.pager(5000))
        runner, code = base.run(page, base.plan(), self.out)  # cap 2500 / step 25 would be 100 pages
        self.assertEqual(self.pages_run(page), session.DEFAULT_MAX_PAGES)
        self.assertEqual(code, session.EXIT_INCOMPLETE)  # rows were left unread

    def test_an_explicit_higher_value_up_to_the_hard_ceiling_is_honoured(self):
        the_plan = base.plan()
        the_plan["calls"][0]["pages"]["max_pages"] = 60
        page = base.FakePage(base.pager(5000))
        base.run(page, the_plan, self.out)
        self.assertEqual(self.pages_run(page), 60)

    def test_the_hard_ceiling_cannot_be_exceeded_even_if_validation_is_skipped(self):
        the_plan = base.plan()
        the_plan["calls"][0]["pages"]["max_pages"] = 500
        page = base.FakePage(base.pager(5000))
        base.run(page, the_plan, self.out)
        self.assertEqual(self.pages_run(page), session.HARD_MAX_PAGES)

    def test_the_run_wide_budget_stops_a_second_paged_call(self):
        the_plan = base.plan()
        first = the_plan["calls"][0]
        first["pages"]["max_pages"] = 30
        second = dict(first, id="more", pages=dict(first["pages"], max_pages=30))
        the_plan["calls"] = [first, second]
        the_plan["max_pages_total"] = 40
        page = base.FakePage(base.pager(5000))
        runner, code = base.run(page, the_plan, self.out)
        self.assertEqual(self.pages_run(page), 40)
        self.assertEqual(code, session.EXIT_CHECKPOINT)
        cp = [r for r in base.records(self.out) if r.get("event") == "checkpoint"][0]
        self.assertEqual(cp["next_id"], "more#250")
        self.assertIn("page budget", cp["reason"])


class SkipDone(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "r.jsonl"

    def test_changed_params_are_not_replayed_from_an_old_record(self):
        base.run(base.FakePage(base.pager(30)), base.plan(), self.out)
        changed = base.plan()
        changed["calls"][0]["params"] = {"query": "a different search"}
        page = base.FakePage(base.pager(30))
        runner, code = base.run(page, changed, self.out, skip_done=True)
        self.assertEqual(runner.executed, 2)  # both pages ran again
        self.assertEqual(page.calls[0][1]["query"], "a different search")

    def test_changed_inline_js_is_not_replayed(self):
        base.run(base.FakePage(base.pager(30)), base.plan(), self.out)
        changed = base.plan()
        changed["calls"][0]["js"] = "async (p) => 'search v2'"
        runner, _ = base.run(base.FakePage(base.pager(30)), changed, self.out, skip_done=True)
        self.assertEqual(runner.executed, 2)

    def test_unchanged_calls_are_replayed_and_old_records_without_a_hash_are_not(self):
        base.run(base.FakePage(base.pager(30)), base.plan(), self.out)
        recs = base.records(self.out)
        self.assertTrue(all(r["h"] for r in recs if "id" in r))
        runner, _ = base.run(base.FakePage(base.pager(30)), base.plan(), self.out, skip_done=True)
        self.assertEqual(runner.executed, 0)
        legacy = [{k: v for k, v in r.items() if k != "h"} for r in recs]
        self.out.write_text("".join(json.dumps(r) + "\n" for r in legacy))
        runner, _ = base.run(base.FakePage(base.pager(30)), base.plan(), self.out, skip_done=True)
        self.assertEqual(runner.executed, 2)


class RowsAndTimeouts(unittest.TestCase):
    def test_count_style_results_are_not_rows(self):
        counting = {"status": 200, "failed": 0, "results": [{"label": "a", "status": 200, "total": 99}] * 3}
        self.assertEqual(session.result_rows(counting), 0)
        self.assertEqual(session.result_rows({"status": 200, "results": [{"term": "x", "elements": []}]}), 0)
        self.assertEqual(session.result_rows({"elements": [1, 2]}), 2)
        self.assertEqual(session.result_rows({"companies": [1]}), 1)
        self.assertEqual(session.result_rows({"rows": 7, "elements": [1]}), 7)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "r.jsonl"
            the_plan = base.plan()
            the_plan["calls"] = [{"id": "size", "js": "async () => 1", "params": {}}]
            runner, _ = base.run(base.FakePage(lambda e, a: counting), the_plan, out)
            self.assertEqual(runner.rows, 0)

    def test_failed_count_queries_make_a_result_not_ok(self):
        self.assertFalse(session.result_ok({"status": 200, "failed": 1, "results": []}))
        self.assertTrue(session.result_ok({"status": 200, "failed": 0, "results": []}))

    def test_every_evaluate_is_wrapped_in_a_timeout_that_keeps_the_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = base.FakePage(base.pager(5))
            the_plan = base.plan(evaluate_timeout_ms=12345)
            base.run(page, the_plan, Path(tmp) / "r.jsonl")
            expression = page.calls[0][0]
            self.assertIn("12345", expression)
            self.assertIn("evaluate_timeout", expression)
            self.assertIn("async (p) => 'search'", expression)

    @unittest.skipUnless(NODE, "node not installed")
    def test_the_timeout_wrapper_resolves_fast_snippets_and_rejects_hung_ones(self):
        def evaluate(source, timeout_ms):
            code = session.wrap_js_timed(source, timeout_ms)
            script = ("Promise.resolve(eval(%s)({n: 2})).then(r => console.log('ok ' + JSON.stringify(r)),"
                      " e => console.log('err ' + e.message));" % json.dumps(code))
            proc = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return proc.stdout.strip()
        self.assertEqual(evaluate("async (p) => p.n * 2;", 5000), "ok 4")
        self.assertEqual(evaluate("async (p) => { await new Promise(() => {}); }", 60), "err evaluate_timeout")

    def test_a_pause_that_crosses_the_ceiling_checkpoints_before_the_call(self):
        clock = base.FakeClock()

        class HighRng:
            def uniform(self, lo, hi):
                return hi

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "r.jsonl"
            runner, code = base.run(base.FakePage(base.pager(100)), base.plan(), out, clock=clock,
                                    max_seconds=4, rng=HighRng())
            self.assertEqual(code, session.EXIT_CHECKPOINT)
            self.assertEqual([r["id"] for r in base.records(out) if "id" in r], ["leads#0"])


# ----------------------------------------------------------------------------- J: compact_js

class CompactJs(unittest.TestCase):
    def test_comments_go_but_strings_that_look_like_comments_stay(self):
        src = "async () => {\n  // c\n  const u = 'http://x.example/a'; // trailing\n  /* block */\n  return \"a//b\" + u;\n}\n"
        out = session.compact_js(src)
        self.assertEqual(out, "async () => {\n  const u = 'http://x.example/a';\n  return \"a//b\" + u;\n}")

    def test_escaped_quotes_do_not_end_a_string_early(self):
        src = "const s = 'it\\'s // fine'; // gone\nconst t = \"say \\\"//\\\"\"; // gone\n"
        self.assertEqual(session.compact_js(src), "const s = 'it\\'s // fine';\nconst t = \"say \\\"//\\\"\";")

    def test_template_literals_keep_comment_lookalikes_and_blank_lines(self):
        src = "const t = `line one // not a comment\n\n  /* nor this */ line three`; // real comment\nconst n = `a ${ x ? `in//ner` : '' } b`;\n"
        out = session.compact_js(src)
        self.assertEqual(out, "const t = `line one // not a comment\n\n  /* nor this */ line three`;\n"
                              "const n = `a ${ x ? `in//ner` : '' } b`;")

    def test_regex_literals_with_quotes_and_slashes_survive(self):
        src = "const r = /[\"']\\/\\/x/g; // c\nconst q = s.replace(/'/g, \"\"); // c\nconst half = a / b / c; // c\n"
        out = session.compact_js(src)
        self.assertEqual(out, "const r = /[\"']\\/\\/x/g;\nconst q = s.replace(/'/g, \"\");\nconst half = a / b / c;")

    def test_a_block_comment_with_a_newline_leaves_a_newline(self):
        self.assertEqual(session.compact_js("a = 1 /* c\nd */ b = 2"), "a = 1\n b = 2")

    def test_crlf_and_blank_lines(self):
        self.assertEqual(session.compact_js("a;\r\n\r\n// c\r\nb;\r\n"), "a;\nb;")

    def test_untokenizable_source_is_returned_unchanged(self):
        for src in ("// c\nconst x = 'abc\n", "// c\nconst x = `abc", "/* never closed\nx", "const r = /abc\n"):
            with self.subTest(src=src):
                self.assertEqual(session.compact_js(src), src)

    def test_emit_compact_uses_the_tokenizer(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "s.js").write_text("// header\nasync (p) => {\n  const u = 'http://a.example'; // note\n  return u + p.n;\n}\n")
            out = session.emit_expression("s.js", '{"n": 1}', [tmp], compact=True)
            self.assertEqual(out, "(\nasync (p) => {\n  const u = 'http://a.example';\n  return u + p.n;\n}\n)({\"n\": 1})")


if __name__ == "__main__":
    unittest.main()
