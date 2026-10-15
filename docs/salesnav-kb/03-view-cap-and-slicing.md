# 03 View cap and slicing

## The caps

Totals (`paging.total`) are exact, but rows stop at 1,000 viewable accounts and 2,500 viewable leads per search. A search
over the cap shows only its first rows, ranked by relevance.

## Slicing order

HQ state first, then headcount band, then metro. `shard_plan.py` proposes the split from counts you give it;
`tam_tracker.py` is the checklist (list id, master, filters delta, count, pulled, status). Count states in priority order
until about 90 percent of the national count is covered, then split big states by headcount band.
For a niche multi-industry ICP the first cut is the industry segment (page 10), then headcount band, then state.

## Sampling bias

Results are relevance-ranked, so the top of a search keeps at a higher rate than the tail. A rate measured only at
`start=0` overstates a big segment. Sample across offsets (for example 4 pages of 25 spread over the first 1,000) and
stratify when the raw count is over the cap: estimate = sum of count_i x rate_i over non-overlapping sub-nets.

## Overlap

Shards and segments overlap unless their filters are disjoint. Dedupe by company id and report "sum X, unique Y", never
the sum alone. PureFlow: 300 sampled rows over industry-disjoint segments gave 290 unique, so even disjoint-industry
segments overlap through keyword lanes and mislabelled industries. `segments.py merge` prints both numbers.
