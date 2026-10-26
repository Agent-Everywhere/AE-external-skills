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

## Runners that read rendered result pages

The engine reads the API, not the page. A runner that loads Sales Nav search URLs and reads the rendered results
(no clicks, no profile opens) learned these live on 2026-10-12:

- **Never headless.** LinkedIn flags a `HeadlessChrome` user agent. Check the UA before the first search and refuse to
  run headless.
- **One run per seat.** Lock the seat (a lock file per machine) and do not use Sales Nav anywhere else while it runs.
- **Human pacing.** 4 to 9 seconds (random) between result pages, a 30 to 60 second pause every 5 pages, and scroll like
  a person so lazy rows load. Write output after every page so a stop loses nothing; rerun into the same folder to
  dedupe.
- **Auth probe first.** Load `/sales/home` and stop if the page title is not Sales Navigator.
- **Page URLs double-encode free text** (space `%2520`, quote `%2522`); single-encoded keywords make the page hang on load.
  The API takes them encoded once (page 02).
- Selectors that held on the live UI:

| What | Selector |
|---|---|
| Result count | `[class*="search-count-container"] span` (rounded above 1K: "2.5K+"; the API total is exact) |
| Result rows | `li.artdeco-list__item` |
| Full About text | `[data-anonymize="person-blurb"]` `title` attribute (the visible text is clamped) |
| View cap | page text "view up to N results per search" |
| Results page check | the filter panel shows "Company headcount" and "Headquarters location" |

- Stop on the banner phrases listed in page 05, on a non-results page, and on sign-out. Do not retry.
