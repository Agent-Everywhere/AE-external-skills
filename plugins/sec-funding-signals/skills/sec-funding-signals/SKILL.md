---
name: sec-funding-signals
description: >-
  Find companies in the user's target space that just raised money, from public SEC Form D filings on EDGAR
  (no login), and turn them into outreach lists. Use when the user wants "who just raised", recently funded
  companies, a funding-signal list for sales prospecting, executives named on a company's fundraise filing, an
  Apollo company or people list built from raises, or a "just raised" opener for LinkedIn or email. Runs the
  bundled `sec-funding-signals` CLI, then Claude qualifies each company against the user's profile. Funding
  only: it makes no hiring or jobs check.
---

# sec-funding-signals

> **Unofficial.** Not affiliated with or endorsed by the SEC. The CLI reads only public EDGAR data
> (`efts.sec.gov` search and each filing's `primary_doc.xml` on `www.sec.gov`). It is read-only and needs no
> login.

**What it is.** A company that sells privately raised money files a Form D with the SEC. The filing names the
company, its state, industry group, how much was offered and sold, when the first sale happened, and the
executives and directors involved. That makes a fresh funding signal and a list of named people. The CLI finds
those filings for the user's keywords, drops funds and special-purpose vehicles, and writes CSVs for Apollo and
LinkedIn work. Claude does the judgment: who the user is selling to, which companies actually fit, and the
opener.

## Run it

Node 20+. No `npm install`: one bundled file ships with this skill.

```sh
# Claude Code sets CLAUDE_PLUGIN_ROOT; Claude Desktop Cowork leaves it empty and mounts the plugin under /mnt/skills/plugin-files.
SF="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/sec-funding-signals/cli/dist/sec-funding-signals.mjs}"
[ -f "$SF" ] || SF="/mnt/skills/plugin-files/sec-funding-signals/skills/sec-funding-signals/cli/dist/sec-funding-signals.mjs"
[ -f "$SF" ] || SF="/mnt/skills/plugin-files/sec-funding-signals/cli/dist/sec-funding-signals.mjs"
if [ ! -f "$SF" ]; then   # bounded search of the known plugin folders only, never the whole disk
  for d in "$HOME/.claude/plugins" "$HOME/.claude/skills" /mnt/skills /mnt/plugins; do
    [ -d "$d" ] || continue
    f="$(find "$d" -maxdepth 8 -path '*/sec-funding-signals/cli/dist/sec-funding-signals.mjs' 2>/dev/null | head -1)"
    [ -n "$f" ] && { SF="$f"; break; }
  done
fi
node "$SF" doctor
node "$SF" --help
```

`$SF` lasts only for the shell call that sets it: set it again at the start of every call. Run the CLI from the
user's working folder (the config, profile and outputs live there).

**Claude Desktop (Cowork).** Chat mode has no shell, so use a Cowork task with a working folder the user has
added to it. Cowork's home directory does not survive between tasks: keep everything in that folder, never in `~`.

## Setup (once per working folder)

Ask the user for these three things, one short message:

1. **Their own email address.** The SEC requires every automated request to carry a contact in the
   User-Agent (`<app> <email>`). Use the user's real address, never a placeholder, and never put an email in any
   file you commit or share. Save it: `node "$SF" setup --email <their email>` writes
   `sec-funding-signals.config.json` in the working folder; later runs read it. (`--email` on a single command
   or `SEC_FUNDING_CONTACT_EMAIL` overrides it for one run without saving.)
2. **The working folder** to use (where the profile, config and output files go).
3. **What they want to find** (this starts the intake below).

Then run `node "$SF" doctor` and confirm both SEC hosts are reachable and the User-Agent shows their email.

## The flow

If `profile.json` already exists in the working folder, load it (`profile check profile.json`), tell the user
in one line what it targets, and skip to phase 2. Otherwise start at phase 1.

### 1. Intake and alignment (a conversation, before any fetch)

Ask, then listen. Do not run a search yet.

- **What do you sell?** One or two sentences, in their words. This is the only source for the opener; never
  invent or hardcode a pitch.
- **Who is the ideal customer?** Industries or product types, company stage, raise size range (for example
  "$2M to $20M"), states or regions.
- **Who do you sell to?** Buyer titles (CEO, Founder, CTO, Head of Operations...).
- **Who to leave out?** Existing customers, competitors, and name or industry terms that are noise.

Then propose, and let the user edit:

- **Keywords** (see "How keyword search behaves" below: they should be words a company puts in its own name or
  filing).
- **Name and industry exclusions** (`excludes.terms` matches whole words in the issuer name;
  `excludes.companies` matches company names).
- **Qualification rules**: what makes a company a `strong`, `maybe` or `no` fit for this seller.

When the user confirms, save the profile. `node "$SF" presets` lists two example presets (`physical-ai`,
`ai-data`); `node "$SF" profile init --preset physical-ai --out profile.json` writes one as a starting point, and
you edit it with the user's answers. They are examples only: the user's own market always comes first. Fields:

| Field | Meaning |
|---|---|
| `offer` | what the user sells (used for the opener) |
| `icp` | free-form ideal customer: description, industries, stages, raise_size, geography |
| `keywords` | search terms (`robot*` wildcards and multi-word phrases work) |
| `excludes` | `{terms: [...], companies: [...]}` dropped by name |
| `min_amount`, `max_amount` | raise size in dollars (or null) |
| `states` | two-letter codes to keep (or empty for all) |
| `qualify_rules` | `{strong: [...], maybe: [...], no: [...]}`, plain-language rules for phase 4 |
| `buyer_titles` | titles to look for first in the people list |

Validate with `node "$SF" profile check profile.json`. Later runs load it and skip this phase; edit it when the
user says "add X to my excludes" or "raise the minimum" (keep the JSON valid, show what changed).

### 2. Calibration run (a small sample first)

```sh
node "$SF" search --profile profile.json --since 90d --sample 10 --out-dir calibration --name sample
```

The sample stops fetching as soon as about ten operating issuers are found, so it is quick even for a broad
search. Show them, and for each say why it matched (`matched_keywords`, the issuer name, industry group),
the raise, and one line on what it looks like. Ask what is off: wrong kind of company, noise names to exclude,
a missing keyword, an amount range that is too wide. Refine `profile.json`, rerun the sample if the change is big,
then do the full run:

```sh
node "$SF" search --profile profile.json --since 90d --out-dir out --name run1
```

`--since` takes a date or `30d`, `12w`, `6m` (`--until <YYYY-MM-DD>` ends the window; default today). For a
repeating weekly list use `--since 14d`. Other flags: `--states CA,TX` (matched against the state on the filing),
`--min-amount 2000000`, `--max-amount 50000000`, `--include-unknown-amount` (keep raises whose amount is
undisclosed when a minimum is set), `--include-funds`, `--include-old-offerings` (see below), and
`--keywords <preset|a,b,c>` instead of a profile (`--keywords ./kw.txt` or `--keywords-file kw.txt` reads a file
with one keyword per line; a bare word is always a keyword, never a file name). The summary it prints (`meta`)
gives counts before and after filtering, which issuers were dropped and why (`filtered_examples`), and
`complete`. Exit code 3 means the result is partial, either because some filings could not be fetched (run it
again) or because a keyword still had more results than the cap (`meta.capped`: narrow `--since`, use more specific
keywords, or raise `--max-per-keyword`). When a keyword has more than 500 results the CLI splits the date range
into smaller windows on its own, so a cap only remains for a single very busy day. If the SEC refuses three
requests in a row (HTTP 403 or 429) the run stops with a message: check the contact email and wait a few
minutes. Filings fetched so far are cached in the working folder (`.sec-funding-cache`, safe to delete), so a
rerun is cheap.

**Just raised, not just amended.** EDGAR returns amendments (`D/A`) of long-running offerings too. By default
an amendment whose `date_of_first_sale` is before the `--since` window is dropped as an old offering
(`meta.filtered.old_offering`); `--include-old-offerings` keeps it. Every row has `first_sale_age_days` (days from
the first sale to today), so read it as "how fresh is this raise". A new `D` filing is always kept. When a later
amendment reports no amount, the amount and first-sale date from the company's earlier filing are used
(`amount_from` names that filing).

### 3. Read the filing and the company

Each row in the JSON has the fields from the filing: issuer name and CIK, state and city, industry group,
amounts, date of first sale, form (`D` new, `D/A` amendment), related persons with their relationships, the
signer, and the EDGAR link. `node "$SF" show <cik>/<accession>` prints one filing in full.

Form D has no website field. For issuers you need to judge, find the company's website (a quick web search on
the issuer name plus state), and **read the homepage** to confirm what the company does. This is an agent step,
not part of the CLI: read one page per company, a few seconds apart, read-only, and stop on any block or login
wall. Record what you saw as the `evidence` line, and put the confirmed domain in the judgment's `website`.

