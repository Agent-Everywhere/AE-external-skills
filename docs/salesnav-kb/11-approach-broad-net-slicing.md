# 11 Approach B: broad net and slicing

Use when the ICP aligns with 1 to 3 well-labelled LinkedIn industries.

## Steps

1. Broad net: industry + geography + headcount ids, no keywords. Count it with `count.js` (`kind: account`).
2. Stratify into non-overlapping sub-nets under 1,000 (headcount bands, HQ states; `shard_plan.py`).
3. Sample each stratum across offsets, score into keep / drop / unsure, estimate = sum of count_i x rate_i. Report n, the
   range keep/n to (keep + unsure)/n and the estimate, labelled an estimate. A rate under 5 percent or over 95 percent
   is "under X" or "over X".
4. Optional keyword lanes as a priority tier: count each alone first; a noisy keyword swamps an OR list.
5. Pull and qualify only what the user asks for; a full pull is a list ask, not a count ask.

## When it does not fit: PureFlow

The own-label brands were not concentrated in one industry. Health, Wellness and Fitness alone is 141,512 raw accounts
(gyms and studios dominate); qualifying 1,000 of them costs about 20 calls (10 search calls at 100 rows plus 10 details
calls), so a single national industry net is days of cap for a handful of fits. Use approach A with tight keywords
instead.
