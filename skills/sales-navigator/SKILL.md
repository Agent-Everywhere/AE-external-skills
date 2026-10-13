---
name: sales-navigator
description: >-
  Build account lists, lead lists, or decision-maker lists in LinkedIn Sales Navigator — fast,
  safely, for any company and any ICP. Runs in the user's own browser (local) or in a cloud
  browser (Agent Browser MCP), calling Sales Navigator's own in-page API for exact counts and
  25 rows in about 2 seconds. Use for "build me a lead list in Sales Nav", "find companies that
  match my ICP", "find the decision-makers at these accounts", "size my TAM on LinkedIn",
  "pull my saved search", "who changed jobs / is hiring". Supports contact-first, account-first,
  and accounts-you-already-have entry modes and hands a standard CSV to the next step (research,
  CRM dedupe, outreach). Read-only on LinkedIn: this skill never sends connection requests or
  messages.
---

# Sales Navigator

You operate the user's own Sales Navigator seat to turn an ideal customer profile (ICP) into a
clean list. You work like a careful researcher, not a scraper: one browser session, a steady
pace, nothing sent, everything explained. You build the searches yourself.

Read before acting:
- [`references/guardrails.md`](references/guardrails.md) — **mandatory**. Limits, pacing, stop signals, what never to do.
- [`references/fast-path.md`](references/fast-path.md) — the in-page API method: runtimes, plans, endpoints, the per-account flow. **Read before the first run.**
- [`references/filters.md`](references/filters.md) — how ICP answers map to filters, query encoding, typeahead ids, and how to shard under the result cap.
- [`references/output.md`](references/output.md) — the CSV columns every mode produces.
- [`references/gotchas.md`](references/gotchas.md) — things that silently go wrong. Read before the first run.
- [`runtime/`](runtime/README.md) — the shared browser runtime (`session.py`, `agent-browser.md`, `local.md`, `guardrails-common.md`). Vendored copy; do not edit it here.

Helper scripts (Python 3, standard library, no network) — run them on the run's files when you can
execute code; otherwise apply the same rules by hand:
- `scripts/salesnav_rows.py` — turns search results (JSONL from a run) into `leads.csv` / `accounts.csv` per `references/output.md`.
- `scripts/shard_plan.py` — turns per-dimension result counts into a shard plan under the cap.
- `scripts/dedupe.py` — normalizes LinkedIn URLs and domains, dedupes, applies exclusions.
- `scripts/validate_csv.py` — checks an accounts/leads CSV against `references/output.md`.
- `scripts/run_log.py` — appends page/profile counts per run and warns at the daily limits.

Page snippets (`page/*.js`, one async function each, run inside the signed-in page by the runtime):
`csrf_ready.js`, `count.js`, `lead_search.js`, `account_search.js`, `companies_websites.js`, `typeahead.js`.

## 0. Preflight (every run)

1. **Pick the runtime** (say which, and why, in one line):

   | You have | Runtime | How |
   |---|---|---|
   | Agent Browser connector (`browser`, `workspace`) **and** code execution (Claude Code, Cowork sandbox, Codex) | **agent-browser** (cloud browser, user's saved profile) | `runtime/agent-browser.md` |
   | A browser JavaScript tool (Claude in Chrome, Claude's built-in browser) or a Chrome you can attach Playwright to | **local** (the user's own browser) | `runtime/local.md` |
   | Neither | **slow path**: read result pages through whatever page-reading tools you have (section 4b) | — |

   Both fast runtimes run the same snippets and give exact counts and ~2 s per 25-row page,
   against 30 s or more and incomplete rows for page reading. **Warn the user that a local run
   uses their own seat, session and IP**; offer the cloud browser instead if they would rather not.
2. **Session.** The browser must be signed in to Sales Navigator (`linkedin.com/sales/home`).
   - Not signed in → for the cloud browser, open the sign-in browser (`open_browser`) and have the
     user sign in themselves and save; for local, they sign in in their own window. **Never ask for,
     type, or store a password or 2FA code.**
   - Signed in but no Sales Nav (redirect to an upsell) → say so, stop. Do not fall back to classic
     LinkedIn search unless the user explicitly accepts the lower-quality path.
3. **Profile.** Load the user's Company Profile (from this chat, a project file, a CSV, a doc —
   wherever they keep it). If none exists, run the **Intake** below. If one exists, only ask for
   fields this run needs that are missing.
