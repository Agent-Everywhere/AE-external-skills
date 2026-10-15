# 14 Lists

Policy (operator decision 2026-10-14): saving Sales Nav lists is allowed as part of TAM work.

- The user confirms the exact list name once per run.
- Never modify, rename or delete an existing list the user did not name.
- Saved accounts are not capped like execution actions: log them with `run_log.py add --saved-accounts N` (pacing guard
  2,500 a day, ceiling 5,000, 3 to 5 seconds between batches).
- Every other LinkedIn write stays forbidden (messages, InMails, connects, follows, profile edits, saved searches, lead
  saves) except the outreach skill's approval flow. Never drive the UI to save.

## Snippets

| Snippet | Call | Notes |
|---|---|---|
| `lists.js` | GET `/sales-api/salesApiLists?q=listType&listType=ACCOUNT` (or `LEAD`) `&start=0&count=25` | id, name, entityCount, listType, listSource; `all: true` pages through |
| `list_create.js` | POST `/sales-api/salesApiLists` | body `{"name","listType","role":"OWNER"}`; 422 without `role`; refuses an existing name unless `reuse: true` |
| `list_save_accounts.js` | POST `/sales-api/salesApiCompanies?action=save` | body `{"companyIds":[ints],"lists":["<listId>"]}`; 50 ids per call, paced; one list only, `EXCEED_LIMIT` entries reported in `exceeded`, never as saved |
| `list_save_sharded.js` | the save and create calls above, plus the `lists.js` read | default for more than a few hundred accounts: verifies `entityCount` after every batch and rotates to `<base> #2`, `#3`... at 1,000 |

Flow: read (`lists.js`), create, save in batches, read again and compare `entityCount` with the number saved. A refused
create returns the existing id so the user can decide.

## Verified findings

| Finding | Result |
|---|---|
| Account save batch | 25 and 50 ids: 200 with `listEntityActionResponses[].status` SUCCESS; 75 and 100: 400. Max 50 per call |
| `CURRENT_COMPANY` ids per lead query | 10, 25, 50, 100, 150, 200, 300, 362, 420: all 200 with sane totals. 362 ids total 2,805, exactly the `ACCOUNT_LIST` count of the same 362 accounts. 480: 200 but no paging total (unreliable). 540, 600, 1,000, 1,430: HTTP 414 URI Too Long |
| Why | the limit is URL length: about 26.6K characters fine at 420 ids, about 34K fails. Chunk `CURRENT_COMPANY` at 400 ids or fewer |
| `ACCOUNT_LIST` filter | bypasses the limit: one 96-character query covers a whole list |
| Several lists in one filter | OR'd: list A 2,805 leads + list B 312 gave 3,071 for both (overlap removed) |
| Max account list size | **1,000, observed live** (2026-10-14): 20 batches of 50 took a fresh list 0 to 1,000; every save after that returns HTTP 200 with per-entity `status: EXCEED_LIMIT` and the count stays 1,000. See "List max size and sharding" |
| Lead-list saving | endpoint unverified: not offered |

## List max size and sharding

Observed live 2026-10-14 (a throwaway test list): an account list holds exactly **1,000** accounts, matching the
Q3 2020 release notes (https://business.linkedin.com/sales-solutions/product-update/archival/20/q3-release; Evaboot's 999
is wrong). Method: `POST /sales-api/salesApiCompanies?action=save`, 50 ids a call, ~4 s pacing, `entityCount` re-read
after every batch. Batches 1-20 each added exactly 50 (950 -> 1,000 on batch 20); batch 21 and 10 single-id probes
after it left the count at 1,000. No 429, no banner.

The limit is silent. The save still returns **HTTP 200** and top-level `"status":"SUCCESS"`, even lists the id under
`successful`, but each entry in `value.listEntityActionResponses[]` carries `"status":"EXCEED_LIMIT"`. Never trust the
top-level status: read the per-entity status and re-read `entityCount`. Not tested: whether a batch that straddles the
cap saves partially (so batches are cut to the room left, and a mixed response is handled per entry).

Automatic rotation (`list_save_sharded.js`, params `listId`, `ids`, optional `name`, `shardAt` 1000, `batch` 50):

1. Read the confirmed list's `entityCount` (same `salesApiLists` endpoint as `lists.js`). The base name is the confirmed
   name without a trailing ` #N`; shards are `<base>`, `<base> #2`, `<base> #3`.
2. Save in batches of at most 50, each cut to the room left under `shardAt`, paced as before. Entries are counted by
   status: `SUCCESS` saved, `EXCEED_LIMIT` counted apart (never saved), anything else failed.
3. After every batch, re-read `entityCount`. At `shardAt`, or on any `EXCEED_LIMIT`, move to the next number: an existing
   list with that exact name is reused (its own count respected, a full one is skipped), otherwise it is created
   (`POST /sales-api/salesApiLists`, `role: OWNER`). The remaining and `EXCEED_LIMIT` ids are saved there.
4. Stops at the first non-200. Returns `shards: [{listId, name, saved, exceeded, entityCount, created}]`, totals `saved`,
   `failed` (not saved anywhere), `exceeded` (cap refusals seen, all re-queued). Resume by re-running with `failed`.

Writes only list creates and saves, and only into lists named `<base> #N`. Confirm the base name with the user once; the
numbered names are the same confirmed list family. Record every shard id (tracker `--filters-delta "list=<id1>,<id2>"`).
Demonstrated live: 200 overflow ids saved to a second list "<test list> #2" (count 200); lead search with `ACCOUNT_LIST`
on list 1 = 6,155, list 2 = 1,103, both OR'd = 7,156 (102 leads de-duplicated), all HTTP 200.

People search then filters on all shards at once, OR'd in one `values:List(...)`: this is the default people-search filter
(next section), not a fallback.

## Lead search by account list

```
(filters:List((type:ACCOUNT_LIST,values:List((id:<listId>,selectionType:INCLUDED)))))
```

Combine with `SENIORITY_LEVEL` and `CURRENT_TITLE` / `FUNCTION` filters in the same `filters:List(...)`; put several list
ids in one `values:List(...)` to OR them: with sharded lists, always pass every shard id. `lead_search.js` and `count.js` take it as an ordinary raw query.

### Large list-filtered lead searches

An `ACCOUNT_LIST` search over a big list can be slow at `count` 100 and hit the runtime's `evaluate_timeout` (60 s per
in-page call). `lead_search.js` therefore aborts each request after `timeoutMs` (25000) and retries the same page with
half the `count` (minimum 10) until `budgetMs` (50000) is spent. Read `count` and `retries` in the result and page on with
`start += rows`. If every attempt times out it returns `{status: 0, error: 'fetch_timeout', count, retries, hint}`:
lower `count`, or fall back to a direct fetch with a larger plan `evaluate_timeout_ms` (up to 600000) and `count` 25.

## Lists as the master of record

Across segments a saved list is the one durable master: later tasks re-read it with `lists.js` instead of re-pulling.
Note the list id in the tracker row (`--filters-delta "list=<listId>"`); the tracker's own `list_id` is its sub-list id,
not LinkedIn's.
