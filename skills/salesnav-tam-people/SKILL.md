---
name: salesnav-tam-people
description: >-
  Size and shape a people-side market on the user's LinkedIn Sales Navigator seat: title, seniority,
  function, geography and company-headcount filters, exact counts per variant, and a master lead
  search under the 2,500 cap. Use for "how many CMOs", "decision-makers at companies like these",
  "build a people search", "size this audience". Counts and samples only; read-only.
---

# Sales Nav TAM: people

**Job.** Turn "these roles at these kinds of companies" into one master lead search with an exact
count, the variants compared, and a sample the user has checked.

**Use when** the user asks how many people fit, which titles or seniority levels to use, or which lead
search to build a list from. Over the 2,500 viewable cap? Cut it into sub-lists (state, then company
headcount band, then metro) and count each; `salesnav-tam-tracker` tracks that, if installed.

## Flow (adapt to the ask)

1. Find the workspace (`python3 scripts/workspace.py locate`); read the company profile for buyer types,
   titles by company size, title words to exclude and geography. Ask only for what is missing.
2. In a signed-in `linkedin.com/sales` tab, run `page/csrf_ready.js`, then `page/typeahead.js` for
   geography (`BING_GEO`) and industry ids. Titles go in as free text (`CURRENT_TITLE`).
3. Build queries yourself: `CURRENT_TITLE` words, `SENIORITY_LEVEL` (320 owner, 310 CXO, 300 VP, 220
   director), `FUNCTION`, `REGION`, `COMPANY_HEADCOUNT` (letter ids). Seniority alone returns every
   director: pair it with a title or function. Lead `REGION` is where the person is, not the company.
4. Size variants in one `page/count.js` call (`kind: lead`, `queries: [{label, query}]`): each title
   alone, with and without a seniority level, each headcount band, each region. Drop a title that
   dominates with the wrong people.
5. Pull one sample page (25 rows) with `page/lead_search.js`; read titles and companies with the user
   and fix filters before anything larger.
6. Report a table (variant, count, note), recommend a master search, say if it is over 2,500, and
   suggest the next step. Rows carry a Sales Nav lead URL, never a public slug: leave `linkedin_url` blank.

## Run a snippet

`python3 runtime/session.py --emit count.js --params '{...}' --compact` prints a paste-ready async IIFE
for the browser JavaScript tool; one snippet per call, save results under the workspace `results/`.
Cloud browser plans: `runtime/README.md`.

## Hard rules

- Read-only by default: counting and searching change nothing on LinkedIn. Never send from here.
- Respect caps: pace calls 3 to 5 seconds apart, one session per seat. Log with
  `python3 scripts/run_log.py add --small-calls N` (or `--pages N` for sample pages) and finish with
  `run_log.py quota`; never raise a cap without the user's explicit go.
- Stop on a 403/429 after the page was ready, a captcha or a limit banner; tell the user the message.
- Never invent people, titles, slugs or facts. There are no exclusions at search time: exclude after
  collecting and show what was removed.

## Tools and details

`page/csrf_ready.js`, `page/typeahead.js`, `page/count.js`, `page/lead_search.js`; `scripts/run_log.py`,
`scripts/workspace.py` (plus `scripts/outreach_log.py`, which `run_log.py` reads for its quota line).
Endpoints, query encoding, filter ids and gotchas: `reference.md`.
