# 05 Rate caps and pacing

Operating defaults, not LinkedIn's. Lower freely, raise only on the user's explicit go, never past the ceiling.
`run_log.py` enforces these.

Strict quotas apply to EXECUTION actions only: profile views, InMail, connection requests, messages, likes, posts.
Search and list reads, and saving accounts to lists, are generous (operator decision 2026-10-14: 5K+ in one paced run was
done); they keep a high pacing guard and the 3 to 5 second spacing, nothing stricter.

| Action | Default per day | Ceiling |
|---|---|---|
| Search result pages read | 100 | 200 |
| Small API calls (counts, typeahead, website batches, list reads and saves) | 300 | 500 |
| Accounts saved to a list (pacing guard, not a quota) | 2,500 | 5,000 |
| Individual profiles opened | 80 | 150 |
| Account pages opened | 60 | 120 |
| Saved searches created | 10 | 25 |

Batch tools (own assumption): 1,000 company records (`companies_details.js`) and 500 profile records
(`profiles_batch.js`) a day.

## Per-seat limits from outside sources (desk research, 2026-10-16)

LinkedIn publishes no numbers. These are vendor and community figures **as reported on 2026-10-16** (medium to low
confidence); they explain the defaults above and do not replace them.

| Limit | Figure | Confidence |
|---|---|---|
| Viewable results per search | lead 2,500 (100 pages x 25), account 1,000 (page 03) | high, shown in the UI |
| Account list size | 1,000 per list, 50 ids per save call (page 14) | high, verified |
| Search export, typical vendor caps | Evaboot 2,500 per 24 h (hard-coded); PhantomBuster 2,500 per working day (start at 500 to 1,000); Airscale 2,500 per 12 h; Vayne about 1,500 a day during a warm-up month | medium |
| Search export, aggressive vendor caps | FullEnrich 5,000 to 7,500 a day for weeks on warm accounts; Prospeo 5,000 a day | medium-low |
| Profile views | about 150 a day | medium |
| Connection requests | about 100 to 250 a week | medium |
| Lifetime export ban at about 100k rows | one claim, unverified | low |

- Overshooting gives a temporary search restriction ("Too Many Actions"). The trigger reported everywhere is a sudden
  change against the account's own history, not a fixed number: ramp a new or reactivated seat.
- Search-page reads tolerate roughly 10 to 30 times more than profile opens; in practice they are separate budgets. No
  source says batch reads are exempt.
- Account search is not more lenient than lead search; it has the lower per-query cap (1,000).
- The one hard 429 seen in our own runs came from sends, not reads: 26 connection requests in 40 minutes on a
  reactivated account.

### Pacing tiers per seat

| Tier | Rows a day (lead or account) | Weekly | Profile opens a day |
|---|---|---|---|
| Conservative (new or reactivated seat) | 500 to 1,000, ramp 50% a week | 3,000 to 5,000 | 20 to 40 |
| Typical (aged seat) | 2,500 | 12,500 | 80 |
| Aggressive | 5,000 | 25,000 | 150 |

The defaults above sit at the typical tier; the ceilings at the aggressive tier.

### Seat cost per 1,000 rows (seat only, 22 working days)

| Tier | Rows a month | $15 seat | $100 seat |
|---|---|---|---|
| Conservative | 16,500 | $0.91 | $6.06 |
| Typical | 55,000 | $0.27 | $1.82 |
| Aggressive | 110,000 | $0.14 | $0.91 |

Add account, proxy, operations and churn costs; even at 3x overhead the typical tier stays at about $1 per 1,000 rows
or less. Very cheap seats are usually referral trials or vouchers: cancelling one wipes its saved lists and searches, and
a seat on someone else's contract can be removed by their admin.

Sources: PhantomBuster, Evaboot, Airscale, Vayne, FullEnrich, Expandi, Cotera, Clay community posts (2026-10-16).

## Logging

- A `count=100` search call is 4 pages; session plans page 25 rows at a time (`pages.step` is 1 to 25), so 1,000 rows is
  40 pages either way.
- A details batch of up to 100 ids is one small call. `run_log.py` has no records column: put `records: companies N` in
  `--note`.
- Account saves: `run_log.py add --saved-accounts N --small-calls B --note "saved to list"` (B batches of up to 50).
  Saves do not count as account pages opened.
- End every action with `run_log.py quota`; it is how tomorrow's task sees what is left.

## Stop rules

Stop for the day on a 403/429 after the page was ready, a captcha, sign-out, a limit banner, or empty or repeating pages.
No retry loops. Pace 3 to 5 seconds between calls, none in parallel, one session per seat.
Banner phrases worth matching on rendered pages: "unusual activity", "been restricted", "captcha", "commercial use
limit", "reached the (monthly / weekly) limit", "security verification", "let's do a quick security check". Page 01
covers page-reading runners (headed browser, seat lock, human pacing).

## Budget per approach (Acme)

| Step | Cost |
|---|---|
| Sizing and a scored sample (counts, lanes, 300 sampled rows, details) | about 68 small calls, 12 pages, 294 company records |
| Pull S1 + S3 + S2 CD + first 600 of S2 B (1,430 unique rows) | 59 pages at 25 a page (13 + 12 + 10 + 24), 15 details batches |
| Save the 362 judged keeps to a list | 8 batches of up to 50 |
| Run 2: pull S5 + rest of S2 B + S4 (1,696 rows) | 71 pages, 17 details batches |
| Save 175 more keeps (list 537) | 4 batches |
| Leads over the list (Owner+CXO 1,183, VP+Dir 658, rest to the 2,500 cap) | about 175 pages |

All of it ran in one evening, paced 3 to 5 seconds, with no 429 and no limit banner.
