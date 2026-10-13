---
name: salesnav-outreach
description: >-
  Daily outreach from the user's LinkedIn Sales Navigator seat with a ledger: connection requests,
  InMails, messages and follow-ups, drafted with a sources column, sent only after the user types
  approval of the exact batch, and capped by the outreach ledger. Use for "draft today's connection
  notes", "send the approved batch", "who accepted", "write follow-ups". Drafts by default.
---

# Sales Nav outreach

**Job.** Run the daily touch loop safely: pick people, draft true and sourced messages, get the user's
typed approval, send one person at a time through the ledger, and record who accepted or replied.

**Use when** the user wants connection notes, InMails, messages or follow-ups drafted or sent, or wants
to know where outreach stands. Drafting is the default; sending only on approval.

## Flow (adapt to the ask)

1. `python3 scripts/workspace.py locate`, then `python3 scripts/run_log.py quota` for the one-line state
   (calls, invites, week). Read `company-profile.md` (`templates/company-profile.md` is the shape): seller
   facts, tone, days before a follow-up. No profile: propose a filled one, let the user correct by number.
2. Pick leads from the user's `leads.csv`. Drop anyone `scripts/outreach_log.py check` reports as
   contacted (exit 3), `pending_invitation=yes`, the do-not-contact list, and 1st-degree people
   (already connected). Re-read a person's row with `page/lead_search.js` when degree or pending is blank.
3. Draft into `drafts/<date>.csv` using `templates/drafts.csv` (lead_id, full_name, company_name, kind,
   text, char_count, sources). Connection notes are 300 characters or fewer, counted. Each draft names one
   true thing about the person and one reason for writing; every claim's source goes in `sources`, and a
   claim without one is cut. Out-of-network (3rd degree) people need an InMail, which may use a credit.
4. `python3 scripts/validate_csv.py drafts/<date>.csv --kind drafts`, then show the exact texts. Send nothing.
5. To send: run `outreach_log.py caps --for connection`; exit 2 means stop for the day. Show the exact
   batch (people, kind, text) and wait for the user's typed approval. For each person, one at a time:
   `outreach_log.py add --pending`, click in the Sales Nav UI, verify, then `outreach_log.py status --status
   sent`, then a random 30 to 90 second gap. A changed text or kind is a new batch.
6. Follow-ups: `outreach_log.py summary --stale-days N` lists who accepted and has not replied. Record
   `accepted`, `replied` or `withdrawn` with `status`. Draft a short follow-up that refers to the earlier
   note and adds one new true thing; log a sent one with `outreach_log.py followup`.
7. End with `run_log.py quota` and report sent, skipped (and why), and what is next.

## Hard rules

- A send needs the user's typed approval of the exact batch. A question-card default, timeout, silence or
  auto-approve mode is never approval. Never send from a schedule: a scheduled task drafts only.
- Caps: 20 connection requests a day, 100 per 7 days, 20 follow-ups a day, 3 messages to one person; InMails
  only within the seat's credits. Never raise a cap without the user's explicit go.
- Never invent claims: seller facts come from the company profile, prospect facts from the row's data.
- Stop on any LinkedIn warning, captcha or limit banner, and on `outreach_log.py` exit 4 (missing
  ledger: ask the user, never start a fresh one). Never retry a send with an unknown result.

## Tools and details

`page/csrf_ready.js`, `page/lead_search.js`, `page/profile.js`, `page/activity.js` (research one lead before
drafting: 1 small call each); `scripts/outreach_log.py`, `scripts/run_log.py`,
`scripts/workspace.py`, `scripts/validate_csv.py`; `templates/drafts.csv`, `templates/company-profile.md`.
Run a snippet: `python3 runtime/session.py --emit lead_search.js --params '{...}' --compact`. Caps, pacing,
pending and degree rules: `reference.md`.
