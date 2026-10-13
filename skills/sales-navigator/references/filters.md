# Filters — from ICP answers to Sales Nav searches

Filter names follow the Sales Nav UI and occasionally get renamed or moved. If a filter isn't
where this says, look for the closest equivalent and tell the user what you used.

## Account (company) search

| ICP answer | Filter | Tips |
|---|---|---|
| Industry / niche | Industry | Pair with keywords; LinkedIn industries are broad (e.g. supplements sit under several) |
| Niche words | Keywords (the top search box, not a left-rail filter) | Use OR lists: `supplement OR vitamin OR nutraceutical`; quote phrases. Matching is strongly company-name weighted |
| Size | Company headcount | Bands; this is LinkedIn's estimate — treat as approximate |
| Growth | Company headcount growth | e.g. >10% in 12 months = scaling |
| Hiring | Job opportunities / department headcount growth | Signals budget in that function |
| Location | Headquarters location | Region, country, metro |
| Type | Company type | Exclude non-profits, government, education unless in ICP |
| Revenue | Annual revenue | Sparse; use only to exclude extremes |
| Your lists | Account lists | Include/exclude saved lists (e.g. exclude "Customers") |

Account search is capped at **1,000** viewable results (40 pages).

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
| Exclusions | Past/current company, Lead lists | Apply after collecting, not in the search (see below) |

Lead search is capped at **2,500** viewable results (100 pages).

## Query encoding (fast path)

The API takes the same query language the Sales Navigator URL uses (Rest.li):

```
(filters:List((type:<TYPE>,values:List((id:<id>,selectionType:INCLUDED),(text:<text>,selectionType:INCLUDED))),(type:<TYPE2>,values:List(...))),keywords:<text>)
```

- **`filters:List(...)` comes first; `keywords:` is a top-level key after it**, not a filter
  entry. Boolean `OR` and quoted phrases work inside keywords. Keywords must be URL-encoded
  (`supplement%20OR%20vitamin`, quotes as `%22`).
- Each filter is `(type:T,values:List((id:..|text:..,selectionType:INCLUDED|EXCLUDED), ...))`.
  Use `id:` for typeahead-resolved values and `text:` (URL-encoded) for free-text values such as
  titles: `(type:CURRENT_TITLE,values:List((text:VP%20Operations,selectionType:INCLUDED)))`.
- Encode `%`, spaces, quotes, parentheses and commas inside values. Raw parentheses in a value
  break the query.
- Filter types seen on live accounts: `CURRENT_TITLE`, `REGION` (geography and HQ), `INDUSTRY`,
  `COMPANY_HEADCOUNT`, `CURRENT_COMPANY`, `SENIORITY_LEVEL`.
- Totals: `count=1` returns the exact `paging.total`; use it for every sizing call.
- **Query copied from a page URL**: strip `recentSearchParam:(...)`, percent-decode it **once**,
  and then send it, or the API answers 400. (The `lead_search.js` / `account_search.js` snippets
  do this for you.) You build searches yourself; only start from a user's URL if they ask.

### Seniority

`SENIORITY_LEVEL` ids: `320` Owner/Partner, `310` CXO, `300` VP, `220` Director. For other
levels, build the filter once in the UI and read its id, or resolve it with typeahead.

### Headcount (`COMPANY_HEADCOUNT`)

Enum ids are letters, used as `(id:C,selectionType:INCLUDED)`:

| Id | Band |
|---|---|
| A | self-employed |
| B | 1–10 |
| C | 11–50 |
| D | 51–200 |
| E | 201–500 |
| F | 501–1,000 |
| G | 1,001–5,000 |
| H | 5,001–10,000 |
| I | 10,001+ |

B–E are verified; F–I follow the same sequence but check them with a count before relying on
them. Bands do **not** sum to the total: self-employed (A) and 501+ (F–I) sit outside B–E, so if
you shard by band include A and F+ shards or you lose those companies.

### Geography and other ids: typeahead, not guessing

Resolve every id with the typeahead endpoint (`page/typeahead.js`):

- **Geography:** `type=BING_GEO` (the filter type you then use is `REGION`). United States is
  `103644278`; states, metros and countries each have their own geo id, so resolve each name.
- **Industry:** `type=INDUSTRY`. Ids come from LinkedIn's taxonomy and are not always what you
  would call the niche: a term like "nutrition" can resolve to nothing, while neighbouring
  industries (health and wellness, personal care, food and beverage manufacturing, pharma,
  cosmetics, retail health) do. Try the parent terms, then add niche words as keywords.
- A wrong `type` or shape returns **200 with an empty list**, not an error. Treat empty as "not
  found"; try another spelling or read the id off the UI's own request.
- Do not copy ids between seats or accounts without checking; confirm with a count.

## Sharding under the cap

Split along one dimension at a time until each shard is under the cap (2,500 leads, 1,000
accounts). Count each candidate shard first with `count=1`.

1. **HQ state** (or country / region for non-US). For a keyword master, most states fit under
   1,000 accounts; a few large ones will not.
2. **Headcount band**, only inside the states still over the cap (include self-employed `A` and
   `F`+ bands so nothing falls through).
3. **Metro** (county / metro geo ids), inside any band still over the cap. For a band that is
   still huge (typically 1–10), a split of the keyword set into overlapping groups also works;
   dedupe afterwards.
4. **Seniority** or **title group** (lead searches).
5. **Industry** (when several are in scope).

Shards overlap slightly (multi-location companies, double geography); **dedupe by company id**
(accounts) and Sales Nav lead URL (leads) after collecting, and expect the sum of shard totals to
exceed the master by a few percent. Name shards consistently and record each shard's total — the
sum is the user's **addressable market on LinkedIn** for that ICP (TAM sizing); report it as an
estimate. `scripts/shard_plan.py` plans shards from counts.

## Funnel strategy

- **Maximize coverage at the top; qualify per row later.** Expect only about a third to a half of
  a keyword master's first page to be plausible buyers; that is fine for a coverage-first funnel
  if research qualifies afterwards.
- **Test single keywords.** Count each keyword alone before building the OR list; a generic term
  can dominate the master and mostly match company names. Drop it from the master and run it as a
  separate, smaller shard if you still want it.
- **Run title variants** in contact-first searches: synonyms, abbreviations, other languages if
  multi-country.
- **Union modes.** Run the same ICP account-first and contact-first and union the companies —
  each surfaces companies the other misses. Include companies with sparse data via keyword
  searches, not only industry codes.
- **No exclusions at search time.** Do not exclude competitors or customers in the query; it
  hides the real market size and the near-misses. Exclude after collecting (`scripts/dedupe.py
  --exclude`) and show the user what was removed.
- Keep a **near-miss bucket** (one filter off) for the user to decide on, rather than silently dropping them.

## Quality checks before paging

Take a 50-row sample (two pages). If more than about a third are clearly off-ICP, change filters
first. Typical fixes: add NOT words to titles, narrow industry with keywords, drop a noisy
keyword, exclude company types, tighten headcount.
