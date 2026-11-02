# Plain LinkedIn endpoints (no Sales Navigator)

What the three plain-LinkedIn skills read, from the user's own signed-in `www.linkedin.com` tab. The API is private,
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
| Polls | 4 a day, at uneven times, 4 to 8 seconds between requests | |
| New or long-idle account | Half of every cap above for the first two weeks | |
