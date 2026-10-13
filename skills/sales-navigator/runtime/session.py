#!/usr/bin/env python3
"""Generic browser-plan runner for the AE browser skills.

Connects to a signed-in browser over CDP, opens (or reuses) a page, waits for it to settle, then
runs a JSON plan: an ordered list of JS snippet calls executed inside the page. Every call's result
is appended to a JSONL file and flushed before the next call, so an interruption loses nothing.

Runtimes
  agent-browser  AB_CLAIM=<one-use claim> --base <https connector base URL>
                 Claims the cloud browser (POST <base>/browser/claim), reports the auth probe
                 (POST <base>/browser/auth), and heartbeats from a thread (<= 60s apart).
                 Prefer the AB_CLAIM environment variable to --claim: command-line arguments are
                 visible to other local users in `ps`.
                 The cloud browser DIES when this process disconnects: run the whole plan, for
                 one session, in ONE invocation.
  cdp            --cdp-url http://127.0.0.1:9222
                 Attaches to the user's own Chrome (started with --remote-debugging-port). It
                 reuses an open linkedin.com/sales tab; if there is none it opens a NEW tab and
                 never navigates one of the user's other tabs.

This file is the one place in the repo that touches the network (claim/auth/heartbeat, plus
Playwright's CDP socket). Skill scripts under skills/<name>/scripts stay stdlib and no-network.
Dependencies: Python 3 standard library and `playwright` (pip install playwright; no browser
download needed, because it connects to an existing browser).

Plan file (JSON)
  {
    "start_url": "https://www.linkedin.com/sales/home",   # https only; goto this first (omit with --no-goto)
    "settle_ms": 3000,                                       # extra wait after networkidle
    "auth": {"url_contains": "/sales/",                      # signed-in probe on the landed URL PATH,
             "url_not_contains": ["login", "checkpoint", "authwall", "uas"],   # matched as whole path segments
             "host_suffix": "linkedin.com"},                 # optional: the landed host must be/end with this
    "ready": {"snippet": "csrf_ready.js", "retries": 5, "interval_ms": 2000},
    "delay_ms": [3000, 5000],                                # random pause between executed calls (min 2000)
    "stop_on_status": [403, 429],                            # stop the whole run on these (never empty)
    "evaluate_timeout_ms": 60000,                            # one in-page call may take at most this long
    "max_pages_total": 40,                                   # pages of paged calls executed in this run (below)
    "calls": [
      {"id": "count-1", "snippet": "count.js", "params": {"kind": "lead", "query": "..."}},
      {"id": "leads-1", "snippet": "lead_search.js", "params": {"query": "..."},
       "pages": {"param": "start", "step": 25, "cap": 2500, "max_pages": 40}}
    ]
  }

Every call needs a unique "id". A snippet is a JS file whose content is ONE async function
expression taking a params object and returning JSON: `async (params) => { ... }`. A call may use
"js" (inline source) instead of "snippet". Snippet names resolve against the skill's vetted
page/ folder FIRST, then the plan's own folder, then --snippets-dir folders. Paged calls write one
record per page with id "<id>#<start>".

Page budget: references/guardrails.md allows 40 search pages a day by default and never more than
80. A paged call stops after "max_pages" pages (default 40, at most 80) and a run executes at most
"max_pages_total" pages of paged calls (default 40, or the largest explicit "max_pages" in the
plan; at most 80). A paged call that stops with rows left unread is "truncated".

Output JSONL (one object per line): {"id", "h", "ok", "ms", "ts", "result"} per call ("h" is a hash
of the call's snippet/js and params), plus {"event": ...} lines (ready, not_signed_in, checkpoint,
stopped, error, done, ended).

Resume: re-run with the same --out and --skip-done; a call is skipped only when its id has an ok
record AND the stored hash matches the call about to run (changed params or code re-run). Skipped
calls' stored results still drive paging.

Exit codes: 0 done, 2 usage / bad plan / playwright missing, 3 not signed in, 4 checkpoint (time
ceiling, lost heartbeat or page budget; reopen and resume), 5 stopped on a stop status, 6 browser /
page / claim error, 7 page never became ready, 8 finished but incomplete (a call failed or a paged
call was truncated; the summary and the JSONL say which).

Secrets: the claim, CDP URL (host and path) and heartbeat token are redacted from everything
printed or written, together with any ws(s):// URL and cookie-shaped text (session cookie, csrf
token and similar). Snippets must never return cookies or tokens; this runner never reads them.
"""
import argparse
import hashlib
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

(EXIT_OK, EXIT_USAGE, EXIT_AUTH, EXIT_CHECKPOINT, EXIT_STOPPED, EXIT_BROWSER, EXIT_NOT_READY,
 EXIT_INCOMPLETE) = (0, 2, 3, 4, 5, 6, 7, 8)

# The agent-browser lease is a hard 40 minutes; checkpoint before it, with margin to flush.
DEFAULT_MAX_SECONDS = 2280
HEARTBEAT_EVERY = 25  # seconds; the connector requires <= 60
HEARTBEAT_MAX_FAILURES = 3  # consecutive failed beats before the run checkpoints and stops

