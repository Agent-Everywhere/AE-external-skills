# Output — standard columns

Every mode writes the same shape so later steps (research, CRM dedupe, outreach) can start
from any file. Leave unknown fields blank; never guess.

## The workspace folder

Every file below, and the state that guards the seat, lives in one workspace folder (`SKILL.md`
preflight; default `~/Claude/sales-navigator`) so a later task finds it:

| Path in the workspace | What |
|---|---|
| `company-profile.md` | the Company Profile, including its `workspace:` line |
| `quota.md` | today's and the last 7 days' usage vs the caps (rewritten by `run_log.py quota`; do not edit) |
| `run_log.csv` | pulls log: `date,time,pages,profiles,accounts,saved_searches,small_calls,note` |
| `outreach_log.csv` | the outreach ledger (`references/outreach.md`); append-only, never recreated |
| `lists/` | account / lead CSVs (`accounts.csv`, `leads.csv`) and `lists_log.csv` |
| `drafts/` | `drafts/<yyyy-mm-dd>.csv` outreach drafts |
| `results/` | raw tool JSON per shard and call |

The CSVs are the source of truth. The user may mirror `quota.md` or `lists/` to a Google Sheet through
their Drive connector; never read state back from the sheet.

## accounts.csv

| Column | Example | Notes |
|---|---|---|
| company_name | Acme Wellness | as shown |
| company_domain | acmewellness.com | from account page/website when visible |
| salesnav_account_url | https://www.linkedin.com/sales/company/… | |
| linkedin_company_url | https://www.linkedin.com/company/… | when visible |
| industry | Wellness and Fitness Services | |
| headcount_band | 11-50 | LinkedIn estimate |
| hq_location | Austin, TX, US | |
| signals | headcount +18% 12mo; hiring ops | semicolon list |
| buyer_type | add-new-line | from the user's buyer types |
| shard | US-TX · 11-50 | |
| mode | B | A/B/C/D |
| fit_notes | sells capsules + gummies, no liquids | short |
| status | collected | collected / qualified / rejected / no_dm_found |
| collected_at | 2026-10-13 | |

## leads.csv

| Column | Example | Notes |
|---|---|---|
| full_name | Jane Doe | |
| title | Head of Product Development | |
| seniority | Director | |
| company_name | Acme Wellness | |
| company_domain | acmewellness.com | join key to accounts |
| salesnav_lead_url | https://www.linkedin.com/sales/lead/… | |
| linkedin_url | https://www.linkedin.com/in/… | **CRM dedupe key** — capture when visible |
| location | Austin, TX, US | person's location |
| time_in_role | 8 months | |
| signals | changed jobs <90d; posted 30d; open profile | |
| dm_rank | 1 | within the account |
| buyer_type | add-new-line | |
| shard | US-TX · Director+ | |
| mode | A | |
| status | collected | collected / qualified / rejected |
| collected_at | 2026-10-13 | |

## Search-row columns (optional, appended to leads.csv)

Written by `scripts/salesnav_rows.py` after the 16 columns above; optional, and
`scripts/validate_csv.py` accepts them. They come straight from the search row, so outreach can
read them without opening the profile (`references/outreach.md`).

| Column | Example | Notes |
|---|---|---|
| pending_invitation | yes | `yes` when an invitation to this person is already pending, `no` when the search row carries `pendingInvitation` and it is false, blank when the field was absent (blank is not "no"). Confirm on a live seat that the field is present; outreach may skip the profile open only on `no` with a 2nd/3rd degree collected today (`references/outreach.md` rule 8) |
| degree | 2nd | connection degree: 1st / 2nd / 3rd, blank when the row has none |
| open_link | yes | `yes` when the person accepts open messages (the API's `openLink`); `signals` also says "open profile" |
| dup_suspect | yes | `yes` on every row of a same-name group inside one account (same company, same name, different profile): often one person with two profiles. Check before contacting. `salesnav_rows.py --append` recomputes it over the whole file, and `salesnav_rows.py --flag-dups FILE` does so for any leads CSV (company matched on domain, else name) |

`buyer_type` is per row. `--buyer-type` sets the default; `--buyer-type-map PATH` overrides it per
company, from a JSON object `{company id: type}` or from a CSV with `buyer_type` and `company_id`
or `salesnav_account_url`, so a qualified `accounts.csv` can type the leads of its accounts.

**Lead URLs contain commas** (`.../sales/lead/ACw...,NAME_SEARCH,...`), so the CSV writer quotes
that cell. Open and edit the file with a CSV reader or spreadsheet, never split a line on commas.
`scripts/outreach_log.py` takes lead URLs or ids from a file with `--ids-file` (one per line)
instead of on the command line, which avoids the quoting problem entirely.

## Qualify columns (appended to accounts.csv)

Added by the `qualify-accounts` action (`references/qualify.md`) after the 14 columns above;
optional, and `scripts/validate_csv.py` accepts them.

| Column | Example | Notes |
|---|---|---|
| facts | sells capsules and gummies; ships to retailers | 1–2 facts read from the website, `;`-separated |
| fit_reason | contract-manufactures for brands = buyer type A | one line against the Company Profile |
| keep | keep | keep / drop / unsure. `keep` sets `status` to `qualified`, `drop` to `rejected`; `unsure` stays `collected` |

## drafts/<yyyy-mm-dd>.csv

Written by the `outreach` action, Part A (`references/outreach.md`), from `templates/drafts.csv`.
`scripts/validate_csv.py` checks it (`--kind drafts`, or detected from the `lead_id` column).

| Column | Example | Notes |
|---|---|---|
| lead_id | https://www.linkedin.com/sales/lead/ACw…,NAME_SEARCH,… | Sales Nav lead id or URL; quote the cell |
| full_name | Jane Doe | |
| company_name | Acme Wellness | |
| kind | connection | connection / inmail. `inmail` for people a connection request cannot reach (out of network) |
| text | Hi Jane, … | for an InMail the subject is the first line |
| char_count | 212 | counted length of `text`; at most 300 for `connection` |
| sources | facts: sells gummies; title; profile s1 | where each claim in `text` came from (the row's `facts`, a search-data column, or a Company Profile section). Required: a draft with no sources is not shown |

## Filling the columns from the fast path

`scripts/salesnav_rows.py` writes these files from API results. It fills what the search returns
and leaves the rest blank on purpose: `linkedin_url` (the search has no public profile URL),
`hq_location` and `seniority` (unless you pass the level you filtered on), and `company_domain`
until website records are included. Accounts get `salesnav_account_url` from the company id, and
`headcount_band` is the range without the word "employees".

## Run summary (to the user)

- Searches/shards run, total results per shard, rows collected, rows excluded (by reason).
- Saved search names.
- File/sheet/CRM location.
- Anything stopped early and why.
- Suggested next step.
