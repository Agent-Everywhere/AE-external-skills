# Action: follow-ups

Find out what happened to the outreach already sent, and draft the next touches. Reading the
inbox and the sent invitations is read-only. Drafting is read-only. Any send goes through
`references/outreach.md` (Part B), only when the user explicitly asks.

## Inputs

- `outreach_log.csv` in the workspace folder (kept by `scripts/outreach_log.py --workspace DIR`). The
  script exits 4 when it is missing: that is not "nothing to follow up", it is lost state or the wrong
  workspace, so ask the user (unless the profile's `Outreach started` is blank, i.e. nothing was ever sent).
- The Company Profile: follow-up wait (default 3 days after acceptance), tone, caps.

## 1. Read the state (read-only)

1. Run `python3 scripts/outreach_log.py summary`: the people whose status is `pending`, `sent` or `accepted`
   are the open ones. Look at those only.
2. Read **Sent invitations** and the **Messaging inbox** in Sales Navigator through the browser
   (page reading; the labels move, so read them before you act). Do not open each profile.
   Opening threads counts against the daily profile/page limits in `references/guardrails.md`;
   read the list views first and open a thread only when its preview is not enough.
3. Map what you see to a status for each logged person:

   | You see | Status |
   |---|---|
   | Invitation still listed as sent | `sent` (pending): no change |
   | Invitation gone and the person now appears as a connection | `accepted` |
   | A message from them in the thread, after ours | `replied` |
   | The user (or an explicit instruction from them) withdrew the invitation | `withdrawn` |
   | Invitation gone, not connected, nobody withdrew it | unknown: report it, do not guess |

4. Record changes: `python3 scripts/outreach_log.py status --lead-id <id> --status accepted|replied|withdrawn`
   (add `--date` when you know the day, otherwise it records today).

## 2. Decide what is due

| Situation | Suggestion |
|---|---|
| Accepted, no reply, last touch at least the follow-up wait ago, touches left | draft a short follow-up (`outreach_log.py summary --stale-days <N>` lists them) |
| Replied | read the reply; draft a response for the user to edit; flag it to them first, it is their conversation |
| Invitation pending a long time (about two weeks) | tell the user; withdrawing is a change in their account, so only with their yes, then log `withdrawn` |
| Accepted and already at the maximum touches | leave them; no more follow-ups |

## 3. Draft follow-ups

Follow the drafting rules in `references/outreach.md` (Part A). Specific to follow-ups:

- Refer to the earlier note and add something new (a relevant fact from the account's `facts`,
  or one small useful offer). No guilt, no "just bumping this".
- One question. Short.
- Draft a reply to a reply so the user can send it in their own words.

Write them to `drafts/followups-<yyyy-mm-dd>.csv`: lead id, name, status, days since last touch,
suggested action, draft text. Show the user the table.

## 4. Report

Counts by status (sent, accepted, replied, withdrawn), who is due, replies needing the user, the
draft file path. Stop with "Next, you can: ..." and start none of them. If they ask to send the drafts, load
`references/outreach.md` Part B and follow it from the start (a new explicit approval of the
exact batch); nothing in this file authorizes a send.