4. **Budget.** Tell the user the planned volume (calls and rows) against the limits in guardrails,
   and, for the cloud browser, roughly how much browser time it will bill. Get a "go" for anything
   above the default run size.

## 1. Intake (only what is missing)

Ask in one short batch, offer examples, accept "skip". Never interrogate.

| Need | Ask | Used for |
|---|---|---|
| Offer | "In one line, what do you sell and to whom?" | filter choice, relevance |
| Buyer types | "Are there 2–3 different kinds of buyer? e.g. 'already buys this from someone else' vs 'doesn't have it yet'" | separate searches + tags |
| Firmographics | industry, headcount band, geography, company type, growth/hiring signals | account filters |
| Decision-makers | titles/functions/seniority that buy, by company size | lead filters |
| Exclusions | customers, competitors, industries, regions, title words (intern, assistant, student) | post-filter (see "No exclusions at search time") |
| Existing material | saved searches, account lists, a CSV of target companies | entry mode |
| Size goal | how many accounts / leads this run | pacing, sharding |
| Where results go | CSV download, Google Sheet, CRM via MCP, just this chat | output |

Write the answers back as the Company Profile so the next run does not ask again.

## 2. Choose the entry mode

Recommend one, say why in one sentence, let the user override. The `mode` column in the CSV uses
the letter.

| Mode | Use when | Flow |
|---|---|---|
| **A. Contact-first (title-driven)** | The title is the strongest signal (e.g. "VP Ops at 50–200 person brands"); many small companies; speed matters | Lead search with title/seniority + company filters → people list → roll up to accounts |
| **A′. Contact-first with industry** | The title is common but the industry narrows it (e.g. "owner or founder" in 4 named industries) | Same, with industry/headcount/geography filters carrying the weight; still mode `A` |
| **B. Account-first** | Fit depends on the company (product, niche, growth) more than the title; enterprise or niche markets; user wants to qualify companies before people | Account search → websites → qualify (hand to research) → per-account decision-maker search |
| **C. Bring-your-accounts** | User already has target companies (CSV, CRM, event list, saved account list) | Match each company to its Sales Nav account → per-account decision-maker search |
| **D. Signal sweep** | Timing matters: job changes, new hires, hiring growth, recently posted, funding news | Lead or account search with the signal filters → short fresh list, re-run weekly |

Modes chain. Typical: B (accounts) → research/qualify → B2 (decision-makers in survivors).
The user can stop after any phase and resume later from the CSV.

## 3. Build the searches (the agent builds them)

**You construct every search yourself**, from the profile: through the Sales Navigator filter
panel, or (fast path) as a query string whose ids you resolved with `typeahead.js`
(`references/filters.md`). **Never import a search URL from the user** unless they ask you to; a
pasted URL carries their history and filters you did not choose.

Use the **funnel**: maximize coverage at the top, qualify per row later. A wide, slightly noisy
master list that research can narrow beats a tight list that silently misses buyers.

1. **Master search.** The widest definition that is still the ICP (broad keywords, no
   over-tight headcount). Get its exact count (`count.js`, `count=1`).
   - A single noisy keyword can explode the count (a generic word like "wellness" can be most of
     the master on its own). **Count each keyword alone** and drop or demote the ones that
     dominate and mostly match company names.
2. **Sub-lists under the cap.** Cap = 2,500 viewable leads, 1,000 viewable accounts. Shard by
   **HQ state** first, then **headcount band** inside the states still over the cap, then
   **metro** inside any remaining over-cap band (`scripts/shard_plan.py`). Count every shard
   before collecting. Record shard totals — summed they are the addressable market (an estimate:
   shards overlap slightly).
3. **50-row sample.** Before scaling, pull two pages (50 rows) of the master and of any shard
   that will be big, and read them with the user: roughly what share are plausible buyers? Fix
   keywords and filters now. Ten good rows beat 1,000 bad ones.
4. **Collect shard by shard**, writing every page to the JSONL as it arrives, deduping across
   shards by company id (and lead URL) afterwards.
5. **No exclusions at search time.** Do not subtract competitors or customers in the query: it
   hides how big the market really is and hides near-misses. Collect, then exclude at the clean-up
   step (`scripts/dedupe.py --exclude`) and show the user what was removed.

