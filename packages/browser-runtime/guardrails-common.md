# Guardrails shared by every runtime

The seat belongs to the user. A restricted account costs them far more than a slower run. A
skill's own `references/guardrails.md` adds site-specific limits; these apply on top of them.

## Sessions

- **One session per seat.** Never run the cloud browser, a local browser and the user's own
  hand-use on the same login at the same time. Ask the user to stay out of the site while a run is
  going.
- **One process per cloud-browser session.** The cloud browser stops when its CDP client
  disconnects (see `agent-browser.md`).
- **Respect the ceiling.** 40 minutes of cloud-browser time per session. Checkpoint to disk and
  reopen rather than racing it.
- **Close what you open.** End every cloud session with `close_session` and a short report.

## Pacing

- About **3 to 5 seconds between API calls**, randomized (`delay_ms` in the plan). No parallel
  calls, no bursts, and a longer pause (30 to 90 seconds) every few dozen calls on long runs.
- Wait for `networkidle` plus about 3 seconds after the first page load before the first call.
  Earlier calls fail with 403 in about 100 ms because the page's CSRF token is not ready yet;
  that is a timing error, not a block.
- Size first (a `count=1` call), sample 50 rows, then scale.

## Stop signals

Stop the run immediately, keep what is already in the JSONL, and tell the user, on any of:

- HTTP **403 or 429** after the page was ready (the runner stops on these by default),
- a captcha, "unusual activity", checkpoint or restriction page,
- a sign-out or a login wall,
- a "limit reached" banner or message,
- empty results where a total says rows exist, or the same rows on consecutive pages.

Do not retry in a loop, refresh-loop, rotate sessions, or work around the signal. Recommend
waiting at least 24 hours before another run on that seat.

## Secrets and data

- Never print, log, return or save cookies, CSRF tokens, claim strings, CDP URLs or heartbeat
  tokens. Read any token inside the page and use it there; do not pass it out.
- Never ask for, type or store a password or 2FA code. The user signs in themselves.
- Collect only the professional fields the job needs. Keep output where the user asked.
- Read-only by default. A runtime run never sends, posts, connects or messages.

## Evidence for the user

Report: calls made, rows collected, stop reason if any, where the output file is, and the next
step. Do not paste whole result sets into chat.
