# Company Profile (EXAMPLE, fictional)

A filled-in example for a made-up company, "Brightwell Labs", a contract manufacturer of liquid
supplements. Copy this file to your working folder as `company-profile.md`, replace every answer
with your own, and delete what does not apply. Nothing here is real: the company, its facts and
its numbers are invented to show the level of detail that works.

**Never use the facts in this example in a draft or a message.** Section 1's facts are
placeholders, not claims. Outreach refuses seller claims from a profile whose title still says
`EXAMPLE`, so replace the title and every fact with your own true ones.

## 1. Offer

- **What we sell, and to whom, in one line:** Contract manufacturing of liquid supplements
  (tinctures, shots, syrups) for brands that sell them but do not make them.
- **The next step we want from a prospect** (a reply, a call, a sample): A 20-minute call, or a
  sample of a liquid format they do not have yet.
- **Facts we may state about ourselves** (one per line; only true, checkable, safe to say):
  - <EXAMPLE ONLY: what you make, for example "We make liquid supplements: tinctures, shots, syrups">
  - <EXAMPLE ONLY: your real minimum order, for example "Minimum order is N units per flavor">
  - <EXAMPLE ONLY: your real lead time, for example "Typical lead time is N weeks">
  - <EXAMPLE ONLY: your real services, for example "Private label and custom formulas">

## 2. ICP (firmographics)

| Field | Answer |
|---|---|
| Industries / niches | Dietary supplements, nutrition, wellness, sports nutrition, functional beverages |
| Company headcount bands | 11-50 and 51-200 (skip 1-10 and 501+) |
| Geography (and whether it means headquarters or the person's location) | United States, headquarters |
| Company type (private, public, non-profit...) | Private brands |
| Growth or hiring signals that matter | Hiring in product development or operations; headcount up over the last 12 months |
| Fit tests: what must be true on the company website | Sells its own branded supplements; has capsules, powders or gummies but few or no liquids |

## 3. Buyer types

| Tag | Who they are | What we say to them |
|---|---|---|
| add-liquids | Supplement brands that sell capsules, powders or gummies and no liquids | Add a liquid format to your line without buying equipment |
| switch-maker | Brands that already sell liquids made by someone else | A second source or a better minimum order |

- **Not a buyer** (types that match the search but never buy, for example another maker of what we
  make). They stay in the master list and are dropped at qualify time, not at search time:
  other contract manufacturers and private-label factories; ingredient suppliers; retailers that
  only resell other brands.

## 4. Decision-makers: titles by company size

| Company size | Titles / functions that buy | Seniority levels | Keep per account |
|---|---|---|---|
| Small (about 1–50) | Founder, CEO, Owner | Owner, CXO | 1–2 |
| Mid (about 51–500) | Head of Product Development, VP Operations, Head of Supply Chain | Director, VP | 1–3 |
| Larger (500+) | VP or Director of Product Development or Sourcing | VP, Director | 1–3 |

Title words to exclude (for example intern, assistant, student): intern, assistant, student, junior

## 5. Keywords

- **Company keywords** (Boolean `OR` lists, quoted phrases): supplement OR vitamin OR nutraceutical OR "sports nutrition" OR tincture
- **Title keywords:** product development OR operations OR sourcing OR founder
- **Noise words** (a keyword that also matches an unrelated industry, or mostly matches company
  names, so a NOT term or a smaller shard is needed; the build checks counts before using one):
  wellness (matches spas and gyms), health (matches clinics and insurers)

## 6. Exclusions and do-not-contact

Applied to collected rows, not in the search query. Competitors are never excluded at search time.

- Customers (names or domains): examplebrand-one.com, examplebrand-two.com
- Competitors: other contract manufacturers (dropped at qualify time)
- Industries / regions to skip: pharmaceuticals, medical devices
- A do-not-contact file, if you have one (path): do-not-contact.csv

## 7. Size goal

- **How many accounts / leads this run** (and any per-run cap on qualify or decision-maker work):
  300 accounts; qualify all from search data first, read websites for at most 40 unsure rows.

## 8. Tone and voice

- **How we sound** (three words, and one thing we never say): plain, specific, short. Never say
  "revolutionary" or "world-class".
- **Sign-off / name to write as:** Sam, Brightwell Labs
- **Language:** English

## 9. Caps and permissions

Defaults are in the skill's guardrails; write here only what you want **lower**.

| Setting | Value |
|---|---|
| Search pages per day | default |
| Connection requests per day / per 7 days | 10 / 50 |
| Follow-up messages per day | default (20) |
| People per account for the first touch (the others are queued) | 1 |
| Days to wait after someone accepts before a follow-up | 3 |
| Create Sales Nav lists without asking each time | no |
| Working hours (your time zone) | 9:00 to 17:00 US Eastern |

Sending is never covered by this file. The skill sends only when you ask it to, in a conversation,
and only for a batch you approve.

## 10. Where things live

- **workspace:** ~/Claude/sales-navigator
- **Outreach started:** (blank: nothing sent yet)
- Other working files (`lists_log.csv` and so on): in the workspace, under `lists/`
- Where finished lists go (CSV, Google Sheet, CRM): CSV files in the folder