# Pacing and page budget. Source of truth: the skill's references/guardrails.md (a test compares).
MIN_DELAY_MS = 2000
DEFAULT_MAX_PAGES = 40
HARD_MAX_PAGES = 80
DEFAULT_EVAL_TIMEOUT_MS = 60000

DEFAULT_AUTH = {"url_contains": "/sales/",
                "url_not_contains": ["login", "checkpoint", "authwall", "uas"]}


# ----------------------------------------------------------------------------- redaction

_URL_RE = re.compile(r"wss?://[^\s\"'<>\\]+", re.I)
_COOKIE_NAMES = r"(?:JSESSIONID|li_at|bcookie|bscookie|lidc|liap|csrf[-_]?token)"  # hygiene-allow: cookie-name scrub pattern
_COOKIE_RE = re.compile(r"\b(" + _COOKIE_NAMES + r")(\\?[\"']?\s*[:=]\s*\\?[\"']?)[^\s\"'\\;,}&]+", re.I)
_AJAX_RE = re.compile(r"ajax:\d+", re.I)


def scrub(text):
    """Pattern scrub for secret-shaped text: ws(s):// URLs, cookie/csrf assignments, ajax:<digits> tokens."""
    text = _URL_RE.sub("[redacted]", str(text))
    text = _COOKIE_RE.sub(lambda m: m.group(1) + m.group(2) + "[redacted]", text)
    return _AJAX_RE.sub("[redacted]", text)


def redact(text, secrets=()):
    """Replace every known secret (longest first), then scrub secret-shaped text."""
    text = str(text)
    known = {str(s) for s in secrets if s and len(str(s)) >= 6}
    for secret in sorted(known, key=len, reverse=True):
        text = text.replace(secret, "[redacted]")
    return scrub(text)


