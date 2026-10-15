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
