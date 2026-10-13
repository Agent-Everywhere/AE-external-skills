#!/usr/bin/env python3
"""Generic browser-plan runner for the AE browser skills.

Connects to a signed-in browser over CDP, opens (or reuses) a page, waits for it to settle, then
runs a JSON plan: an ordered list of JS snippet calls executed inside the page. Every call's result
is appended to a JSONL file and flushed before the next call, so an interruption loses nothing.

Runtimes
  agent-browser  --claim <one-use claim> --base <connector base URL>
                 Claims the cloud browser (POST <base>/browser/claim), reports the auth probe
                 (POST <base>/browser/auth), and heartbeats from a thread (<= 60s apart).
                 The cloud browser DIES when this process disconnects: run the whole plan, for
                 one session, in ONE invocation.
  cdp            --cdp-url http://127.0.0.1:9222
                 Attaches to the user's own Chrome (started with --remote-debugging-port).

This file is the one place in the repo that touches the network (claim/auth/heartbeat, plus
Playwright's CDP socket). Skill scripts under skills/<name>/scripts stay stdlib and no-network.
Dependencies: Python 3 standard library and `playwright` (pip install playwright; no browser
download needed, because it connects to an existing browser).

Plan file (JSON)
  {
    "start_url": "https://www.linkedin.com/sales/home",   # goto this first (omit with --no-goto)
    "settle_ms": 3000,                                       # extra wait after networkidle
    "auth": {"url_contains": "/sales/",                      # signed-in probe on the landed URL
             "url_not_contains": ["login", "checkpoint", "authwall", "uas"]},
    "ready": {"snippet": "csrf_ready.js", "retries": 5, "interval_ms": 2000},
    "delay_ms": [3000, 5000],                                # random pause between executed calls
    "stop_on_status": [403, 429],                            # stop the whole run on these
    "calls": [
      {"id": "count-1", "snippet": "count.js", "params": {"kind": "lead", "query": "..."}},
      {"id": "leads-1", "snippet": "lead_search.js", "params": {"query": "..."},
       "pages": {"param": "start", "step": 25, "cap": 2500, "max_pages": 100}}
    ]
  }

A snippet is a JS file whose content is ONE async function expression taking a params object
and returning JSON: `async (params) => { ... }`. A call may use "js" (inline source) instead of
"snippet". Paged calls write one record per page with id "<id>#<start>".

Output JSONL (one object per line): {"id", "ok", "ms", "ts", "result"} per call, plus
{"event": ...} lines (ready, not_signed_in, checkpoint, stopped, error, done).

Resume: re-run with the same --out and --skip-done; calls whose id already has an ok record are
skipped (their stored result still drives paging).

Exit codes: 0 done, 2 usage, 3 not signed in, 4 checkpoint (time ceiling; reopen and resume),
5 stopped on a stop status, 6 browser/page error, 7 page never became ready.

Secrets: the claim, CDP URL and heartbeat token are redacted from everything printed or written.
Snippets must never return cookies or tokens; this runner never reads them.
"""
import argparse
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

EXIT_OK, EXIT_USAGE, EXIT_AUTH, EXIT_CHECKPOINT, EXIT_STOPPED, EXIT_BROWSER, EXIT_NOT_READY = (
    0, 2, 3, 4, 5, 6, 7)

# The agent-browser lease is a hard 40 minutes; checkpoint before it, with margin to flush.
DEFAULT_MAX_SECONDS = 2280
HEARTBEAT_EVERY = 25  # seconds; the connector requires <= 60

DEFAULT_AUTH = {"url_contains": "/sales/",
                "url_not_contains": ["login", "checkpoint", "authwall", "uas"]}


# ----------------------------------------------------------------------------- helpers

def redact(text, secrets):
    """Replace every known secret in `text` (str) with a marker."""
    text = str(text)
    for secret in secrets:
        if secret and len(str(secret)) >= 6:
            text = text.replace(str(secret), "[redacted]")
    return text


