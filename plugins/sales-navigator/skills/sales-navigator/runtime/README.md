# browser-runtime

Runs a skill's page snippets (`$ENGINE/page/*.js`: one `async (params) => {...}` doing a same-origin `fetch` in
the signed-in page, returning compact JSON). This folder is the source of truth; `python3
build/sync_runtime.py` vendors it into the engine skill's `runtime/` (`--check` fails on drift; `$ENGINE` is the engine folder the skills resolve, see their "Engine path" line). Code runtimes
need `pip install playwright` (it attaches to an existing browser). `session.py --help` lists every flag.

## Run a snippet

1. **Browser JavaScript tool** (Cowork built-in browser, Claude in Chrome), the user's own tab:
   `python3 "$ENGINE/runtime/session.py" --emit lead_search.js --params '{"query":"...","count":25}' --compact`
   prints a paste-ready async IIFE (add `--form return` if the tool shows nothing). One snippet per tool
   call; save each result before the next. Without code execution, wrap the file as `( <file> )({...})`.
2. **Agent Browser** (cloud, for schedules and laptop-off runs): check `browser action=status` and
   `workspace action=list`, `open_session` (the claim lives 60 seconds, so write the plan first), run
   everything in ONE process, then `close_session`:
   `AB_CLAIM="<claim>" python3 "$ENGINE/runtime/session.py" --runtime agent-browser --base "<base>" --plan plan.json --out results.jsonl`
3. **Local Chrome over CDP** (`--remote-debugging-port=9222 --user-data-dir=<dedicated dir>`):
   `python3 "$ENGINE/runtime/session.py" --runtime cdp --cdp-url http://127.0.0.1:9222 --plan plan.json --out results.jsonl`

## Plan

```json
{
  "start_url": "https://www.linkedin.com/sales/home",
  "settle_ms": 3000,
  "ready": {"snippet": "csrf_ready.js", "retries": 5, "interval_ms": 2000},
  "delay_ms": [3000, 5000],
  "calls": [
    {"id": "size", "snippet": "count.js", "params": {"kind": "account", "query": "(filters:List(...))"}},
    {"id": "accts", "snippet": "account_search.js", "params": {"query": "(filters:List(...))"},
     "pages": {"param": "start", "step": 25, "cap": 1000}}
  ]
}
```

Validated before anything is claimed; `--skip-done` resumes from the JSONL. Paged calls default to 40
pages (80 maximum); `"sample": true` with `pages.max_pages` marks a deliberate partial pull. A cloud plan
is fixed up front, so dependent steps are one session each. Exit codes: 0 done; 2 bad plan; 3 not signed
in (the user signs in); 4 checkpoint (40-minute ceiling: reopen with `--skip-done`); 5 stopped on 403/429;
6 browser error; 7 page never ready; 8 finished but incomplete.

## Rules

- One session per seat; one process per cloud session (the browser dies when it exits).
- 3 to 5 seconds between calls, none in parallel. Size with `count=1`, sample 50 rows, then scale.
- Stop on 403/429 after the page was ready, a captcha, sign-out, limit banner, or empty or repeating
  pages. No retry loops.
- Never print or save cookies, tokens, claims or CDP URLs; never handle a password or 2FA code.
- A local run uses the user's own seat and IP and needs the machine awake.
