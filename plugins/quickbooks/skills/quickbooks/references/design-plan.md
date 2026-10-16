# QuickBooks Online skill: research and design plan

Status: design only (nothing pushed). Author: Grok Bot for Giovanni Lu, 2026-10-15.

## 1. Existing patterns in this repo

### 1a. sales-navigator (browser-driven plugin, v0.7.2)

```
plugins/sales-navigator/                    # marketplace source, strict:false, 5 skills
  skills/sales-navigator/                   # the "engine"
    SKILL.md  skill.yaml (name, version, category, runtimes: [local, agent-browser])
    reference.md  recipes.md
    page/*.js            # in-page snippets: `async (params) => {...}`, same-origin fetch, compact JSON
    runtime/session.py   # VENDORED from packages/browser-runtime by build/sync_runtime.py (--check in tests)
    runtime/README.md
    scripts/*.py         # stdlib-only, no network: doctor, run_log, dedupe, validate_csv, workspace...
    references/salesnav-kb/NN-*.md   # field-notes KB
    templates/
  skills/salesnav-{tam-accounts,tam-people,tam-tracker,outreach}/  SKILL.md + skill.yaml (purpose skills reuse engine)
packages/browser-runtime/   # single source of truth for session.py
build/sync_runtime.py       scripts/build-plugin-zip.sh
.github/workflows/release-plugin-zip.yml   # tag sales-navigator-v<ver> -> zip + rolling "-latest" release
tests/*.py (pytest) + tests/node_snippet_runner.js + fixtures/
.claude-plugin/marketplace.json            # version must match skill.yaml (test_repo_manifest.py)
```

- **SKILL.md**: YAML front matter (`name`, `description` = when-to-use), then "Engine path" sh block
  resolving `$ENGINE` (`$CLAUDE_PLUGIN_ROOT` → Cowork `/mnt/skills/plugin-files/...` → own folder → find),
  "Step 0: run doctor.py", Toolkit, Hard rules (read-only default, typed approval for writes, caps,
  stop on captcha/warning, never handle cookies/passwords), purpose skills.
- **Browser driving**: never clicks the UI. Snippets run inside the user's signed-in tab, calling the
  site's own internal JSON API. Three runtimes, one `session.py`:
  1. Browser JS tool (Cowork / Claude in Chrome): `session.py --emit x.js --params ... --compact` prints a paste-ready IIFE.
  2. Agent Browser (cloud): via the browser MCP connector `.../mcp` (Google sign-in): `browser status`,
     `open_session` → one-use 60 s claim → `AB_CLAIM=... session.py --runtime agent-browser --base <base> --plan plan.json`
     which POSTs `<base>/browser/claim`, gets `cdp_url` + heartbeat token, attaches via Playwright over CDP,
     heartbeats, 40-min lease checkpoint, then `close_session`.
  3. Local Chrome CDP (`--runtime cdp --cdp-url http://127.0.0.1:9222`).
  Plan JSON: `start_url`, `ready` snippet, `delay_ms`, `calls[]` with paging; JSONL out; `--skip-done`;
  exit codes 0/2/3(not signed in)/4/5(403/429)/6/7/8. Secrets redacted.
- **Install**: `/plugin marketplace add Agent-Everywhere/AE-external-skills` + `/plugin install sales-navigator@ae-external-skills`;
  or Claude Desktop upload of release zip/.plugin; or zip the plugin folder.
- **Versioning**: semver in skill.yaml + marketplace.json (tested equal), tag-driven release, README "Upgrading" notes.

### 1b. grokbot (CLI + skill, v0.1.0)

```
skills/grokbot/
  SKILL.md  skill.yaml (runtimes: [])
  references/{internals,host-commands}.md
  cli/package.json (type module, commander, node>=20, test: node --test, build: esbuild single file)
  cli/bin/grokbot.js  cli/src/{cli,gateway,session,cdp,cursor,agents,sections,policy,output,local}.js
  cli/dist/grokbot.mjs   # committed bundled file: no npm install needed
  cli/tests/*.test.js  cli/README.md
```

- Run as `node <skill-dir>/cli/dist/grokbot.mjs <cmd>`, optional symlink into `~/.local/bin`; also
  published as a release asset for curl install. Commander subcommands, `--json` global flag, `doctor`
  first, `policy.js` (operator vs agent policy, audit log), destructive commands gated by `--yes`
  / `--confirm-count`. Credentials read from the signed-in app, never printed.

