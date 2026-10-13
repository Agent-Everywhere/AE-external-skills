---
name: sales-navigator
description: >-
  Work LinkedIn Sales Navigator for the user's own seat, fast and safely, for any company and any
  ICP: build account, lead and decision-maker lists; qualify accounts from their websites; save
  them to named Sales Nav lists; draft outreach; track accepted/replied/pending invitations and
  draft follow-ups; or run all of that as a daily routine. Calls Sales Navigator's own in-page API
  through the browser's JavaScript tool (Claude Desktop Cowork built-in browser, Claude in Chrome)
  or a cloud browser (Agent Browser MCP): exact counts and 25 rows in about 2 seconds. Use for
  "build me a lead list in Sales Nav", "find companies that match my ICP", "which of these fit",
  "save these to a Sales Nav list", "draft connection notes", "who accepted / replied", "run my
  day", "size my TAM on LinkedIn", "who changed jobs / is hiring". Read-only on LinkedIn by
  default: nothing is sent, connected or messaged unless the user explicitly asks to send and
  approves the exact batch.
---

# Sales Navigator

You operate the user's own Sales Navigator seat like a careful researcher, not a scraper: one
browser session, a steady pace, everything explained. The user's **Company Profile** (offer, ICP,
buyer types, titles, tone, caps: `templates/company-profile.md`) drives every action. You build the
searches yourself.

## Actions (router)

Pick the action from what the user asked, run preflight below, then load **only that action's
reference**. Actions chain through CSV files in the user's folder, so any can start from a file.

| Action | The user says | Load | Writes to LinkedIn? |
|---|---|---|---|
| **setup** | "set up my prospecting", "get me started" | [`references/build-list.md`](references/build-list.md) section 1 | No (zero search pages) |
| **build-list** | "build me a list", "find companies/decision-makers", "size my TAM", "pull my saved search" | [`references/build-list.md`](references/build-list.md) | No |
| **qualify-accounts** | "which of these fit", "check their websites", "narrow this list" | [`references/qualify.md`](references/qualify.md) | No |
| **save-to-lists** | "save these to a list", "put the keepers in Sales Nav" | [`references/lists.md`](references/lists.md) | Creates/fills a list, with the user's okay |
| **outreach** | "draft connection notes", "write the InMails", and only on an explicit ask, "send them" | [`references/outreach.md`](references/outreach.md) | Only on an explicit ask, per approved batch |
| **follow-ups** | "who accepted / replied", "what's pending", "draft follow-ups" | [`references/followups.md`](references/followups.md) | No (drafts only) |
| **run-my-day** | "run my day", "do today's routine", "set this up on a schedule" | [`references/run-my-day.md`](references/run-my-day.md) | No (drafts only; never sends unattended) |

Nothing is sent unless the user explicitly asks, and then only under `outreach.md` (the only file that describes sending); caps and stop rules: `references/guardrails.md`.

## One step per request (the rule that overrides "being helpful")

**Do exactly the one action the user asked for, then stop.** Never chain into the next action,
even when it is obvious and the budget allows. **Setup writes the Company Profile and the
workspace only: zero search pages, no sign-in check.** Market sizing is count calls only (plus
typeahead lookups for filter ids; no page pulls). A pull gets only the list asked for. End every
step with a short result (numbers, file path, the `quota` line) and **"Next, you can: ..."** with
two or three suggestions; the user picks. Only **run-my-day** chains, and only on the literal "run
my day" or a schedule. A bare "continue" or "go on" means exactly ONE step: the one named, or the
single one you offered (several offered: ask which). Choices (question cards) may auto-select the
recommended option after a few minutes, so the recommended/default is always the **safe** one
(never raise a cap, never spend calls, never send) and the question says so. A send is never
approved by a card (`references/outreach.md`).

## Always read first

- [`references/guardrails.md`](references/guardrails.md) — **mandatory**: limits, pacing, stop signals, outreach caps.
- [`references/gotchas.md`](references/gotchas.md) — things that silently go wrong (browser JS tool notes at the end).
- [`references/fast-path.md`](references/fast-path.md) — the in-page API method; read before the first run of any search action.
- [`runtime/`](runtime/README.md) — the shared browser runtime (`local.md`, `agent-browser.md`, `session.py`, `guardrails-common.md`). Vendored copy; do not edit it here.

Loaded by the action that needs them: [`filters.md`](references/filters.md) (ICP to filters, sharding),
[`geo-us-states.md`](references/geo-us-states.md) (state ids), [`output.md`](references/output.md) (CSV columns).

## Preflight (every run except setup)

Setup needs only step 3's workspace; it skips steps 1, 2 and 5.

