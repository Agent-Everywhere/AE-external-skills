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

## Run summary (to the user)

- Searches/shards run, total results per shard, rows collected, rows excluded (by reason).
- Saved search names.
- File/sheet/CRM location.
- Anything stopped early and why.
- Suggested next step.