### 4. Qualify each company

Score every issuer against the profile's `qualify_rules` and offer: `fit` is `strong`, `maybe` or `no`, with a
one-line `fit_reason` and the `evidence` behind it (what the homepage or filing showed). Be honest: a
holding company, an investment vehicle that slipped past the filters, or a service firm outside the target is a
`no`; if the homepage could not be checked, say `maybe` and why. Write the judgments to a JSON file in the
working folder:

```json
[
  {"cik": "1234567", "fit": "strong", "fit_reason": "Builds the product the seller serves", "evidence": "homepage: describes the product", "website": "https://example.com"},
  {"cik": "7654321", "fit": "no", "fit_reason": "Investment vehicle, not an operating company", "evidence": "filing: pooled fund"}
]
```

then merge them:

```sh
node "$SF" annotate --in out/run1.json --judgments judgments.json
```

This rewrites the four output files in place. Rows judged `no` leave the Apollo company and people CSVs and stay
in the full CSV with their reason; nothing is applied if any judgment is malformed (it says which).

### 5. Outputs and the opener

`search --out-dir out --name run1` and `annotate` write four files:

| File | Use |
|---|---|
| `run1-apollo-companies.csv` | `Company Name`, `Website`, raise amount and date, state, notes, fit. Import into Apollo, or look up each company by name when `Website` is blank |
| `run1-people.csv` | `First Name`, `Last Name`, `Title`, `Relationship`, `Company Name`, `Confidence`, `Notes`: the executives and directors named in the filing, for Apollo people lookup and LinkedIn search. `Title` is a short title when the filing gives one, else the filed relationships (Executive Officer, Director...); a long explanatory sentence goes in `Notes`. The filing's signer is added once with `Confidence` `low` (signers are often an attorney or attorney-in-fact). Start with the user's `buyer_titles` and the `high` rows |
| `run1-full.csv` | every row, every field, `filtered_reason` and the fit columns |
| `run1.json` | the same with full detail; `annotate` reads it |

