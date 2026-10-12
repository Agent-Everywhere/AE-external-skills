---
name: sales-navigator
description: >-
  Drive LinkedIn Sales Navigator through a cloud browser (Agent Browser MCP) to build
  account lists, lead lists, or decision-maker lists — safely, at a human pace, for any
  company and any ICP. Use for "build me a lead list in Sales Nav", "find companies that
  match my ICP", "find the decision-makers at these accounts", "size my TAM on LinkedIn",
  "pull my saved search", "who changed jobs / is hiring". Supports three entry modes
  (lead-first, account-first, accounts-you-already-have) and hands a standard CSV to the
  next step (research, CRM dedupe, outreach). Read-only on LinkedIn: this skill never sends
  connection requests or messages.
---

# AE Browser — Sales Navigator

You operate the user's own Sales Navigator seat inside a cloud browser to turn an ideal
customer profile (ICP) into a clean list. You work like a careful human researcher, not a
scraper: one browser, steady pace, nothing sent, everything explained.

Read before acting:
- [`references/guardrails.md`](references/guardrails.md) — **mandatory**. Limits, stop signals, what never to do.
- [`references/filters.md`](references/filters.md) — how ICP answers map to Sales Nav filters, and how to shard under the result cap.
- [`references/output.md`](references/output.md) — the CSV columns every mode produces.
- [`references/gotchas.md`](references/gotchas.md) — things that silently go wrong (result cap, lazy-loading rows, Sales Nav vs public URLs, sign-outs, throttling). Read before the first run.

Helper scripts (Python 3, standard library, no network) — run them on the run's CSVs when you can
execute code; otherwise apply the same rules by hand:
- `scripts/shard_plan.py` — turns per-dimension result counts into a shard plan under the cap.
- `scripts/dedupe.py` — normalizes LinkedIn URLs and domains, dedupes, applies exclusions.
- `scripts/validate_csv.py` — checks an accounts/leads CSV against `references/output.md`.
- `scripts/run_log.py` — appends page/profile counts per run and warns at the daily limits.

## 0. Preflight (every run)

1. **Tools.** Confirm the Agent Browser tools are available (`browser`, `workspace`). If not, give
   the user the connector steps for their app and stop.
2. **Session.** Open the browser with the saved profile. Load `linkedin.com/sales/home`.
   - Not signed in → open the sign-in browser for the user (`open_browser`), tell them to sign in
     to LinkedIn themselves and press Save. **Never ask for, type, or store a password or 2FA code.**
   - Signed in but no Sales Nav (redirect to LinkedIn upsell) → say so, stop. Do not fall back to
     classic LinkedIn search unless the user explicitly accepts the lower-quality path.
3. **Profile.** Load the user's Company Profile (from this chat, a project file, a CSV, a doc —
   wherever they keep it). If none exists, run the **Intake** below. If one exists, only ask for
   fields this run needs that are missing.
4. **Budget.** Tell the user today's planned volume (pages, profiles to open) against the limits in
   guardrails, and how much browser time that is likely to bill. Get a "go" for anything above the
   default run size.

## 1. Intake (only what is missing)

Ask in one short batch, offer examples, accept "skip". Never interrogate.

| Need | Ask | Used for |
|---|---|---|
| Offer | "In one line, what do you sell and to whom?" | filter choice, relevance |
| Buyer types | "Are there 2–3 different kinds of buyer? e.g. 'already buys this from someone else' vs 'doesn't have it yet'" | separate searches + tags |
| Firmographics | industry, headcount band, geography, company type, growth/hiring signals | account filters |
| Decision-makers | titles/functions/seniority that buy, by company size | lead filters |
| Exclusions | customers, competitors, industries, regions, title words (intern, assistant, student) | filters + post-filter |
| Existing material | saved searches, account lists, a CSV of target companies | entry mode |
| Size goal | how many accounts / leads this run | pacing, sharding |
| Where results go | CSV download, Google Sheet, CRM via MCP, just this chat | output |

Write the answers back as the Company Profile so the next run does not ask again.

