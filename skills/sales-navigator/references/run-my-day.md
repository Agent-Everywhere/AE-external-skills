# Action: run-my-day

One routine that chains the other actions into a day's work, and ends with drafts and a short
report for the user to act on. It reads, qualifies, saves to a list the user already allowed, and
drafts. **It never sends.** Sending needs the user, awake, in a conversation, approving a batch
(`references/outreach.md`).

## Before the first run

- A filled Company Profile (`templates/company-profile.md`) with a **sub-list plan** (the ordered
  sub-lists to work through, each with a status), the daily volume you may use, and whether
  creating lists is allowed ("create lists: yes").
- Preflight from `SKILL.md` (runtime, signed-in session, budget). Check `scripts/run_log.py today`
  and `scripts/outreach_log.py caps` so the day starts with the limits in view.

## The routine

Do the steps in order; each is a normal action, so load its reference when you reach it. After
each step save its files, and stop the routine (not just the step) on any stop signal in
`references/guardrails.md`.

1. **Next sub-list.** Take the first sub-list in the plan whose status is `todo`. Count it, then
   collect it up to the day's page budget (`build-list.md`). If it does not finish, mark it
   `partial` and resume it tomorrow.
2. **Qualify.** Run `qualify-accounts` on the new accounts only (`qualify.md`). Keep the first
   run's calibration step: if this sub-list has not been calibrated with the user, qualify 10 and
   leave the rest for them to review.
3. **Decision-makers.** For accounts marked `keep`, find 1–3 decision-makers (`build-list.md`,
   section 5). Remove anyone already in the ledger: `outreach_log.py check`.
4. **Save to list.** If the profile allows it, save the qualified rows to the named list
   (`lists.md`) and verify the count. If it does not, leave the file and say so.
5. **Draft for approval.** Draft up to the room left under today's caps (`outreach_log.py caps`)
   following `references/outreach.md` Part A. Write `drafts/<yyyy-mm-dd>.csv`. Do not click
   anything in the compose screens.
6. **Follow-ups.** Read the sent invitations and inbox, update the ledger, and draft the follow-ups
   that are due (`followups.md`). Write `drafts/followups-<yyyy-mm-dd>.csv`.
7. **Report.** One short message or file for the user:
   - sub-list worked and its status; accounts kept / dropped / unsure;
   - list name and verified count;
   - drafts waiting for approval (count, file path);
   - follow-ups due and replies that need them;
   - limits used today and anything that stopped the run.
   Update the sub-list plan's status. End with the one thing you need from them: "approve the
   drafts to send?" is a question for the user's next conversation, not something to act on.

## Run it as a Cowork scheduled task

In Claude Desktop's Cowork, create a scheduled task (the scheduled-tasks screen, or ask Claude to
schedule it), pick the frequency (for example weekdays at 9:00 in the user's time zone), choose
the folder that holds the Company Profile and CSVs, and give it this prompt:

> Run the sales-navigator skill's run-my-day action using the Company Profile in this folder.
> Draft only: do not send, connect or message anyone. Stop and report on any LinkedIn warning,
> captcha or limit. Finish with the day report.

What the runtime needs to be true when the task fires:

| Runtime | Needs | Laptop closed? |
|---|---|---|
| **local** (browser JS tool) | The Mac awake, Claude Desktop open, and a Sales Navigator page signed in in the built-in browser (the task opens `linkedin.com/sales/home` first and waits for it to load) | **No**: nothing runs |
| **agent-browser** (cloud) | The Agent Browser connector and code execution in the task; its saved profile signed in | **Yes** |

Tell the user which they have, and that a missed local run is simply skipped. A scheduled run uses
the same seat as their own browsing, so ask them not to work in Sales Navigator during the run.
Review the first few runs by reading the day report before relying on the schedule.
