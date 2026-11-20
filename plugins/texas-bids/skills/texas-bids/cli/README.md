# texas-bids

Read-only CLI that checks the Texas state bid board (ESBD, the Electronic State Business Daily at
https://www.txsmartbuy.gov/esbd) for open solicitations matching keywords, and reports only new ones on repeat runs.
Single-file bundle: `dist/texas-bids.mjs` (Node 20+, no install, no dependencies). Unofficial; not affiliated with the
State of Texas.

```sh
node dist/texas-bids.mjs search --keywords "fuel,generator,tank" --limit 10
node dist/texas-bids.mjs watch --keywords "janitorial,HVAC" --state ./state.json
node dist/texas-bids.mjs notify-teams --keywords "janitorial,HVAC" --state ./state.json   # needs TEXAS_BIDS_TEAMS_WEBHOOK or --webhook
```

Develop: edit `src/`, then `npm run build && npm test`. `dist/texas-bids.mjs` is committed; rebuild it with every
source change. Tests run offline against a mocked `fetch` and the saved real replies in `tests/fixtures/`.
See `../SKILL.md` for the user-facing flows.

## The data source (discovery notes, checked 2026-11-20)

The ESBD page is a NetSuite SuiteCommerce single-page app. A plain GET of `/esbd?keyword=fuel` returns an HTML page
whose results ignore the keyword (it always shows the newest postings, 24 per page), so it is not usable for search.
The page's own search calls a JSON service (found in `/app/extensions/shopping_2.js`: model `ESBD.Model`,
`urlRoot` = the extension's `services/ESBD.Service.ss`; independent scrapers on GitHub use the same endpoint):

```
POST https://www.txsmartbuy.gov/app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Service.ss
Content-Type: application/json
{"keyword":"fuel","status":"1","page":1}
```

No login, cookie or token is needed. A GET of the same URL answers `405 ERR_METHOD_NOT_ALLOWED` (HTTP 200 with a JSON
error body). Reply:

```
{ "agencies":[{agencyname, agencyId}...],     // the agency picklist (413 entries); ignored by the CLI
  "lines":[ { internalid, title, solicitationId, responseDue, responseTime,
              agencyNumber, agencyName, status, statusName, postingDate, cancelledDate,
              created, lastModified, nigpCodes, repostURL, url } ... ],
  "page":1, "recordsPerPage":24, "totalRecordsFound":341 }
```

Dates are `M/D/YYYY` (Texas time); `nigpCodes` is a `;`-separated list of class/item codes; `url` is the agency's
external attachment URL when it has one. The solicitation's public page is `https://www.txsmartbuy.gov/esbd/<solicitationId>`.

Request fields that work (verified live):

| Field | Meaning |
|---|---|
| `keyword` | text search over the posting (title/description); `""` = no filter. A multi-word value is matched as typed (`"fuel generator"` returned 0 where `fuel` returned 1) |
| `status` | `"1"` Posted (the service returns both Posted and Addendum Posted), `"2"` Awarded, `"3"` Posting Cancelled, `"5"` Closed, `"11"` No Award. `"6"` returns only Addendum Posted |
| `page` | 1-based, 24 per page, fixed. A page past the end returns an empty `lines` |
| `startDate`, `endDate` | `MM/DD/YYYY`, a window on the **posting** date (inclusive) |
| `agencyNumber` | exact agency/member number (`"405"` worked); the CLI filters agencies client side instead |

Limits and behaviour worth knowing:

- Always send a `status`. Open-only searches answer in about 2 seconds; a keyword search with **no** status filter
  scans everything and often takes 60+ seconds and then returns an empty body (the CLI treats an empty body as
  "retry", then reports it).
- A keyword search is one request per page; a keyword matching a few hundred open bids is a few pages. The CLI caps a
  keyword at 40 pages (960 rows) and says so.
- The `nigp` (class/item code) filter did not return results for a bare code in a quick test, so the CLI does not
  use it; the codes are returned per row for reading.
- The per-solicitation detail comes from `ESBD.Details.Service.ss` (what the `/esbd/<id>` page calls, with contact name,
  email, addenda text and attachments); a plain GET with `internalid` or `solicitationId` is rejected
  (`SSS_INVALID_SRCH_OPERATOR`), and the server-rendered `/esbd/<id>` HTML page works but the CLI does not fetch it.
  The list reply already carries everything the alert needs.
- Rate: the CLI sends at most about one request per 750 ms, with a 45 s timeout and 2 retries (backoff 2 s, 4 s) on
  429, 5xx, timeouts and empty bodies. User-Agent: `texas-bids-cli/<version> (read-only public bid board check; ...)`.

## Teams message

`notify-teams` (or `watch --teams-webhook`) POSTs Teams messages, each carrying one Adaptive Card (version 1.4), to the
Workflows "When a Teams webhook request is received" URL, or a legacy connector URL. The URL comes from the
`TEXAS_BIDS_TEAMS_WEBHOOK` environment variable (recommended) or from `--webhook`/`--teams-webhook` (a flag value
shows in shell history and process lists), must be https, and is never stored or printed, including in error and
usage messages (anything URL-like in a mistyped argument is shown as `[hidden]`). Workflows answers `202`; any 2xx
counts as accepted.

Delivery rule: all new bids are posted, 10 per card, about a second apart (each card is checked to be under 28 KB;
titles and agencies are clipped). The state file is saved only after every card was accepted; if one fails nothing is
saved and the whole set is sent again next run (already delivered cards may repeat). The state path is checked to be
writable before the first post. When more than 50 bids are new (a first run, typically), the 50 whose response is due
soonest are listed (bids already past due, or with no due date, last) plus one summary card stating how many more were
not listed individually. Only the listed ones are marked seen; the rest are reported again at the next check.

`search` and `watch` print a `WARNING` line (and add it to `warnings` in `--json`) when a keyword was cut off at 40
pages (960 rows), or when the board returned fewer rows than its reported total.

## State file

`watch` keeps `{ "version": 1, "updated": "YYYY-MM-DD", "seen": { "<internalid>": { "id", "title", "due", "first_seen" } } }`.
A solicitation is "new" the first time its `internalid` is not in `seen`. Entries are dropped 120 days after their due
date once they no longer appear in the results. A missing file is a first run (baseline); a corrupt file is an error,
never a silent reset. The file is written atomically (temp file, then rename).
