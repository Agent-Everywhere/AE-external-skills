# Action: build-list

Turn the Company Profile into a clean list of accounts and/or decision-makers. This is the
original, read-only action; every other action starts from its CSVs. Preflight (runtime, session,
profile, budget) is in `SKILL.md` and has already been done.

**One step per request.** build-list covers four separate requests; do only the one asked, then
stop with a short result and "Next, you can: ...":

| The user asks | You do | You do not |
|---|---|---|
| **Set up** | Section 1: write the profile + workspace | any search page or count call |
| **Size my market** / "how big is it" | Sections 2-3 counting only: `count=1` calls, shard counts, the `## Sub-list plan` | pull any rows, qualify, find decision-makers |
| **Pull** N accounts / leads | Sections 4-6 for only that list and size (samples are 2 pages) | the rest of the market, qualify, decision-makers, save to a list |
| **Find decision-makers** | Section 5 for only the accounts named | pull more accounts |

Chaining (pull, then qualify, then decision-makers) happens only through `run-my-day`
(`run-my-day.md`) or when the user explicitly asks to continue. The next step is a suggestion.

## 1. Intake = the Setup action (one turn, no search pages)

"Set up my prospecting" does **one thing: write `company-profile.md` and create the workspace.**
It makes **zero LinkedIn search pages and zero count calls** (at most a sign-in check), and it
does **not** size the market, qualify, or find decision-makers. When it is done, stop and say
"Next, you can: size my market (counts only) / pull a first 25 accounts / run my day".
Target: setup done in 1-2 turns, not a 15-minute interview.

