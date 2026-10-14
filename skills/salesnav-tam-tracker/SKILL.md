---
name: salesnav-tam-tracker
description: >-
  Break a Sales Navigator master search that is over the viewable cap into sub-lists (state, then
  headcount band, then metro), pull each one, dedupe across them and track coverage in a CSV. Use for
  "pull the whole TAM", "split this search", "what is left to pull", "how much of the market have
  we covered", "resume the TAM pull". Pulls only what the user asks for.
---

# Sales Nav TAM: tracker

**Job.** Cover a market bigger than one search can show (1,000 accounts, 2,500 leads) with sub-lists
that each fit under the cap, and keep a checklist so any later task knows what is counted, pulled and next.

**Use when** a master search is over the cap, the user wants the full list, or a pull is being resumed.

## Flow (adapt to the ask)

1. Locate the workspace (`python3 scripts/workspace.py locate`; outside the default, pass `--workspace DIR`
   to every script). Check the tracker first:
   `python3 scripts/tam_tracker.py status`. It is `tam_tracker.csv` (columns: list_id, master,
   filters_delta, count, pulled, status new|partial|done, last_pulled, file).
2. Plan the cut. Count states in priority order with `page/count.js` until about 90 percent of the
   national count is covered, then split big states by headcount band, then metro. `scripts/shard_plan.py`
   proposes the split from the counts you give it. State ids come from `page/typeahead.js`.
3. Record each sub-list under the cap, with ids that carry the master: `tam_tracker.py add --list-id
   acme-tx-c --master acme --filters-delta "state=Texas; headcount=C" --count 840 --kind account`
   (`--kind lead` for people). A list is keyed on (master, list id). Exit 5 means over the cap (1,000
   accounts, 2,500 leads): split it further.
4. Ask `tam_tracker.py next`, pull that list page by page (`page/account_search.js` or
   `page/lead_search.js`, 25 rows, `start` += `count`), save each page under `results/<list_id>/`, then
   `tam_tracker.py update --master acme --list-id ID --pulled N --file PATH`. Status turns partial, then
   done; a changed `--count N` re-derives it.
5. Convert with `scripts/salesnav_rows.py accounts|leads results/<list_id>/*.json -o FILE.csv`, check it
   with `scripts/validate_csv.py`, and merge shards with `scripts/dedupe.py`. Shards overlap: report
   "sum X, unique Y", never the sum alone.
6. Report `tam_tracker.py status`, the unique total, what is left, and the next list.

## Run a snippet

`python3 runtime/session.py --emit account_search.js --params '{...}' --compact` prints a paste-ready async
IIFE for the browser JavaScript tool (one call per snippet). A paged cloud run is one plan in one process:
`runtime/README.md`.

## Hard rules

- Read-only by default; never send from here. Do the step asked: do not chain big pulls unless asked,
  and say what a pull will cost in pages first.
- Respect caps: default 40 result pages a day, pace 3 to 5 seconds apart. Log with
  `python3 scripts/run_log.py add --pages N` and finish with `run_log.py quota`; never raise a cap without
  the user's explicit go. A big TAM is several days of pulls: the tracker is how the next day resumes.
- Stop on a 403/429, captcha, limit banner, or empty or repeating pages; tell the user the message.
- Never invent rows or slugs; leave `linkedin_url` blank.

## Tools and details

`page/csrf_ready.js`, `page/typeahead.js`, `page/count.js`, `page/account_search.js`, `page/companies_details.js` (batched account details, up to 100 ids per call), `page/lead_search.js`;
`scripts/tam_tracker.py`, `scripts/shard_plan.py`, `scripts/salesnav_rows.py`, `scripts/dedupe.py`,
`scripts/validate_csv.py`, `scripts/run_log.py`, `scripts/workspace.py` (plus `scripts/outreach_log.py`,
read by `run_log.py` for its quota line). Caps, sharding and gotchas: `reference.md`.
