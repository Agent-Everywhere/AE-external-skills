# Action: outreach

**This is the only file that describes sending.** Part A drafts messages (read-only). Part B sends
them, and applies **only when the user has explicitly asked to send** in this conversation, and
then only for batches they approve. A schedule, a routine, a follow-up check or "run my day" never
starts Part B: they stop at drafts.

Numbers for caps and the stop rules are in `references/guardrails.md` ("Outreach caps and stop
rules"); `scripts/outreach_log.py` enforces them. Read both before the first send of a run.

## The ledger

`outreach_log.csv` in the user's folder is the record of who was contacted. A person is their
Sales Nav lead id (from `salesnav_lead_url`; the script accepts the URL or the id). Only a hash
of each message is stored, never the text. The script locks the file while it writes, so it is
safe to call from one run at a time per ledger even if a second run starts by mistake.

```
python3 scripts/outreach_log.py check  --lead-id <id> [--lead-id <id> ...]   # exit 3 = already contacted (pending counts)
python3 scripts/outreach_log.py add    --lead-id <id> --kind connection|inmail --message "<exact text>" --pending
                                                                              # BEFORE the click; exit 2 = cap reached, 3 = already in the ledger
python3 scripts/outreach_log.py status --lead-id <id> --status sent           # AFTER the send is verified
python3 scripts/outreach_log.py caps --for connection|followup                # exit 2 = a cap for that kind is reached
```

A `pending` row is the intent to send, written before the click so that a crash between the click
and the log can never lead to a second send. It counts as contacted and toward the caps.

## Part A: draft (no sending)

1. **Pick people**: `leads.csv` rows that are `qualified` (or in the saved list) for accounts with
   `keep = keep`. Run `check` on the batch first (put the lead URLs or ids in a file and use
   `--ids-file`: lead URLs contain commas) and drop anyone already in the ledger, on the
   Company Profile's do-not-contact list, or excluded. **The search-row columns are the first
   check** (`references/output.md`): drop rows with `pending_invitation = yes` (an invitation is
   already out); `degree = 1st` means already connected, so a connection note is wrong for them
   (a message is a follow-up-style send, under Part B); `open_link = yes` marks people who accept
   open messages. When these columns are filled from this run's search there is no need to open
   each profile to learn it. Open a profile only when the columns are blank or the row is from an
   older run, and see Part B rule 8 for what the search row cannot tell you. Rows with
   `dup_suspect = yes` need a look before anyone is picked.
2. **Draft per person** from their profile fields (name, title, company, time in role, signals)
   and the account's `facts` and `fit_reason` (`references/qualify.md`). Use the Company Profile's
   tone and voice. Each message:
   - names one specific, true thing about them or their company, and one reason you are writing;
   - asks one small question or makes one small offer, with no pitch dump and no links in a
     connection note;
   - never claims familiarity, results or mutual contacts you cannot see;
   - uses only professional information that is on their profile or their website.
3. **Formats.**
   - *Connection note*: **at most 300 characters**, counting every character. Count it; do not
     estimate. Over 300 means rewrite, not truncate.
   - *InMail*: a subject and a body. Keep the subject short and specific, and the body brief.
   - A connection request may also go with no note at all if the profile asks for that.
4. **Write drafts to a file.** Create the `drafts/` folder in the user's working folder if it is
   not there, and write `drafts/<yyyy-mm-dd>.csv` starting from `templates/drafts.csv`. The exact
   columns, in this order:

   ```
   lead_id,full_name,company_name,kind,text,char_count
   ```

   `lead_id` is the Sales Nav lead id or URL (quote the cell: it contains commas), `kind` is
   `connection` or `inmail` (for an InMail put the subject at the start of `text` on its own
   line), `char_count` is the counted length of `text` (at most 300 for `connection`).
5. **Show the exact drafts to the user** before anything else happens: every person with the full
   text that would be sent and its character count, the file path, and who was skipped and why.
   Part A sends nothing. A draft the user has seen is still not permission to send: sending needs
   their explicit ask and approval of the exact batch under Part B.

## Part B: send (only on an explicit ask)

### Hard rules

1. **Explicit ask first.** The user must have said, in this conversation, to send (or connect, or
   message). Drafting is not asking. Never send from a scheduled or unattended run.
2. **Show the exact batch; get explicit approval of that batch.** List every person with the exact
   text that will be sent, the batch size, and today's cap position (`caps`). Wait for a clear
   yes. Approval covers only the batch shown: it does **not** carry to the next batch, to an
   edited message, or to a later day. Show the next batch and ask again. Send only the people the
   user approved; if they edit a message, show the edit again.
3. **Send by clicking in the Sales Navigator UI, one person at a time**, in the user's visible
   window with the browser's click and type tools. No API posts, no scripts that submit, no
   parallel tabs, no bulk tools.
4. **Human pace.** Wait a random 30 to 90 seconds between two sends (jitter, not a fixed
   interval), and a longer pause every few sends. Only in the user's local business hours.
5. **Verify the sent-state for each person before the next, and record the intent first.**
   Right before the click run `outreach_log.py add ... --pending` (it refuses a reached cap and
   anyone already in the ledger). Click. Then verify: for an invitation, the lead page shows it as
   pending; for a message or InMail, it appears in the thread (and an InMail's credit count
   drops). Only then record it: `outreach_log.py status --lead-id <id> --status sent`. No
   verification, no next person. (A follow-up has no pending form: look at the thread first, send,
   verify, then `outreach_log.py followup`.)
6. **Caps.** At most **20 connection requests a day and 100 a week** (rolling 7 days), at most
   **20 follow-up messages a day**, and InMails only within the credits the seat has left: read
   the credit count in the UI first and tell the user. Run `caps --for <connection|followup>`
   (the kind of batch you are about to send) before the batch and after each send; when it exits
   2, stop. `add` and `followup` refuse at a reached cap too (exit 2). Lower caps are always fine
   (`--daily`, `--weekly`, `--followup-daily`); raise them (`--allow-over-cap`) only on the user's
   explicit go.
7. **Never contact anyone already in `outreach_log.csv`** (any status, any kind) with a first
   message. Run `check` on the batch before drafting, again before showing it, and once more on
   each person right before their send. The one exception is a follow-up to someone who accepted
   (rule 11).
8. **Never send a first message to anyone with a pending invitation or an existing message
   thread.** Look first. A search row from today's run with `pending_invitation` and `degree`
   filled is the first check for a connection request: `pending_invitation = yes` or
   `degree = 1st` means skip, and for a 2nd or 3rd degree person with no pending invitation no
   profile open is needed. The search row says nothing about message threads, so before a message
   or InMail, or when those columns are blank or older than today, open the lead and look. If
   either a pending invitation or a thread is there, skip them and say why; do not send a second
   note. **On every resume** (a new session, a restart, or after any stop) this look is
   mandatory for every row still `pending` before anything else is sent: a pending invitation or a
   thread means the send went out (`status --status sent`); neither means it did not
   (`status --status withdrawn --note "not sent"`, and tell the user, who decides whether that
   person is ever tried again). Never send to a pending row without that look.
9. **Stop on any warning.** Any LinkedIn warning, captcha, "unusual activity" or checkpoint page, or
   any weekly-limit or "reached the limit" banner: stop the run, send nothing more that day,
   report the exact message to the user (no screenshots of private data), and advise waiting at
   least 24 hours. Do not work around it.
10. **Never auto-retry a send with an unknown result.** If you cannot tell whether a send went
    through (page error, no confirmation, a timeout), do not click again. The `pending` row already
    stops anyone retrying them: leave it pending (do not mark it sent or withdrawn), stop the
    batch, and ask the user to check. (For a follow-up, log it with `--note unverified`.)
11. **Follow-up messages are sends.** A follow-up to someone who accepted goes through this same
    Part B: explicit ask, exact batch approval, one at a time, paced, verified, and logged with
    `outreach_log.py followup`. At most three messages ever go to one person (the first plus two
    follow-ups); the script refuses more.

### Procedure

1. Confirm the ask, the kind (connection requests, InMails or follow-up messages) and the number.
2. `caps --for <kind>` (and, for InMails, the credits). The batch is the smaller of what the user
   asked for, the cap room left, and ten people.
3. `check` the batch; read each lead's page for a pending invite or thread (rules 7 and 8). On a
   resume, settle every `pending` row first (`summary` lists them; rule 8).
4. Show the batch and wait for approval (rule 2).
5. For each approved person, in order: `add --pending` (rule 5), send, wait for the confirmation,
   verify (rule 5), `status --status sent`, `caps --for <kind>`, then wait the jittered gap (rule 4).
6. Stop early on rules 6, 9 or 10.
7. Report: sent, skipped (with reasons), unverified, caps remaining today and this week, and
   which accepted people will be due a follow-up (`outreach_log.py summary --stale-days N`).
   Then ask whether to show the next batch; do not assume yes.

## Recording what happens afterwards

Acceptances, replies and withdrawals are read by the follow-ups action
(`references/followups.md`) and recorded with `outreach_log.py status`. Replies are handled by
the user: you may draft a response for them to approve and send under Part B.
