# Gotchas — things that silently go wrong in Sales Nav

Each item: what happens, how to notice, what to do. Re-check against the live UI; Sales Nav
changes without notice.

## Search and results

1. **The viewable-result cap.** Lead searches show at most ~2,500 results (100 pages of 25) and
   account searches at most **1,000** (40 pages), even when the header says "10K+". Paging further
   returns nothing or repeats.
   → Shard until each search is under its cap (`scripts/shard_plan.py`). Never trust "10K+".
2. **Result counts drift (UI) or are exact (API).** In the page, totals above 1,000 are rounded and
   the same search can show different totals minutes apart. Through the API (`count=1`),
   `paging.total` is exact for the query as sent.
   → Prefer API counts; record the count per shard at run time; treat TAM sums as estimates.
3. **Results lazy-load (page reading only).** Only part of a page's rows render until you scroll. Reading too early
   gives ~10 rows instead of 25.
   → Scroll to the bottom of the results list and confirm 25 rows (or the remainder on the last
   page) before reading.
4. **Duplicates across shards and pages.** Overlapping filters (a person in two metros, a company
   in two industries) and re-ordering between page loads produce repeats.
   → Dedupe on `salesnav_lead_url` / `linkedin_url` / company domain after every run
   (`scripts/dedupe.py`).
5. **Boolean title search is picky.** Operators must be uppercase `AND` `OR` `NOT`; phrases need
   straight double quotes; no wildcards; parentheses for grouping. A typo silently returns junk or
   zero results.
   → Show the user the exact Boolean string; sanity-read page 1.
6. **Headcount is LinkedIn's estimate**, based on profiles that list the company. Small brands with
   few LinkedIn users show "1–10" even with 40 staff; holding companies inflate.
   → Treat as a hint; verify on the company page or website for borderline accounts.
7. **Two different "locations".** Lead searches filter the *person's* location; account searches
   filter *headquarters*. Remote employees and multi-site companies leak through.
   → Pick deliberately and say which one you used.
8. **Industry codes are coarse.** Many niche companies sit under a generic industry (or the wrong
   one). Industry-only searches miss them.
   → Combine industry with company keywords, and run a keyword-only shard.
9. **Spotlight/signal filters change totals fast** ("Changed jobs in 90 days", "Posted in 30 days").
   Fine for weekly sweeps; bad for a fixed TAM number.

## People and URLs

10. **Sales Nav URLs are not public LinkedIn URLs.** Result rows link to `/sales/lead/…` with an
    internal id. CRMs and other tools usually need `linkedin.com/in/<slug>`.
    → Capture the public URL only when the profile view shows it; otherwise store the Sales Nav
    URL and leave `linkedin_url` blank. Never invent a slug.
11. **Hidden names.** Some out-of-network people show as "LinkedIn Member" depending on the
    user's plan.
    → Keep the row only if the user wants it; it can't be deduped or messaged reliably.
12. **Stale current roles.** People who left a company but didn't update their profile still match
    "current company"; "time in role" can be years old.
    → For account-first runs, prefer people with recent activity or a plausible tenure.
13. **Multiple current positions.** Founders and advisors list several current roles; they match
    searches for each company.
    → Check the title belongs to the target company before keeping the row.

## Session and browser

14. **One seat, one browser.** Opening the same LinkedIn login in two browsers (or the user's
    laptop plus the cloud browser at the same time for heavy work) is a classic restriction trigger.
    → Ask the user not to run their own Sales Nav searches while a run is going.
15. **Silent sign-outs.** The session expires mid-run and pages redirect to login; reading continues
    on the login page and produces garbage.
    → Before each page read, confirm the page is a results page (filters panel present, results
    header present). Stop on anything else.
16. **Soft throttling looks like "no results".** An empty page or the same rows on consecutive
    pages can mean throttling, not the end of results.
    → Stop for the day (guardrails), don't retry in a loop.
17. **UI changes.** Filter names and positions move. A selector-based assumption that worked last
    week can click the wrong filter.
    → Read labels before clicking; confirm the applied-filter chips match the plan before running.

## Lists and saved searches

18. **Saved searches only alert on new matches going forward**; they don't re-list old results.
    → Keep the run CSV as the source of truth; use saved searches for "new since last run".
19. **Lead/Account lists have size limits and are per-seat.** Teammates don't see the user's lists
    unless shared.
    → Use lists for exclusions and hand-offs, not as the main storage.

## Data quality before hand-off

20. **Exclusions leak.** Filters miss competitors with odd names, customers under a parent brand,
    and "former" people in titles.
    → Re-apply exclusions on the collected CSV (`scripts/dedupe.py --exclude`), and show the user
    what was removed.

## Fast path (in-page API)

21. **403 in ~100 ms on the first call.** The page's CSRF token (the `JSESSIONID` cookie) is not
    ready yet. This is timing, not a block.
    → Wait for `networkidle` plus about 3 seconds before the first call (`session.py` does;
    `page/csrf_ready.js` checks). Only treat 403/429 as a stop signal after the page was ready.
22. **A query copied from a page URL returns 400.** The URL's query carries `recentSearchParam`
    and is percent-encoded once more than the API wants.
    → Strip `recentSearchParam:(...)` and percent-decode once (the search snippets do). Better: build
    the query yourself from typeahead-resolved ids; do not import a user's URL unless they ask.
23. **Query order matters.** In an account query, `filters:List(...)` comes first and
    `keywords:<url-encoded text>` is a top-level key after it.
    → Boolean `OR` and quoted phrases work in keywords; they are not filter entries.
24. **Account results have no website, domain or location.** A search row has name, industry,
    headcount range and the company id only.
    → Fetch websites with `companies_websites.js` (25 ids per call, decoration URL-encoded as
    `%28entityUrn%2Cname%2Cwebsite%29`). Raw parentheses or richer decorations return 400. Leave
    `hq_location` blank rather than guessing.
25. **Typeahead fails silently.** A wrong `type` returns 200 with empty `elements`. Geography is
    `type=BING_GEO` (the filter type is `REGION`). An industry like "nutrition" resolves to nothing.
    → Treat empty as "not found", try parent industries, add niche words as keywords.
26. **A noisy keyword swamps the master.** One generic word can account for most of an OR-list's
    total and mostly match company names.
    → Count every keyword alone; drop or demote the dominant one.
27. **Headcount bands do not sum to the total.** Self-employed (`A`) and 501+ (`F`–`I`) sit outside
    `B`–`E`; shard by band without them and companies vanish.
    → Include explicit `A` and `F`+ shards inside any band-sharded state.
28. **Shard totals over-count.** State (or metro) shards overlap through multi-location companies.
    → Dedupe by company id (accounts) or Sales Nav lead URL (leads); expect a few percent overlap.
29. **The cloud browser dies when the script disconnects.** Splitting a session across scripts, or
    ending the process early, ends the browser and its state.
    → Do all of a session's work in one `session.py` process; heartbeat at least every 60 s; stay
    under the 40-minute ceiling by checkpointing to JSONL and reopening (`--skip-done`).
30. **The claim is one-use and lasts 60 seconds.** A slow setup wastes it.
    → Install Playwright and write the plan first, then open the session and run immediately.
31. **Search results do not contain the public profile URL.** The row has the Sales Nav lead id
    only.
    → `linkedin_url` stays blank in fast-path output; never construct a slug.
32. **Local runs are your own seat.** A local browser run uses the user's session and IP; the
    platform sees the same person working fast.
    → Warn first, keep the pacing, and offer the cloud browser.
