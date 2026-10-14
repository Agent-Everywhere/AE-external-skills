---
name: salesnav-tam-tracker
description: >-
  Break a Sales Navigator master search that is over the viewable cap into sub-lists (state, then
  headcount band, then metro), pull each one, dedupe across them and track coverage in a CSV. Use for
  "pull the whole TAM", "split this search", "what is left to pull", "how much of the market have
  we covered", "resume the TAM pull". Pulls only what the user asks for.
---

# Sales Nav TAM: tracker

**Engine path.** `ENGINE` is `${CLAUDE_PLUGIN_ROOT}/skills/sales-navigator` when `CLAUDE_PLUGIN_ROOT` is set,
else the `sales-navigator` folder next to this skill's folder (`<this SKILL.md's folder>/../sales-navigator`).
Set it at the top of every shell call. Below, a bare script name such as `run_log.py` means
`python3 "$ENGINE/scripts/run_log.py"` and a snippet name such as `count.js` means `$ENGINE/page/count.js`.

**Job.** Cover a market bigger than one search can show (1,000 accounts, 2,500 leads) with sub-lists
that each fit under the cap, and keep a checklist so any later task knows what is counted, pulled and next.

## Flow

0. Run `python3 "$ENGINE/scripts/doctor.py"`. **If doctor fails or the engine can't be found, stop and tell
   the user. Never fall back to driving the Sales Navigator UI by hand (clicking filters, scrolling
   results, saving lists).**
1. Locate the workspace (`python3 "$ENGINE/scripts/workspace.py" locate`; elsewhere pass `--workspace DIR`
   to every script). Check the tracker first: `python3 "$ENGINE/scripts/tam_tracker.py" status`. It is
   `tam_tracker.csv` (columns: list_id, master, filters_delta, count, pulled, status new|partial|done,
   last_pulled, file).
2. Plan the cut. Count states in priority order with `count.js` until about 90 percent of the national
   count is covered, then split big states by headcount band, then metro. `shard_plan.py` proposes the
   split from the counts you give it. State ids come from `typeahead.js`. Run snippets with
   `python3 "$ENGINE/runtime/session.py" --emit <snippet>.js --params '{...}' --compact`.
3. Record each sub-list under the cap, with ids that carry the master: `python3
   "$ENGINE/scripts/tam_tracker.py" add --list-id acme-tx-c --master acme --filters-delta "state=Texas;
   headcount=C" --count 840 --kind account` (`--kind lead` for people). Exit 5 means over the cap (1,000
   accounts, 2,500 leads): split it further.
4. Ask `tam_tracker.py next`, pull that list page by page (`account_search.js` or `lead_search.js`,
   `count` 100, `start` += `count`), save each page under `results/<list_id>/`, then
   `tam_tracker.py update --master acme --list-id ID --pulled N --file PATH`. Status turns partial, then
   done; a changed `--count N` re-derives it.
5. Convert with `python3 "$ENGINE/scripts/salesnav_rows.py" accounts|leads results/<list_id>/*.json -o
   FILE.csv`, check it with `validate_csv.py`, and merge shards with `dedupe.py`. Shards overlap: report
   "sum X, unique Y", never the sum alone. Qualifying accounts: `salesnav-tam-accounts`.
6. Report `tam_tracker.py status`, the unique total, what is left, and the next list.

## Hard rules

- Read-only by default; never send from here, and never create a Sales Nav list or saved search without
  the user's explicit confirmation. Say what a pull costs in pages first; do not chain big pulls.
- Respect caps: default 40 result pages a day (a `count=100` call is 4 pages), pace 3 to 5 seconds apart.
  Log with `python3 "$ENGINE/scripts/run_log.py" add --pages N` and run `run_log.py quota`; never raise a
  cap without the user's explicit go. A big TAM is several days: the tracker is how the next day resumes.
- Stop on a 403/429, captcha, limit banner, or empty or repeating pages; tell the user the message.
- Never invent rows or slugs; leave `linkedin_url` blank.

Tools: `$ENGINE/page/` (`csrf_ready.js`, `typeahead.js`, `count.js`, `account_search.js`,
`companies_details.js`, `lead_search.js`), `$ENGINE/scripts/` (`tam_tracker.py`, `shard_plan.py`,
`salesnav_rows.py`, `dedupe.py`, `validate_csv.py`, `run_log.py`, `workspace.py`, `doctor.py`, `outreach_log.py`).
Caps, sharding, gotchas: `$ENGINE/reference.md`.