## 2. Proposed package: `quickbooks`

Hybrid of both: the sales-navigator plugin shape (engine + purpose skills, shared browser runtime,
marketplace/zip install) plus a grokbot-style bundled single-file CLI (`qbo`) for speed and testability.

```
plugins/quickbooks/
  skills/quickbooks/                   # engine
    SKILL.md  skill.yaml (name: quickbooks, version 0.1.0, category: finance, runtimes: [local, agent-browser])
    reference.md                       # rules, approval gates, area overview
    references/qbo-kb/
      00-index.md 01-navigation-and-deeplinks.md 02-ui-map-<area>.md ... 90-quirks.md
    routes.json                        # area -> deep link, ready selector, list/detail/new URLs (machine-readable)
    selectors.json                     # recorded stable selectors (data-automation-id / aria / role first)
    page/                              # in-page snippets, same contract as salesnav
      ready.js  company_info.js  search.js  list.js (customers/vendors/items/accounts/txns)
      get_txn.js  report.js  form_fill.js (writes, gated)
    runtime/                           # vendored browser-runtime (sync_runtime.py)
    cli/ (package.json, src/, tests/, dist/qbo.mjs)   # `qbo doctor|open|list|get|search|report|create|...`
    scripts/doctor.py  run_log.py
  skills/qbo-reports/  skills/qbo-ar/ (invoices, payments, estimates)  skills/qbo-ap/ (bills, expenses)  skills/qbo-books/ (banking, CoA)
tests/test_quickbooks_*.py  + cli node tests
```

- Add marketplace entry `quickbooks` (version-checked), README row + Install/Upgrading section, release
  workflow generalized to `quickbooks-v*` tags (parametrize PLUGIN), `build-plugin-zip.sh quickbooks`.
- Install: `/plugin install quickbooks@ae-external-skills`; Desktop upload of `quickbooks.zip`; CLI alone
  via curl of `qbo.mjs` release asset.

## 3. Connecting to a logged-in browser

