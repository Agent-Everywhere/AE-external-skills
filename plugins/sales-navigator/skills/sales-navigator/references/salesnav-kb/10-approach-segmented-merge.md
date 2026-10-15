# 10 Approach A: segmented merge

Use when the ICP is niche and its companies are spread over many LinkedIn industries (Acme: own-label supplement and
wellness brands labelled retail, wellness, food, cosmetics, alternative medicine, pharma).

## Steps

1. Define 4 to 6 industry-disjoint segments, each a resolved industry id set plus tight keywords (`segments.json`).
2. Count each segment (raw, and with keywords); `segments.py plan --kind count` makes the plan, 6 queries per call.
3. Split any segment over 1,000: headcount band first, then state. Use `parts` in `segments.json`.
4. Sample 50 to 100 rows per segment across offsets; score with ONE shared rubric (page 20); calibrate on 10 spread rows
   with the user.
5. Pull each segment under 1,000: `segments.py plan --kind pull --counts <counts>` (25 rows a page, `max_rows` for a
   deliberate partial pull), then `companies_details.js` over the ids.
6. `segments.py merge --pulls r1.jsonl r2.jsonl --out merged.csv`: unique by company id, `segment` pipe-joined. Report
   "sum X, unique Y". Optional: save the keeps to one account list (page 14).

## Acme segments (US, 2-200 employees)

| Segment | Raw count | Notes |
|---|---|---|
| S1 retail health (1359) | 313 | pulled whole |
| S2 HWF (3207) | 1,240 | over the cap: B 1,020 and C+D 234, split by headcount |
| S3 food and beverage | 283 | pulled whole |
| S4 topicals | 780 | not pulled in run 1 |
| S5 alternative medicine | 542 | not pulled in run 1 |
| S6 pharma and manufacturing | 996 | not pulled in run 1 |

Industry ids per segment: page 02.

Sum of raw counts 4,154; segments are industry-disjoint, so overlap comes only from keyword lanes and relabelled
companies.

## Run 1

Pulled S1 + S3 + S2 CD + the first 600 of S2 B: 1,430 unique accounts. Regex pre-score kept 574; the judgment pass over
the keeps left 362 (saved to the list "Acme TAM 500 - 2026-10-14"). The first 600 of S2 B is a relevance-ranked
sample, so its keep rate is biased upward (page 03).

## Run 2

Pulled S5 (542), S2 B rows 600 to 1,020 and S4 (780): 1,696 new unique accounts. Regex kept 433; judgment kept 175
(S4 topicals and S5 alt-med are mostly drops: clinics, cosmetics, practitioners). Final: 537 accounts, tier 1 95 / tier 2
442, all in the one list. S6 (pharma manufacturing) was not pulled: it is mostly contract manufacturers.

## Gaps this approach exposed

- The tracker has one master per list: several segments need one tracker master per segment, or one master of record
  as a saved list (page 14).
- A segment planner was missing: now `segments.py`.