**Read before asking.** If a `company-profile.md` already exists (an attached file, a project
file, or in the user's folder), read it and ask only for the fields still blank. A filled generic
example to copy is `templates/company-profile.example.md`.

If there is none, do **not** ask the questions one by one. **Propose a filled profile in ONE
message:**

1. Take the user's one-line description of what they sell and to whom. If they gave a website
   (or you can name it), take a quick read of the homepage (one page fetch is enough; it is not a
   LinkedIn call) for the offer, who it serves, and any facts we may state.
2. Fill every row of the table below from that, with a sensible default and a short rationale
   where you guessed (buyer types, headcount band, titles, keywords, size goal 25, tone, default
   caps from `guardrails.md`).
3. Show it as a **short numbered list** (one line per row, 1-9) and ask exactly one question:
   **"Confirm, or correct by number."** Accept "looks good", "yes", "use defaults" or "skip" as
   a confirmation; apply any corrections and do not ask a second round.
4. Save the profile and workspace (`scripts/workspace.py init`), show the path, and stop with the
   "Next, you can: ..." line.

Never run multi-round questioning or a question screen. The table and the template are the same
set; if one changes, change the other.

| Ask | Profile section | Used for |
|---|---|---|
| **Offer**: "In one line, what do you sell and to whom?" and any facts we may state about you (location, certifications) | 1 | filter choice, relevance |
| **Buyer types**: 2–3 kinds ("already buys this from someone else" vs "doesn't have it yet"), and which kinds are **not a buyer** | 3 | separate searches, tags, qualify drops |
| **Firmographics**: industry, headcount band, geography (HQ or person), company type, growth signals | 2 | account filters |
| **Decision-maker titles by company size** (and title words to avoid: intern, assistant, student) | 4 | lead filters, title map |
| **Keywords**: company keywords, title keywords, and **noise words** (a keyword that also matches an unrelated industry) | 5 | searches, NOT terms |
| **Exclusions**: customers, competitors, regions, do-not-contact file | 6 | post-filter (see "No exclusions at search time") |
| **Size goal**: how many accounts / leads this run | 7 | pacing, sharding |
| **Tone** for later drafts: three words, sign-off | 8 | outreach |
| **Caps**: only what the user wants lower than the defaults | 9 | guardrails |

Where files go (profile section 10) is not asked: default to the user's working folder as CSVs, and
say so. The confirmed answers live in the Company Profile so no later action asks again. Existing material (saved searches, account lists,
a CSV of target companies) is not an intake question either: if the user brings some, it picks the
entry mode (section 2).

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

Modes chain across requests through the CSVs. Typical: B (accounts) → research/qualify → B2
(decision-makers in survivors), each its own request. Stop after any phase and resume later from the CSV.

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
   - **States:** `references/geo-us-states.md` has the geography ids and the 1-call typeahead for
     any state without one. Count states in **priority order** and **stop when coverage is good**
     (about 90 percent of the nationwide count, or the size goal met); do not count all 51 by
     default, it spends the small-call budget (`guardrails.md`).
   - **After counting, record the plan:** append a `## Sub-list plan` table to the Company Profile
     (order, buyer type tag, sub-list name, search notes, count, status of todo / partial /
     collected / qualified / listed / done). It is an output of counting, not an intake question;
     the daily routine (`run-my-day.md`) and the list names (`lists.md`) read it.
3. **50-row sample** (part of a **pull** request only; a market-sizing request stops after step 2's counts). Before scaling, pull two pages (50 rows) of the master and of any shard
   that will be big, and read them with the user: roughly what share are plausible buyers? Fix
   keywords and filters now. Ten good rows beat 1,000 bad ones.
   - **Sample vs collection.** A sample is a deliberate partial pull; a collection is every
     viewable row of a shard and is the only thing you hand over as complete. On the cloud runtime
     mark the sample call `"sample": true` with `"pages": {"max_pages": 2}`: it ends with a
     `sampled` event and exit 0. Without the flag a call that stops early with rows left unread
     is `truncated` and the run exits 8 (not complete). Never set `sample` on a collection call to
     silence exit 8; a collection that exits 8 means rows are missing. In the local runtime
     there is no exit code: you decide, and you say "sample" or "collected" when you report counts.
4. **Collect shard by shard**, writing every page to the JSONL as it arrives, deduping across
   shards by company id (and lead URL) afterwards.
5. **No exclusions at search time, with one carve-out.** Do not subtract competitors or
   customers in the query: it hides how big the market really is and hides near-misses. Collect,
   then exclude at the clean-up step (`scripts/dedupe.py --exclude`) and show the user what was
   removed. **Carve-out: noise words.** When a keyword also matches an unrelated industry (for
   example a word that pulls in insurance firms), add a NOT term for that obvious off-meaning
   noise, but only after checking counts: count the search with and without the NOT term and
   confirm the drop is the noise (read a handful of the rows it removes). Tell the user the
   term and the counts. Never use this to remove competitors, customers, or types that could be
   buyers; and "not a buyer" types (for example, if the seller is a manufacturer, other
   manufacturers) stay in the list and are dropped at qualify time (`qualify.md`).

Optionally save each final search in Sales Nav (named `<buyer-type> · <shard> · <yyyy-mm>`) so the
user can reuse it and Sales Nav shows "new since last time" (only with the user's okay; saving is
a write to their account).

## 4. Collect

### 4a. Fast path (local or agent-browser runtime) — default

**Browser JS tool (local, the default for Desktop users):** one `page/*.js` snippet per tool call,
each result saved to the user's folder before the next call, then `scripts/salesnav_rows.py`
rebuilds the CSV (`runtime/local.md`).

**Code execution (cloud browser, or Playwright on the user's Chrome):** write a plan
(`references/fast-path.md`), run it with `runtime/session.py` in ONE process for the session, then
convert with `scripts/salesnav_rows.py`.

- Reads come from the search API inside the page: 25 rows per call in about 2 s, with exact
  totals. Account results carry no website; fetch websites in batches of 25 with
  `companies_websites.js`.
- One record per call is saved as it arrives (a JSONL line, or one `results/*.json` file), so a
  stop, a sign-out, or the 40-minute cloud ceiling loses nothing. Resume with `--skip-done`, or
  continue from the next page after the last saved file.
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
   role (`references/fast-path.md` has the query). Filter on the **seniority levels and the
   buying function or title together**: `SENIORITY_LEVEL` alone returns every director in the
   company, buyers or not. Add `CURRENT_TITLE` (title words from the profile; typeahead ids, or
   free text) and/or `FUNCTION` next to `SENIORITY_LEVEL`. When the account is in one country,
   also restrict the person's location (`REGION`, the account's HQ country) so offshore staff of
   the same title do not outrank the local buyer. Apply the title map for the company's size
   (small: founder/CEO/owner; mid: function head; larger: VP/Director of the buying function +
   one level below). Keep **1–3 people per account**, ranked: buying-function title match →
   seniority → time in role (6+ months beats 2 weeks unless the run is a job-change sweep). Run
   `keep` accounts first, then `unsure` ones only if the run's cap (profile section 7) still has
   room and the user agrees; never `drop` accounts.
4. If nobody matches, record the account as `no_dm_found` with the closest title — don't force a
   bad match.
5. **Hand to CRM dedupe** (always before any outreach): `leads.csv` + `accounts.csv`, joined on
   `company_domain`, with `linkedin_url` blank where the search did not expose it.

## 6. Clean and hand off

- De-duplicate within the run (same person from two shards; same company spelled twice;
  `scripts/dedupe.py`). **State and metro lists overlap** (a company with sites in several states
  is in each list), so when you combine shard files, dedupe by company id (the id in
  `salesnav_account_url`) and tell the user: "the lists add up to X rows; Y are unique" (the
  script prints rows in and rows out). Do not quote the sum as the market size.
- Apply exclusions on the collected rows (customers, competitors, title words) and show what was removed.
- Tag each row: buyer type, shard, mode, signal(s), fit notes. Type each row per company when the
  buyer types differ by account (`salesnav_rows.py --buyer-type-map`, `references/output.md`), and
  look at the `dup_suspect` rows (same name twice in one account) before they go anywhere.
  `--append` recomputes `dup_suspect` over the combined file; after merging CSVs another way, run
  `salesnav_rows.py --flag-dups leads.csv`.
- Validate: `scripts/validate_csv.py`.
- Give the user: counts per shard, a sample of 5 rows, what was excluded and why, and the file /
  sheet / CRM location.
- **Stop here.** End with "Next, you can: qualify these accounts (`references/qualify.md`) / save
  them to a list (`references/lists.md`) / find decision-makers", and do not start any of them.
  Building a list sends nothing; outreach happens only if the user asks for it (see `SKILL.md`).

## 7. Resume and repeat

- Each run's JSONL and CSVs plus the saved searches are the state. To resume, re-run the plan
  with `--skip-done`, or read the last CSV, skip rows already present, continue from the next
  shard/page.
- Weekly cadence: re-run the saved searches or plans and take only new rows.

### Running this on a schedule

A recurring daily routine is `references/run-my-day.md`. A recurring sweep alone (weekly job
changes, new hires, "new since last time" lists) can also run unattended: the plan, queries and
CSV columns from this run carry over unchanged to a schedule on the cloud runtime (laptop off) or,
on the local runtime, to a Cowork scheduled task that needs the Mac and the app open. Set up
scheduling only when the user asks.