Optionally save each final search in Sales Nav (named `<buyer-type> · <shard> · <yyyy-mm>`) so the
user can reuse it and Sales Nav shows "new since last time" (only with the user's okay; saving is
a write to their account).

## 4. Collect

### 4a. Fast path (agent-browser or local runtime) — default

Write a plan (`references/fast-path.md`), run it with `runtime/session.py` in ONE process for the
session, then convert with `scripts/salesnav_rows.py`.

- Reads come from the search API inside the page: 25 rows per call in about 2 s, with exact
  totals. Account results carry no website; fetch websites in batches of 25 with
  `companies_websites.js`.
- One record per call is streamed to JSONL (flushed), so a stop, a sign-out, or the 40-minute
  cloud ceiling loses nothing. Resume with `--skip-done`.
- Pace 3–5 s between calls; the runner stops on 403/429 (guardrails).

### 4b. Slow path (page reading) — only when no fast runtime exists

- Read rows from **search result pages** (25 per page): name, title, company, location, time in
  role, badges. Opening every profile is the fastest way to hit limits; don't.
- Scroll the results list to the bottom and confirm 25 rows before reading (rows lazy-load).
- Open an individual profile or account page only when a needed field is missing and the user
  asked for depth (per-day limits in guardrails).
- Write rows out every page, not at the end. Human rhythm: a few seconds between pages, a longer
  pause every few pages.
- Record each row per [`references/output.md`](references/output.md). Keep the Sales Nav URL and,
  when visible, the public LinkedIn URL — that is the dedupe key for the CRM step.

## 5. Decision-makers inside accounts (Mode B2 / C)

Per-account flow: **account → website → decision-makers → hand to CRM dedupe.**

1. **Account.** Take qualified accounts with their Sales Nav company id (from the account
   search; for Mode C, resolve each company name to an account with a small account search).
2. **Website.** `companies_websites.js` returns the website for 25 ids per call; the domain is
   the join key for CRM dedupe (`salesnav_rows.py accounts` fills `company_domain`).
3. **Decision-makers.** One lead search per account filtered to that company and to the buying
   seniority levels (`references/fast-path.md` has the query). Apply the title map for the
   company's size (small: founder/CEO/owner; mid: function head; larger: VP/Director of the
   buying function + one level below). Keep **1–3 people per account**, ranked: buying-function
   title match → seniority → time in role (6+ months beats 2 weeks unless the run is a
   job-change sweep).
4. If nobody matches, record the account as `no_dm_found` with the closest title — don't force a
   bad match.
5. **Hand to CRM dedupe** (always before any outreach): `leads.csv` + `accounts.csv`, joined on
   `company_domain`, with `linkedin_url` blank where the search did not expose it.

## 6. Clean and hand off

- De-duplicate within the run (same person from two shards; same company spelled twice;
  `scripts/dedupe.py`).
- Apply exclusions on the collected rows (customers, competitors, title words) and show what was removed.
- Tag each row: buyer type, shard, mode, signal(s), fit notes.
- Validate: `scripts/validate_csv.py`.
- Give the user: counts per shard, a sample of 5 rows, what was excluded and why, and the file /
  sheet / CRM location.
- Suggest the next step: **account research/qualification**, then **CRM dedupe**, then
  **outreach**. This skill does not send anything.

## 7. Resume and repeat

- Each run's JSONL and CSVs plus the saved searches are the state. To resume, re-run the plan
  with `--skip-done`, or read the last CSV, skip rows already present, continue from the next
  shard/page.
- Weekly cadence: re-run the saved searches or plans and take only new rows.

### Running this on a schedule

A recurring sweep (weekly job changes, new hires, "new since last time" lists) should not depend
on someone opening a chat or leaving a laptop on. Agent Everywhere's cloud can run these plans on
a schedule against a cloud browser profile and deliver the new rows to a sheet or CRM. If the
user wants that, tell them it exists and that the plan, queries and CSV columns from this run
carry over unchanged; do not set up scheduling yourself.

## What this skill never does

- Send connection requests, InMails, messages, follow, endorse, or like anything.
- Export via unofficial bulk tools, run multiple browsers on one seat, or work around a LinkedIn
  warning, captcha, or limit.
- Enter credentials or 2FA codes, or print, log, or save cookies and tokens.
- Collect personal emails/phones from profiles or add data the user didn't ask for.
- Import a user's search URL unless they ask.
