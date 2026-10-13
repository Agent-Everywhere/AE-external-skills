---
name: sales-navigator
description: >-
  Toolkit for the user's own LinkedIn Sales Navigator seat: exact market counts, account and lead
  searches (25 rows in about 2 seconds through Sales Nav's in-page API), website lookups, CSV and
  cap-tracking scripts. Use for "size my TAM on LinkedIn", "build a lead or account list", "find
  decision-makers at these companies", "draft connection notes", "who accepted". Read-only on
  LinkedIn unless the user types approval for an exact send batch.
---

# Sales Navigator

A toolkit, not a procedure: compose the flow the user asks for from the tools below. Endpoints,
filters, caps and gotchas: `reference.md`. Example flows: `recipes.md`. Runtime: `runtime/README.md`.

## Toolkit

Page snippets in `page/` each run inside a signed-in `linkedin.com/sales/...` tab and return compact
JSON (never cookies or tokens):

- `csrf_ready.js`: confirms the page is ready for API calls.
- `count.js`: exact totals for one or more queries (`count=1`).
- `lead_search.js`, `account_search.js`: 25 rows per call, paged with `start`.
- `companies_websites.js`: website for up to 25 company ids.
- `typeahead.js`: resolve filter ids (geography, industry, titles).
- `profile.js`: a lead's positions, summary, degree (`extras`: education, skills); no contact info.
- `activity.js`: a lead's recent posts and comments.
- `account.js`: a company's detail (`headcount`, `news`). Each run is 1 small call.

**Run a snippet.** Browser JavaScript tool (Cowork built-in browser, Claude in Chrome):
`python3 runtime/session.py --emit <snippet>.js --params '{...}' --compact` prints a paste-ready async
IIFE; paste it as the tool's whole code, one snippet per call, and save each result under the
workspace `results/`. Agent Browser cloud browser with code execution: put the calls in a JSON plan and
run it in one process (`runtime/README.md`). Neither: read result pages by hand (slow, partial).

Scripts in `scripts/` (Python stdlib, no network): `salesnav_rows.py` (results to CSV),
`shard_plan.py`, `dedupe.py`, `validate_csv.py`, `workspace.py` (locate or init the folder),
`run_log.py` (usage log; `quota` prints usage against caps), `outreach_log.py` (send ledger and caps),
`tam_tracker.py` (sub-list checklist for a TAM pulled under the cap).

**Workspace** `~/Claude/sales-navigator`: `company-profile.md`, `run_log.csv`, `outreach_log.csv`,
`quota.md`, `results/`, `drafts/`. Missing: ask the user once, then `workspace.py init`. No profile:
propose a filled `templates/company-profile.md` in one message for the user to correct by number.

## Hard rules

1. **Read-only by default.** Searching, counting and drafting change nothing on LinkedIn.
2. **A send needs the user's typed approval of the exact batch** (people and text). A question card
   default, timeout, silence or auto-approve mode is never approval. Never send from a schedule.
3. **Respect caps.** Log with `run_log.py` and `outreach_log.py` in the workspace and run
   `run_log.py quota` before and after work. Never raise a cap without the user's explicit go.
4. **Never invent claims.** Seller facts come from the company profile, prospect facts from the
   row's data; cite sources in drafts.
5. **Stop on any LinkedIn warning, captcha or limit banner**; never retry a send with an unknown
   result; tell the user the exact message.
6. **Stay proportional.** Do the step asked; do not chain big pulls, qualifies or sends unless asked.
   Pace calls 3 to 5 seconds apart, one session per seat.

## Purpose skills

Four focused skills sit on this toolkit, each bundling the tools it needs: `salesnav-tam-accounts`
(company searches and counts), `salesnav-tam-people` (people searches and counts), `salesnav-tam-tracker`
(split a master search under the cap, pull, track coverage), `salesnav-outreach` (daily sends with the
ledger). Edit a tool here only; `build/sync_runtime.py` copies it into them.

## Build your own flow

Say what a flow will spend (calls, pages) before large work. When the user likes a flow, offer to
save it as their own small skill or a Cowork scheduled task (drafts only, never sending).