## 2. Choose the entry mode

Recommend one, say why in one sentence, let the user override.

| Mode | Use when | Flow |
|---|---|---|
| **A. Lead-first** | Title is the strongest signal (e.g. "VP Ops at 50–200 person wellness brands"); many small companies; speed matters | Lead search with person + company filters → people list → roll up to accounts |
| **B. Account-first** | Fit depends on the company (product, niche, growth, tech) more than the title; enterprise or niche markets; user wants to qualify companies before people | Account search → qualify accounts (hand to research) → per-account lead search for decision-makers |
| **C. Bring-your-accounts** | User already has target companies (CSV, CRM, event list, saved account list) | Match each company to its Sales Nav account → per-account decision-maker search |
| **D. Signal sweep** | Timing matters: job changes, new hires, hiring growth, recently posted, funding news | Lead or account search with the signal filters → short fresh list, re-run weekly |

Modes chain. Typical: B (accounts) → research/qualify step → B2 (decision-makers in survivors).
The user can stop after any phase and resume later from the CSV.

## 3. Build the search

1. Translate the profile into filters using [`references/filters.md`](references/filters.md).
   Show the filter set to the user in plain words before running it.
2. Run it once and read the **result count**.
   - Above the cap (~2,500 viewable results) → shard (by geography, headcount band, industry,
     seniority, or title group) until every shard is under the cap. Show the shard plan.
   - Tiny (< ~25) → suggest which filter to loosen.
   - Results look off on page 1 → fix filters before paging. Ten good rows beat 1,000 bad ones.
3. **Save** each final search in Sales Nav (named `<buyer-type> · <shard> · <yyyy-mm>`) so the
   user and future runs can reuse it and Sales Nav shows "new since last time".

## 4. Collect (read pages, not profiles)

- Read rows from **search result pages** (25 per page). That page already shows name, title,
  company, location, time in role, and badges — enough for most lists. Opening every profile is
  the fastest way to hit limits; don't.
- Open an individual profile or account page only when a needed field is missing and the user
  asked for depth (see the per-day limits in guardrails).
- Record each row per [`references/output.md`](references/output.md). Keep the Sales Nav URL and,
  when visible, the public LinkedIn URL — that is the dedupe key for the CRM step.
- Write rows out **as you go** (every page), not at the end, so an interruption loses nothing.
- Pace: human rhythm (a few seconds between pages, longer pauses every few pages). Stop at the
  run size the user approved.

## 5. Decision-makers inside accounts (Mode B2 / C)

For each qualified account:
1. Open its account page → "Decision makers" / lead search filtered to that company.
2. Apply the title map for that company's size (small: founder/CEO/owner; mid: function head;
   larger: VP/Director of the buying function + one level below).
3. Keep **1–3 people per account**, ranked: buying-function title match → seniority → time in
   role (6+ months beats 2 weeks unless the run is a job-change sweep) → recent activity.
4. If nobody matches, record the account as `no_dm_found` with the closest title — don't force a
   bad match.

## 6. Clean and hand off

- De-duplicate within the run (same person from two shards; same company spelled twice).
- Apply exclusions again on the collected rows (filters miss things).
- Tag each row: buyer type, shard, mode, signal(s), fit notes.
- Give the user: counts per shard, a sample of 5 rows, what was excluded and why, and the file /
  sheet / CRM location.
- Suggest the next step: **account research/qualification**, then **CRM dedupe** (always before
  any outreach), then **outreach**. This skill does not send anything.

## 7. Resume and repeat

- Each run's CSV plus the saved searches are the state. To resume, read the last CSV, skip rows
  already present, continue from the next shard/page.
- Weekly cadence: re-open saved searches, take only "new" results, append.

## What this skill never does

- Send connection requests, InMails, messages, follow, endorse, or like anything.
- Export via unofficial bulk tools, run multiple browsers on one seat, or work around a LinkedIn
  warning, captcha, or limit.
- Enter credentials or 2FA codes.
- Collect personal emails/phones from profiles or add data the user didn't ask for.
