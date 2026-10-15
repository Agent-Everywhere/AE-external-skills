# 13 Approach: account-first people

Never keyword-search people across all of LinkedIn. People come only after a qualified accounts file exists, scoped to
those accounts.

## Scope

| Option | When | Limit |
|---|---|---|
| `ACCOUNT_LIST` filter | preferred: save the qualified accounts to a list first (page 14). Default: filter by all shard lists (`<name>`, `<name> #2`, ...) OR'd in one `values:List(...)` | none on id count: one short query covers every shard |
| `CURRENT_COMPANY` chunks | no list | URL length: at most 400 ids per query (420 ok, 480 unreliable, 540+ HTTP 414) |

Add `SENIORITY_LEVEL` plus a title or function, then count each variant with `count=1` before pulling. 2,500 leads are
viewable per search: if a list yields more, split by seniority or title first.

## Roles by size band

| Company size | Roles |
|---|---|
| under 50 employees | Founder, CEO, Owner |
| 50 or more | Operations, Product Development, Supply Chain, COO, CFO |

Cap 2 to 3 people per account. Exclude after collecting (`dedupe.py --exclude`), never at search time. Rows carry a Sales
Nav lead URL: leave `linkedin_url` blank.

## Acme result

537 keeps saved to one account list. Lead search on `ACCOUNT_LIST` alone: 3,540; with `SENIORITY_LEVEL` Owner+CXO
1,183, VP+Director 658, and the rest (those four EXCLUDED) pulled to the 2,500 view cap. Picked locally 2 to 3 per account
(founder/CEO/owner under 50 employees; ops, product development, supply chain, COO, CFO above), dropping junior titles:
517 contacts across 323 accounts; 214 accounts had no qualifying person on LinkedIn. Leads stay in CSVs.

Runtime note: `lead_search.js` over a list hit `evaluate_timeout` twice while the same in-page fetch returned 200; pull
leads with a direct fetch until the snippet timeout is raised.
