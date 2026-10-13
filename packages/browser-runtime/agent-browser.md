# Runtime: Agent Browser (cloud browser)

A cloud browser, signed in with the user's saved profile, driven from code that runs in your
own sandbox or shell. It works from Claude Code, from Claude Desktop **Cowork** (the sandbox
allows `pip install playwright` and outbound calls to the connector; no browser download is
needed because Playwright attaches over CDP), and from other agents with shell access.

Needs: the Agent Browser connector (tools `browser`, `workspace`) **and** code execution.
Without code execution (plain chat) this runtime is not available: use the skill's slow
page-reading path instead.

## Preflight (before spending a session)

Both calls are free reads; do them first, in this order.

1. **Workspace.** Call the connector's `workspace` tool with `action=list`. Browsers are billed to
   a workspace, and each plan has a monthly hours allowance and a cap on browsers open at once.
   Pick a workspace with hours left and no browser already running (`in_use` below
   `max_browsers`). If the user has several, say which you picked; if a Free plan is out of hours,
   `open_session` is rejected with `plan_hours_exhausted` and retrying cannot help, so tell the
   user. For a big run, `browser action=usage` with that `workspace` shows what is already used.
   Pass the chosen workspace to `open_session`.
2. **Sign-in per site.** Call `browser action=status`. It reports whether a saved profile exists
   and, per site, what real runs last reported (`ok` or `auth_required`). It never says what is
   inside the profile, so it is a hint, not proof: the auth probe in step 3 below is the check.
   If Sales Navigator shows `auth_required`, or there is no saved profile, have the user sign in
   first (`browser action=open_browser`) before you open a billed session.

## Flow

1. **Prepare first.** The claim in step 2 lives 60 seconds. Install Playwright
   (`python3 -m pip install playwright`; the import has no `__version__`, check with
   `pip show playwright`), write the plan JSON, and have the command ready.
2. **Open.** Call the connector: `browser action=open_session` with the user's workspace and the
   site. The result carries `claim` (one-use, 60s), `base`, `session_id`, `auth_probe`,
   `lease_expires_at`, and `ceiling_at`.
3. **Run, in ONE process:**
   ```
   AB_CLAIM="<claim>" python3 runtime/session.py --runtime agent-browser --base "<base>" \
           --plan plan.json --out results.jsonl
   ```
   Pass the claim as the `AB_CLAIM` environment variable rather than `--claim`: command-line
   arguments are visible to other users on the machine (`ps`). `--base` must be an `https` URL.
   The script then does everything below by itself:
   - `POST <base>/browser/claim {claim}` returns `cdp_url`, `heartbeat_token`, `session_id`.
   - Imports Playwright first (exit 2 if it is missing, before the claim is spent), then connects
     with `connect_over_cdp` and uses `contexts[0].pages[0]`.
   - Navigates to the plan's start page, waits for `networkidle` plus about 3 seconds, runs the
     signed-in probe, and `POST <base>/browser/auth {session_id, heartbeat_token, signed_in}`.
     If the connector answers `error: auth_required`, or the probe fails, it stops (exit 3): the
     scraper is not broken, the user is signed out. Ask them to sign in through the sign-in
     browser (`open_browser`) and save; never handle a password or 2FA code.
   - Heartbeats from a thread every 25 seconds (the connector requires one at least every 60s,
     or it reclaims the browser). A 4xx answer, or 3 failed beats in a row, means the session is
     gone: the runner checkpoints and exits 4 instead of working on a dead browser.
   - Runs the plan's calls with a pause between them, one JSONL record per call, flushed.
4. **Close.** Call `browser action=close_session` with a `report` (what ran, rows, attempts, any
   stop reason). The browser has usually already stopped: it dies the moment the CDP client
   disconnects, so `close_session` may answer `already closed`. That is normal.

## Rules that come from how the browser works

- **Do all of a session's work in one process.** When the script exits or disconnects the browser
  is gone, and its state with it. Do not split a session across several scripts, and do not
  background-poll from another process.
- **Hard 40-minute ceiling** on browser time (`ceiling_seconds`). `session.py` stops with a
  `checkpoint` event and exit code 4 near the limit (`--max-seconds`, default 2280). Everything
  collected is already in the JSONL. Open a new session and re-run with `--skip-done`.
- **A claim is one-use and expires in 60 seconds.** If the claim fails, open a fresh session; do
  not retry the same claim.
- **One session per seat.** Never open a second session on the same login while one is running.
- **Billing is browser time.** Do not leave a session idle; close it when the job ends.
- **Dependent steps cost a session each, unless the plan can chain them.** A plan is fixed before
  the claim is spent (the claim lives 60 seconds), so calls inside one plan can only use params
  written in advance. Chain steps in one plan only when every param is static: for example a
  fixed list of states or title queries, or ids you already have. When a step needs the output of
  an earlier step (typeahead ids for a query, the companies a search returned, then a search per
  company), expect one session per step: run the first plan, close, read the JSONL, write the
  next plan, open a new session. The local runtime (`local.md`) has no such limit, because each
  snippet is its own tool call and the next call can use the last result.
- **A long-lived helper process is fine** if it is the one holding the CDP connection (for
  interactive exploration it can read command files and execute them). It must still heartbeat.

## Exit codes

| Code | Meaning | Next |
|---|---|---|
| 0 | plan finished | close_session, hand off the JSONL |
| 3 | not signed in / `auth_required` | ask the user to sign in, then a new session |
| 2 | usage, invalid plan, or Playwright not installed | fix it; no claim was spent |
| 4 | checkpoint: time ceiling, lost heartbeat or page budget | new session, `--skip-done` |
| 5 | stop status (403/429) | stop; see `guardrails-common.md` |
| 6 | browser, page or claim error | read the `error` event; new session if the page is gone |
| 7 | page never ready (CSRF cookie absent) | confirm the page is signed in and loaded, retry once |
| 8 | finished, but a call failed or a paged call was truncated | read the `ended` event and the failed records; do not treat the output as complete |

An intentional partial pull is not a failure: set `"sample": true` on the plan (or on one call)
and a paged call that stops with rows left unread ends with a `sampled` event and exit 0 instead of
exit 8. Use it for the 50-row sample of a big search (`"pages": {"max_pages": 2}`); never for a
collection you mean to hand over as complete. `sample` only counts on a call with an explicit
`pages.max_pages` that stops on that limit; a call without `max_pages` that hits the viewable cap
still exits 8 even when the plan says `"sample": true`. A failed call or an empty early page still
exits 8.
