# Fast path — Sales Navigator's in-page API

Sales Navigator's own pages call a same-origin JSON API. From a signed-in page you can call it
directly: **exact totals, 25 rows in about 2 seconds**, against 30 seconds or more per page (and
incomplete rows) when reading the rendered page. The snippets in `page/` wrap the calls; the
runtime in `runtime/` delivers them to the page.

Everything here was proven on live seats; the API is private and can change. If a call that used
to work returns 400 or an unexpected shape, say so and fall back to the slow path rather than
guessing.

## Runtimes

| Runtime | Use when | Doc |
|---|---|---|
| local (default) | A browser JavaScript tool (Cowork built-in browser, Claude in Chrome), or Playwright on the user's Chrome | `runtime/local.md` |
| agent-browser | Agent Browser connector + code execution; runs on a schedule or with the laptop closed | `runtime/agent-browser.md` |
| neither | Plain chat with no browser JS tool and no connector | slow path in `references/build-list.md` section 4b |

Both fast runtimes run the same snippets. With a browser JS tool each snippet is one tool call
(an async IIFE with its params inline, built with `session.py --emit`); the plan and `--skip-done`
machinery below is for the code-execution runtimes. Plain chat cannot do the fast path.

## The call, exactly

Run inside a loaded `linkedin.com/sales/...` page:

- Header `csrf-token` = the `JSESSIONID` cookie value **with its quotes stripped**. Read it in the
  page; never log it, return it, or save it.
- Header `x-restli-protocol-version: 2.0.0`, header `accept: application/json`, `credentials: 'include'`.
- **Wait for `networkidle` plus about 3 seconds after the page loads before the first call.**
  Earlier, the token is not ready and the call returns 403 in about 100 ms. That is timing, not a
  block; `session.py` and `csrf_ready.js` handle it.

| Purpose | Endpoint | Notes |
|---|---|---|
| Lead search | `/sales-api/salesApiLeadSearch?q=searchQuery&query=<restli>&start=N&count=25&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14` | `paging.total` exact; `count=1` to size; viewable cap 2,500 (100 pages) |
| Account search | `/sales-api/salesApiAccountSearch?q=searchQuery&query=<restli>&start=N&count=25&decorationId=com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4` | viewable cap 1,000; **no website in the result** |
| Websites | `/sales-api/salesApiCompanies?ids=List(id1,...,id25)&decoration=%28entityUrn%2Cname%2Cwebsite%29` | decoration **must** be URL-encoded (raw parentheses return 400); richer decorations return 400; 25 ids per call |
| Typeahead | `/sales-api/salesApiFacetTypeahead?q=query&start=0&count=10&type=<TYPE>&query=<term>` | geography is `type=BING_GEO`; a wrong shape returns 200 with empty `elements` |

Query construction, filter types and ids: `references/filters.md`.

## Plans

A plan is a JSON list of snippet calls. The runtime runs them in order inside one browser
session, waits and heartbeats for you, and writes one JSONL record per call.

```json
{
  "start_url": "https://www.linkedin.com/sales/home",
  "settle_ms": 3000,
  "ready": {"snippet": "csrf_ready.js", "retries": 5, "interval_ms": 2000},
  "delay_ms": [3000, 5000],
  "calls": [
    {"id": "size", "snippet": "count.js",
     "params": {"kind": "account", "queries": [
        {"label": "master", "query": "(filters:List((type:REGION,values:List((id:103644278,selectionType:INCLUDED)))),keywords:supplement%20OR%20vitamin)"}]}},
    {"id": "sample", "snippet": "account_search.js",
     "params": {"query": "(filters:List(...),keywords:...)"},
     "pages": {"param": "start", "step": 25, "max_pages": 2}},
    {"id": "accts", "snippet": "account_search.js",
     "params": {"query": "(filters:List(...),keywords:...)"},
     "pages": {"param": "start", "step": 25, "cap": 1000}}
  ]
}
```

Run it (cloud browser shown; `runtime/local.md` has the local command). Snippet names resolve
against this skill's `page/` folder automatically:

```
AB_CLAIM="<claim>" python3 runtime/session.py --runtime agent-browser --base "<base>" \
        --plan plan.json --out results.jsonl
```

Then turn the results into the standard CSVs:

```
python3 scripts/salesnav_rows.py accounts results.jsonl -o accounts.csv --mode B --buyer-type "<type>" --shard "<shard>"
python3 scripts/salesnav_rows.py leads    results.jsonl -o leads.csv    --mode A --buyer-type "<type>" --shard "<shard>"
python3 scripts/validate_csv.py accounts.csv
```

