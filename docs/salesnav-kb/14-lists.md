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
| `list_save_accounts.js` | POST `/sales-api/salesApiCompanies?action=save` | body `{"companyIds":[ints],"lists":["<listId>"]}`; 50 ids per call, paced |

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
| Max account list size | per LinkedIn docs only, not observed live (largest seen: about 500): 1,000 per list since the Q3 2020 release (was 250); Evaboot says 999. See "List max size and sharding" |
| Lead-list saving | endpoint unverified: not offered |

## List max size and sharding

Per LinkedIn docs, not observed live: a list holds up to 1,000 accounts (the Q3 2020 release notes raised it from 250,
https://business.linkedin.com/sales-solutions/product-update/archival/20/q3-release; Evaboot says 999). Our largest list
is about 500.

Default pattern: shard into numbered lists before the max. Name them `<name>`, `<name> #2`, `<name> #3`, and so on, and
rotate to the next shard at 900 accounts. Confirm the base name with the user once; the numbered names are the same
confirmed list family. Record every shard id (tracker `--filters-delta "list=<id1>,<id2>"`).

People search then filters on all shards at once, OR'd in one `values:List(...)`: this is the default people-search filter
(next section), not a fallback.

## Lead search by account list

```
(filters:List((type:ACCOUNT_LIST,values:List((id:<listId>,selectionType:INCLUDED)))))
```

Combine with `SENIORITY_LEVEL` and `CURRENT_TITLE` / `FUNCTION` filters in the same `filters:List(...)`; put several list
ids in one `values:List(...)` to OR them: with sharded lists, always pass every shard id. `lead_search.js` and `count.js` take it as an ordinary raw query.

## Lists as the master of record

Across segments a saved list is the one durable master: later tasks re-read it with `lists.js` instead of re-pulling.
Note the list id in the tracker row (`--filters-delta "list=<listId>"`); the tracker's own `list_id` is its sub-list id,
not LinkedIn's.
