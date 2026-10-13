# Example flows

Examples to adapt, not procedures. Do only what the user asked, say what it will cost in calls, and
stop with a short result and two or three suggestions.

## 1. Set up a profile (one or two turns, no LinkedIn calls)

Take the user's one-line description of what they sell and to whom. Fill `templates/company-profile.md`
yourself (offer, ICP, buyer types, "not a buyer" types, titles by size, keywords, tone, size goal 25),
show it as a numbered list, and ask only "Confirm, or correct by number." A guessed profile grants no
permissions: list creation and sending stay off until the user says yes. Save it in the workspace
(`workspace.py init`). The example profile shows the detail level; its seller facts are placeholders.

## 2. Size a market (counts only)

`typeahead.js` for geography and industry ids, then `count.js` with `queries` for the master search and
each keyword alone. Over the cap? Count states in priority order until about 90 percent of the national
count is covered, then split big states by headcount band (`shard_plan.py`). Report the counts, the sum as
an estimate (shards overlap) and the small calls used (`run_log.py add --small-calls N`, then `quota`).
Pull no rows.

## 3. Account-first list, qualify, decision-makers

1. Pull a 50-row sample (two pages) of the master search; read it with the user and fix keywords first.
2. Collect shard by shard with `account_search.js`, saving each page under `results/<shard>/`, then
   `salesnav_rows.py accounts ...` and `dedupe.py` across shards.
3. Qualify from search data into `facts`, `fit_reason`, `keep`; calibrate on 10 rows spread across the
   list. Fetch websites (`companies_websites.js`) only for `unsure` rows, ten at a time, after asking
   about Cowork's per-site prompts once.
4. For `keep` accounts, one `lead_search.js` per company with seniority plus title or function; keep 1
   to 3 people. `salesnav_rows.py leads ...`.
5. Report counts, five sample rows, what was dropped and why, and the file paths.

## 4. Draft first-touch notes with a sources column

Pick qualified leads, one per account. `outreach_log.py check` drops anyone already contacted;
also drop pending invitations and the do-not-contact list. Connection note (300 characters or fewer,
counted) for 2nd degree, InMail for people you cannot connect with. Each draft names one true thing
about them and one reason for writing; list every claim's source in `sources` and cut any claim without
one. Write `drafts/<date>.csv` from `templates/drafts.csv`, run `validate_csv.py`, show the exact texts,
send nothing. If the user then asks to send: show the exact batch, wait for their typed approval, click
in the Sales Nav UI one person at a time (`add --pending`, verify, `status --status sent`, then a
random 30 to 90 second gap), and stop at any warning or cap.

## 5. Follow-ups

`outreach_log.py summary` lists open people. Read the sent-invitations and inbox views (not each
profile) and record `accepted`, `replied` or `withdrawn` with `status`. For people who accepted
longer ago than the profile's wait (`summary --stale-days N`), draft a short follow-up that refers to
the earlier note and adds one new true thing. Draft replies for the user to edit. Sending follows
recipe 4's approval rules.

## 6. Research a lead or account before outreach

For one or a few people the user will actually write to: `profile.js` with `extras` (the lead from the
search row's `entityUrn`), `activity.js` (`days` 90) and `account.js` for their current company
(`companyId` from the profile's first current position; add `news`). That is 3 small calls per
person. Summarize only what the data says (role tenure, a recent comment, an alert) with the source
named for each fact; feed it to recipe 4's `sources` column. Skip anyone with `pendingInvitation`.

## Make it yours

If the user likes a flow, offer to save it as their own small skill (ICP, caps and tone baked in) or a
Cowork scheduled task that drafts only. A local schedule needs the Mac awake and the app open; a
laptop-off schedule needs Agent Browser.
