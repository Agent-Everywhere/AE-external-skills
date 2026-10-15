# 01 Navigation basics

## Runtimes

| Runtime | Use | How |
|---|---|---|
| Cowork built-in browser, Claude in Chrome | the user's own signed-in tab | `session.py --emit <snippet>.js --params '{...}' --compact`, paste the IIFE, one snippet per call, save each result |
| Agent Browser (cloud) | schedules, laptop-off runs | one JSON plan, one process per session; the claim lasts 60 seconds (write the plan first); 40-minute ceiling (exit 4, resume with `--skip-done`) |
| Local CDP | a dedicated Chrome profile | `session.py --runtime cdp --cdp-url http://127.0.0.1:<port> --plan plan.json --out results.jsonl` |

On the local machine the Acme run used a pwkit pool profile in legacy-cdp mode. The CDP URL is a local endpoint to the
user's own browser: keep it out of user-facing output, notes and files.

## Ready gate and read-only API

- Every call is a same-origin `fetch` from a loaded `linkedin.com/sales/...` tab with the `JSESSIONID` cookie as the
  `csrf-token` header (read inside the page, never returned). `csrf_ready.js` confirms the token is there.
- A 403 within about 100 ms of load means the token is not ready: wait. A 403 or 429 after the ready gate is a stop.
- Signed out: the URL path leaves `/sales/` (login, checkpoint, authwall). The user signs in; never handle a password.
- Never click the UI (filters, scrolling, saving). If no snippet can run (no JS tool, no Agent Browser, no CDP), stop.

## Workspace and run log

`workspace.py locate` finds `~/Claude/sales-navigator` (or the folder named in the profile); missing: confirm the
default once, then `workspace.py init ~/Claude`. It holds `company-profile.md`, `run_log.csv`, `outreach_log.csv`,
`quota.md`, `results/`, `drafts/`. Caps are per workspace folder, so use one folder per seat and pass `--workspace DIR`
on every script call when it is not the default.

## Gotcha: queries per count call

One `count.js` call with about 24 queries hit `evaluate_timeout` in Agent Browser. Chunk to about 6 queries per call
(`segments.py plan` does this). A timed-out call tells you nothing about the counts it was still running.
