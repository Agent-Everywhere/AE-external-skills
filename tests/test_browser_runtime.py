"""Tests for packages/browser-runtime/session.py (no browser, no network: a fake page).

Run from the repo root:  python3 -m pytest -q tests
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "packages" / "browser-runtime"
sys.path.insert(0, str(PKG))

import session  # noqa: E402

SECRET = "claim-secret-123456"


class FakePage:
    def __init__(self, responder, url="https://www.linkedin.com/sales/home"):
        self.url = url
        self.responder = responder
        self.calls = []

    def goto(self, url, wait_until=None):
        self.url = url

    def wait_for_load_state(self, state, timeout=None):
        pass

    def wait_for_timeout(self, ms):
        pass

    def evaluate(self, expression, arg=None):
        self.calls.append((expression, arg))
        return self.responder(expression, arg)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def pager(total, fail_at=None, status=403):
    """Responder: a search endpoint with `total` rows, 25 per page."""
    def respond(expression, arg):
        if "ready" in expression:
            return {"ready": True}
        start = arg["start"]
        if fail_at is not None and start == fail_at:
            return {"status": status, "body": "nope"}
        rows = max(0, min(25, total - start))
        return {"status": 200, "total": total, "rows": rows, "elements": [{"i": start + n} for n in range(rows)]}
    return respond


def plan(**extra):
    base = {"start_url": "https://www.linkedin.com/sales/home", "settle_ms": 0, "delay_ms": [3000, 5000],
            "calls": [{"id": "leads", "js": "async (p) => 'search'", "params": {"query": "q"},
                       "pages": {"param": "start", "step": 25, "cap": 2500}}]}
    base.update(extra)
    return base


def run(page, the_plan, out, clock=None, **kw):
    clock = clock or FakeClock()
    runner = session.Runner(page, the_plan, str(out), [PKG], sleep=clock.sleep, clock=clock,
                            log=lambda m: None, **kw)
    return runner, runner.run()


def records(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines()]


class Helpers(unittest.TestCase):
    def test_wrap_js(self):
        self.assertEqual(session.wrap_js("  async (p) => 1;\n"), "(\nasync (p) => 1\n)")

    def test_redact(self):
        self.assertEqual(session.redact("a %s b" % SECRET, [SECRET, None, "x"]), "a [redacted] b")

    def test_signed_in(self):
        self.assertTrue(session.signed_in("https://www.linkedin.com/sales/home?x=1", None))
        for bad in ("https://www.linkedin.com/login", "https://www.linkedin.com/checkpoint/challenge",
                    "https://www.linkedin.com/uas/login", "https://www.linkedin.com/feed/"):
            self.assertFalse(session.signed_in(bad, None), bad)

    def test_result_ok(self):
        self.assertTrue(session.result_ok({"status": 200}))
        self.assertTrue(session.result_ok({"ready": True}))
        self.assertFalse(session.result_ok({"status": 403}))
        self.assertFalse(session.result_ok({"status": 200, "error": "x"}))
        self.assertFalse(session.result_ok(None))

    def test_heartbeat_posts_stage_and_rows(self):
        sent = []
        hb = session.Heartbeat(lambda stage, rows: sent.append((stage, rows)))
        hb.stage, hb.rows = "leads#25", 50
        hb.beat()
        self.assertEqual(sent, [("leads#25", 50)])

    def test_heartbeat_swallows_errors(self):
        def boom(stage, rows):
            raise OSError("down")
        hb = session.Heartbeat(boom)
        hb.beat()
        self.assertEqual((hb.beats, hb.errors), (0, 1))

    def test_heartbeat_thread_beats_and_stops(self):
        sent = []
        hb = session.Heartbeat(lambda s, r: sent.append(s), interval=0.01)
        hb.start()
        deadline = __import__("time").time() + 2
        while not sent and __import__("time").time() < deadline:
            __import__("time").sleep(0.01)
        hb.stop()
        hb.join(2)
        self.assertTrue(sent)
        self.assertFalse(hb.is_alive())

    def test_snippet_lookup(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "s.js").write_text("async () => 1")
            self.assertEqual(session.load_snippet("s.js", [d]), "async () => 1")
            with self.assertRaises(FileNotFoundError):
                session.load_snippet("nope.js", [d])

    def test_emit_expression(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "s.js").write_text("// c\nasync (p) => p.n;\n")
            out = session.emit_expression("s.js", '{"n": 2}', [d])
            self.assertTrue(out.startswith("(\n// c\nasync (p) => p.n\n)"))
            self.assertTrue(out.endswith('({"n": 2})'))


    def test_emit_compact_and_return_forms(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "s.js").write_text("// c\nasync (p) => {\n  // inner\n\n  return p.n;\n}\n")
            out = session.emit_expression("s.js", '{"n": 2}', [d], compact=True)
            self.assertEqual(out, '(\nasync (p) => {\n  return p.n;\n}\n)({"n": 2})')
            ret = session.emit_expression("s.js", '{"n": 2}', [d], compact=True, form="return")
            self.assertEqual(ret, "return await " + out)

    def test_emit_cli_flags(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "s.js").write_text("// c\nasync (p) => p.n")
            proc = subprocess.run([sys.executable, str(PKG / "session.py"), "--emit", "s.js", "--params", '{"n":1}',
                                   "--snippets-dir", d, "--compact", "--form", "return"],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.strip(), 'return await (\nasync (p) => p.n\n)({"n": 1})')


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "results.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def test_paging_streams_one_record_per_page_and_stops_at_total(self):
        page = FakePage(pager(60))
        runner, code = run(page, plan(), self.out)
        self.assertEqual(code, session.EXIT_OK)
        recs = records(self.out)
        calls = [r for r in recs if "id" in r]
        self.assertEqual([r["id"] for r in calls], ["leads#0", "leads#25", "leads#50"])
        self.assertEqual([r["result"]["rows"] for r in calls], [25, 25, 10])
        self.assertTrue(all(r["ok"] for r in calls))
        self.assertEqual(recs[-1]["event"], "done")
        self.assertEqual(runner.rows, 60)
        # params carried the page offset and the step as count
        self.assertEqual(page.calls[0][1], {"query": "q", "start": 0, "count": 25})
        self.assertEqual(page.calls[2][1]["start"], 50)

    def test_pacing_pauses_between_calls_but_not_before_the_first(self):
        clock = FakeClock()
        run(FakePage(pager(60)), plan(), self.out, clock=clock)
        # 3 pages -> 2 pauses of 3-5s
        self.assertGreaterEqual(clock.now, 6.0)
        self.assertLessEqual(clock.now, 10.0)

    def test_cap_limits_paging(self):
        the_plan = plan()
        the_plan["calls"][0]["pages"]["cap"] = 50
        run(FakePage(pager(5000)), the_plan, self.out)
        ids = [r["id"] for r in records(self.out) if "id" in r]
        self.assertEqual(ids, ["leads#0", "leads#25"])

    def test_stops_on_403_and_does_not_continue(self):
        page = FakePage(pager(100, fail_at=25))
        runner, code = run(page, plan(), self.out)
        self.assertEqual(code, session.EXIT_STOPPED)
        recs = records(self.out)
        self.assertEqual([r["id"] for r in recs if "id" in r], ["leads#0", "leads#25"])
        self.assertEqual(recs[-1]["event"], "ended")
        self.assertEqual([r for r in recs if r.get("event") == "stopped"][0]["status"], 403)
        self.assertEqual(len(page.calls), 2)  # two pages, no retry after the 403

    def test_429_stops_too_and_other_failures_do_not(self):
        _, code = run(FakePage(pager(100, fail_at=0, status=429)), plan(), self.out)
        self.assertEqual(code, session.EXIT_STOPPED)
        self.out.unlink()
        two = plan()
        two["calls"] = [dict(two["calls"][0], id="a"), dict(two["calls"][0], id="b")]
        _, code = run(FakePage(pager(30, fail_at=0, status=400)), two, self.out)
        self.assertEqual(code, session.EXIT_INCOMPLETE)  # a 400 fails that call, the run goes on, exit is non-zero
        recs = [r for r in records(self.out) if "id" in r]
        self.assertEqual([(r["id"], r["ok"]) for r in recs], [("a#0", False), ("b#0", False)])

    def test_skip_done_resumes_without_repeating_ok_calls(self):
        run(FakePage(pager(100, fail_at=50)), plan(), self.out)  # pages 0, 25 ok; 50 -> 403
        page = FakePage(pager(100))
        runner, code = run(page, plan(), self.out, skip_done=True)
        self.assertEqual(code, session.EXIT_OK)
        started = [a["start"] for _, a in page.calls if a and "start" in a]
        self.assertEqual(started, [50, 75])  # 0 and 25 replayed from the file, only 50 and 75 executed
        self.assertEqual(runner.executed, 2)

    def test_failed_records_are_not_treated_as_done(self):
        self.out.write_text(json.dumps({"id": "leads#0", "ok": False, "result": {"status": 400}}) + "\n")
        self.assertEqual(session.read_done(self.out), {})

    def test_checkpoint_when_time_ceiling_reached(self):
        clock = FakeClock()

        class LowRng:
            def uniform(self, lo, hi):
                return lo

        # every pause advances the fake clock 3s; the ceiling is checked again AFTER each pause, so a
        # pause that crosses it (the third page: 3s + 3s >= 4s) checkpoints before that page runs
        runner, code = run(FakePage(pager(100)), plan(), self.out, clock=clock, max_seconds=4, rng=LowRng())
        self.assertEqual(code, session.EXIT_CHECKPOINT)
        recs = records(self.out)
        cp = [r for r in recs if r.get("event") == "checkpoint"][0]
        self.assertEqual(cp["next_id"], "leads#50")
        self.assertEqual([r["id"] for r in recs if "id" in r], ["leads#0", "leads#25"])

    def test_not_signed_in_runs_no_calls(self):
        page = FakePage(pager(10), url="https://www.linkedin.com/login")
        page.goto = lambda url, wait_until=None: None  # stays on the login page
        runner, code = run(page, plan(), self.out)
        self.assertEqual(code, session.EXIT_AUTH)
        self.assertEqual(page.calls, [])
        self.assertEqual(records(self.out)[0]["event"], "not_signed_in")

    def test_ready_snippet_retries_then_proceeds(self):
        state = {"n": 0}

        def respond(expression, arg):
            if "ready" in expression:
                state["n"] += 1
                return {"ready": state["n"] >= 3}
            return pager(5)(expression, arg)
        the_plan = plan(ready={"js": "async () => 'ready'", "retries": 5, "interval_ms": 10})
        _, code = run(FakePage(respond), the_plan, self.out)
        self.assertEqual((code, state["n"]), (session.EXIT_OK, 3))

    def test_never_ready_exits_7(self):
        the_plan = plan(ready={"js": "async () => 'ready'", "retries": 2, "interval_ms": 10})
        _, code = run(FakePage(lambda e, a: {"ready": False}), the_plan, self.out)
        self.assertEqual(code, session.EXIT_NOT_READY)

    def test_page_exception_is_recorded_and_exit_6(self):
        def boom(expression, arg):
            raise RuntimeError("Target closed")
        _, code = run(FakePage(boom), plan(), self.out)
        self.assertEqual(code, session.EXIT_BROWSER)
        self.assertEqual(records(self.out)[-1]["event"], "error")

    def test_secrets_are_redacted_from_output(self):
        def leaky(expression, arg):
            return {"status": 200, "rows": 0, "note": "see %s here" % SECRET}
        the_plan = plan()
        the_plan["calls"] = [{"id": "x", "js": "async () => 1", "params": {}}]
        run(FakePage(leaky), the_plan, self.out, secrets=[SECRET])
        text = self.out.read_text()
        self.assertNotIn(SECRET, text)
        self.assertIn("[redacted]", text)

    def test_heartbeat_stage_tracks_current_call(self):
        sent = []
        hb = session.Heartbeat(lambda s, r: sent.append((s, r)))
        runner, _ = run(FakePage(pager(30)), plan(), self.out, heartbeat=hb)
        self.assertTrue(hb.stage.startswith("leads#"))

    def test_unpaged_call_runs_once(self):
        the_plan = plan()
        the_plan["calls"] = [{"id": "size", "js": "async () => 1", "params": {"count": 1}}]
        page = FakePage(lambda e, a: {"status": 200, "total": 99, "rows": 1, "elements": [{}]})
        run(page, the_plan, self.out)
        self.assertEqual([r["id"] for r in records(self.out) if "id" in r], ["size"])


class CommandLine(unittest.TestCase):
    def test_help_and_usage(self):
        proc = subprocess.run([sys.executable, str(PKG / "session.py"), "--help"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("agent-browser", proc.stdout)
        proc = subprocess.run([sys.executable, str(PKG / "session.py")], capture_output=True, text=True)
        self.assertEqual(proc.returncode, session.EXIT_USAGE)

    def test_emit_prints_paste_ready_expression(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "s.js").write_text("async (p) => p.n")
            proc = subprocess.run([sys.executable, str(PKG / "session.py"), "--emit", "s.js",
                                   "--params", '{"n":1}', "--snippets-dir", d], capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.strip(), '(\nasync (p) => p.n\n)({"n": 1})')

    def test_agent_browser_requires_claim_and_base(self):
        with tempfile.TemporaryDirectory() as d:
            plan_path = Path(d) / "plan.json"
            plan_path.write_text("{}")
            env = {"PATH": "/usr/bin:/bin"}
            proc = subprocess.run([sys.executable, str(PKG / "session.py"), "--runtime", "agent-browser",
                                   "--plan", str(plan_path), "--out", str(Path(d) / "o.jsonl")],
                                  capture_output=True, text=True, env=env)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("--claim and --base", proc.stderr)


if __name__ == "__main__":
    unittest.main()
