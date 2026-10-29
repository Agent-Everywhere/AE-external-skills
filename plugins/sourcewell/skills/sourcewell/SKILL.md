---
name: sourcewell
description: >-
  Research Sourcewell (the US cooperative-purchasing contract vehicle for public agencies) for public-sector
  prospecting, read-only, with the bundled `sourcewell` CLI. Use when the user wants to know who holds a
  Sourcewell contract and when it expires, which contracts expire soon, which RFPs are open or upcoming
  ("planned"), who bid on and won a past RFP, what categories a bid covers, which agencies (cities, school
  districts, counties, states) are Sourcewell members, or who will be re-bidding a category. Calls Sourcewell's
  public website data only; downloading bid documents needs the user's own portal login.
---

# sourcewell

> **Unofficial.** Not affiliated with or endorsed by Sourcewell. `sourcewell` reads public pages and data
> endpoints that may change without notice. It is read-only: it never registers for a bid, submits, asks a
> question or changes anything on the portal.

**What it is.** Sourcewell awards cooperative contracts that thousands of public agencies buy from. For a
seller, that makes three things useful: who already holds a contract in a category and when it ends (a
re-bid window), which solicitations are open or coming, and which agencies are members. The CLI turns the
public data into JSON or CSV.

## Run it

Node 20+. No `npm install`: one bundled file ships with this skill.

```sh
SW="<skill-dir>/cli/dist/sourcewell.mjs"   # <skill-dir> = the folder holding this SKILL.md
node "$SW" doctor                           # reachability of the data API and the bid portal: run this first
node "$SW" --help
```

Global flags: `--format json|csv` (default json), `--out <file>`, `--limit <n>`, `--full` (long text
fields), `--no-cache`. JSON output is `{count, meta?, rows}`. Requests are limited to 2 per second, retried
with backoff on 429/5xx, and cached for 24 hours in `~/.cache/sourcewell` (bid lists: 1 hour). Use
`--no-cache` when freshness matters.

## Commands

| Command | What it does |
|---|---|
| `contracts search --q <text> [--field description\|keywords\|title\|number\|brand] [--expiring-within <months>]` | Contract holders matching text (default: description, keywords and title), or contracts ending within N months. Rows: contract number, vendor, end date, description, keywords |
| `contracts vendor <name>` | Every contract a vendor or brand holds, with end dates |
| `solicitations list [--open] [--status Open\|Pending\|Awarded]` | Solicitations from the public data API: `Open` = accepting bids, `Pending` = announced, `Awarded` = done |
| `bids list [--status open\|planned\|closed\|awarded\|archived\|all] [--q <keywords>]` | Bids from the procurement portal: number, name, status, closing date, days left, plan takers, documents, addendums. `planned` shows upcoming RFPs with their estimated publish date |
| `bids detail <tenderId\|rfp-number>` | One bid's closing date, question deadline, description and NAICS category lines |
| `awards --year YYYY [--rfp <number>]` | Contract awards report: per RFP, every bidder and every awardee |
| `rebid <rfp-or-contract-number>` | For an RFP or contract, the current contract holders in that category with end dates, plus the prior RFP's awardees |
| `agencies list [--state XX] [--type <text>]` | Participating agencies: name, state, city, type, sub-type, member status, website, member number |
| `categories list`, `states list` | The category and state vocabularies |
| `docs download <tenderId\|rfp-number> --out <dir>` | Saves a bid's document ZIP. Needs the user's own portal login (see below) |
| `watch init --out <file>` / `watch run --config <file> --state-dir <dir> [--format md\|json] [--out <file>]` | Daily alerts: new matching bids, status changes, closing soon, addenda, awards, expiring and competitor contracts (see "Daily watch / alerts") |
| `doctor` | Checks Node, the data API and the portal |

## Example flows

**Who holds contract X and when does it expire?**

```sh
node "$SW" contracts search --q 011723-JDC --field number
node "$SW" contracts vendor "John Deere"
node "$SW" contracts search --q "construction equipment" --field description --format csv --out holders.csv
```

**Which contracts come up for re-bid soon?** (the prospecting list)

```sh
node "$SW" contracts search --expiring-within 6 --format csv --out expiring.csv
node "$SW" contracts search --q "scoreboards" --expiring-within 12
```

**Open bids in my category**

```sh
node "$SW" bids list --status open --q construction
node "$SW" bids detail 110326                 # closing date, question deadline, NAICS lines
node "$SW" solicitations list --open
```

**What is coming next?** (`planned` = upcoming RFPs, the earliest pipeline signal)

```sh
node "$SW" bids list --status planned
```

Rows show `planned_issue` (the estimated publish date) and `days_to_issue`; there is no closing date yet and
the number is `TBD`. Check it again later, since dates move.

**Who will be re-bidding, and who won last time?**

```sh
node "$SW" rebid 110326
node "$SW" awards --year 2023 --rfp 011723    # every bidder and every awardee of the prior RFP
```

`rebid` matches current holders on words from the solicitation title in contract descriptions and keywords,
so it can include loosely related contracts. Read each row's `description` and `matched_terms` before using
it; `meta.prior_awards` names the earlier RFP and who won it. The awards report uses legal entity names
("John Deere Shared Services LLC"), the contract list uses brand names: match them by eye.

