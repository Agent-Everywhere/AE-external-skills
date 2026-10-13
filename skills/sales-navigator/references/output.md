# Output — standard columns

Every mode writes the same shape so later steps (research, CRM dedupe, outreach) can start
from any file. Leave unknown fields blank; never guess.

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

## Qualify columns (appended to accounts.csv)

Added by the `qualify-accounts` action (`references/qualify.md`) after the 14 columns above;
optional, and `scripts/validate_csv.py` accepts them.

| Column | Example | Notes |
|---|---|---|
| facts | sells capsules and gummies; ships to retailers | 1–2 facts read from the website, `;`-separated |
| fit_reason | contract-manufactures for brands = buyer type A | one line against the Company Profile |
| keep | keep | keep / drop / unsure. `keep` sets `status` to `qualified`, `drop` to `rejected`; `unsure` stays `collected` |

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
