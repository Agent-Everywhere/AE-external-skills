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
| **build-list** | "build me a list", "find companies/decision-makers", "size my TAM", "pull my saved search" | [`references/build-list.md`](references/build-list.md) | No |
| **qualify-accounts** | "which of these fit", "check their websites", "narrow this list" | [`references/qualify.md`](references/qualify.md) | No |
| **save-to-lists** | "save these to a list", "put the keepers in Sales Nav" | [`references/lists.md`](references/lists.md) | Creates/fills a list, with the user's okay |
| **outreach** | "draft connection notes", "write the InMails", and only on an explicit ask, "send them" | [`references/outreach.md`](references/outreach.md) | Only on an explicit ask, per approved batch |
| **follow-ups** | "who accepted / replied", "what's pending", "draft follow-ups" | [`references/followups.md`](references/followups.md) | No (drafts only) |
| **run-my-day** | "run my day", "do today's routine", "set this up on a schedule" | [`references/run-my-day.md`](references/run-my-day.md) | No (drafts only; never sends unattended) |

Nothing is sent unless the user explicitly asks to send, and then only under `outreach.md`.
Sending is described nowhere else; the caps and stop rules are in `references/guardrails.md`.

## Always read first

- [`references/guardrails.md`](references/guardrails.md) — **mandatory**: limits, pacing, stop signals, outreach caps.
- [`references/gotchas.md`](references/gotchas.md) — things that silently go wrong (browser JS tool notes at the end).
- [`references/fast-path.md`](references/fast-path.md) — the in-page API method; read before the first run of any search action.
- [`runtime/`](runtime/README.md) — the shared browser runtime (`local.md`, `agent-browser.md`, `session.py`, `guardrails-common.md`). Vendored copy; do not edit it here.

Other references, loaded by the action that needs them: [`filters.md`](references/filters.md)
(ICP to filters, query encoding, sharding), [`geo-us-states.md`](references/geo-us-states.md)
(US state geography ids), [`output.md`](references/output.md) (CSV columns).

## Preflight (every run)

1. **Pick the runtime** (say which, and why, in one line):

   | You have | Runtime | How |
   |---|---|---|
   | **A browser JavaScript tool** (Claude Desktop Cowork's built-in browser, Claude in Chrome) | **local** fast path — **the default** | `runtime/local.md`: one `page/*.js` snippet per tool call, no Playwright, no CDP |
   | Agent Browser connector (`browser`, `workspace`) **and** code execution | **agent-browser** (cloud browser, saved profile) — for schedules and laptop-off runs, or when there is no JS tool | `runtime/agent-browser.md` |
   | Neither | **slow path**: read result pages with whatever page-reading tools exist | `references/build-list.md` section 4b |

   Every fast runtime runs the same snippets and gives exact counts and ~2 s per 25-row page,
   against 30 s or more and incomplete rows for page reading. **Warn the user that a local run
   uses their own seat, session and IP**; offer the cloud browser if they would rather not.
2. **Session.** The browser must be signed in to Sales Navigator (`linkedin.com/sales/home`).
   - Not signed in → the user signs in themselves (their own window; or the sign-in browser,
     `open_browser`, for the cloud browser). **Never ask for, type, or store a password or 2FA code.**
   - Signed in but no Sales Nav (redirect to an upsell) → say so, stop. Do not fall back to classic
     LinkedIn search unless the user explicitly accepts the lower-quality path.
3. **Company Profile.** Load the user's filled `company-profile.md` (an attached file, a project
   file, their folder, a doc) and ask only for the fields it lacks. If none exists, ask the short
   set in ONE message (`references/build-list.md` section 1; accept "skip" and "use defaults"),
   not a multi-step question screen. `templates/company-profile.md` is the blank form and
   `templates/company-profile.example.md` a filled fictional one to copy. Only ask for what the
   action needs and is missing.
4. **Budget.** Tell the user the planned volume (calls, rows, pages) against `references/guardrails.md`
   and, for the cloud browser, roughly how much browser time it bills. Get a "go" for anything above
   the default run size. Work in the user's folder: CSVs, `results/`, `outreach_log.csv`.
   If a cap stops a pull, say how many rows remain and offer to continue tomorrow, or to raise
   today's cap with the user's explicit OK (`references/guardrails.md`).

## Helper scripts

Python 3 standard library, no network. Run them on the run's files when you can execute code;
otherwise apply the same rules by hand.

- `scripts/salesnav_rows.py` — search results (JSONL or saved JSON) to `leads.csv` / `accounts.csv` per `references/output.md`; per-company buyer type (`--buyer-type-map`), pending/degree/open-link columns, same-name flags.
- `scripts/shard_plan.py` — per-dimension result counts to a shard plan under the cap.
- `scripts/dedupe.py` — normalize LinkedIn URLs and domains, dedupe, apply exclusions.
- `scripts/validate_csv.py` — check an accounts/leads CSV against `references/output.md`.
- `scripts/run_log.py` — daily page, small-API-call and profile counts against the limits.
- `scripts/outreach_log.py` — the outreach ledger: `check` (already contacted?), `add` (`--pending` before a send), `status`, `followup`, `caps`, `summary`. Used only by outreach and follow-ups.

Page snippets (`page/*.js`, one async function each, run inside the signed-in page): `csrf_ready.js`,
`count.js`, `lead_search.js`, `account_search.js`, `companies_websites.js`, `typeahead.js`. Each is
also usable standalone as an async IIFE with its params inline (`runtime/local.md`).

## What this skill never does

- Sends, connects, messages, follows, endorses or likes anything unless the user explicitly asked
  to send, and then only under `references/outreach.md`. Never from a scheduled or unattended run.
- Exports via unofficial bulk tools, runs multiple browsers on one seat, or works around a LinkedIn
  warning, captcha, or limit.
- Enters credentials or 2FA codes, or prints, logs, or saves cookies and tokens.
- Collects personal emails/phones from profiles or adds data the user didn't ask for.
- Imports a user's search URL unless they ask.
