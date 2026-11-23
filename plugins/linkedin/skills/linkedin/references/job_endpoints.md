# LinkedIn job endpoints (`linkedin-job-signals`)

What the job-signals skill reads: LinkedIn's public, logged-out job pages (the main route) and, as a fallback, the
signed-in voyager job search from the user's own `www.linkedin.com` tab. The pages and the API are private,
undocumented and change without notice: treat every row as "worked on the date shown", and on a 400, 404 or 410 say so
and stop. Nothing here writes: no apply, save or message call exists and none may be built.

## Status markers

| Marker | Meaning |
|---|---|
| **VERIFIED <date>** | Run live on that date; shape checked |
| **UNVERIFIED** | Our reading of the page or a field name no one has checked live. The parser is tolerant and says when it did not recognise the layout |

## Common request rules (signed-in fallback only)

The public route sends no cookies and no headers beyond a browser-like `User-Agent` and `Accept-Language`. These rules
apply to the signed-in fallback (`search_jobs.js`):

- Same-origin `fetch` from a loaded `www.linkedin.com` tab, `credentials: 'include'`.
- Headers: `csrf-token` = the `JSESSIONID` cookie value with quotes stripped (read inside the page, never printed,
  logged or saved); `x-restli-protocol-version: 2.0.0`; `accept: application/vnd.linkedin.normalized+json+2.1`
  (entities arrive flattened in `included[]`, linked by `entityUrn`).
- Rest.li values: parentheses, colons and commas inside a value are percent-encoded. `encodeURIComponent` does not
  encode `(` and `)`: replace them with `%28` and `%29` or the server returns 400.
- Pace and stop: see the skill. Stop on 401, 403, 429, 999, a redirect off the page, a checkpoint or captcha. No retry
  loops, no parallel calls.

## Job postings (`linkedin-job-signals`)

Two routes. The main one is LinkedIn's PUBLIC, logged-out job pages, read by `job_signals.py` with plain HTTPS GETs from
the user's own connection: no sign-in, no cookie or token is sent or stored, a browser-like `User-Agent` and
`Accept-Language`, 3 to 8 seconds between requests, no retries. The fallback is the signed-in voyager endpoint, read by
`search_jobs.js` in the user's own tab when the public route is blocked.

| What | Request | Status |
|---|---|---|
| Public job search, first page | `GET https://www.linkedin.com/jobs/search?keywords=<kw>&location=<place>&f_TPR=r<seconds>&sortBy=DD&position=1&pageNum=0`: server-rendered HTML, about 60 cards in `<ul class="jobs-search__results-list">`. Each card: `data-entity-urn="urn:li:jobPosting:<id>"`, `h3.base-search-card__title` (title), `h4.base-search-card__subtitle` with an `<a href=".../company/<slug>">` (company; some are `/school/<slug>`, which has no slug here), `span.job-search-card__location`, `<time datetime="YYYY-MM-DD">` (class `job-search-card__listdate` or `--new`) holding relative text such as "3 days ago". `f_TPR` is the posted-within window: `r86400` 24 hours, `r604800` week, `r2592000` 30 days (any `r<seconds>` is accepted). Keyword matching is loose: results include unrelated titles, so the skill filters titles locally | VERIFIED 2026-11-05 (200, cards parsed; one request from a home connection) |
| Public job search, later pages | `GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=...&location=...&f_TPR=...&sortBy=DD&start=<offset>`: an HTML fragment of the same `<li>` cards. `start` is the number of cards already read | UNVERIFIED: answered 429 on a first try from one connection, so the skill treats any 429 as a stop and never retries |
| Public job post | `GET https://www.linkedin.com/jobs/view/<jobId>`: HTML with `h1.top-card-layout__title`, `a.topcard__org-name-link`, `span.topcard__flavor--bullet` (location), `span.posted-time-ago__text`, `figcaption.num-applicants__caption`, the description in `div.show-more-less-html__markup` and the criteria (seniority, employment type, function, industries) in `span.description__job-criteria-text`. 404 or 410 means the job is gone | VERIFIED 2026-11-05 (200, fields parsed) |
| Blocks on the public route | HTTP 401, 403, 429, 999, a redirect to `/authwall`, `/login`, `/uas/` or a checkpoint, or a captcha page. The skill stops, locks the route for 24 hours and offers the signed-in fallback | UNVERIFIED (wording of the pages varies) |
| Signed-in job search (fallback) | `GET /voyager/api/voyagerJobsDashJobCards?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220&count=25&q=jobSearch&query=(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:<kw>,locationUnion:(seoLocation:(location:<place>)),selectedFilters:(sortBy:List(DD),timePostedRange:List(r<seconds>)),spellCorrectionEnabled:true)&start=<n>`: normalized JSON, `data.paging.total`, `data.elements`, and `included[]` with `JobPostingCard` rows: `jobPostingTitle`, `jobPostingUrn` (`urn:li:fsd_jobPosting:<id>`), `primaryDescription.text` (company), `secondaryDescription.text` (location and workplace type), `footerItems[]` (type `LISTED_DATE`, `timeAt` in epoch milliseconds), and the company in `logo.attributes[].detailDataUnion.companyLogo` (`urn:li:fsd_company:<id>`). The response may also hold prefetched cards of the next page: `search_jobs.js` keeps only cards that `data.elements` names. Filters are `List(...)` values; the decoration's trailing number rotates (a 400 stops with `decoration_rotated`) | Endpoint and `JobPostingCard` fields from a prior capture (2026-04); the exact `footerItems` and `elements` shape is UNVERIFIED, so the snippet is tolerant |

Company website and domain are not in either result. `qualify` accepts an optional `website` per company (from the
post or the user); otherwise Apollo fills it from the company's LinkedIn URL or name.
