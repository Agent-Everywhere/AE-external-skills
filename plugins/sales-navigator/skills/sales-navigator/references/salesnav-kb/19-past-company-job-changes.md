# 19 Past company and job changes

People who USED TO work at a list of companies, hold a title you name and recently changed jobs: warm leads at their new
employer (for a list of customers, people who already know the product). Read-only. Measured 2026-11-20 on a real seat with
direct `salesApiLeadSearch` `count=1` calls on two large, well-known companies.

## Query shape

```
(filters:List((type:PAST_COMPANY,values:List((id:urn%3Ali%3Aorganization%3A<id>,selectionType:INCLUDED),...)),(type:CURRENT_TITLE,values:List((text:<title>,selectionType:INCLUDED))),(type:RECENTLY_CHANGED_JOBS,values:List((id:RPC,selectionType:INCLUDED)))))
```

`python3 "$ENGINE/scripts/company_chunks.py" --csv accounts.csv --filter-type PAST_COMPANY --titles "a,b" --recent-job-change`
builds it, one query per chunk of at most 400 ids, with `lead_search.js` (`count` 100) behind it.

| Piece | Status |
|---|---|
| `PAST_COMPANY`, value shape the same as `CURRENT_COMPANY` (`id:urn%3Ali%3Aorganization%3A<id>`) | VERIFIED: HTTP 200. One large company alone: 291,486 leads, against 187,147 for `CURRENT_COMPANY` on the same id, so the filter is distinct from current company |
| `PAST_COMPANY` plus `RECENTLY_CHANGED_JOBS` (id `RPC`) | VERIFIED: 18,872 for that company. Two companies OR'd in one `values:List`: 46,268 |
| plus `CURRENT_TITLE` text `operations%20manager` | VERIFIED: 186 |
| 400 ids in one `PAST_COMPANY` filter plus `RPC` | VERIFIED: HTTP 200 with an exact paging total, request URL 23,886 characters (200 ids: 200 OK, 12,086 characters). Chunk size 400 holds |
| An unknown filter type | SILENTLY IGNORED, HTTP 200: a bogus type returned 9,470,434 against 9,470,808 for `RECENTLY_CHANGED_JOBS` alone |
| URN encoding | the colons are percent-encoded exactly once (`urn%3Ali%3A...`). Double-encoded returns 200 with total 0; raw colons return HTTP 400 |
| `RECENTLY_CHANGED_JOBS` id `RPC`, `CURRENT_TITLE` free text OR'd | VERIFIED earlier (page 17, section 3; page 02) |

**Guard.** Run `count.js` (`kind: lead`) first: `PAST_COMPANY` alone, then plus `RPC`, then plus a title word, each smaller than
the one before. Because a wrong filter type is ignored without an error, stop when a total is about equal to the
`RECENTLY_CHANGED_JOBS`-only total (or to the unfiltered one): the filter did nothing. A total of 0 on a query you expect to
match usually means a double-encoded URN.

## Which company is the past one

The lead search row (decoration `LeadSearchResult-14`) carries `pastPositions` next to `currentPositions`. A position has
`companyName`, `companyUrn`, `title`, `startedOn`, `current`, `tenureAtCompany` and `tenureAtPosition`. The past company is the
`pastPositions` entry whose `companyUrn` id is in your list. `lead_search.js` slim mode keeps `pastPositions` (its drop list does
not name it); use `raw: true` if a row comes back without it. How often `pastPositions` is present and holds the matching
`companyUrn` is UNMEASURED. Fallback only when it is missing or has no matching urn: `profiles_batch.js` with `extras: true`
(100 profiles per call, page 15) returns every position with `companyUrn`, `endedOn` and `current`; `companyUrn` is filled on
about 83% of those positions. Still no match: leave the past company blank and say so, never guess from the name. A person who
worked at two listed companies matches both: report both.

## Flags

- A row whose `currentPositions` `companyUrn` is itself in the list moved between listed companies.
- A person who left and came back can match `PAST_COMPANY` for the company they work at now.
- `RECENTLY_CHANGED_JOBS` is LinkedIn's own window (a recent move, not a date you set).

## Saved search for alerts (a seat write)

Policy 2026-11-20: creating a saved people search is allowed under the account-list rule (page 14). The user confirms the exact
name of each saved search once, before it is created; never modify, rename or delete an existing one (no delete snippet ships);
capped at 10 a day, ceiling 25 (`run_log.py add --saved-searches 1`, then `run_log.py quota`). LinkedIn then sends its own alerts
for new matches. Snippets: `saved_searches.js` (read) and `saved_search_create.js` (write; `query` is the Rest.li string from
`company_chunks.py`, converted to the JSON form by the snippet itself).

| Piece | Status |
|---|---|
| List: `GET /sales-api/salesApiSavedSearchesV2?q=savedPeopleSearches&count=50&start=0&decoration=%28createdAt%2Cid%2ClastViewedAt%2Cname%2CnewHitsCount%2Cseat%2Ckeywords%2Cfilters%29` returns `elements[]` with `id`, `name`, `seat`, `createdAt`, `lastViewedAt`, `newHitsCount`, `keywords`, `filters` | VERIFIED 2026-11-20. The decoration must be fully percent-encoded: raw parentheses and commas return HTTP 400 |
| Seat: `GET /sales-api/salesApiIdentity?q=findLicensesByCurrentMember&includeRecentlyInactiveDueToAdminReassignment=true`, elements carry `seatUrn` (`urn:li:seat:<digits>`), the same value as an existing saved search's `seat` | VERIFIED that the field exists. Which element to take when there are several licences is UNVERIFIED: the snippet prefers the seat an existing saved search carries, else the first licence, and returns `seatSource` and `licenses` so the skill can say which |
| Create: `POST /sales-api/salesApiSavedSearchesV2`, `content-type: application/json; charset=UTF-8`, body `{name, seat, useCase: "SAVED_LEAD_SEARCH", frequency: "DAILY", filters: [], keywords: "", searchQuery: {leadSearchQuery: {filters: [{type: "PAST_COMPANY", values: [{id: "urn:li:organization:<id>", selectionType: "INCLUDED"}]}, {type: "RECENTLY_CHANGED_JOBS", values: [{id: "RPC", selectionType: "INCLUDED"}]}]}}}` | VERIFIED: HTTP 201, empty body, the id in the `x-restli-id` header (`{seat=urn:li:seat:N, id=N}`). `leadSearchQuery` is plain JSON (raw `urn:li:organization:<id>`, no percent-encoding; text as plain text). `frequency` is the model default; other values are untested |
| Verify: re-list and find the name; the listing echoes each filter with a display title ("Past company") and display values | VERIFIED: that echo is the proof the filter was understood (the snippet returns it as `echo`) |
| Delete: `DELETE /sales-api/salesApiSavedSearchesV2/(seat:<urn percent-encoded>,id:<id>)` returns 204 | VERIFIED but NOT shipped as a snippet |
| 400 `PAST_COMPANY` ids in one saved search body | UNMEASURED live (the snippet is unit-tested with 400); use `--chunk 50` if LinkedIn refuses it |
| `CURRENT_TITLE` text values in the body, per-seat maximum number of saved searches | UNMEASURED (text is posted as plain text, the same form as ids) |

**Fallback.** The search page URL is `https://www.linkedin.com/sales/search/people?query=<query>`, the same query string as
above; the user opens it and clicks Save search. Whether the page accepts a URL of about 24,000 characters (a 400-id chunk) is
UNVERIFIED: if it fails to load, use chunks of 50 ids (`--chunk 50`).
