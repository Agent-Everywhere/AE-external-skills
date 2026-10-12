# Gotchas — things that silently go wrong in Sales Nav

Each item: what happens, how to notice, what to do. Re-check against the live UI; Sales Nav
changes without notice.

## Search and results

1. **The ~2,500 viewable-result cap.** Results show 25 per page and stop around page 100, even
   when the header says "10K+". Paging further returns nothing or repeats.
   → Shard until each search is under ~2,500 (`scripts/shard_plan.py`). Never trust "10K+".
2. **Result counts are approximate and drift.** The same search can show different totals minutes
   apart, and counts above 1,000 are rounded.
   → Record the count per shard at run time; treat TAM sums as estimates.
3. **Results lazy-load.** Only part of a page's rows render until you scroll. Reading too early
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