- **Never handle the Intuit password, 2FA codes or cookies.** The user signs in once in the browser
  (Agent Browser's persistent profile, their own Chrome, or the Cowork browser); we only detect state.
- Runtimes (reuse `session.py` unchanged where possible):
  1. **Agent Browser (cloud)**: browser MCP `https://browser-mcp-production-6535.up.railway.app/mcp`
     → `open_session` → claim → `session.py --runtime agent-browser --base <hosted-browser-agent base>`
     → CDP attach. If not signed in (`ready.js` sees `accounts.intuit.com` / sign-in form) exit 3 and
     ask the user to sign in via the live view. Company picker: detect `/app/companyselection` and ask.
  2. **Local CDP**: dedicated Chrome profile with `--remote-debugging-port`.
  3. **Browser JS tool**: `--emit` IIFE paste mode.
- Extend `session.py` (in `packages/browser-runtime`, then sync) with an optional **navigate step** per
  call (`"goto": "/app/invoice"`) and a **DOM action** mode (fill/click by selector) since QBO writes
  are not all practical via raw internal API; keep JSON-API reads as the fast path.
- Multi-company: capture `companyId` (realm) from `company_info.js`; every run logs it; refuse
  writes if the realm differs from the one the user confirmed.

## 4. QBO areas and actions to map

| Area | Read actions | Write actions (approval-gated) |
|---|---|---|
| Customers | list, search, detail, open balance, transactions | create, edit, make inactive |
| Vendors | list, search, detail, open bills | create, edit, inactive |
| Invoices | list (status/date filters), get, PDF link | create, edit, send (email), void, delete |
| Estimates | list, get | create, convert to invoice, send |
| Bills | list, get, unpaid | create, pay bill |
| Expenses / checks | list, get | create expense/check, attach receipt |
| Payments (receive) | list, get | receive payment, apply to invoices |
| Products & services | list, get | create, edit, inactive, price change |
| Chart of accounts | list, balances, account register | create, edit, inactive |
| Banking | accounts, feed "for review" list, rules | categorize/match/add, exclude (high risk) |
| Reports | P&L, Balance Sheet, Cash Flow, A/R & A/P aging, GL, sales by customer, custom date ranges; export CSV/XLSX | memorize report |
| Settings | company info, preferences (read) | change (out of scope v0.1, deny by default) |
| Search | global search, transaction search by number/amount | — |

Rules: read-only by default; every write shows the exact record/diff and needs the user's typed
approval per batch; never send email to customers, void, delete, or reconcile without explicit
per-item approval; stop on any Intuit security prompt, captcha, MFA, or "session expired".

## 5. UI exploration plan (depth-first, deep-link first)

1. Sign in on a **sandbox/test company** (Intuit Developer sandbox or `qbo.intuit.com` test-drive
   company) — never explore on production books.
2. For each area in section 4, depth-first: list page → filters/columns → row detail → each tab →
   "New" form → each field/dropdown → save/void menus. Back out only when a branch is exhausted.
3. At each node record into `routes.json` / `selectors.json`:
   URL (pathname + query params, e.g. `txnId`, `nameId`, `token`), ready selector, key selectors
   (prefer `data-automation-id`, `data-testid`, aria-label, role+name; avoid hashed CSS classes),
   form field ids, network calls observed (XHR endpoint + method, via CDP Network log) for a possible
   JSON-API fast path, and timing (navigation→ready ms).
4. Prefer **direct deep links** over click paths; only fall back to clicks when no URL exists.
5. Write `02-ui-map-<area>.md` per area with screenshots-in-words; flag fragile items.
6. Re-verify the map quarterly / on QBO UI change; `qbo doctor --probe` checks every route's ready selector.

## 6. Deep-link feasibility

QBO's SPA is plausibly drivable by URL (to be verified in exploration). Known/likely routes on
`https://qbo.intuit.com/app/...`: `homepage`, `customers`, `customerdetail?nameId=<id>`, `vendors`,
`vendordetail?nameId=<id>`, `invoice` (new) / `invoice?txnId=<id>`, `estimate`, `bill`, `expense`,
`check`, `recvpayment`, `salesreceipt`, `creditmemo`, `journal`, `items`, `chartofaccounts`,
`register?accountId=<id>`, `banking`, `reportlist`, `reportv2?token=PROFIT_AND_LOSS` (also
`BALANCE_SHEET`, `AR_AGING_SUMMARY`, `AP_AGING_SUMMARY`, `GENERAL_LEDGER`, with `&date_macro=`/
`low_date=`/`high_date=` params), `settings?p=Company`, `sales`, `invoices`, `expenses`,
`transactions`/`search`. Caveats: some environments use `app.qbo.intuit.com` or regional hosts
(`qbo.intuit.com` vs `ca.qbo.intuit.com` etc.); deep links redirect to sign-in/company selection when
the session or realm differs; new "QuickBooks experience" UI may rename routes. Internal XHR APIs
(`/qbo<NN>/neo/v1/company/<realm>/...`) exist and could power fast reads like salesnav's in-page
fetch, but are undocumented — treat as optional. The official QBO REST API (OAuth app) is a separate,
more stable option but needs a developer app; out of scope for a browser skill.

## 7. Test plan

**Unit / offline (CI, no network)**
- pytest: manifest/version parity (extend `test_repo_manifest.py`), vendored runtime drift, routes.json
  and selectors.json schema, plan validation, approval-gate logic, output parsing from saved HTML/JSON fixtures.
- node `--test`: CLI arg parsing, `--json` output, gate flags, snippet behaviour in `node_snippet_runner.js` with stubbed DOM/fetch.

**Functional (sandbox company, opt-in `QBO_LIVE=1`)**
- Per command: `doctor`, `open <area>` for every route (ready selector found), list/get/search per
  area, each report token with a date range + CSV export, then gated writes on sandbox only:
  create customer → create invoice → receive payment → void; bill → pay bill; expense; estimate→invoice.
  Assert by reading back. Session tests: signed-out exits 3; wrong realm refuses writes; captcha stop.

**Speed (timed runs)**
- `qbo bench` runs each command N=5 cold + warm, records nav→ready ms, total ms, request count to
  `bench.jsonl`; report p50/p95 per command; compare deep link vs click path for each area.
- Targets (initial, tune after measurement): deep-link open p50 < 3 s, list/read < 5 s, report < 8 s,
  single write < 15 s. Regression fails if p50 worsens > 25 % vs committed baseline.
- Run on both Agent Browser (cloud) and local CDP.

## 8. Open questions / blockers
- Need a QBO sandbox or test company + a signed-in browser profile to explore (none available yet).
- Confirm hosted-browser-agent's `/browser/claim` contract still matches `session.py` and supports
  persistent per-user Intuit login across sessions.
- Intuit bot detection / MFA frequency in the cloud browser is unknown.
- Decide CLI language: Node (grokbot style) vs extend Python `session.py` only.
