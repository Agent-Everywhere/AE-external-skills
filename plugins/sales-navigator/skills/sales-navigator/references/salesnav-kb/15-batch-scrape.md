# 15 Batch scrape

The tier between a list scrape (search rows) and a deep scrape (one account or profile page). Measured live 2026-10-14 on
a real seat (Acme run: 537 accounts, 517 contacts). The API is private; re-probe if a call starts returning 400.

Batch scrape is the in-page batch-get ("decoration") read: pass up to 100 ids taken from list or search rows and get back the
record a company or lead page would load, with no page opened.

| | Companies | People |
|---|---|---|
| Endpoint | `salesApiCompanies?ids=List(...)&decoration=...` | `salesApiProfiles?ids=List((profileId,authType,authToken),...)&decoration=...` |
| Snippet | `companies_details.js` | `profiles_batch.js` (`extras: true` for the long field list) |
| Max ids per call | **100** (101, 150, 200: HTTP 400) | **100** (101: HTTP 400) |
| Calls per 100 | 1 | 1 |
| Latency, size per 100 | 1.3 to 1.7 s, about 215 KB | 1.3 to 1.6 s, about 650 KB |
| Acme run | 537 accounts in 6 calls, 537 of 537 returned | 517 of 517 contact rows enriched in 6 calls (515 unique leads, every one returned) |
| Throttling | none: 0 x 429, no banner, 4 s pacing | same |

Pace 3 to 5 seconds between calls, none in parallel (page 05). Log each call as a small call.

## Strict decoration schema

The decoration is a field list. One unknown field name makes the **whole call 400**, not just that field. To test a field
you have not used before, probe it alone on a few ids, then add it to the list. Encode the whole decoration, parentheses
and commas included (the raw `*` stays); raw parentheses return 400.

## Company fields (fill rate of 537)

| Group | Fields |
|---|---|
| Identity | name 537, website 519, flagshipCompanyUrl 537, industry 537, type 533, yearFounded 420, location 531 |
| Text | description 537 (full text, never truncated), specialties 249 |
| Size | employeeCount 466, employeeDisplayCount 466, employeeCountRange 535, decisionMakersDisplayCount 537 |
| Growth | employeeGrowthPercentages: 6 months 479, 1 year 461, 2 years 421. The value 2147483647 means "new" (no prior base): `companies_details.js` returns it as `new` |
| Money | revenueRange min and max 423 |
| Address | headquarters line1 296, line2 108, city 513, state 476, postal 418, country 531 |
| Your seat | teamLinkConnectionsDisplayCount, sharedAlumniDisplayCount, crmOpportunities, account (saved, listCount), personaResultCounts (your saved personas such as CXO, Director+, custom, with counts): all 537 |
| Other | `employees*` (sample employee urns) also decorates |

Fill rates are the share of accounts that carry the field; a blank is the account not publishing it, not a failed call.

**Not available in batch** (each returned 400): phone, followerCount, funding, function or department headcount,
medianTenure, job openings, new hires. Median tenure and monthly headcount live in `salesApiEmployeeInsights/<id>`, which is
**one call per company**: that is the deep tier (`account.js`).

## People fields (fill rate of 517)

| Group | Fields |
|---|---|
| Identity | headline 517, location 516, degree 517, fullName 473 (out-of-network names are hidden), summary 329 (full text) |
| Experience | positions[] 517 (title, company, companyUrn, current, startedOn, endedOn, location, description): current title 517, current start and tenure 458, past positions 381 |
| Background | educations 406 (school, degree, field, dates), skills 417 (name, endorsements), languages 136, volunteering 84 |
| Reach | numOfConnections 517, numOfSharedConnections 178, memberBadges (premium, openLink, jobSeeker) 517, inmailRestriction 517 |
| Contact | contactInfo gives **websites only** (196): never an email or a phone |
| Seat | savedLead, listCount, flagshipProfileUrl: 517 |

`profiles_batch.js` requests the short set by default (headline, summary, location, positions). `extras: true` adds
educations, skills, languages, numOfConnections, memberBadges, inmailRestriction, degree and position `endedOn` and
`companyUrn` to the same single decoration, so the cost stays one call per 100. It never requests `contactInfo`: it holds no
email or phone, so there is nothing to gain.

## Does a profile batch count as a profile view?

Evidence says no; the Acme run read all 517 profiles this way.

1. Sales Nav's own bundle records a view as a separate client-side tracking event:
   `salesTrackingV2.trackProfileView` fires a `ProfileViewEvent` (view type `profile-view`, viewer and target ids). UI
   components fire it, for example when a lead view renders. The data fetch does not.
2. The profile data adapter is a plain record read (`/sales-api/salesApiProfiles/<id>`). Our batch GET carries only `ids` and
   `decoration`: no tracking id, no view params, and it never sends a `ProfileViewEvent`.
3. The admin usage report defines a profile view as a user hovering over or viewing a profile, counted from those tracking events.
4. Empirical: after the batch, the lead-search pages holding the 10 test leads still showed `viewed: false` for 10 of 10.

Caveat: there was **no positive control**. Every earlier row was also `false`, and the job forbade opening a profile to
calibrate, so this shows "no change seen", not "the flag would have moved".
Residual risk: LinkedIn may log decoration fetches server-side for abuse detection. Keep pacing and volume reasonable and
count a batch as a small call, not as profile views.

## Three tiers

| | List scrape (search rows) | Batch scrape (decoration batch-get) | Deep scrape (per entity) |
|---|---|---|---|
| Accounts | name, industry, headcount range and display count, short description, saved, listCount | adds website, full description, specialties, type, founded, HQ address, revenue range, growth 6m/1y/2y, decision-maker count, persona counts | adds median tenure, monthly headcount history, news and alerts (`account.js`, `salesApiEmployeeInsights`) |
| People | name, title, company, tenure at position and company, geo region, summary, degree, openLink, premium, saved, viewed | adds headline, full position history with dates, education, skills, languages, connections, InMail restriction, websites | adds the profile page UI: highlights, activity, warm intros; the page fires `ProfileViewEvent` |
| Calls per 100 | 1 (`count=100`) to 4 (`count=25`); capped at 2,500 viewable per search | **1** (max 100 ids) | 100 to 400 (1 to 4 requests per entity) |
| Quota risk | low (paced reads) | low (paced reads; not a profile view per the evidence above) | accounts: low; **people: a profile view each (strict quota)** |

## Recommendation

Use batch for qualifying (accounts: description, specialties, type, size, growth, revenue, HQ) and for enrichment (people:
headline, positions, education, skills). One paced call per 100 replaces up to 400 page-level requests, and people avoid the
strict profile-view quota. Reach for the deep tier only for what batch cannot return (median tenure, headcount history,
news; opened-profile UI), and then only for the few ids that need it.
