# Filters — from ICP answers to Sales Nav searches

Filter names follow the Sales Nav UI and occasionally get renamed or moved. If a filter isn't
where this says, look for the closest equivalent and tell the user what you used.

## Account (company) search

| ICP answer | Filter | Tips |
|---|---|---|
| Industry / niche | Industry | Pair with keywords; LinkedIn industries are broad (e.g. supplements sit under several) |
| Niche words | Keywords (company) | Use OR lists: `supplement OR nutrition OR wellness`; quote phrases |
| Size | Company headcount | Bands; this is LinkedIn's estimate — treat as approximate |
| Growth | Company headcount growth | e.g. >10% in 12 months = scaling |
| Hiring | Job opportunities / department headcount growth | Signals budget in that function |
| Location | Headquarters location | Region, country, metro |
| Type | Company type | Exclude non-profits, government, education unless in ICP |
| Revenue | Annual revenue | Sparse; use only to exclude extremes |
| Your lists | Account lists | Include/exclude saved lists (e.g. exclude "Customers") |

## Lead (people) search

| ICP answer | Filter | Tips |
|---|---|---|
| Buying role | Current job title | Boolean: `("head of product" OR "VP operations" OR founder) NOT (assistant OR intern)` |
| Function | Function | Broader than title; combine with seniority |
| Level | Seniority level | Owner/Partner, CXO, VP, Director, Manager |
| Company fit | Current company headcount, industry, HQ location; or Account lists | Same as account search |
| Freshness | Years in current position / company | "Less than 1 year" for job-change plays |
| Signals | Changed jobs in last 90 days, Posted on LinkedIn in last 30 days, Following your company, Shared experiences | Best for warm angles |
| Geography | Geography | Person's location, not the company's |
| Exclusions | Past/current company, Lead lists | Exclude customers, competitors, already-contacted lists |

## Sharding under the ~2,500 viewable cap

Split along one dimension at a time until each shard is under the cap:
1. **Geography** (state / metro / country).
2. **Headcount band** (1–10, 11–50, 51–200, 201–500, ...).
3. **Seniority** or **title group**.
4. **Industry** (when several are in scope).

Name shards consistently and record each shard's total count — the sum is the user's
**addressable market on LinkedIn** for that ICP (TAM sizing). Report it as an estimate.

## Maximizing coverage (TAM)

- Run title variants: synonyms, abbreviations, other languages if multi-country.
- Run the same ICP in both account-first and lead-first; union the companies — each mode
  surfaces companies the other misses.
- Include companies with sparse LinkedIn data via keyword searches, not only industry codes.
- Keep a "near-miss" bucket (one filter off) for the user to decide on, rather than silently
  dropping them.

## Quality checks before paging

On page 1, read 10 rows. If more than ~3 are clearly off-ICP, change filters first. Typical fixes:
add NOT words to titles, narrow industry with keywords, exclude company types, tighten headcount.
