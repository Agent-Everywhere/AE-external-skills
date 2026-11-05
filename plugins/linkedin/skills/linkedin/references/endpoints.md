# Plain LinkedIn endpoints (no Sales Navigator)

What the plain-LinkedIn skills read, from the user's own signed-in `www.linkedin.com` tab. The API is private,
undocumented and changes without notice: treat every row as "worked on the date shown", and on a 400, 404 or 410 say
so and fall back to reading the page. Every send (connection request, message) is a UI click after the user's typed
approval of the exact batch; no programmatic send exists here and none may be built.

The Sales Navigator endpoints (`/sales-api/...`, InMail, Sales Nav inbox) are not used by these skills.

## Status markers

| Marker | Meaning |
|---|---|
| **VERIFIED 2026-11-02** | Run live in a signed-in browser on that date; shape checked |
| **VERIFIED 2026-10-18** | Read-only GET run in a signed-in browser on that date, 200, shape checked (keys only). Copied from the Sales Navigator plugin's KB 16 |
| **UNVERIFIED** | Our reading of the page or a field name no one has checked live. The snippet is tolerant and says when it did not recognise the layout |

## Common request rules (voyager reads)

- Same-origin `fetch` from a loaded `www.linkedin.com` tab, `credentials: 'include'`.
- Headers: `csrf-token` = the `JSESSIONID` cookie value with quotes stripped (read inside the page, never printed,
  logged or saved); `x-restli-protocol-version: 2.0.0`; `accept: application/vnd.linkedin.normalized+json+2.1`
  (entities arrive flattened in `included[]`, linked by `entityUrn`).
- Rest.li values: parentheses, colons and commas inside a value are percent-encoded. `encodeURIComponent` does not
  encode `(` and `)`: replace them with `%28` and `%29` or the server returns 400.
- GraphQL `queryId`s (`messengerConversations.<hash>`) are build hashes and rotate when LinkedIn ships. Read the
  current one from the page: open linkedin.com/messaging once, then list `performance.getEntriesByType('resource')`
  names containing `queryId=`. Never hard-code one past a failure.
- Pace and stop: see each snippet. Stop on 401, 403, 429, 999, a redirect off the page, a checkpoint or captcha. No
  retry loops, no parallel calls.
- Several "My Network" pages now render server-side (React Server Components). That is not a JSON API: do not parse
  it. The older voyager REST routes below still answer.

## People search (`linkedin-find-people`)

| What | Request | Status |
|---|---|---|
| People search, server-rendered | `GET https://www.linkedin.com/search/results/people/?keywords=<kw>&network=%5B%22F%22%5D[&page=N]`: same-origin fetch from a signed-in linkedin.com tab (or read the rendered page). Returns server-rendered HTML, not JSON: results are inside `<main>`, 10 per page. `network` is a JSON array of `F` (1st), `S` (2nd), `O` (3rd and beyond), URL-encoded | VERIFIED 2026-11-02 |

Result card (VERIFIED 2026-11-02): an `<a href=".../in/<vanity>/">` (the photo link), the name, a second
`<a href=".../in/<vanity>/">` holding the name, then `• 1st|2nd|3rd+`, then the headline line, then the location line,
then optional lines: mutual connections (which hold OTHER people's `/in/` links followed by "is a mutual connection" /
"are mutual connections" / "N other mutual connection(s)") and "N followers". Pagination buttons carry
`aria-label="Page N"`. There is no internal JSON API in the page: `search_people.js` parses the HTML, and its
parser must return the card's own person, never the mutual-connection people. A redacted real page is the test
fixture `tests/fixtures/linkedin_classic/search_people_page.html` in the repository (10 results).

| What | Detail | Status |
|---|---|---|
| `geoUrn` filter | `&geoUrn=%5B%22<geo id>%22%5D` (a JSON array of the geo id as a string) | UNVERIFIED |
| Other filters | `extra` passes a raw query string through (copy the filter part of a LinkedIn search URL) | UNVERIFIED |
| Free-account limit | LinkedIn shows a monthly "commercial use limit" for searches on free accounts; the snippet stops with `commercial_use_limit` when the page says so (wording UNVERIFIED) | UNVERIFIED |
| Zero results | A page past the last result says "No results found" (wording UNVERIFIED); the snippet then returns `end_of_results` (or `no_results` on page 1) | UNVERIFIED |

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

## Replies and acceptance (`linkedin-replies`)

Used by `poll.js`, first page of each, one call every 4 to 8 seconds.

