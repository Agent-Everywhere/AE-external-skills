# Guardrails — Sales Nav (cloud browser or the user's own browser)

The seat belongs to the user. A restricted LinkedIn account costs them far more than a slower
list. When in doubt, go slower and ask. These limits apply on every runtime; the runtime-level
rules (sessions, heartbeats, secrets) are in `runtime/guardrails-common.md`.

A **local** run uses the user's own seat, session and home IP, so tell them that before the first
call and keep to the pace below.

LinkedIn does not publish its limits and changes them. The numbers below are **conservative
operating defaults**, not LinkedIn's thresholds. Users may lower them; raise them only with the
user's explicit go, and never past the "hard ceiling" column.

## Daily volume defaults (per seat, per day)

| Action | Default | Hard ceiling | Notes |
|---|---|---|---|
| Search result pages read | 40 (≈1,000 rows) | 80 | 25 rows/page, whether read from the page or fetched by an API search call; spread across the day for big runs |
| Small API calls (counts, typeahead, website batches) | 100 | 150 | Tiny responses, but still calls; sizing a shard plan uses most of this |
| Individual profiles opened | 80 | 150 | Only when the row lacks a needed field |
| Account pages opened | 60 | 120 | Mode B/C research |
| Saved searches created | 10 | 25 | |
| Concurrent browsers / sessions on this seat | 1 | 1 | Never two sessions on one LinkedIn login (cloud plus local counts as two) |
| Active hours | user's local business hours | — | No overnight marathons |

Viewable results per search are capped by Sales Nav (≈2,500). Shard instead of paging past it.

## Pace

- **About 3–5 seconds between API calls**, randomized (the runtime's `delay_ms`); a longer pause
  (30–90s) every few dozen calls on a long run. No parallel calls, no bursts.
- Wait for `networkidle` plus about 3 seconds after the first page load before the first call.
- Page reading: a few seconds between page loads, a longer pause every ~5 pages, and scroll the
  page to load results before reading, like a person. No parallel tabs hammering searches.
- Size with `count=1`, sample 50 rows, then scale; do not page a search you have not sized.

## Stop immediately and tell the user if you see

- A captcha, "unusual activity", "we've restricted your account", or a security checkpoint.
- A "commercial use limit" / "you've reached the limit" banner.
- Being signed out mid-run, or a page asking for a password or code.
- Results suddenly empty or the same page repeating (soft throttling).
- **HTTP 403 or 429 from the API after the page was ready** (the runtime stops on these by
  default). A 403 within ~100 ms of the very first call is just the token not being ready yet;
  wait and retry once, then treat it as a stop.

On any of these: stop the run, save what you have, report the exact message (no screenshots of
private data), and recommend waiting at least 24h. **Never retry, refresh-loop, or work around it.**

## Data handling

- Collect only professional fields needed for the list (see `output.md`).
- No personal emails, phone numbers, or private details from profiles.
- Keep results where the user asked (their file/sheet/CRM). Don't paste whole lists into
  unrelated tools.
- Respect the user's exclusions and any "do not contact" list on every run.

## Browser hygiene

- **One session per seat.** Use the saved profile; close the cloud browser session as soon as the
  run ends (it is billed). Cloud browser: one `session.py` process per session, heartbeats at
  least every 60 s, a hard 40-minute ceiling (checkpoint to JSONL and reopen).
- If the workspace reports a concurrency or billing limit, stop and ask.
- The user signs in themselves via the sign-in browser (or their own window). Never handle
  passwords or 2FA.
- Never print, log or save cookies, CSRF tokens, claim strings or CDP URLs. Tokens are read and
  used inside the page only.

## Outreach is out of scope

This skill is read-only. Sending invites or messages belongs to the outreach skill, which has
its own (stricter) weekly limits and requires CRM dedupe first.