**Agencies in Utah**

```sh
node "$SW" agencies list --state UT --format csv --out utah-agencies.csv
node "$SW" agencies list --state UT --type "K-12"
```

The full agency list is very large, so `agencies list` needs `--state` and/or `--type` (or `--limit`).
`member_status` is blank for many agencies.

## Daily watch / alerts

`watch run` pulls open and planned bids (plus recently closed/awarded), the awards reports and the contracts
you care about, diffs them against the previous run, and prints a short digest of what changed. It reuses the
read-only commands above: no new endpoints.

**Set it up.** `watch init` writes an example config (a work-truck upfitter: edit it to the user's business).

```sh
node "$SW" watch init --out ~/sourcewell-watch.json     # refuses to overwrite an existing file
```

The user edits the lists themselves, or asks Claude "add X to my Sourcewell watch" / "stop alerting on Y"
(edit the JSON, keep it valid, show what changed). Fields: `profile` (a label), `keywords` (bid match),
`exclude_keywords` (drops a match; whole words, so "bus" does not hit "business"; checked against bid name + description, and against a contract's description only, not its keywords or vendor), `contract_keywords` (contracts to follow), `competitor_brands`,
`closing_soon_days` (default 14), `contract_expiring_months` (default 18), `award_years` (default this year and
last). Matching is a case-insensitive substring on bid name + description, or contract description + keywords +
vendor; competitor brands match whole words in the vendor name. Changing keywords means the next run also reports
bids that newly match.

**Run it.**

```sh
node "$SW" watch run --config ~/sourcewell-watch.json --state-dir ~/.sourcewell-watch --format md --out ~/sourcewell-digest.md
```

The first run has no earlier snapshot, so it prints a "Current landscape" baseline (`baseline: true` in JSON)
instead of a diff. After that it reports only what changed: `NEW_BID`, `STATUS_CHANGE` (planned to open, open to
closed, closed to awarded), `CLOSING_SOON` (once at the threshold, once more in the final 3 days), `ADDENDUM`,
`PLAN_TAKERS_JUMP`, `NEW_AWARD`, `CONTRACT_EXPIRING` (once, on first crossing: an upcoming re-bid) and
`COMPETITOR_CONTRACT`, or "Nothing new today". `--format json` gives `{date, baseline, changes, summary}`.
State is `snapshot-YYYY-MM-DD.json` (last 30) and `latest.json` in `--state-dir`. If any fetch fails the command
exits non-zero and leaves `latest.json` untouched, so a partial pull is never recorded; run it again.

**Schedule it daily.** Either a Claude Code scheduled task (`/schedule`, e.g. weekday mornings: "run the
sourcewell watch and show me the digest"), or plain cron/launchd running
`node <skill-dir>/cli/dist/sourcewell.mjs watch run --config ~/sourcewell-watch.json --state-dir ~/.sourcewell-watch --format md --out ~/sourcewell-digest.md --no-cache`.
Use `--no-cache` for scheduled runs so awards and contracts are not a day stale.

**When Claude runs it,** present the digest as is (headline counts first), then suggest next actions per item:
for a `NEW_BID`, `bids detail <number>` and, if the user has a portal login, `docs download`; for a
`CONTRACT_EXPIRING`, `rebid <contract-number>` and `awards --year` to see who held it and who bid last time;
for `NEW_AWARD`, who won, and whether a competitor did; for `CLOSING_SOON` or `ADDENDUM`, whether the user has
read the latest addenda. Do not add an alert the digest did not report.

## Bid documents (needs the user's own login)

Documents (the RFP, addenda, a summary sheet) sit behind a portal login. The user must have their own account
on the Sourcewell procurement portal, and the skill never creates one. Credentials come only from the
environment, or the password on stdin: never a flag, never printed, never cached, and held in memory for the
one command.

```sh
export SOURCEWELL_USER="you@example.com"
printf '%s' "$PW" | node "$SW" docs download 110326 --out ./rfp-docs --password-stdin
# or: export SOURCEWELL_PASSWORD=... and drop --password-stdin
```

Ask the user to set the environment variables themselves; do not ask them to paste a password into chat and
do not read stored credentials on their behalf. If they would rather not, tell them to open the bid in their
own signed-in browser (`bids detail` prints the link). Without a login the command exits with an error and
makes no request.

## Hard rules

- Read-only. The CLI calls only an allowlist of public data resources and portal pages; anything else is
  refused in code before a request is made. It never calls a register, terms, submit-a-bid or ask-a-question
  route.
- Do not try to widen the data it reads. If the user wants something the commands do not return, say so.
- Treat the output as research leads: contract end dates and categories come from Sourcewell's published
  data and can lag the real state. Confirm before quoting a date to a prospect.
- The bid portal and data endpoints are Sourcewell's, not ours: keep to the built-in rate limit and cache.

## Troubleshooting

- `doctor` fails on "bid portal": the portal is down or the page layout changed. The error says which
  (`portal page changed: ...`); the data-API commands still work.
- Zero rows: loosen `--q`, try `--field keywords`, or drop `--field`.
- `docs download` says the login was not accepted: the user should check the variables and sign in once in
  their own browser (the portal may ask for a password reset or email verification).
