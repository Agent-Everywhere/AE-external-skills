# 02 Filters and ids

## Query encoding

```
(filters:List((type:<TYPE>,values:List((id:<id>,selectionType:INCLUDED),(text:<text>,selectionType:INCLUDED)))),keywords:<text>)
```

- `filters:List(...)` first, `keywords:` last as a top-level key. Keywords are URL-encoded, uppercase `OR` / `AND` /
  `NOT`, quotes as `%22`.
- `id:` for typeahead-resolved values, `text:` (URL-encoded) for free text such as titles. Encode `%`, spaces, quotes,
  parentheses and commas inside values.
- Build from resolved ids. A query copied from a page URL carries `recentSearchParam` and double encoding and returns 400
  (the search snippets clean it, but do not rely on that).
- Types seen: `REGION`, `INDUSTRY`, `COMPANY_HEADCOUNT`, `CURRENT_COMPANY`, `ACCOUNT_LIST`, `CURRENT_TITLE`,
  `SENIORITY_LEVEL`, `FUNCTION`.

## Geography and headcount

| Filter | Values |
|---|---|
| `REGION` | United States `103644278`; resolve a state with typeahead `BING_GEO` and take the entry whose display value is the state itself. Lead region is the person's location, account region the headquarters |
| `COMPANY_HEADCOUNT` | letters: A self-employed, B 1-10, C 11-50, D 51-200, E 201-500 (verified); F 501-1,000, G 1,001-5,000, H 5,001-10,000, I 10,001+ (confirm with a count) |

Acme ICP 2-200 employees = B + C + D. B includes one-person companies. Bands do not sum to the total (A and F and up
are outside); include them when you shard.

## INDUSTRY ids resolved for Acme

| Id | Industry |
|---|---|
| 1359 | Retail Health and Personal Care Products |
| 3207 | Health, Wellness and Fitness |
| 124 | Wellness and Fitness Services |
| 23 | Food and Beverage Manufacturing |
| 142 | Beverage Manufacturing |
| 18 | Personal Care Product Manufacturing |
| 3189 | Cosmetics |
| 125 | Alternative Medicine |
| 15 | Pharmaceutical Manufacturing |
| 25 | Manufacturing |
| 133 | Wholesale |
| 2353 | Health and Human Services |

Niche terms ("liquid supplement") resolve to nothing in typeahead: use the parent industry plus keywords. Confirm any id with a
`count=1` before you build on it.

## Lead filters

| Filter | Notes |
|---|---|
| `SENIORITY_LEVEL` | 320 Owner/Partner, 310 CXO, 300 VP, 220 Director. Alone it returns every director: pair it with a title or function |
| `CURRENT_TITLE` | free text, URL-encoded |
| `FUNCTION` | resolved id |
| `CURRENT_COMPANY` | `id:urn%3Ali%3Aorganization%3A<companyId>`; URL length limits it to about 400 ids per query (see 14) |
| `ACCOUNT_LIST` | `id:<listId>`; no id-count limit (see 14) |
