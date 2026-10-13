# Company Profile

Fill this in once and keep it in your working folder as `company-profile.md`. Every action reads
it, so it never has to ask you the same question twice. The list-building intake
(`references/build-list.md`, section 1) asks for exactly these sections, in one short batch.
Leave a field blank or write "skip" if you do not know yet. Do not put passwords, cookies or
personal data in this file. A filled generic example is `company-profile.example.md` next to this
file; copy it and change the answers.

**Outreach drafts use only what is written here.** Every claim about us in a message (what we
make, where, certifications, capacity, customers, results) must come from this file. Put real,
usable facts in section 1 and in "Facts we may state" below; anything not written here is never
claimed.

## 1. Offer

- **What we sell, and to whom, in one line:**
- **The next step we want from a prospect** (a reply, a call, a sample):
- **Facts we may state about ourselves** (one per line; only true, checkable, safe to say. Leave
  blank to say nothing beyond the offer line. Examples: a location, a certification we hold,
  a minimum order size. Never customer names unless you list them as usable references):

## 2. ICP (firmographics)

| Field | Answer |
|---|---|
| Industries / niches | |
| Company headcount bands | |
| Geography (and whether it means headquarters or the person's location) | |
| Company type (private, public, non-profit...) | |
| Growth or hiring signals that matter | |
| Fit tests: what must be true on the company website | |

## 3. Buyer types

Two or three kinds of buyer, each with a short tag used in file names and list names
(`<buyer-type>` in `<buyer-type> · <sub-list> · <yyyy-mm>`).

| Tag | Who they are | What we say to them |
|---|---|---|
| | | |

- **Not a buyer** (types that match the search but never buy, for example another maker of what we
  make). They stay in the master list and are dropped at qualify time, not at search time:

## 4. Decision-makers: titles by company size

| Company size | Titles / functions that buy | Seniority levels | Keep per account |
|---|---|---|---|
| Small (about 1–50) | | | 1–2 |
| Mid (about 51–500) | | | 1–3 |
| Larger (500+) | | | 1–3 |

Title words to exclude (for example intern, assistant, student):

## 5. Keywords

- **Company keywords** (Boolean `OR` lists, quoted phrases):
- **Title keywords:**
- **Noise words** (a keyword that also matches an unrelated industry, or mostly matches company
  names, so a NOT term or a smaller shard is needed; the build checks counts before using one):

## 6. Exclusions and do-not-contact

Applied to collected rows, not in the search query. Competitors are never excluded at search time.

- Customers (names or domains):
- Competitors:
- Industries / regions to skip:
- A do-not-contact file, if you have one (path):

## 7. Size goal

- **How many accounts / leads this run** (and any per-run cap on qualify or decision-maker work):

## 8. Tone and voice

- **How we sound** (three words, and one thing we never say):
- **Sign-off / name to write as:**
- **Language:**

## 9. Caps and permissions

Defaults are in the skill's guardrails; write here only what you want **lower**.

| Setting | Value |
|---|---|
| Search pages per day | default |
| Connection requests per day / per 7 days | default (20 / 100) |
| Follow-up messages per day | default (20) |
| People per account for the first touch (the others are queued) | 1 |
| Days to wait after someone accepts before a follow-up | 3 |
| Create Sales Nav lists without asking each time | no |
| Working hours (your time zone) | |

Sending is never covered by this file. The skill sends only when you ask it to, in a conversation,
and only for a batch you approve.

## 10. Where things live

- Working folder for CSVs, `results/`, `drafts/`, `outreach_log.csv`, `lists_log.csv`:
- Where finished lists go (CSV, Google Sheet, CRM):

The ordered sub-lists (state, region or headcount band) are an output, not an intake question: the
build records them here after counting, as a "Sub-list plan" table (`references/build-list.md`,
section 3).