def post_json(base, path, body, timeout=30):
    """POST a JSON body to base+path; return the decoded JSON object ({} when empty)."""
    req = urllib.request.Request(
        base.rstrip("/") + path, data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def wrap_js(source):
    """Turn a snippet file's text into a single JS expression Playwright can evaluate."""
    body = source.strip()
    while body.endswith(";"):
        body = body[:-1].rstrip()
    return "(\n" + body + "\n)"


def load_snippet(ref, dirs):
    """Read snippet `ref` (a path or a bare file name) from the first directory that has it."""
    candidates = [Path(ref)] if os.path.isabs(ref) else [Path(d) / ref for d in dirs]
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise FileNotFoundError("snippet %r not found in: %s" % (ref, ", ".join(str(d) for d in dirs)))


def read_done(out_path):
    """Map id -> record for every ok record already in the JSONL (for --skip-done)."""
    done = {}
    path = Path(out_path)
    if not path.is_file():
        return done
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("ok") and rec.get("id"):
            done[rec["id"]] = rec
    return done


def result_ok(result):
    if not isinstance(result, dict):
        return result is not None
    if result.get("error"):
        return False
    status = result.get("status")
    return status is None or status == 200


def result_rows(result):
    if not isinstance(result, dict):
        return 0
    if isinstance(result.get("rows"), int):
        return result["rows"]
    for key in ("elements", "companies", "results"):
        if isinstance(result.get(key), list):
            return len(result[key])
    return 0


def signed_in(url, auth):
    """Signed-in probe on a landed URL (no page content is read)."""
    url = (url or "").split("?")[0].lower()
    need = (auth or {}).get("url_contains", DEFAULT_AUTH["url_contains"])
    bad = (auth or {}).get("url_not_contains", DEFAULT_AUTH["url_not_contains"])
    return (not need or need.lower() in url) and not any(b.lower() in url for b in bad)


class Heartbeat(threading.Thread):
    """Posts a heartbeat every `interval` seconds until stopped (agent-browser only)."""

    def __init__(self, post, interval=HEARTBEAT_EVERY, log=None):
        super().__init__(daemon=True)
        self._post = post
        self._interval = interval
        self._log = log or (lambda msg: None)
        self._halt = threading.Event()
        self.stage = "starting"
        self.rows = 0
        self.beats = 0
        self.errors = 0

    def beat(self):
        try:
            self._post(self.stage, self.rows)
            self.beats += 1
        except Exception as exc:  # network blip: keep going, the next beat may succeed
            self.errors += 1
            self._log("heartbeat error: %s" % str(exc)[:120])

    def run(self):
        while not self._halt.wait(self._interval):
            self.beat()

    def stop(self):
        self._halt.set()


# ----------------------------------------------------------------------------- runner

class Runner:
    """Runs a plan against `page` (anything with evaluate/goto/wait_for_*), streaming JSONL."""

    def __init__(self, page, plan, out_path, snippet_dirs, secrets=(), heartbeat=None,
                 max_seconds=DEFAULT_MAX_SECONDS, skip_done=False, sleep=time.sleep,
                 clock=time.monotonic, rng=None, log=None):
        self.page = page
        self.plan = plan
        self.out_path = out_path
        self.snippet_dirs = [Path(d) for d in snippet_dirs]
        self.secrets = list(secrets)
        self.heartbeat = heartbeat
        self.max_seconds = max_seconds
        self.sleep = sleep
        self.clock = clock
        self.rng = rng or random.Random()
        self.log = log or (lambda msg: print(redact(msg, self.secrets), file=sys.stderr))
        self.done = read_done(out_path) if skip_done else {}
        self.stop_status = set(plan.get("stop_on_status", [403, 429]))
        self.t0 = self.clock()
        self.executed = 0
        self.ok_count = 0
        self.fail_count = 0
        self.rows = 0
        self._out = None
        self._ran_any = False

    # -- output
    def emit(self, record):
        text = redact(json.dumps(record, ensure_ascii=False, separators=(",", ":")), self.secrets)
        self._out.write(text + "\n")
        self._out.flush()

    def stage(self, name):
        if self.heartbeat:
            self.heartbeat.stage = name
            self.heartbeat.rows = self.rows

    # -- steps
    def settle(self, goto=True):
        page = self.page
        if goto and self.plan.get("start_url"):
            self.stage("goto")
            page.goto(self.plan["start_url"], wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:  # long-polling pages never go idle; the fixed wait below still applies
            pass
        page.wait_for_timeout(int(self.plan.get("settle_ms", 3000)))

    def probe_auth(self):
        """True when the landed URL looks signed in; emits an event when it does not."""
        url = self.page.url
        ok = signed_in(url, self.plan.get("auth"))
        if not ok:
            self.emit({"event": "not_signed_in", "path": url.split("?")[0]})
        return ok

    def wait_ready(self):
        spec = self.plan.get("ready")
        if not spec:
            return True
        self.stage("ready")
        for attempt in range(int(spec.get("retries", 5))):
            result = self.evaluate(spec.get("snippet"), spec.get("js"), spec.get("params", {}))
            if isinstance(result, dict) and result.get("ready"):
                self.emit({"event": "ready", "attempt": attempt + 1})
                return True
            self.sleep(int(spec.get("interval_ms", 2000)) / 1000.0)
        self.emit({"event": "not_ready"})
        return False

    def evaluate(self, snippet, js, params):
        source = js if js else load_snippet(snippet, self.snippet_dirs)
        return self.page.evaluate(wrap_js(source), params if params is not None else {})

    def pause(self):
        lo, hi = self.plan.get("delay_ms", [3000, 5000])
        if self._ran_any:
            self.sleep(self.rng.uniform(lo, hi) / 1000.0)

    def over_budget(self):
        return self.max_seconds and (self.clock() - self.t0) >= self.max_seconds

    def run_one(self, call_id, call, params):
        """Run (or replay from --skip-done) one call. Return (record, executed_bool)."""
        if call_id in self.done:
            return self.done[call_id], False
        self.pause()
        self.stage(call_id)
        started = self.clock()
        result = self.evaluate(call.get("snippet"), call.get("js"), params)
        ms = int((self.clock() - started) * 1000)
        ok = result_ok(result)
        record = {"id": call_id, "ok": ok, "ms": ms, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "result": result}
        self.emit(record)
        self._ran_any = True
        self.executed += 1
        self.ok_count += 1 if ok else 0
        self.fail_count += 0 if ok else 1
        self.rows += result_rows(result)
        self.log("%s ok=%s status=%s rows=%s" % (
            call_id, ok, result.get("status") if isinstance(result, dict) else "-", result_rows(result)))
        return record, True

    def hit_stop_status(self, record):
        result = record.get("result")
        status = result.get("status") if isinstance(result, dict) else None
        if status in self.stop_status:
            self.emit({"event": "stopped", "call": record["id"], "status": status,
                       "note": "stop-on-status: do not retry; wait and tell the user"})
            return True
        return False

    def run_calls(self):
        """Return an exit code."""
        for call in self.plan.get("calls", []):
            call_id = call.get("id") or "call-%d" % (self.executed + 1)
            if self.over_budget():
                self.emit({"event": "checkpoint", "next_id": call_id, "reason": "time ceiling"})
                return EXIT_CHECKPOINT
            pages = call.get("pages")
            if not pages:
                record, _ = self.run_one(call_id, call, call.get("params", {}))
                if self.hit_stop_status(record):
                    return EXIT_STOPPED
                continue
            code = self.run_paged(call_id, call, pages)
            if code is not None:
                return code
        return None

    def run_paged(self, call_id, call, pages):
        param = pages.get("param", "start")
        step = int(pages.get("step", 25))
        cap = int(pages.get("cap", 2500))
        max_pages = int(pages.get("max_pages", max(1, cap // step)))
        total_key = pages.get("total_key", "total")
        start, n = int(pages.get("from", 0)), 0
        while True:
            if self.over_budget():
                self.emit({"event": "checkpoint", "next_id": "%s#%d" % (call_id, start),
                           "reason": "time ceiling"})
                return EXIT_CHECKPOINT
            params = dict(call.get("params", {}))
            params[param] = start
            params.setdefault("count", step)
            record, _ = self.run_one("%s#%d" % (call_id, start), call, params)
            if self.hit_stop_status(record):
                return EXIT_STOPPED
            result = record.get("result")
            n += 1
            if not record.get("ok") or not isinstance(result, dict):
                return None
            total = result.get(total_key)
            got = result_rows(result)
            nxt = start + step
            limit = min(total, cap) if isinstance(total, int) else cap
            if got == 0 or nxt >= limit or n >= max_pages:
                return None
            start = nxt

    def run(self, goto=True):
        """Settle, probe auth, run the calls. Return (exit_code, auth_ok)."""
        with open(self.out_path, "a", encoding="utf-8") as fh:
            self._out = fh
            try:
                self.settle(goto=goto)
                auth_ok = self.probe_auth()
                if not auth_ok:
                    return EXIT_AUTH
                if not self.wait_ready():
                    return EXIT_NOT_READY
                code = self.run_calls()
                if code is None:
                    code = EXIT_OK
                self.emit({"event": "done" if code == EXIT_OK else "ended", "code": code,
                           "executed": self.executed, "ok": self.ok_count,
                           "failed": self.fail_count, "rows": self.rows,
                           "seconds": int(self.clock() - self.t0)})
                return code
            except Exception as exc:
                self.emit({"event": "error", "error": str(exc)[:300]})
                self.log("browser/page error: %s" % str(exc)[:200])
                return EXIT_BROWSER
            finally:
                self._out = None


# ----------------------------------------------------------------------------- connect + CLI

def pick_page(browser, prefer="linkedin.com/sales"):
    """Reuse an open tab on the target site, else the first tab, else a new one."""
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    for page in ctx.pages:
        if prefer in (page.url or ""):
            return page
    return ctx.pages[0] if ctx.pages else ctx.new_page()


EMIT_FORMS = ("expression", "return")


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runtime", choices=["agent-browser", "cdp"])
    ap.add_argument("--claim", default=os.environ.get("AB_CLAIM"),
                    help="one-use 60s claim from open_session (or env AB_CLAIM)")
    ap.add_argument("--base", default=os.environ.get("AB_BASE"),
                    help="connector base URL returned by open_session (or env AB_BASE)")
    ap.add_argument("--session-id", default=os.environ.get("AB_SESSION_ID"),
                    help="only needed if the claim response omits session_id")
    ap.add_argument("--cdp-url", help="CDP endpoint of the user's own Chrome (runtime cdp)")
    ap.add_argument("--plan", help="plan JSON file")
    ap.add_argument("--out", help="JSONL results file (appended)")
    ap.add_argument("--snippets-dir", action="append", default=[],
                    help="extra directory to look for snippet files (repeatable)")
    ap.add_argument("--max-seconds", type=int, default=DEFAULT_MAX_SECONDS,
                    help="checkpoint and exit after this long (default %(default)s)")
    ap.add_argument("--skip-done", action="store_true", help="skip calls with an ok record in --out")
    ap.add_argument("--no-goto", action="store_true", help="do not navigate; use the page as it is")
    ap.add_argument("--emit", metavar="SNIPPET",
                    help="print a paste-ready JS expression for a snippet (use with --params), then exit")
    ap.add_argument("--params", default="{}", help="JSON params for --emit")
    ap.add_argument("--compact", action="store_true",
                    help="--emit: drop whole-line // comments and blank lines (smaller tool call)")
    ap.add_argument("--form", choices=EMIT_FORMS, default="expression",
                    help="--emit: 'expression' = async IIFE a JS tool evaluates; 'return' = the same "
                         "prefixed with `return await`, for tools that run the code as a function body")
    return ap


def default_snippet_dirs(extra, plan_path):
    here = Path(__file__).resolve().parent
    dirs = [Path(d) for d in extra]
    if plan_path:
        dirs.append(Path(plan_path).resolve().parent)
    dirs += [here.parent / "page", here / "page", here]
    return dirs


def compact_js(source):
    """Drop whole-line // comments and blank lines. The page snippets use no multi-line strings."""
    return "\n".join(l for l in source.splitlines() if l.strip() and not l.lstrip().startswith("//"))


def emit_expression(snippet, params_json, dirs, compact=False, form="expression"):
    """One paste-ready JS expression: the snippet as an async IIFE with its params inline."""
    source = load_snippet(snippet, dirs)
    if compact:
        source = compact_js(source)
    params = json.loads(params_json)
    expr = "%s(%s)" % (wrap_js(source), json.dumps(params, ensure_ascii=False))
    return "return await " + expr if form == "return" else expr


def connect_agent_browser(args, log):
    """Claim the cloud browser. Return (cdp_url, session_id, hb_token)."""
    if not (args.claim and args.base):
        raise SystemExit("agent-browser runtime needs --claim and --base (or AB_CLAIM / AB_BASE)")
    claimed = post_json(args.base, "/browser/claim", {"claim": args.claim})
    cdp_url = claimed.get("cdp_url")
    hb_token = claimed.get("heartbeat_token")
    session_id = claimed.get("session_id") or args.session_id
    if not (cdp_url and hb_token and session_id):
        raise SystemExit("claim response missing cdp_url / heartbeat_token / session_id "
                         "(claims are one-use and expire in 60s: open a fresh session)")
    log("claimed browser session")
    return cdp_url, session_id, hb_token


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.emit:
        print(emit_expression(args.emit, args.params, default_snippet_dirs(args.snippets_dir, args.plan),
                              compact=args.compact, form=args.form))
        return EXIT_OK
    if not (args.runtime and args.plan and args.out):
        print("error: --runtime, --plan and --out are required (or use --emit)", file=sys.stderr)
        return EXIT_USAGE
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    dirs = default_snippet_dirs(args.snippets_dir, args.plan)

    secrets = [args.claim]
    log = lambda msg: print(redact(msg, secrets), file=sys.stderr, flush=True)  # noqa: E731
    heartbeat = None
    sid = token = None
    base = args.base

    if args.runtime == "agent-browser":
        cdp_url, sid, token = connect_agent_browser(args, log)
        secrets += [cdp_url, token]
    else:
        if not args.cdp_url:
            print("error: --cdp-url is required for runtime cdp", file=sys.stderr)
            return EXIT_USAGE
        cdp_url = args.cdp_url
        log("local runtime: this uses your own browser session, seat and IP")

    from playwright.sync_api import sync_playwright  # imported late: tests and --emit need no browser

    pw = sync_playwright().start()
    code = EXIT_BROWSER
    try:
        browser = pw.chromium.connect_over_cdp(cdp_url)
        page = pick_page(browser)
        if args.runtime == "agent-browser":
            heartbeat = Heartbeat(
                lambda stage, rows: post_json(base, "/browser/heartbeat", {
                    "session_id": sid, "heartbeat_token": token, "stage": stage, "rows": rows}),
                log=log)
            heartbeat.start()
        runner = Runner(page, plan, args.out, dirs, secrets=secrets, heartbeat=heartbeat,
                        max_seconds=args.max_seconds, skip_done=args.skip_done, log=log)
        # Report the auth probe to the connector as soon as the landing URL is known.
        original_probe = runner.probe_auth

        def probe_and_report():
            ok = original_probe()
            if args.runtime == "agent-browser":
                try:
                    post_json(base, "/browser/auth",
                              {"session_id": sid, "heartbeat_token": token, "signed_in": ok})
                except urllib.error.HTTPError as exc:
                    log("auth report rejected: HTTP %s" % exc.code)
                    return False
                except Exception as exc:
                    log("auth report failed: %s" % str(exc)[:120])
            return ok

        runner.probe_auth = probe_and_report
        code = runner.run(goto=not args.no_goto)
        if heartbeat:
            heartbeat.stage = "done"
            heartbeat.rows = runner.rows
            heartbeat.beat()
        summary = {"code": code, "executed": runner.executed, "ok": runner.ok_count,
                   "failed": runner.fail_count, "rows": runner.rows}
        print(json.dumps(summary))
    except SystemExit:
        raise
    except Exception as exc:
        log("fatal: %s" % str(exc)[:200])
        code = EXIT_BROWSER
    finally:
        if heartbeat:
            heartbeat.stop()
        try:
            pw.stop()  # disconnects; never browser.close() on a CDP attach
        except Exception:
            pass
    return code


if __name__ == "__main__":
    sys.exit(main())
