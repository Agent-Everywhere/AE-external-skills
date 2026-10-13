# Action: save-to-lists

Put qualified accounts or leads into a **named list inside Sales Navigator**, through the normal
screens, so the user sees the result in their own seat. Saving to a list does not contact anyone
and does not notify them. It is a write to the user's account, so get their okay first.

## When to use it

After `qualify-accounts` (keepers) or `build-list` (a finished sub-list). Lists are for hand-offs,
exclusions and "who is in this batch"; the CSV stays the source of truth (`gotchas.md` item 19).

## Name

`<buyer-type> · <sub-list> · <yyyy-mm>` with a space-dot-space (a middle dot) between the parts.

Examples (generic): `needs-new-line · US-TX · 2026-10`, `already-buys · UK-all · 2026-10`.

- `buyer-type` and `sub-list` come from the Company Profile's buyer types and its `## Sub-list plan` table, so the
  same name appears in the CSV `buyer_type` and `shard` columns.
- Lead lists and account lists are separate in Sales Nav. Use the same name for both kinds of a
  sub-list; the type tells them apart.
- If a list with that name exists, add to it; do not create a twin.

## Procedure

1. **Ask once, then act.** Tell the user: list name, kind (leads or accounts), how many rows, from
   which file. Wait for a yes. A standing yes in the Company Profile ("create lists: yes") covers
   the list itself, not anything else.
2. **Choose the rows**: those with `keep = keep` (accounts) or `status = qualified` (leads), not
   already saved to this list (check `lists_log.csv`). Leave out anyone on the exclusion list.
3. **Create or open the list** in the Sales Nav UI (Lists, then create a lead list or an account
   list). Read each label before you click; the UI moves (`gotchas.md` item 17). Use the browser's
   click and type tools in the user's visible window, not scripts that submit forms.
4. **Add the rows** the least-click way the seat offers, in this order of preference:
   - *Accounts*: upload the kept rows as a CSV (name and domain) into the account list, if the seat
     offers upload and matching; check the match count it reports.
   - *Either*: open the saved sub-list's search, select the wanted rows on a page, "Save to list",
     and pick the list; then page on. Only select rows you chose in step 2; if the page also holds
     dropped rows, tick the keepers individually.
   - *Leads*: from a lead's card, "Save", choose the list. Slow; use it for small sets.
   Work at a human pace: a few seconds between clicks and a longer pause every few pages. Lists have
   size limits (check the UI; the search caps in `guardrails.md` are a good guide), which is one more
   reason to keep sub-lists under the cap.
5. **Verify the count.** Open the list, read its total, and compare with what you expected (rows
   already in it plus rows you added). A mismatch is reported, not "fixed" by adding again:
   show the user the numbers and the likely cause (rows that did not match, rows already saved).
6. **Log it.** Append one line to `lists_log.csv` in the user's folder:
   `date, list_name, kind, expected, actual`. In the Company Profile's `## Sub-list plan` table, mark the
   sub-list as `listed`.

## Report to the user

The list name, kind, expected vs actual count, rows that did not match, and where `lists_log.csv`
is. Offer the next step: draft outreach for the list (`references/outreach.md`), which only drafts
until the user asks to send.

## Stops

Apply `references/guardrails.md`: stop on a captcha, restriction or limit banner, report the
exact message, and do not retry. Saving a very large number of leads in one sitting is the same
kind of burst as paging search results; spread big saves across the day.
