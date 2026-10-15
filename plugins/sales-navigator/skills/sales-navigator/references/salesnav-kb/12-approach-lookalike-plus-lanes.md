# 12 Approach C: lookalike plus keyword lanes

Use when the user has real customers to calibrate from.

## Calibrate

1. Resolve each example customer to a company id: `typeahead.js` for the name; nothing found: `account_search.js` with
   the name as keywords and `count` 5. Never invent an id.
2. `companies_details.js` on them: industry, headcount, description, specialties. Their industry ids seed the net; their
   words seed the rubric's keep signals; bad fits seed the drop signals. Say which example each came from.
3. Verify a stand-in before trusting it (page 04).

## Keyword lanes

Count a keyword alone, and inside versus outside the segment industries. Promote a lane to its own segment when its
outside-segment remainder is large and clean. Acme lanes (total / inside the segment industries):

| Lane | Total | Inside segments |
|---|---|---|
| tincture | 716 | 482 |
| liquid supplement | 36 | 29 |
| wellness shot | 66 | 28 |
| liquid vitamin | 18 | 11 |
| syrup | 27 | 17 |
| Amazon / DTC supplement | 124 | 57 |

Small lanes stay a priority tier inside their segments; the outside remainder of tincture (234) and Amazon/DTC (67) is
what a lane segment would add (not measured in the Acme run).
