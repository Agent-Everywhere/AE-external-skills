# 16 DIY LinkedIn endpoints (no Unipile, no LiReach)

What a hosted LinkedIn API (Unipile and tools built on it) does for an outreach program, mapped to the calls the
user's own signed-in browser already makes. Read by `salesnav-diy-linkedin`. The API is private, undocumented and
changes without notice: treat every row as "worked on the date shown", and on a 400, 404 or 410 say so and fall back
to reading the page.

## Status markers

| Marker | Meaning |
|---|---|
| **VERIFIED 2026-10-18** | Read-only GET run in a signed-in browser on that date, 200, shape checked (keys only, no data kept) |
| **VERIFIED (engine)** | Already shipped and verified as a `page/` snippet in this engine; see `reference.md` |
| **UNTESTED** | Write. Shape from public community reverse-engineering and from observing the UI, never submitted while writing this page. The supported path is the UI click after typed approval |
| **GONE** | Returned 410 on 2026-10-18; do not use |

## Common request rules

- Same-origin `fetch` from a loaded `www.linkedin.com` tab (voyager) or `www.linkedin.com/sales/...` tab
  (`/sales-api`), `credentials: 'include'`.
- Headers: `csrf-token` = the `JSESSIONID` cookie value with quotes stripped (read inside the page, never printed,
  logged or saved); `x-restli-protocol-version: 2.0.0`. Voyager reads use
  `accept: application/vnd.linkedin.normalized+json+2.1` (entities arrive flattened in `included[]`, linked by
  `entityUrn`); `/sales-api` reads use `accept: application/json`. The page also sends `x-li-lang` (the UI locale)
  and `x-li-track` (client info); calls worked without setting them by hand.
- Rest.li values: parentheses, colons and commas inside a value are percent-encoded. `encodeURIComponent` does not
  encode `(` and `)`: replace them with `%28` and `%29` or the server returns 400 (seen on `messengerMessages`).
- GraphQL `queryId`s (`messengerConversations.<hash>`) are build hashes and rotate when LinkedIn ships. Read the
  current one from the page: open the matching UI page once and list
  `performance.getEntriesByType('resource')` names containing `queryId=`. Never hard-code one past a failure.
- Your own member id: `GET /voyager/api/me` (**VERIFIED 2026-10-18**); `included[]` holds the mini profile with
  `publicIdentifier` and `dashEntityUrn` (`urn:li:fsd_profile:<id>`). The `<id>` is the `ACoAA...` member id a
  hosted API calls `provider_id`.
- Pace: one call every 4 seconds or slower, never in parallel. Stop on 401, 403 (after the ready gate), 429, 999,
  a redirect off the page, a checkpoint or captcha. No retry loops.
- Several "My Network" pages (sent and received invitations, connections) now render server-side
  (`/flagship-web/rsc-action/...`, React Server Components). That is not a JSON API: do not parse it. The older
  voyager REST routes below still answer.

## Capability map

Unipile paths are its v2 API (`https://api.unipile.com/v2/{account}/...`) as used by LiReach.

