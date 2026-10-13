# browser-runtime

Shared runtime for skills that work inside a signed-in website through the user's own browser
session. **This folder is the single source of truth.** Skills do not edit their own copy: each
skill whose `skill.yaml` lists a browser runtime gets this folder vendored into
`skills/<name>/runtime/` by `build/sync_runtime.py`. Change it here, then run
`python3 build/sync_runtime.py`, and run `python3 build/sync_runtime.py --check` before committing
(the tests enforce it: they fail if a copy drifted, or if a skill with `runtimes: []` has a
`runtime/` folder).

## What is in it

| File | Purpose |
|---|---|
| `session.py` | Generic runner. Connects to a browser over CDP, settles the page, runs a JSON plan of JS snippet calls, streams one JSONL record per call, heartbeats (Agent Browser). |
| `agent-browser.md` | Runtime A: the cloud browser (Agent Browser MCP connector) driven from a sandbox or shell with code execution. |
| `local.md` | Runtime B (default for Desktop users): the user's own signed-in browser, driven through its JavaScript tool (Cowork built-in browser, Claude in Chrome), one snippet per call, or through Playwright attached to their Chrome. |
| `guardrails-common.md` | Rules every runtime shares: one session per seat, pacing, stop signals, secrets. |

## Which runtime

```
A browser JS tool (Cowork built-in browser, Claude in Chrome)      -> local   (default; no code execution needed)
Agent Browser connector + code execution (Claude Code, Cowork, Codex) -> agent-browser (schedules, laptop off)
Neither                                                             -> slow page-reading path (skill-specific)
```

Both runtimes run the same page snippets (`skills/<name>/page/*.js`): each file is one
`async (params) => {...}` function that does a same-origin `fetch` inside the signed-in page and
returns compact JSON. Only how the function reaches the page differs.

## Quick start

```
python3 -m pip install playwright            # no `playwright install`: it attaches to an existing browser

# Agent Browser: claim is ONE-USE and expires in 60s, so write the plan first, then open the session.
# Pass the claim in the environment, not on the command line (arguments show up in `ps`).
AB_CLAIM="$CLAIM" python3 runtime/session.py --runtime agent-browser --base "$BASE" \
        --plan plan.json --out results.jsonl

# Local Chrome started with --remote-debugging-port=9222
python3 runtime/session.py --runtime cdp --cdp-url http://127.0.0.1:9222 \
        --plan plan.json --out results.jsonl

# Paste-ready async IIFE for a browser JS tool (one snippet per tool call).
# --compact drops comments and blank lines (strings, templates, regexes untouched); --form return prefixes `return await` for tools that run a function body.
python3 runtime/session.py --emit lead_search.js --params '{"query":"(filters:List(...))","count":1}' --compact
```

The plan format, exit codes, and resume behaviour are documented at the top of `session.py`
(`python3 session.py --help` prints the summary). The plan is validated before anything is claimed
or run: `--base` must be https, `delay_ms` at least 2000 ms, `stop_on_status` never empty, every
call needs a unique `id`, and paged calls default to 40 pages (at most 80, the guardrails
pages-per-day numbers). Re-run with `--skip-done` to resume a run: calls that already have an `ok`
record in the output file for the same id and the same params/code are not repeated. Exit 8 means
the run finished but a call failed or a paged call was truncated, unless the plan (or that call)
sets `"sample": true`, which marks an intentional partial page pull (a `sampled` event, exit 0).

## Conventions

- **Network exception.** `session.py` is the one place in this repo that touches the network
  (the connector claim/auth/heartbeat calls, and Playwright's CDP socket). Skill scripts under
  `skills/<name>/scripts/` stay Python-stdlib and no-network. `session.py` itself uses only the
  standard library plus `playwright`, and imports `playwright` lazily so the rest runs without it.
- **Secrets never surface.** The claim, CDP URL (host and path) and heartbeat token are redacted
  from everything printed or written, as are any `ws(s)://` URL and cookie-shaped text. Snippets read the page's CSRF token inside the page and never return it.
  Never log or save cookies, tokens or request headers.
- **Client-agnostic.** No customer, seat or workspace names in any file here.
- **One process per browser session.** The cloud browser stops when the CDP client disconnects, so a
  session's whole job runs in one `session.py` invocation. Checkpoint to JSONL and reopen if the
  40-minute ceiling is near (`--max-seconds`).
