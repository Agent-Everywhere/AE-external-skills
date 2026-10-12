# Guardrails — Sales Nav through a cloud browser

The seat belongs to the user. A restricted LinkedIn account costs them far more than a slower
list. When in doubt, go slower and ask.

LinkedIn does not publish its limits and changes them. The numbers below are **conservative
operating defaults**, not LinkedIn's thresholds. Users may lower them; raise them only with the
user's explicit go, and never past the "hard ceiling" column.

## Daily volume defaults (per seat, per day)

| Action | Default | Hard ceiling | Notes |
|---|---|---|---|
| Search result pages read | 40 (≈1,000 rows) | 80 | 25 rows/page; spread across the day for big runs |
| Individual profiles opened | 80 | 150 | Only when the row lacks a needed field |
| Account pages opened | 60 | 120 | Mode B/C research |
| Saved searches created | 10 | 25 | |
| Concurrent browsers on this seat | 1 | 1 | Never two sessions on one LinkedIn login |
| Active hours | user's local business hours | — | No overnight marathons |

Viewable results per search are capped by Sales Nav (≈2,500). Shard instead of paging past it.

## Pace

- A few seconds between page loads, randomized; a longer pause (30–90s) every ~5 pages.
- Scroll the page to load results before reading, like a person.
- No parallel tabs hammering searches.

## Stop immediately and tell the user if you see

- A captcha, "unusual activity", "we've restricted your account", or a security checkpoint.
- A "commercial use limit" / "you've reached the limit" banner.
- Being signed out mid-run, or a page asking for a password or code.
- Results suddenly empty or the same page repeating (soft throttling).

On any of these: stop the run, save what you have, report the exact message (no screenshots of
private data), and recommend waiting at least 24h. **Never retry, refresh-loop, or work around it.**

## Data handling

- Collect only professional fields needed for the list (see `output.md`).
- No personal emails, phone numbers, or private details from profiles.
- Keep results where the user asked (their file/sheet/CRM). Don't paste whole lists into
  unrelated tools.
- Respect the user's exclusions and any "do not contact" list on every run.

## Browser hygiene

- Use the saved profile; close the browser session as soon as the run ends (it is billed).
- If the workspace reports a concurrency or billing limit, stop and ask.
- The user signs in themselves via the sign-in browser. Never handle passwords or 2FA.

## Outreach is out of scope

This skill is read-only. Sending invites or messages belongs to the outreach skill, which has
its own (stricter) weekly limits and requires CRM dedupe first.