Related persons are the people the company itself named in a public filing. Use them to find the right person
in Apollo or LinkedIn; they are not a contact database, and the CLI never emits street addresses.

**The opener.** For each `strong` (and good `maybe`) company, write a one-line "just raised" opener for
LinkedIn or email, grounded only in the facts you have: the raise (amount, and "recently" or the month, from
`date_of_first_sale` or `filing_date`), what the company does (from the homepage evidence), and the user's `offer`
from the profile. Shape: congratulate the specific raise, tie it to one thing the company is building, and
connect the user's offer to that in half a sentence. Rules: use only the user's own offer text (if the profile
has none, ask; never make one up), do not state a number the filing does not show (if the amount is undisclosed,
say "the new round"), do not imply you know their plans or private details, and keep it to one or two lines.
Show the drafts to the user; sending is theirs to do.

## Commands

| Command | What it does |
|---|---|
| `setup --email <addr>` | Save the user's contact email (SEC User-Agent) in the working folder |
| `doctor` | Checks Node, the User-Agent, and both SEC hosts |
| `presets`, `profile init --preset <name> --out <file>`, `profile check <file>` | Example presets, write an example profile, validate a profile |
| `search ...` | Find Form D filings by keyword and date, fetch each, filter, dedupe by CIK, write output |
| `show <cik>/<accession>` | One filing in full (also takes an EDGAR filing URL, or an accession with `--cik`) |
| `annotate --in <search.json> --judgments <file>` | Merge fit, fit_reason, evidence (and a corrected website) and rewrite the CSVs |