def redact_obj(obj, secrets=()):
    """redact() every string (keys and values) in a JSON-shaped object, before it is serialised."""
    if isinstance(obj, str):
        return redact(obj, secrets)
    if isinstance(obj, dict):
        return {(redact(k, secrets) if isinstance(k, str) else k): redact_obj(v, secrets) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [redact_obj(v, secrets) for v in obj]
    return obj


def clip(text, secrets=(), limit=200):
    """Redact FIRST, then truncate, so a secret cut in half by the limit cannot leak."""
    return redact(text, secrets)[:limit]


def url_secrets(url):
    """The URL and its sensitive parts (host, path, query): CDP URLs carry the session in all of them."""
    if not url:
        return []
    out = [url]
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return out
    out += [parts.netloc, parts.hostname or "", parts.path, parts.query]
    # token-like path segments (a session id / uuid) on their own, but not plain words like "devtools"
    out += [seg for seg in parts.path.split("/") if len(seg) >= 12 and re.search(r"\d", seg)]
    return [x for x in out if x and x != "/"]


def safe_path(url):
    """First two path segments only: no host, query, fragment or ids (a segment with a digit or very long is '*')."""
    try:
        path = urllib.parse.urlsplit((url or "").strip()).path
    except ValueError:
        return ""
    segs = [s for s in path.split("/") if s][:2]
    segs = ["*" if (re.search(r"\d", s) or len(s) > 24) else s for s in segs]
    return "/" + "/".join(segs) if segs else "/"


# ----------------------------------------------------------------------------- helpers

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


def wrap_js_timed(source, timeout_ms):
    """wrap_js, but the call rejects with 'evaluate_timeout' if it takes longer than timeout_ms.

    page.evaluate has no time limit of its own: a snippet whose promise never settles would hang the run.
    """
    return ("(\nasync (__arg) => {\n  const __fn = " + wrap_js(source) + ";\n  let __timer;\n  try {\n"
            "    return await Promise.race([__fn(__arg), new Promise((_, __reject) => {\n"
            "      __timer = setTimeout(() => __reject(new Error('evaluate_timeout')), %d);\n"
            "    })]);\n  } finally { clearTimeout(__timer); }\n}\n)" % int(timeout_ms))


def load_snippet(ref, dirs):
    """Read snippet `ref` (a path or a bare file name) from the first directory that has it."""
    if not os.path.isabs(ref) and ".." in Path(ref).parts:
        raise ValueError("snippet name %r must not contain '..'" % ref)
    candidates = [Path(ref)] if os.path.isabs(ref) else [Path(d) / ref for d in dirs]
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise FileNotFoundError("snippet %r not found in: %s" % (ref, ", ".join(str(d) for d in dirs)))


def call_hash(call, params):
    """Short hash of what a call runs (snippet name / inline js) and with which params."""
    blob = json.dumps({"snippet": call.get("snippet"), "js": call.get("js"), "params": params},
                      sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


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
    if isinstance(result.get("failed"), int) and result["failed"] > 0:  # count.js: a sizing query failed
        return False
    status = result.get("status")
    return status is None or status == 200


def result_rows(result):
    """Rows a result carries. Count/typeahead results (`results`, `total`) are not rows."""
    if not isinstance(result, dict):
        return 0
    if isinstance(result.get("rows"), int):
        return result["rows"]
    for key in ("elements", "companies"):
        if isinstance(result.get(key), list):
            return len(result[key])
    return 0


def _segments(path):
    return [s for s in (path or "").lower().split("/") if s]


def _has_run(hay, needle):
    """True when `needle` (a list of segments) appears contiguously in `hay`."""
    n = len(needle)
    return n > 0 and any(hay[i:i + n] == needle for i in range(len(hay) - n + 1))


def signed_in(url, auth):
    """Signed-in probe on a landed URL: path SEGMENTS only (no query, no substring of the whole URL)."""
    try:
        parts = urllib.parse.urlsplit((url or "").strip())
    except ValueError:
        return False
    auth = auth or {}
    need = _segments(auth.get("url_contains", DEFAULT_AUTH["url_contains"]))
    bad = auth.get("url_not_contains", DEFAULT_AUTH["url_not_contains"])
    suffix = (auth.get("host_suffix") or "").lower().lstrip(".")
    host = (parts.hostname or "").lower()
    if suffix and not (host == suffix or host.endswith("." + suffix)):
        return False
    segs = _segments(urllib.parse.unquote(parts.path))
    if need and not _has_run(segs, need):
        return False
    return not any(_has_run(segs, _segments(b)) for b in bad)


class Heartbeat(threading.Thread):
    """Posts a heartbeat every `interval` seconds until stopped (agent-browser only).

    A 4xx answer (the connector no longer accepts this session) or `max_failures` failed beats in a
    row set `lost`; the runner then checkpoints and exits instead of working on a reclaimed browser.
    """

    def __init__(self, post, interval=HEARTBEAT_EVERY, log=None, max_failures=HEARTBEAT_MAX_FAILURES):
        super().__init__(daemon=True)
        self._post = post
        self._interval = interval
        self._log = log or (lambda msg: None)
        self._halt = threading.Event()
        self._max_failures = max_failures
        self.stage = "starting"
        self.rows = 0
        self.beats = 0
        self.errors = 0
        self.consecutive = 0
        self.lost = False
        self.lost_reason = ""

    def _lose(self, reason):
        if not self.lost:
            self.lost, self.lost_reason = True, reason
            self._log("heartbeat lost: %s" % reason)

    def beat(self):
        try:
            self._post(self.stage, self.rows)
            self.beats += 1
            self.consecutive = 0
        except urllib.error.HTTPError as exc:
            self.errors += 1
            self.consecutive += 1
            self._log("heartbeat error: HTTP %s" % exc.code)
            if 400 <= exc.code < 500:
                self._lose("HTTP %s" % exc.code)
            elif self.consecutive >= self._max_failures:
                self._lose("%d failed beats in a row" % self.consecutive)
        except Exception as exc:  # network blip: keep going, the next beat may succeed
            self.errors += 1
            self.consecutive += 1
            self._log("heartbeat error: %s" % str(exc)[:120])
            if self.consecutive >= self._max_failures:
                self._lose("%d failed beats in a row" % self.consecutive)

    def run(self):
        while not self._halt.wait(self._interval):
            self.beat()

    def stop(self):
        self._halt.set()


# ----------------------------------------------------------------------------- plan validation

def _is_int(value, lo=None, hi=None):
    ok = isinstance(value, int) and not isinstance(value, bool)
    return ok and (lo is None or value >= lo) and (hi is None or value <= hi)


def _is_num(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_plan(plan, dirs=None):
    """Return a list of problems with a plan (empty when it is fine to run). No network.

    With `dirs`, every named snippet must also be found there.
    """
    if not isinstance(plan, dict):
        return ["the plan must be a JSON object"]
    bad = []
    start = plan.get("start_url")
    if start is not None and not (isinstance(start, str) and urllib.parse.urlsplit(start).scheme == "https"):
        bad.append("start_url must be an https URL")
    if "settle_ms" in plan and not _is_int(plan["settle_ms"], 0, 120000):
        bad.append("settle_ms must be a whole number of ms, 0..120000")
    if "delay_ms" in plan:
        d = plan["delay_ms"]
        if not (isinstance(d, (list, tuple)) and len(d) == 2 and all(_is_num(x) for x in d)
                and MIN_DELAY_MS <= d[0] <= d[1]):
            bad.append("delay_ms must be [min, max] in ms with min >= %d (3000-5000 is the default)" % MIN_DELAY_MS)
    if "stop_on_status" in plan:
        s = plan["stop_on_status"]
        if not (isinstance(s, list) and s and all(_is_int(x, 100, 599) for x in s)):
            bad.append("stop_on_status must be a non-empty list of HTTP statuses (default [403, 429])")
    if "evaluate_timeout_ms" in plan and not _is_int(plan["evaluate_timeout_ms"], 1000, 600000):
        bad.append("evaluate_timeout_ms must be 1000..600000")
    if "max_pages_total" in plan and not _is_int(plan["max_pages_total"], 1, HARD_MAX_PAGES):
        bad.append("max_pages_total must be 1..%d (guardrails hard ceiling)" % HARD_MAX_PAGES)
    auth = plan.get("auth")
    if auth is not None:
        if not isinstance(auth, dict):
            bad.append("auth must be an object")
        else:
            if "url_contains" in auth and not isinstance(auth["url_contains"], str):
                bad.append("auth.url_contains must be a string")
            nc = auth.get("url_not_contains", [])
            if not (isinstance(nc, list) and all(isinstance(x, str) for x in nc)):
                bad.append("auth.url_not_contains must be a list of strings")
            if "host_suffix" in auth and not isinstance(auth["host_suffix"], str):
                bad.append("auth.host_suffix must be a string")
    ready = plan.get("ready")
    refs = []
    if ready is not None:
        if not isinstance(ready, dict) or bool(ready.get("snippet")) == bool(ready.get("js")):
            bad.append("ready needs exactly one of snippet / js")
        else:
            refs.append(ready)
            if "retries" in ready and not _is_int(ready["retries"], 1, 30):
                bad.append("ready.retries must be 1..30")
            if "interval_ms" in ready and not _is_int(ready["interval_ms"], 500, 60000):
                bad.append("ready.interval_ms must be 500..60000")
    calls = plan.get("calls")
    if not (isinstance(calls, list) and calls):
        bad.append("calls must be a non-empty list")
        calls = []
    seen = set()
    for n, call in enumerate(calls, 1):
        label = "call %d" % n
        if not isinstance(call, dict):
            bad.append("%s must be an object" % label)
            continue
        cid = call.get("id")
        if not (isinstance(cid, str) and cid and "#" not in cid):
            bad.append("%s needs a string id without '#'" % label)
        elif cid in seen:
            bad.append("duplicate call id %r" % cid)
        else:
            seen.add(cid)
            label = "call %r" % cid
        if bool(call.get("snippet")) == bool(call.get("js")):
            bad.append("%s needs exactly one of snippet / js" % label)
        refs.append(call)
        params = call.get("params", {})
        if not isinstance(params, dict):
            bad.append("%s: params must be an object" % label)
        elif "delayMs" in params and not (_is_num(params["delayMs"]) and params["delayMs"] >= MIN_DELAY_MS):
            bad.append("%s: params.delayMs must be >= %d" % (label, MIN_DELAY_MS))
        pages = call.get("pages")
        if pages is None:
            continue
        if not isinstance(pages, dict):
            bad.append("%s: pages must be an object" % label)
            continue
        for key, lo, hi in (("step", 1, 25), ("cap", 1, 100000), ("max_pages", 1, HARD_MAX_PAGES),
                            ("from", 0, 100000)):
            if key in pages and not _is_int(pages[key], lo, hi):
                bad.append("%s: pages.%s must be a whole number %d..%d" % (label, key, lo, hi))
    if dirs is not None:
        for ref in refs:
            if ref.get("snippet"):
                try:
                    load_snippet(ref["snippet"], dirs)
                except (OSError, ValueError) as exc:
                    bad.append(str(exc))
    return bad


class _Checkpoint(Exception):
    """Raised inside the runner to stop cleanly: the next call that was NOT run, and why."""

    def __init__(self, next_id, reason):
        super().__init__(reason)
        self.next_id, self.reason = next_id, reason


# ----------------------------------------------------------------------------- runner

class Runner:
    """Runs a plan against `page` (anything with evaluate/goto/wait_for_*), streaming JSONL."""

    def __init__(self, page, plan, out_path, snippet_dirs, secrets=(), heartbeat=None,
                 max_seconds=DEFAULT_MAX_SECONDS, skip_done=False, sleep=time.sleep,
                 clock=time.monotonic, rng=None, log=None, on_auth=None):
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
        self.on_auth = on_auth
        self.done = read_done(out_path) if skip_done else {}
        self.stop_status = set(plan.get("stop_on_status") or [403, 429])
        self.eval_timeout_ms = int(plan.get("evaluate_timeout_ms", DEFAULT_EVAL_TIMEOUT_MS))
        explicit = [int(c["pages"]["max_pages"]) for c in plan.get("calls", [])
                    if isinstance(c.get("pages"), dict) and "max_pages" in c["pages"]]
        self.page_budget = min(HARD_MAX_PAGES, int(plan.get("max_pages_total",
                                                            max([DEFAULT_MAX_PAGES] + explicit))))
        self.pages_run = 0
        self.t0 = self.clock()
        self.executed = 0
        self.ok_count = 0
        self.fail_count = 0
        self.rows = 0
        self.truncated = []
        self._out = None
        self._ran_any = False

    # -- output
    def emit(self, record):
        """Write one JSONL line: strings are redacted before serialising, the text is scrubbed after."""
        text = json.dumps(redact_obj(record, self.secrets), ensure_ascii=False, separators=(",", ":"))
        text = redact(text, self.secrets)
        try:
            json.loads(text)
        except ValueError:  # a redaction ate JSON structure (a secret that looks like a number, say)
            text = json.dumps({"event": "redaction_error", "id": str(record.get("id", ""))[:80]})
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
        """True when the landed URL looks signed in (and the connector accepts it); emits an event when not."""
        url = self.page.url
        ok = signed_in(url, self.plan.get("auth"))
        if not ok:
            self.emit({"event": "not_signed_in", "path": safe_path(url)})
        if self.on_auth:
            accepted = self.on_auth(ok)
            if ok and not accepted:
                self.emit({"event": "auth_rejected", "note": "the connector did not accept the session"})
            ok = ok and accepted
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
        return self.page.evaluate(wrap_js_timed(source, self.eval_timeout_ms),
                                  params if params is not None else {})

    def pause(self):
        lo, hi = self.plan.get("delay_ms", [3000, 5000])
        lo, hi = max(lo, MIN_DELAY_MS), max(hi, MIN_DELAY_MS)
        if self._ran_any:
            self.sleep(self.rng.uniform(lo, hi) / 1000.0)

    def over_budget(self):
        return self.max_seconds and (self.clock() - self.t0) >= self.max_seconds

    def stop_reason(self):
        """Why the run must stop before the next call (None to carry on)."""
        if self.over_budget():
            return "time ceiling"
        if self.heartbeat is not None and getattr(self.heartbeat, "lost", False):
            return "heartbeat lost (%s)" % self.heartbeat.lost_reason
        return None

    def check_stop(self, next_id):
        reason = self.stop_reason()
        if reason:
            raise _Checkpoint(next_id, reason)

    def replay(self, call_id, call_h):
        """The stored ok record for this call when --skip-done applies and the call is unchanged."""
        rec = self.done.get(call_id)
        if rec is None:
            return None
        if rec.get("h") == call_h:
            return rec
        self.log("%s: saved record is for different params/code: running it again" % call_id)
        return None

    def run_one(self, call_id, call, params, paged=False):
        """Run (or replay from --skip-done) one call. Return (record, executed_bool)."""
        call_h = call_hash(call, params)
        stored = self.replay(call_id, call_h)
        if stored is not None:
            return stored, False
        if paged and self.pages_run >= self.page_budget:
            raise _Checkpoint(call_id, "page budget reached (%d pages; guardrails pages/day)" % self.page_budget)
        self.pause()
        self.check_stop(call_id)  # the pause counts against the time budget too
        self.stage(call_id)
        started = self.clock()
        result = self.evaluate(call.get("snippet"), call.get("js"), params)
        ms = int((self.clock() - started) * 1000)
        ok = result_ok(result)
        record = {"id": call_id, "h": call_h, "ok": ok, "ms": ms,
                  "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "result": result}
        self.emit(record)
        self._ran_any = True
        self.executed += 1
        self.pages_run += 1 if paged else 0
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
        """Return an exit code (None when every call ran to its end)."""
        try:
            for index, call in enumerate(self.plan.get("calls", []), 1):
                call_id = call.get("id") or "call-%d" % index
                self.check_stop(call_id)
                pages = call.get("pages")
                if not pages:
                    record, _ = self.run_one(call_id, call, call.get("params", {}))
                    if self.hit_stop_status(record):
                        return EXIT_STOPPED
                    continue
                code = self.run_paged(call_id, call, pages)
                if code is not None:
                    return code
        except _Checkpoint as cp:
            self.emit({"event": "checkpoint", "next_id": cp.next_id, "reason": cp.reason})
            return EXIT_CHECKPOINT
        return None

    def run_paged(self, call_id, call, pages):
        param = pages.get("param", "start")
        step = int(pages.get("step", 25))
        cap = int(pages.get("cap", 2500))
        max_pages = min(int(pages.get("max_pages", DEFAULT_MAX_PAGES)), HARD_MAX_PAGES)
        total_key = pages.get("total_key", "total")
        start, n = int(pages.get("from", 0)), 0
        while True:
            self.check_stop("%s#%d" % (call_id, start))
            params = dict(call.get("params", {}))
            params[param] = start
            params.setdefault("count", step)
            record, _ = self.run_one("%s#%d" % (call_id, start), call, params, paged=True)
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
                finished = start + got >= total if isinstance(total, int) else got < step
                if not finished:
                    self.truncated.append(call_id)
                    self.emit({"event": "truncated", "call": call_id, "fetched_to": nxt, "total": total,
                               "note": "rows were left unread (cap, page limit or an empty page)"})
                return None
            start = nxt

    def run(self, goto=True):
        """Settle, probe auth, run the calls. Return the exit code."""
        with open(self.out_path, "a", encoding="utf-8") as fh:
            self._out = fh
            try:
                self.settle(goto=goto)
                if not self.probe_auth():
                    return EXIT_AUTH
                if not self.wait_ready():
                    return EXIT_NOT_READY
                code = self.run_calls()
                if code is None:
                    code = EXIT_INCOMPLETE if (self.fail_count or self.truncated) else EXIT_OK
                self.emit({"event": "done" if code == EXIT_OK else "ended", "code": code,
                           "executed": self.executed, "ok": self.ok_count,
                           "failed": self.fail_count, "truncated": len(self.truncated),
                           "rows": self.rows, "seconds": int(self.clock() - self.t0)})
                return code
            except Exception as exc:
                message = clip(exc, self.secrets, 300)
                self.emit({"event": "error", "error": message})
                self.log("browser/page error: %s" % message[:200])
                return EXIT_BROWSER
            finally:
                self._out = None


# ----------------------------------------------------------------------------- connect + CLI

def _page_is_target(url, prefer):
    """True for a page on the preferred host + path prefix, e.g. 'linkedin.com/sales'."""
    host, _, path = prefer.partition("/")
    try:
        parts = urllib.parse.urlsplit(url or "")
    except ValueError:
        return False
    page_host = (parts.hostname or "").lower()
    if host and not (page_host == host or page_host.endswith("." + host)):
        return False
    want = _segments(path)
    return not want or _segments(parts.path)[:len(want)] == want


def pick_page(browser, prefer="linkedin.com/sales", reuse_first=False):
    """Reuse an open tab on the target site, else open a NEW tab.

    The user's other tabs are never navigated. `reuse_first` is for a cloud browser we own: its
    first (blank) tab is ours to use.
    """
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    for page in ctx.pages:
        if _page_is_target(page.url, prefer):
            return page
    if reuse_first and ctx.pages:
        return ctx.pages[0]
    return ctx.new_page()


EMIT_FORMS = ("expression", "return")


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runtime", choices=["agent-browser", "cdp"])
    ap.add_argument("--claim", default=os.environ.get("AB_CLAIM"),
                    help="one-use 60s claim from open_session. Prefer the env var AB_CLAIM: "
                         "command-line arguments are visible to other users in `ps`")
    ap.add_argument("--base", default=os.environ.get("AB_BASE"),
                    help="connector https base URL returned by open_session (or env AB_BASE)")
    ap.add_argument("--session-id", default=os.environ.get("AB_SESSION_ID"),
                    help="only needed if the claim response omits session_id")
    ap.add_argument("--cdp-url", help="CDP endpoint of the user's own Chrome (runtime cdp)")
    ap.add_argument("--plan", help="plan JSON file")
    ap.add_argument("--out", help="JSONL results file (appended)")
    ap.add_argument("--snippets-dir", action="append", default=[],
                    help="extra directory to look for snippet files, after the vetted page/ folder "
                         "and the plan's folder (repeatable)")
    ap.add_argument("--max-seconds", type=int, default=DEFAULT_MAX_SECONDS,
                    help="checkpoint and exit after this long (default %(default)s)")
    ap.add_argument("--skip-done", action="store_true",
                    help="skip calls with an ok record in --out (same id, same params/code)")
    ap.add_argument("--no-goto", action="store_true", help="do not navigate; use the page as it is")
    ap.add_argument("--emit", metavar="SNIPPET",
                    help="print a paste-ready JS expression for a snippet (use with --params), then exit")
    ap.add_argument("--params", default="{}", help="JSON params for --emit")
    ap.add_argument("--compact", action="store_true",
                    help="--emit: drop comments and blank lines (strings, template literals and regex "
                         "literals are left alone; smaller tool call)")
    ap.add_argument("--form", choices=EMIT_FORMS, default="expression",
                    help="--emit: 'expression' = async IIFE a JS tool evaluates; 'return' = the same "
                         "prefixed with `return await`, for tools that run the code as a function body")
    return ap


def default_snippet_dirs(extra, plan_path, here=None):
    """Snippet search order: the skill's vetted page/ folder, then the plan's folder, then --snippets-dir."""
    here = Path(here) if here else Path(__file__).resolve().parent
    dirs = [here.parent / "page", here / "page"]
    if plan_path:
        dirs.append(Path(plan_path).resolve().parent)
    dirs += [Path(d) for d in extra]
    dirs.append(here)
    return dirs


# -- compact_js: a minimal JS tokenizer that strips comments outside strings, templates and regexes

class _Unterminated(Exception):
    pass


_REGEX_AFTER_WORDS = {"return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else",
                      "do", "yield", "await"}
_REGEX_AFTER_CHARS = set("(,=:[!&|?{;+-*%<>~^")
_WORD_CHARS = re.compile(r"[A-Za-z0-9_$\u0080-￿]")


def _strip_comments(src):
    """Return (chars, protected) with // and /* */ comments removed; `protected` holds the indexes
    of newlines that sit inside a string or template literal (they must survive)."""
    out, protected = [], set()
    n = len(src)
    prev = [""]  # last significant token: a single char, or an identifier / keyword

    def put(c, protect=False):
        if protect:
            protected.add(len(out))
        out.append(c)

    def copy_string(i, quote):
        put(src[i])
        i += 1
        while i < n:
            c = src[i]
            if c == "\\":
                if i + 1 >= n:
                    raise _Unterminated
                put(c)
                put(src[i + 1], protect=src[i + 1] == "\n")
                i += 2
            elif c == quote:
                put(c)
                return i + 1
            elif c == "\n":
                raise _Unterminated
            else:
                put(c)
                i += 1
        raise _Unterminated

    def copy_regex(i):
        put(src[i])
        i += 1
        in_class = False
        while i < n:
            c = src[i]
            if c == "\n":
                raise _Unterminated
            if c == "\\":
                if i + 1 >= n:
                    raise _Unterminated
                put(c)
                put(src[i + 1])
                i += 2
                continue
            put(c)
            i += 1
            if c == "[":
                in_class = True
            elif c == "]":
                in_class = False
            elif c == "/" and not in_class:
                while i < n and _WORD_CHARS.match(src[i]):  # flags
                    put(src[i])
                    i += 1
                return i
        raise _Unterminated

    def copy_template(i):
        put(src[i])
        i += 1
        while i < n:
            c = src[i]
            if c == "\\":
                if i + 1 >= n:
                    raise _Unterminated
                put(c)
                put(src[i + 1], protect=src[i + 1] == "\n")
                i += 2
            elif c == "`":
                put(c)
                return i + 1
            elif c == "$" and i + 1 < n and src[i + 1] == "{":
                put("$")
                put("{")
                i = scan(i + 2, True)
            else:
                put(c, protect=c == "\n")
                i += 1
        raise _Unterminated

    def scan(i, until_close):
        depth = 0
        while i < n:
            c = src[i]
            if c.isspace():
                put(c)
                i += 1
            elif c in "'\"":
                i = copy_string(i, c)
                prev[0] = '"'
            elif c == "`":
                i = copy_template(i)
                prev[0] = "`"
            elif c == "/":
                nxt = src[i + 1] if i + 1 < n else ""
                if nxt == "/":
                    while i < n and src[i] != "\n":
                        i += 1
                elif nxt == "*":
                    end = src.find("*/", i + 2)
                    if end < 0:
                        raise _Unterminated
                    put("\n" if "\n" in src[i:end] else " ")
                    i = end + 2
                elif prev[0] == "" or prev[0] in _REGEX_AFTER_CHARS or prev[0] in _REGEX_AFTER_WORDS:
                    i = copy_regex(i)
                    prev[0] = "r"
                else:
                    put(c)
                    i += 1
                    prev[0] = "/"
            elif c == "{":
                depth += 1
                put(c)
                i += 1
                prev[0] = "{"
            elif c == "}":
                put(c)
                i += 1
                if until_close and depth == 0:
                    return i
                depth = max(0, depth - 1)
                prev[0] = "}"
            elif _WORD_CHARS.match(c):
                j = i
                while j < n and _WORD_CHARS.match(src[j]):
                    j += 1
                for ch in src[i:j]:
                    put(ch)
                prev[0] = src[i:j]
                i = j
            else:
                put(c)
                i += 1
                prev[0] = c
        if until_close:
            raise _Unterminated
        return i

    scan(0, False)
    return out, protected


def compact_js(source):
    """Drop comments (outside strings, template literals and regex literals) and blank lines.

    A minimal tokenizer, not a parser. A comment that held a newline leaves a newline behind, so
    automatic semicolon insertion is unchanged. If the source cannot be tokenized (an unterminated
    string, template or regex) it is returned unchanged rather than guessed at.
    """
    try:
        chars, protected = _strip_comments(source.replace("\r\n", "\n"))
    except _Unterminated:
        return source
    lines, current = [], []
    for index, ch in enumerate(chars):
        if ch == "\n" and index not in protected:
            lines.append("".join(current))
            current = []
        else:
            current.append(ch)
    lines.append("".join(current))
    return "\n".join(line.rstrip() for line in lines if line.strip())


def emit_expression(snippet, params_json, dirs, compact=False, form="expression"):
    """One paste-ready JS expression: the snippet as an async IIFE with its params inline."""
    source = load_snippet(snippet, dirs)
    if compact:
        source = compact_js(source)
    params = json.loads(params_json)
    expr = "%s(%s)" % (wrap_js(source), json.dumps(params, ensure_ascii=False))
    return "return await " + expr if form == "return" else expr


class RunnerExit(Exception):
    """A startup failure with the documented exit code to return."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def import_playwright():
    """Import Playwright late (tests and --emit need no browser). Raises ImportError when missing."""
    from playwright.sync_api import sync_playwright
    return sync_playwright


def _error_body(exc, limit=300):
    try:
        return exc.read(limit).decode("utf-8", "replace")
    except Exception:
        return ""


def connect_agent_browser(args, log, secrets=()):
    """Claim the cloud browser. Return (cdp_url, session_id, hb_token); raise RunnerExit on any failure."""
    try:
        claimed = post_json(args.base, "/browser/claim", {"claim": args.claim})
    except urllib.error.HTTPError as exc:
        raise RunnerExit(EXIT_BROWSER, "claim rejected (HTTP %s): claims are one-use and expire in 60s; "
                                       "open a fresh session" % exc.code)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise RunnerExit(EXIT_BROWSER, "claim request failed: %s" % clip(exc, secrets, 160))
    if not isinstance(claimed, dict):
        raise RunnerExit(EXIT_BROWSER, "claim response was not a JSON object")
    cdp_url = claimed.get("cdp_url")
    hb_token = claimed.get("heartbeat_token")
    session_id = claimed.get("session_id") or args.session_id
    if not (cdp_url and hb_token and session_id):
        raise RunnerExit(EXIT_BROWSER, "claim response missing cdp_url / heartbeat_token / session_id "
                                       "(claims are one-use and expire in 60s: open a fresh session)")
    log("claimed browser session")
    return cdp_url, session_id, hb_token


def make_auth_reporter(base, sid, token, log, post=None):
    """Callback for Runner.on_auth: report the probe to the connector; False when it refuses the session."""
    post = post or post_json

    def report(ok):
        try:
            post(base, "/browser/auth", {"session_id": sid, "heartbeat_token": token, "signed_in": ok})
        except urllib.error.HTTPError as exc:
            body = _error_body(exc)
            log("auth report rejected: HTTP %s%s" % (exc.code, " (auth_required)" if "auth_required" in body else ""))
            return not (400 <= exc.code < 500 or "auth_required" in body) and ok
        except (urllib.error.URLError, OSError, ValueError) as exc:
            log("auth report failed: %s" % clip(exc, [token], 120))
        return ok

    return report


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.emit:
        print(emit_expression(args.emit, args.params, default_snippet_dirs(args.snippets_dir, args.plan),
                              compact=args.compact, form=args.form))
        return EXIT_OK
    if not (args.runtime and args.plan and args.out):
        print("error: --runtime, --plan and --out are required (or use --emit)", file=sys.stderr)
        return EXIT_USAGE
    if args.runtime == "agent-browser":
        if not (args.claim and args.base):
            print("error: agent-browser runtime needs --claim and --base (or AB_CLAIM / AB_BASE)", file=sys.stderr)
            return EXIT_USAGE
        parts = urllib.parse.urlsplit(args.base)
        if parts.scheme != "https" or not parts.hostname:
            print("error: --base must be an https URL", file=sys.stderr)
            return EXIT_USAGE
    elif not args.cdp_url:
        print("error: --cdp-url is required for runtime cdp", file=sys.stderr)
        return EXIT_USAGE
    try:
        plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print("error: cannot read the plan: %s" % str(exc)[:200], file=sys.stderr)
        return EXIT_USAGE
    dirs = default_snippet_dirs(args.snippets_dir, args.plan)
    problems = validate_plan(plan, dirs)
    if problems:
        print("error: the plan is not valid (nothing was claimed or run):", file=sys.stderr)
        for problem in problems:
            print("  - " + problem, file=sys.stderr)
        return EXIT_USAGE
    try:  # before the claim: a claim is one-use and expires in 60s, so never burn it on a missing dependency
        sync_playwright = import_playwright()
    except ImportError:
        print("error: the 'playwright' package is not installed: python3 -m pip install playwright "
              "(no `playwright install` needed: it attaches to an existing browser)", file=sys.stderr)
        return EXIT_USAGE

    secrets = [args.claim] + url_secrets(args.cdp_url)
    log = lambda msg: print(redact(msg, secrets), file=sys.stderr, flush=True)  # noqa: E731
    cli_args = list(argv if argv is not None else sys.argv[1:])
    if args.claim and any(a == "--claim" or a.startswith("--claim=") for a in cli_args):
        log("note: --claim on the command line is visible to other users in `ps`; prefer the env var AB_CLAIM")

    heartbeat = None
    sid = token = None
    base = args.base
    if args.runtime == "agent-browser":
        try:
            cdp_url, sid, token = connect_agent_browser(args, log, secrets)
        except RunnerExit as exc:
            print("error: " + redact(exc.message, secrets), file=sys.stderr)
            return exc.code
        secrets += [token] + url_secrets(cdp_url)
    else:
        cdp_url = args.cdp_url
        log("local runtime: this uses your own browser session, seat and IP")

    pw = None
    code = EXIT_BROWSER
    try:
        pw = sync_playwright().start()
        browser = pw.chromium.connect_over_cdp(cdp_url)
        page = pick_page(browser, reuse_first=args.runtime == "agent-browser")
        on_auth = None
        if args.runtime == "agent-browser":
            heartbeat = Heartbeat(
                lambda stage, rows: post_json(base, "/browser/heartbeat", {
                    "session_id": sid, "heartbeat_token": token, "stage": stage, "rows": rows}),
                log=log)
            heartbeat.start()
            on_auth = make_auth_reporter(base, sid, token, log)
        runner = Runner(page, plan, args.out, dirs, secrets=secrets, heartbeat=heartbeat,
                        max_seconds=args.max_seconds, skip_done=args.skip_done, log=log, on_auth=on_auth)
        code = runner.run(goto=not args.no_goto)
        if heartbeat:
            heartbeat.stage = "done"
            heartbeat.rows = runner.rows
            heartbeat.beat()
        summary = {"code": code, "executed": runner.executed, "ok": runner.ok_count,
                   "failed": runner.fail_count, "truncated": len(runner.truncated), "rows": runner.rows}
        print(json.dumps(summary))
    except SystemExit:
        raise
    except Exception as exc:
        log("fatal: %s" % clip(exc, secrets, 200))
        code = EXIT_BROWSER
    finally:
        if heartbeat:
            heartbeat.stop()
        try:
            if pw is not None:
                pw.stop()  # disconnects; never browser.close() on a CDP attach
        except Exception:
            pass
    return code


if __name__ == "__main__":
    sys.exit(main())