| Capability | Unipile (v2) | DIY browser equivalent | Status |
|---|---|---|---|
| Own account / member id | `GET /accounts` | `GET /voyager/api/me` | VERIFIED 2026-10-18 |
| Profile lookup by vanity (member id, headline, degree) | `GET /{acct}/users/{public_identifier}?variant=linkedin_classic` | `GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<vanity>&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-19`: `included[]` holds a `...identity.profile.Profile` (`entityUrn` = `urn:li:fsd_profile:<id>`, `publicIdentifier`, `headline`, `*memberRelationship`) and a `...relationships.MemberRelationship` (connection state / distance) | VERIFIED 2026-10-18 (the decoration's trailing number rotates; take it from the profile page's own request on a 400) |
| Legacy profile view, network info | none | `/voyager/api/identity/profiles/<vanity>/profileView`, `/networkinfo` | GONE (410) |
| Sales Nav profile, Open Profile flag, InMail restriction, degree, pending invite | `GET /{acct}/users/{id}?variant=linkedin_sales_navigator` | `profile.js` (`degree`, `pendingInvitation`; `extras` adds `memberBadges.openLink`, `inmailRestriction`), batch: `profiles_batch.js` | VERIFIED (engine) |
| Sales Nav people search (URL or params) | `POST /{acct}/linkedin/sales-navigator/search[/people]` | `lead_search.js` (`/sales-api/salesApiLeadSearch`, 100 per call, 2,500 viewable) | VERIFIED (engine) |
| Search parameter lookup (geo, industry, title ids) | `GET /{acct}/linkedin/sales-navigator/search/parameters` | `typeahead.js` (`/sales-api/salesApiFacetTypeahead`) | VERIFIED (engine) |
| Company profile | `getClassicCompanyProfile` | `account.js`, `companies_details.js` (`/sales-api/salesApiCompanies`) | VERIFIED (engine) |
| Lists read / account list save | not used by LiReach | `lists.js`, `list_save_accounts.js` | VERIFIED (engine) |
| Posts and comments of a lead | category only, never called | `activity.js` (`/sales-api/salesApiInsightsV2`; post text unverified) | VERIFIED (engine), partial |
| Sent connection requests (pending) | `GET /{acct}/users/me/relation-requests?type=sent` | `GET /voyager/api/relationships/sentInvitationViewsV2?invitationType=CONNECTION&q=invitationType&start=0&count=10`: `*elements` of `SentInvitationViewV2`; `included[]` `Invitation` has `toMemberId`, `sentTime`, `customMessage`, `entityUrn`, `sharedSecret` (needed to withdraw) | VERIFIED 2026-10-18 |
| Acceptance detection | `relation.new` webhook, or "invite left the pending list" | Poll connections newest first: `GET /voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=10&q=search&sortType=RECENTLY_ADDED&start=0`: `Connection` rows with `createdAt` and `connectedMember` (`urn:li:fsd_profile:<id>`). Match on member id; stop paging at the first `createdAt` older than your last check | VERIFIED 2026-10-18 |
| Received invitations | not used | `GET /voyager/api/relationships/invitationViews?q=receivedInvitation&start=0&count=10` | VERIFIED 2026-10-18 |
| Inbox: list conversations (reply detection) | `GET /{acct}/chats`, `message.new` webhook | `GET /voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.<hash>&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3A<your id>)`: `included[]` has `Conversation` (`lastActivityAt`, `unreadCount`, `read`, `*conversationParticipants`), its latest `Message` (`deliveredAt`, `body.text`, `*sender`) and `MessagingParticipant` | VERIFIED 2026-10-18 |
| Messages in one conversation | `GET /{acct}/chats/{chat_id}/messages` | `GET /voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.<hash>&variables=(conversationUrn:<urn, fully encoded incl. %28 %29>)`: `Message` rows with `deliveredAt`, `body`, `*sender`. A reply = a message whose sender is not you, later than your send | VERIFIED 2026-10-18 |
| Sales Nav inbox (InMail and Open Profile replies) | `GET /{acct}/inboxes/SALES_NAVIGATOR_PRIMARY/chats` | From a `/sales/` tab: `GET /sales-api/salesApiMessagingThreads?decoration=<encoded>&count=20&filter=INBOX&q=filter&pageStartsAt=<epoch ms>`; decoration `(id,archived,unreadMessageCount,nextPageStartsAt,totalMessageCount,messages*(id,type,deliveredAt,subject,body,author),participants*~fs_salesProfile(entityUrn,fullName,degree))`. Page older with `pageStartsAt` = the last `nextPageStartsAt` | VERIFIED 2026-10-18 |
| InMail credit balance | InMail balance route | `GET /sales-api/salesApiCredits?q=findCreditGrant&creditGrantType=LSS_INMAIL`: elements with `type`, `value` | VERIFIED 2026-10-18 |
| Send connection request (with note) | `POST /{acct}/users/me/relation-requests` `{user_id, message}` | UI: the Connect button on the profile, "Add a note", Send. Community-observed API: `POST /voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2` body `{"invitee":{"inviteeUnion":{"memberProfile":"urn:li:fsd_profile:<id>"}},"customMessage":"<=300 chars"}` | UNTESTED |
| Withdraw a pending request | `DELETE /{acct}/users/me/relation-requests/{id}` | UI: My Network, Manage, Sent, Withdraw. Community-observed: `POST /voyager/api/relationships/invitations/<invitation id>?action=withdraw` body `{"inviteActionType":"ACTOR_WITHDRAW"}` (uses the `sharedSecret`/id from the sent list) | UNTESTED |
| Message a connection (new or existing chat) | `POST /{acct}/inboxes/CLASSIC_PRIMARY/chats/send`, `POST /{acct}/chats/{id}/messages/send` | UI: Message button, type, Send. Community-observed: `POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage` body `{"message":{"body":{"attributes":[],"text":"..."},"renderContentUnions":[],"conversationUrn":"<urn>"},"mailboxUrn":"urn:li:fsd_profile:<your id>","trackingId":"<random 16 bytes>","dedupeByClientGeneratedToken":false}` (new chat: `hostRecipientUrns` instead of `conversationUrn`) | UNTESTED |
| InMail / Open Profile message | `POST /{acct}/inboxes/SALES_NAVIGATOR_PRIMARY/chats/send` with a subject | UI: Sales Nav lead page, Message, subject + body, Send. Check `memberBadges.openLink` first: Open Profile costs no credit | UNTESTED (UI only; no API shape recorded) |
| Reactions, comments, follows, profile-view counts | category only, never called | Not covered. Do these by hand if at all | n/a |
| Hosted auth / reconnect | `POST /auth/link` | The user signs in to their own browser. Never handle a password or 2FA | n/a |