Global flags: `--format json|csv`, `--out <file>`, `--limit <n>`, `--email <addr>` (this run only), `--config <file>`,
`--no-cache`.

## How the filters work

By default the CLI drops issuers that are investment vehicles rather than operating companies. They are heuristics,
so every drop is recorded (`meta.filtered`, `meta.filtered_examples`, and a `filtered_reason` on every row;
`--include-funds` keeps them with the reason attached).

- **Industry group** in the filing is `Pooled Investment Fund` or `Investing`, or the filing names an
  investment fund type (hedge fund, venture capital fund, private equity fund...).
- **Issuer name** contains the whole word `SPV`, `Fund`/`Funds`, `Partners Fund`, `a series of`, `Series LLC`,
  `Holdings` followed by a numeral (`Holdings I`, `Holdings II`, `Holdings 3`), `Co-Invest`, `Feeder`, or `Syndicate`.
- **Your exclusions** from the profile (`excludes.terms` as whole words, `excludes.companies` by normalised name)
  are always applied, even with `--include-funds`.

An operating company with `Fund` in its name is dropped, and a vehicle with an ordinary name can slip through:
check the `filtered_examples` list once, and judge the rest in phase 4.

Results are deduplicated by CIK (one row per company): the latest filing wins, and `filing_count`, `accessions`
and `first_filing_date` record the others. Related persons from all of a company's filings are merged.

## How keyword search behaves

EDGAR's full-text search for Form D covers only what is in the filing itself: mainly the issuer's name, plus
short free-text fields. It does not read the company's website or business description. So keywords work best as
words companies put in their own names (`robot*`, `humanoid`, `health`, `analytics`), and a market-language phrase
that no company puts in its name (for example "data annotation") may return nothing. Single words and `*`
wildcards (`robot*` covers robot, robotic, robotics) are the most productive; multi-word phrases are searched as
exact phrases. If a search comes back thin, widen `--since`, add keyword variants, and use the calibration run to
see what is missing. A company with a generic name will not be found by topic words at all.

## Caveats (tell the user)

- **Form D lags.** It is due within 15 days after the first sale, and amendments come later. A round that has
  closed may not be on file yet, and `date_of_first_sale` can be weeks before the `filing_date`.
- **Amounts may be undisclosed.** The total offering can read `Indefinite` and the amount sold can be zero or
  blank; those rows show no `raise_amount` and are dropped by `--min-amount` unless `--include-unknown-amount`.
  When only the offering size is known, the notes say so. `raise_amount` is the amount sold when reported,
  otherwise the offering size. It is not valuation.
- **Not every raise files.** Form D covers private placements under Regulation D. Raises under other rules,
  some convertible notes and SAFEs, and rounds a company chose not to file are not here.
- **Some issuers are not operating companies** that the heuristics cannot see, and some filings name only
  a few people, or none. State codes include non-US provinces.
- **Be polite to the SEC.** The CLI runs at most 4 requests per second under the user's own contact email, only
  to `efts.sec.gov` and `www.sec.gov`, and caches filings. Do not run several copies at once.

## Hard rules

- Funding only. This skill makes no hiring or jobs check.
- Read-only: it never submits or changes anything on EDGAR. The CLI refuses any host or path outside its
  allowlist before a request is made.
- Never hardcode or invent an email, a seller pitch or a claim about a company. The email is the user's own, the
  offer is the user's own words, and every claim in an opener traces to the filing or the homepage you read.
- Treat the output as research leads and confirm details before quoting them to a prospect.