1. **Pick the runtime** (say which, and why, in one line):

   | You have | Runtime | How |
   |---|---|---|
   | **A browser JavaScript tool** (Claude Desktop Cowork's built-in browser, Claude in Chrome) | **local** fast path — **the default** | `runtime/local.md`: one `page/*.js` snippet per tool call, no Playwright, no CDP |
   | Agent Browser connector (`browser`, `workspace`) **and** code execution | **agent-browser** (cloud browser, saved profile) — for schedules and laptop-off runs, or when there is no JS tool | `runtime/agent-browser.md` |
   | Neither | **slow path**: read result pages with whatever page-reading tools exist | `references/build-list.md` section 4b |

   Fast runtimes: exact counts, ~2 s per 25-row page (page reading: 30 s or more, incomplete rows).
   **Warn the user that a local run uses their own seat, session and IP**; offer the cloud browser.
2. **Session.** The browser must be signed in to Sales Navigator (`linkedin.com/sales/home`).
   - Not signed in → the user signs in themselves (own window, or `open_browser` for the cloud
     browser). **Never ask for, type, or store a password or 2FA code.**
   - Signed in but no Sales Nav (upsell redirect) → say so, stop; no classic-search fallback unless accepted.
3. **Workspace** (so the caps and the outreach ledger survive across tasks and days). All state lives in
   one folder the host always has access to: `company-profile.md`, `quota.md`, `run_log.csv`,
   `outreach_log.csv`, `lists/`, `drafts/`, `results/`. Locate it in this order (the scripts do the same):
   `--workspace DIR`, the profile's `workspace:` field, `$SALESNAV_WORKSPACE`, `~/Claude/sales-navigator`
   if it exists (Cowork's user-files folder is `~/Claude`), else **ask the user ONCE** where their Cowork
   folder is, run `python3 scripts/workspace.py init <that folder>` and save the path in
   `company-profile.md` as `workspace:`. Pass `--profile FILE` (or `--workspace DIR`) on EVERY script call.
   `python3 scripts/workspace.py locate` shows what was found; with nothing found the scripts REFUSE
   (exit 4): ask the user, never start a fresh `outreach_log.csv` silently (`references/outreach.md`).
   Setup folds this question into its one profile message.
4. **Company Profile.** Load the user's filled `company-profile.md` (workspace, else an attached or
   project file) and ask only for fields it lacks. If none exists, run **setup** (`references/build-list.md`
   section 1) and stop, even if the user asked for something else: propose a filled profile in ONE
   message, the user confirms or corrects by number, then save it in the workspace.
   `templates/company-profile.md` is the blank form and `templates/company-profile.example.md` a
   filled fictional one (its seller facts are placeholders, never used in drafts).
5. **Budget.** Run `python3 scripts/run_log.py quota --workspace DIR` first and read the line it prints
   (`Today: 87/150 calls · 12/20 invites · week 41/100`). Tell the user the planned volume (calls, rows,
   pages) against `references/guardrails.md` (cloud browser: roughly the browser time billed). Get a
   "go" for anything above the default run size. If the page budget would be exceeded, offer the
   three options in `references/guardrails.md`, safe default first (use rows already pulled).

**End of every action:** log what you used (`run_log.py add ...`), run `run_log.py quota` (it rewrites
`quota.md`), show its one-line summary, then the "Next, you can: ..." line. The local CSVs are the source of truth.

## Helper scripts

Python 3 standard library, no network; run them on the run's files, or apply the same rules by hand.
- `scripts/salesnav_rows.py` — search results (JSONL or saved JSON) to `leads.csv` / `accounts.csv` per `references/output.md`.
- `scripts/shard_plan.py` — per-dimension result counts to a shard plan under the cap.
- `scripts/dedupe.py` — normalize LinkedIn URLs and domains, dedupe, apply exclusions.
- `scripts/validate_csv.py` — check an accounts/leads CSV against `references/output.md`.
- `scripts/workspace.py` — `locate` / `init`: find or create the workspace folder (above).
- `scripts/run_log.py` — `add` / `today` / `quota`: the usage log (`run_log.csv`) against the limits, and `quota.md` with the one-line summary. Takes `--workspace` / `--profile`; `quota` also takes `--daily` / `--weekly` / `--followup-daily`: pass the same lowered invite caps you pass to `outreach_log.py`.
- `scripts/outreach_log.py` — the outreach ledger (`check`, `add`, `status`, `followup`, `caps`, `summary`); outreach and follow-ups only; refuses (exit 4) when the ledger is missing or the workspace unlocated.

Page snippets (`page/*.js`, run in the signed-in page; `runtime/local.md`): `csrf_ready.js`, `count.js`,
`lead_search.js`, `account_search.js`, `companies_websites.js`, `typeahead.js`.

## What this skill never does

- Sends, connects, messages, follows, endorses or likes anything unless the user explicitly asked
  to send, and then only under `references/outreach.md`. Never from a scheduled or unattended run.
- Exports via unofficial bulk tools, runs multiple browsers on one seat, or works around a LinkedIn
  warning, captcha, or limit.
- Enters credentials or 2FA codes, or prints, logs, or saves cookies and tokens.
- Collects personal emails/phones or data the user didn't ask for, or imports their search URL unasked.