## What the DIY path cannot give you

| Unipile provides | DIY reality | Workaround |
|---|---|---|
| Webhooks: `message.new`, `relation.new`, account status | Nothing pushes. You only learn by reading | Poll 2 to 4 times a day at uneven times: conversations list (1 call), Sales Nav inbox (1 call), connections newest first (1 to 2 calls). Unipile itself warns against fixed-interval polling |
| A hosted, always-on session | Works only while the user's browser is open and signed in; a sign-out or checkpoint stops everything | Run when the user is at the machine; a scheduled run drafts and reads only |
| Many accounts behind one API | One seat per browser profile | One workspace folder per seat (`--workspace`), never two seats in one profile |
| Rate-limit handling, 429 back-off, `cannot_resend_yet` | You see raw 429, 999, or a banner | Stop for the day on the first one; caps below stay under the published guidance |
| Cached GETs that do not count against limits | Every read is a real LinkedIn request | Read less: one page per poll, stop at known items |
| Stable, versioned endpoints | queryIds and decorations rotate | Re-read them from the page's own requests; mark a broken row and fall back to the UI |
| Programmatic send, queue, retries | No supported programmatic write | Every send is a human-approved UI click, one at a time, 30 to 90 s apart |

## Caps and their sources

Our defaults sit under every source. LinkedIn publishes that limits exist but not the numbers.

| Action | Our default | Source and kind |
|---|---|---|
| Connection requests | 20 a day, 100 per 7 days | LinkedIn Help ("weekly invitation limit", no number): documented that it exists. Unipile provider-limits page: paid accounts 80 to 100 a day and about 200 a week, free about 150 a week without a note: vendor guidance. "About 100 a week" is widely repeated: folklore. LiReach default 20 per 24h |
| Note length | 300 characters (free accounts: about 200, about 5 notes a month) | Unipile provider-limits page: vendor guidance; 300 is the UI's counter |
| Messages to connections | 20 follow-ups a day, 3 per person total | Unipile: 100 a day default for other routes; LiReach default 30 per 24h: vendor and operator guidance |
| Open Profile messages | 20 a day | LinkedIn caps free Open Profile messages at 800 a month per account (Unipile, vendor-reported); Unipile suggests 30 to 50 a day, randomly spaced |
| Paid InMail | Within the seat's credits (`salesApiCredits`) | LinkedIn: credits per plan, documented |
| Profiles opened | 80 a day, ceiling 150 | Unipile: about 100 profile reads a day, a recommendation; LiReach 80 per 24h; field reports of a lock after about 150 to 250 checks: folklore |
| Inbox / invitation polls | 4 a day | Unipile: first page only, a few times a day, randomly spaced |

New or long-idle accounts start at half these for the first two weeks (Unipile guidance). See also KB 05 for search
and list pacing.