Rules for plans:

- **A cloud browser session is one process.** Put every call for the session in one plan. Close
  and reopen near the 40-minute ceiling (`session.py` checkpoints and exits 4; re-run with
  `--skip-done`).
- Write the plan **before** opening a cloud session: the claim expires in 60 seconds. The runtime
  checks the plan first (exit 2, nothing claimed): unique call `id`s, `delay_ms` of at least
  2000, a non-empty `stop_on_status`, and at most 40 pages per paged call and per run unless the
  plan sets `max_pages` / `max_pages_total` higher (never above 80, the hard ceiling in
  `references/guardrails.md`).
- Exit code 8 means the run finished but a call failed or a paged call was truncated: do not hand
  the output over as complete. A deliberate partial pull (the 50-row sample) sets `"sample": true`
  on the plan or on that call, with `"pages": {"max_pages": 2}`: it ends with a `sampled` event and
  exit 0. Use it only for samples, never for a collection (`references/build-list.md`, section 3).
- A cloud session is one fixed plan. Dependent steps (typeahead ids, then a search that uses them,
  then a search per company) are one session per step; chain steps in one plan only when every
  param is static (`runtime/agent-browser.md`). The local runtime has no such limit.
- Keep plans to the call budget in `references/guardrails.md`. Size first (`count.js`, `count=1`
  responses are tiny), then sample, then collect.
- For many companies or ids, generate the plan with a short script; do not hand-write hundreds of calls.

## Per-account flow

1. Account search → rows with company id (`entityUrn` = `urn:li:fs_salesCompany:<id>`).
2. Websites: `companies_websites.js` with up to 25 ids per call (the snippet chunks longer lists
   with a pause). The domain is derived from `website` (`http://www.x.com` → `x.com`).
3. Decision-makers: one lead search per qualified company, filtered to that company, to the buying
   seniority levels, **and to the buying title or function** (seniority alone returns every
   director in the company):

   ```
   (filters:List((type:CURRENT_COMPANY,values:List((id:urn%3Ali%3Aorganization%3A<company id>,selectionType:INCLUDED))),(type:SENIORITY_LEVEL,values:List((id:320,selectionType:INCLUDED),(id:310,selectionType:INCLUDED),(id:300,selectionType:INCLUDED),(id:220,selectionType:INCLUDED))),(type:CURRENT_TITLE,values:List((text:operations,selectionType:INCLUDED),(text:product%20development,selectionType:INCLUDED))),(type:REGION,values:List((id:103644278,selectionType:INCLUDED)))))
   ```

   Seniority ids: `320` Owner/Partner, `310` CXO, `300` VP, `220` Director.
   - `CURRENT_TITLE` takes free text (`text:`, URL-encoded; proven) or typeahead ids; use the title
     words from the Company Profile's titles by company size. `FUNCTION` (a department such as
     operations) can go next to it or instead of it: resolve its ids with `typeahead.js` and
     confirm with a `count=1`; if the typeahead comes back empty, use `CURRENT_TITLE`.
   - `REGION` here is the **person's** location. When the account is headquartered in one country,
     restrict to that country's geo id (the example is the United States) so offshore staff with
     the same title do not take the slots; drop the filter for global companies or when the
     profile says the buyer can sit anywhere.
   - Count first when a combination looks too tight (`count=1`); if it returns nothing, loosen the
     title words before dropping seniority. One page (25) is plenty per company; rank and keep 1–3.
4. Convert (`salesnav_rows.py leads ... --company-ids ids.csv` keeps a lead-to-company join), then
   hand `leads.csv` + `accounts.csv` to CRM dedupe.

## Timings and expectations

| | Fast path | Page reading |
|---|---|---|
| 25 rows | about 2 s per call (plus 3–5 s pacing) | 30 s or more, often incomplete |
| Count | exact `paging.total`, tiny response | rounded and approximate in the UI |
| 1,000 rows | about 40 calls, a few minutes | most of an hour, rows missing |

## When it fails

| Symptom | Cause | Do |
|---|---|---|
| 403 within ~100 ms of the first call | token not ready yet | wait for networkidle + 3 s; `csrf_ready.js` |
| 403/429 later | throttling or a block | stop, tell the user (guardrails) |
| 400 on a copied URL query | `recentSearchParam` / double encoding | the search snippets clean it; better, build the query yourself |
| 400 on websites | decoration not encoded, or a richer decoration | use the exact encoded `(entityUrn,name,website)` |
| 200 with no elements from typeahead | wrong `type` or shape | `gotchas.md` |
| Total looks wrong / cap hit | viewable cap | shard (`filters.md`) |
