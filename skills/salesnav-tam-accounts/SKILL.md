---
name: salesnav-tam-accounts
description: >-
  Size and shape a company-side market on the user's LinkedIn Sales Navigator seat: build account
  filters and keywords, resolve ids with typeahead, count variants exactly (count=1), compare the
  options and pick one master account search. Use for "how many companies match", "build an account
  search", "which keywords work", "size this market by accounts". Counts only; read-only.
---

# Sales Nav TAM: accounts

**Job.** Turn "companies like these" into one master account search with an exact count, a short
comparison of the options, and the noise words removed. It pulls no rows beyond a 50-row sample.

**Use when** the user asks how many companies fit, which filter or keyword variant is best, or which
search to build a list from. Over the cap? Cut the master search into sub-lists (state, then headcount
band, then metro) and count each; `salesnav-tam-tracker` does that and tracks the pulls, if installed.

## Flow (adapt to the ask)

1. Find the workspace (`python3 scripts/workspace.py locate`) and read the company profile for ICP,
   keywords, noise words and exclusions. Ask only for what is missing, once.
2. Open a signed-in `linkedin.com/sales` tab; `page/csrf_ready.js` must report ready first.
3. Resolve ids with `page/typeahead.js`: geography (`BING_GEO`), industry. Niche industries often resolve
   to nothing; use a parent industry and put the niche in keywords. An empty typeahead means not found.
4. Build each query yourself from resolved ids: filters first, `keywords:` after (encoding in
   `reference.md`). Never reuse a query copied from a page URL (it returns 400).
5. Size every variant in one `page/count.js` call (`kind: account`, `queries: [{label, query}]`): the
   master, each keyword alone, with and without a NOT term, headcount bands (include self-employed and
   501+, bands do not sum to the total).
6. Noise words: one dominant keyword that mostly matches company names swamps an OR list. Count each
   alone; drop or demote it. Use NOT only for obvious off-meaning noise, after counting both ways.
7. Optionally pull 2 pages with `page/account_search.js` and read the rows with the user before scaling.
8. Report a small table (variant, count, what it adds or loses), recommend one master search, say
   whether it is over the 1,000 viewable cap, and name the next step.

## Run a snippet

`python3 runtime/session.py --emit count.js --params '{...}' --compact` prints a paste-ready async IIFE
for the browser JavaScript tool; one snippet per call, save each result under the workspace `results/`.
Cloud browser plans: `runtime/README.md`.

## Hard rules

- Read-only by default: counting and searching change nothing on LinkedIn. Never send from here.
- Respect caps: pace calls 3 to 5 seconds apart, one session per seat. Log with
  `python3 scripts/run_log.py add --small-calls N` and finish with `run_log.py quota`; never raise a cap
  without the user's explicit go.
- Stop on a 403/429 after the page was ready, a captcha or a limit banner; tell the user the message.
- Never invent claims or ids; headcount is LinkedIn's estimate, so flag brands that look wrong.

## Tools and details

`page/csrf_ready.js`, `page/typeahead.js`, `page/count.js`, `page/account_search.js`; `scripts/run_log.py`,
`scripts/workspace.py` (plus `scripts/outreach_log.py`, which `run_log.py` reads for its quota line).
Endpoints, query encoding, filter ids and gotchas: `reference.md`.
