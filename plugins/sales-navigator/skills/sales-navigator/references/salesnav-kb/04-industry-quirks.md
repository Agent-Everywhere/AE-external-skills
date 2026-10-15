# 04 Industry quirks

LinkedIn industry is a company's self-label, not the buyer type. For Acme:

| Where the right companies sit | Where the wrong ones sit |
|---|---|
| Own-label supplement and wellness brands are scattered over Retail Health and Personal Care, Health Wellness and Fitness, Food and Beverage, Cosmetics, Alternative Medicine | Contract manufacturers and competitors sit in the generic "Manufacturing" industry (for example a contract manufacturer calibrated as a stand-in, and a competitor liquid-supplement maker) |

## Raw industry nets are noise

| Net | Raw count |
|---|---|
| Health, Wellness and Fitness, US, 2-200 employees | 141,512 (gyms, studios, coaches) |
| Food and Beverage, same filters | 62,152 |
| Manufacturing plus Pharma | 528,584 |

A raw count of an industry is a ceiling, not a TAM. Narrow with tight keywords per segment (page 10), then qualify by
reading each company's own description (page 20).

## Other quirks

- Niche terms resolve to nothing in typeahead: use the parent industry plus keywords.
- Headcount is LinkedIn's estimate: known brands can show 1-10, holding companies inflate. Never drop on headcount band
  alone.
- A stand-in used to calibrate can be wrong. Check its `companies_details.js` record before building a rubric on it
  (the Acme stand-in "Yellow Emperor" turned out to be a contract manufacturer: a drop signal, not a keep).
- Lead `REGION` is the person's location; account `REGION` is the headquarters.
