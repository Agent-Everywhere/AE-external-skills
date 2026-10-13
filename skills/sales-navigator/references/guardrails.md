# Guardrails — Sales Nav (cloud browser or the user's own browser)

Everything in this skill is **read-only on LinkedIn by default**. The one exception is sending,
which happens only when the user explicitly asks for it and approves each batch, under
[`outreach.md`](outreach.md). The outreach caps and stop rules are at the end of this file.

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
| Small API calls (counts, typeahead, website batches) | 150 | 200 | Tiny responses, but still calls; sizing a shard plan uses a lot of this. Log them with `scripts/run_log.py add --small-calls N` |
| Individual profiles opened | 80 | 150 | Only when the row lacks a needed field |
| Account pages opened | 60 | 120 | Mode B/C research |
| Saved searches created | 10 | 25 | |
| Concurrent browsers / sessions on this seat | 1 | 1 | Never two sessions on one LinkedIn login (cloud plus local counts as two) |
| Active hours | user's local business hours | — | No overnight marathons |

Viewable results per search are capped by Sales Nav (≈2,500). Shard instead of paging past it.

**Why small calls are 150 / 200.** Account and lead search pages are a different row (counted
under "Search result pages read" and never under small calls), so a 50-account pull plus sizing,
typeahead and website lookups needs more small calls than the old 100 and still stays tiny in
traffic. 150 is the default and 200 the hard ceiling (50 above the default, as before). LinkedIn
publishes no limit, so these stay conservative operating numbers. Past 150 needs the user's
explicit go.

**When the daily page budget would be exceeded (or a cap stops a pull),** say so and give the numbers:
rows collected, rows remaining (the shard's `paging.total` minus rows saved), and which cap. Then
offer exactly these three options, **in this order, with the first as the recommended default**:

1. **Use the rows already pulled** (no new calls). *Recommended and safe.*
2. **Continue tomorrow** (the CSV and `--skip-done` / the next page number resume it). No calls today.
3. **Raise today's cap**, only with the user's explicit OK in that conversation, only up to the hard
   ceiling, and never after a stop signal below.

**Question cards time out to the recommended option.** Cowork can auto-select the recommended
choice after a few minutes with nobody answering. So the recommended/default option of any choice
this skill asks must be the **safe** one: never raise a cap, never spend calls, never send. Say
"the safe default is X" in the question. Never recommend raising a cap, and never raise one on
your own or because a card timed out. **A send approval is never a card:** it is the user's own
typed message in chat approving the exact batch (`outreach.md`); a card's auto-selected default,
a timeout or silence is not approval, and with no typed approval nothing is sent.

**Unattended runs** (scheduled tasks, nobody to answer) take the safe option automatically: no
new calls beyond the budget, no raised cap, no send. Report what was skipped.

## Where the counters live (they must persist)

The caps only protect the seat if the numbers survive from one task and one day to the next. They live
in the **workspace** folder (`SKILL.md` preflight; default `~/Claude/sales-navigator`, Cowork's
user-files folder): `run_log.csv` (pulls), `outreach_log.csv` (sends), and `quota.md`, which
`scripts/run_log.py quota` rewrites from both with today's and the last 7 days' usage against the caps.
Start every action by reading it and end every action by regenerating it, then show the user the
one-line summary (`Today: 87/150 calls · 12/20 invites · week 41/100`). If the scripts refuse
(exit 4: **no workspace found**, or the workspace folder does not exist), the counters would not persist
or would restart from zero: ask the user where their Cowork folder is instead of carrying on, because a
fresh log makes every cap look untouched.

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

## Outreach caps and stop rules (only when the user has asked to send)

Sending is not part of any read action. If the user has not explicitly asked to send, none of this
applies and nothing is sent. The procedure, the approval rule and the pacing are in
[`outreach.md`](outreach.md); load it only then. The numbers live here and in
`scripts/outreach_log.py` (a test keeps the two equal).

| Outreach cap | Default |
|---|---|
| Connection requests per day | 20 |
| Connection requests per 7 days | 100 |
| Follow-up messages to people who accepted, per day | 20 |
| Messages to one person (first message plus follow-ups) | 3 |
| InMails | within the InMail credits the seat has left; never past the user's own cap |

Lower the caps freely; raise them only on the user's explicit go. A new or recently restricted seat
should start well below the defaults.

Stop sending, report to the user, and send nothing more that day when:

- any LinkedIn warning, captcha, "unusual activity" or checkpoint page appears,
- a "weekly invitation limit", "you've reached the limit" or similar banner appears,
- the daily or 7-day cap is reached (`scripts/outreach_log.py caps` exits 2),
- the outreach ledger is missing or the workspace cannot be located (`outreach_log.py` exits 4 and refuses): never start a fresh ledger to get past it, ask the user where it is; only the very first send ever creates one, with `--first-send` and the user told (`outreach.md`),
- the result of a send is unknown (never click again; log it with `--note unverified` so nobody retries, and ask the user).