| What | Request | Status |
|---|---|---|
| Own account / member id | `GET /voyager/api/me`: `included[]` holds the mini profile with `publicIdentifier` and `dashEntityUrn` (`urn:li:fsd_profile:<id>`); the `<id>` is the `ACoAA...` member id | VERIFIED 2026-10-18 |
| Profile lookup by vanity | `GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<vanity>&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-19`: `included[]` holds a `...identity.profile.Profile` (`entityUrn` = `urn:li:fsd_profile:<id>`, `publicIdentifier`, `headline`, `*memberRelationship`) and a `...relationships.MemberRelationship` (connection state / distance). The decoration's trailing number rotates: take it from the profile page's own request on a 400 | VERIFIED 2026-10-18 |
| Sent connection requests (pending) | `GET /voyager/api/relationships/sentInvitationViewsV2?invitationType=CONNECTION&q=invitationType&start=0&count=10`: `*elements` of `SentInvitationViewV2`; `included[]` `Invitation` has `toMemberId`, `sentTime`, `customMessage`, `entityUrn`, `sharedSecret`. `poll.js` returns only `toMemberId` and `sentTime` | VERIFIED 2026-10-18 |
| Acceptance detection | `GET /voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=10&q=search&sortType=RECENTLY_ADDED&start=0`: `Connection` rows with `createdAt` and `connectedMember` (`urn:li:fsd_profile:<id>`). Match on member id; stop at the first `createdAt` older than your last check | VERIFIED 2026-10-18 |
| Received invitations | `GET /voyager/api/relationships/invitationViews?q=receivedInvitation&start=0&count=10` | VERIFIED 2026-10-18 |
| Inbox: list conversations (reply detection) | `GET /voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.<hash>&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3A<your id>)`: `included[]` has `Conversation` (`lastActivityAt`, `unreadCount`, `read`, `*conversationParticipants`), its latest `Message` (`deliveredAt`, `body.text`, `*sender`) and `MessagingParticipant` | VERIFIED 2026-10-18 |
| Messages in one conversation | `GET /voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.<hash>&variables=(conversationUrn:<urn, fully encoded incl. %28 %29>)`: `Message` rows with `deliveredAt`, `body`, `*sender`. A reply = a message whose sender is not you, later than your send | VERIFIED 2026-10-18 |

Not verified, and so tolerant in `poll.js`:

- **Vanity on these rows.** The connections, invitation and participant entities may or may not carry
  `publicIdentifier` or a `/in/<vanity>` profile URL. When they do not, `poll.js` returns the member id with an empty
  `vanity`, and `replies.py` matches on the member id the outreach ledger learned (`outreach.py record --member`).
- **Which message belongs to which conversation.** The key list above does not say how a `Message` points at its
  `Conversation`. `poll.js` uses `*conversation` or `conversation.entityUrn` when present, and otherwise falls back to
  the conversation's `unreadCount` / `read` flags. It reports `seen` counts so a changed layout is visible.

## Writes (UI only)

| What | How | Status |
|---|---|---|
| Send a connection request with a note | The Connect button on the profile, "Add a note", paste, Send, after typed approval of the exact batch | UNTESTED, UI only |
| Message a 1st-degree connection | The Message button on the profile, type, Send, after typed approval of the exact batch | UNTESTED, UI only |
| Withdraw a pending request | My Network, Manage, Sent, Withdraw, after typed approval | UNTESTED, UI only |

## Caps and their sources

Our defaults sit under every source. LinkedIn publishes that limits exist but not the numbers; the figures below are
operator defaults, aligned with the Sales Navigator plugin's KB 05 and KB 16.

| Action | Our default | Note |
|---|---|---|
| Connection requests | 20 a day, 100 per rolling 7 days | One request per person; a free account may be limited to about 5 notes a month and about 200 characters per note |
| Messages to 1st-degree connections | 40 a day, 3 per person | |
| Search pages | 10 a day, 5 per run, 8 to 15 seconds apart | Free accounts hit a monthly "commercial use limit" on searches |
| Public job pages (`linkedin-job-signals`) | 12 search pages and 30 posts a day, 6 and 10 per run, 3 to 8 seconds apart, no cookies | Stops 24 hours at the first 429, 999, 403, login wall or captcha |
| Signed-in job search (fallback) | 10 pages a day, 5 per run, 8 to 15 seconds apart | Same stops as the people search |
| Polls | 4 a day, at uneven times, 4 to 8 seconds between requests | |
| New or long-idle account | Half of every cap above for the first two weeks | |
