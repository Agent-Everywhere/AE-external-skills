# US geography ids (`REGION` filter)

Sales Navigator geography ids for the United States and its states, for sharding a search by HQ
state (`references/filters.md`, "Sharding under the cap"). Use them as
`(type:REGION,values:List((id:<id>,selectionType:INCLUDED)))`.

**United States (country): `103644278`.** Arizona is `106032500`.

The ids below were read off live Sales Navigator requests. Geo ids are stable, but check one with
a `count=1` call the first time you use it on a seat; a wrong id returns a small or zero count, not
an error. A state marked **resolve once** has no id recorded here yet.

## Resolve a missing state once (one call)

Run `page/typeahead.js` with `type=BING_GEO` and the state name; take the entry whose
`displayValue` is the state itself ("Idaho, United States"), not a city or county inside it:

```
{"type": "BING_GEO", "term": "Idaho"}
```

Several names are one tool call: `{"type": "BING_GEO", "terms": ["Idaho", "Maine", "Vermont"]}`
(the snippet paces the terms itself; each term counts as a small API call in `guardrails.md`). An
empty `elements` list means no such value: try "Idaho, United States". Then **write the id into
this table** (or the user's working copy) so the next run does not look it up again.

## Which states to count, and when to stop

Counting every state is 51 small calls, most of a day's small-call budget, and rarely needed.

1. Count the **master search** once, nationwide, with `count=1`. If it fits under the cap
   (2,500 leads, 1,000 accounts) there is nothing to shard.
2. Otherwise count states **in priority order**: the states where the user's buyers are densest or
   that they care about most first (the Company Profile's geography), then the largest states by
   population. Record each count.
3. **Stop when coverage is good**: when the states counted add up to about 90 percent or more of
   the nationwide master count, or the size goal is already met. Leave the rest for a later run,
   or as one remainder shard (the nationwide search with the counted states as `EXCLUDED` regions)
   if that remainder fits under the cap.
4. A state still over the cap splits by headcount band, then metro (`filters.md`).

| State | Code | Geo id |
|---|---|---|
| Alabama | AL | 102240587 |
| Alaska | AK | resolve once |
| Arizona | AZ | 106032500 |
| Arkansas | AR | resolve once |
| California | CA | 102095887 |
| Colorado | CO | 105763813 |
| Connecticut | CT | 106914527 |
| Delaware | DE | resolve once |
| District of Columbia | DC | resolve once |
| Florida | FL | 101318387 |
| Georgia | GA | 103950076 |
| Hawaii | HI | resolve once |
| Idaho | ID | resolve once |
| Illinois | IL | 101949407 |
| Indiana | IN | 103336534 |
| Iowa | IA | resolve once |
| Kansas | KS | 104403803 |
| Kentucky | KY | 106470801 |
| Louisiana | LA | 101822552 |
| Maine | ME | resolve once |
| Maryland | MD | 100809221 |
| Massachusetts | MA | 101098412 |
| Michigan | MI | 103051080 |
| Minnesota | MN | 103411167 |
| Mississippi | MS | resolve once |
| Missouri | MO | 101486475 |
| Montana | MT | resolve once |
| Nebraska | NE | resolve once |
| Nevada | NV | 101690912 |
| New Hampshire | NH | resolve once |
| New Jersey | NJ | 101651951 |
| New Mexico | NM | resolve once |
| New York | NY | 105080838 |
| North Carolina | NC | 103255397 |
| North Dakota | ND | resolve once |
| Ohio | OH | 106981407 |
| Oklahoma | OK | 101343299 |
| Oregon | OR | 101685541 |
| Pennsylvania | PA | 102986501 |
| Rhode Island | RI | resolve once |
| South Carolina | SC | 102687171 |
| South Dakota | SD | resolve once |
| Tennessee | TN | 104629187 |
| Texas | TX | 102748797 |
| Utah | UT | 104102239 |
| Vermont | VT | resolve once |
| Virginia | VA | 101630962 |
| Washington | WA | 103977389 |
| West Virginia | WV | resolve once |
| Wisconsin | WI | 104454774 |
| Wyoming | WY | resolve once |
