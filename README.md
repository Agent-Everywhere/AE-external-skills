# AE external skills

Agent Everywhere's shareable Claude skills and plugins, installable from one marketplace
(`Agent-Everywhere/AE-external-skills`). Each skill is portable: it works for any company, asks the
user only for what it needs, and runs inside the user's own Claude (Claude Code, Claude Desktop, or
another agent with shell or browser access, as noted per plugin below).

## What do you want to do?

Paste the sentence into your AI agent (Claude, Codex, Grok Bot or similar). It installs the skill and walks you
through setup. You only sign in to the website yourself, in your own browser; the agent never needs your password.

### Plain LinkedIn (no Sales Navigator needed)

| I want to... | Paste this | You need |
|---|---|---|
| Get emails for my LinkedIn connections | `Install the linkedin-emails skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/linkedin-emails and set it up for me.` | Your LinkedIn Connections.csv, a signed-in LinkedIn tab |
| Find people on LinkedIn by keywords (like "realtor") without Sales Navigator | `Install the linkedin-find-people skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/linkedin and set it up for me.` | A LinkedIn account, signed in in your browser |
| Draft and send my LinkedIn connection requests and messages (I approve every batch) | `Install the linkedin-outreach skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/linkedin and set it up for me.` | A LinkedIn account, signed in in your browser |
| See who accepted my connection requests and who replied | `Install the linkedin-replies skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/linkedin and set it up for me.` | A LinkedIn account, signed in in your browser |

These run on a normal (classic) LinkedIn account, with no Sales Navigator seat and no paid tool.

### Sales Navigator (needs a seat)

These run on LinkedIn Sales Navigator, a separate paid LinkedIn product. They need a Sales Navigator seat; a plain (classic) LinkedIn account is not enough.

| I want to... | Paste this | You need |
|---|---|---|
| Find decision-makers at a list of companies | `Install the salesnav-find-people skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/sales-navigator and set it up for me.` | A LinkedIn Sales Navigator seat, signed in in your browser |
| Find the companies that match my ideal customer | `Install the salesnav-find-companies skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/sales-navigator and set it up for me.` | A LinkedIn Sales Navigator seat |
| Split a Sales Navigator search that is too big to pull at once, and track what is covered | `Install the salesnav-split-big-search skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/sales-navigator and set it up for me.` | A LinkedIn Sales Navigator seat |
| Draft and send my daily LinkedIn outreach (I approve every batch) | `Install the salesnav-outreach skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/sales-navigator and set it up for me.` | A LinkedIn Sales Navigator seat |
| See who accepted and who replied on LinkedIn | `Install the salesnav-inbox skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/sales-navigator and set it up for me.` | A LinkedIn Sales Navigator seat, signed in in your browser |

### Other tools

| I want to... | Paste this | You need |
|---|---|---|
| Ask questions of my QuickBooks Online books | `Install the quickbooks skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/quickbooks and set it up for me.` | Node 20+, Chrome signed in to QuickBooks Online |
| Research Sourcewell contracts, bids and agencies | `Install the sourcewell skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/sourcewell and set it up for me.` | Node 20+ |

The five `salesnav-*` skills above (`salesnav-find-people`, `salesnav-find-companies`, `salesnav-split-big-search`, `salesnav-outreach`, `salesnav-inbox`) are each one job from the `sales-navigator` plugin (below), installed on its own. `linkedin-emails` is a separate plugin and works on plain LinkedIn. So do `linkedin-find-people`, `linkedin-outreach` and `linkedin-replies`: three plugins that each install one skill of the `linkedin` plugin folder (below) with its shared engine. They are not the Sales Navigator skills, and need no seat.

**For the agent reading this:** the plugin names above are marketplace plugin names (Claude Code: `/plugin marketplace add Agent-Everywhere/AE-external-skills`, then `/plugin install <name>@ae-external-skills`). If you install by copying folders instead, copy the skill folder AND the shared engine `plugins/sales-navigator/skills/sales-navigator` next to it, then follow the "Install (for you, the agent)" section of the skill's `SKILL.md`:

| Plugin | Skill folder under `plugins/sales-navigator/skills/` |
|---|---|
| `salesnav-find-people` | `salesnav-tam-people` |
| `salesnav-find-companies` | `salesnav-tam-accounts` |
| `salesnav-split-big-search` | `salesnav-tam-tracker` |
| `salesnav-outreach` | `salesnav-outreach` |
| `salesnav-inbox` | `salesnav-diy-linkedin` |

The three plain-LinkedIn job plugins are the same idea over `plugins/linkedin/skills/` (shared engine folder: `linkedin`):

| Plugin | Skill folder under `plugins/linkedin/skills/` |
|---|---|
| `linkedin-find-people` | `linkedin-find-people` |
| `linkedin-outreach` | `linkedin-outreach` |
| `linkedin-replies` | `linkedin-replies` |

Copy the skill folder AND the shared engine `plugins/linkedin/skills/linkedin` next to it, then follow the "Install (for you, the agent)" block in the skill's `SKILL.md`. `linkedin-emails`, `quickbooks` and `sourcewell` are `plugins/<name>/skills/<name>`.

### For developers / power users

| Skill | What it is |
|---|---|
| `grokbot` | The `grokbot` CLI and a skill to drive your Grok Bot desktop app from Claude Code on your Mac |
| `grokbot-box` | Skill for a Grok Bot agent inside its own cloud box to manage its sibling workers |
| `desktop-cowork` | Skill that drives the Claude Desktop app on your Mac (Cowork tasks, projects, connectors) |

Details are in the table below.

## What's in here

Install only the ones you need. The five job plugins `salesnav-find-people`, `salesnav-find-companies`,
`salesnav-split-big-search`, `salesnav-outreach` and `salesnav-inbox` each install one skill of the `sales-navigator` plugin;
the table lists the other plugins (`linkedin-emails` is its own plugin). The three plain-LinkedIn plugins `linkedin-find-people`, `linkedin-outreach` and `linkedin-replies` each install one skill of the `linkedin` plugin folder, with its shared engine.

| Plugin | What it is | Who it's for | Where it runs | Needs | Install |
|---|---|---|---|---|---|
| [`grokbot`](skills/grokbot/SKILL.md) | CLI + skill. The `grokbot` command (bundled single-file Node CLI) plus a skill that drives it: status/doctor, agents, groups, sections, pins, transcripts, `send --wait`, app restart | A person on their Mac who wants Claude Code to drive their Grok Bot desktop app | Claude Code on the Mac that has Grok Bot installed | Node 20+, the signed-in Grok Bot app | `/plugin install grokbot@ae-external-skills` (CLI alone: see Install) |
| [`grokbot-box`](skills/grokbot-box/SKILL.md) | Skill only. No CLI bundled: it clones this repo inside the box and uses the `grokbot` CLI from there | A Grok Bot agent inside its own cloud box that manages its sibling workers (list, create, organize, send, delete) under a restricted, audited agent policy | Inside a Grok Bot cloud box | Node 20+ in the box, a clone of this repo | `/plugin install grokbot-box@ae-external-skills` |
| [`desktop-cowork`](skills/claude-desktop/SKILL.md) | Skill + helper script (`desktop.py`, using Peekaboo). The skill folder is `claude-desktop`; the plugin name avoids the `claude-` prefix, which the marketplace reserves | Claude Code on a Mac driving the Claude Desktop app: Cowork tasks, replies, approvals, projects, skills, connectors, plugins, scheduled tasks | Claude Code on your Mac, controlling the Desktop app by screenshots and clicks | macOS 15+, Peekaboo, Screen Recording / Accessibility / Automation permission | `/plugin install desktop-cowork@ae-external-skills` |
| [`sales-navigator`](plugins/sales-navigator/skills/sales-navigator/SKILL.md) | One plugin bundling 6 skills: the `sales-navigator` toolkit plus `salesnav-tam-accounts`, `salesnav-tam-people`, `salesnav-tam-tracker`, `salesnav-outreach` and `salesnav-diy-linkedin` | Anyone with a LinkedIn Sales Navigator seat who sizes markets, builds lists and runs outreach | Claude Desktop / Cowork's built-in browser, or your own Chrome | A signed-in Sales Navigator seat | `/plugin install sales-navigator@ae-external-skills` |
| [`quickbooks`](plugins/quickbooks/skills/quickbooks/SKILL.md) | CLI + skill. The `qbo` command (bundled single-file Node CLI) plus a skill: doctor, lists, search, reports (P&L, balance sheet, aging, general ledger...), and approval-gated create / void / delete. Calls QuickBooks Online's own API from inside your signed-in tab, with page reading as a fallback | Anyone with a QuickBooks Online company who wants Claude to read the books and do small, approved bookkeeping steps | Claude Code (or any agent with shell access) attached to your own Chrome over CDP | Node 20+, a browser signed in to QuickBooks Online | `/plugin install quickbooks@ae-external-skills` |
| [`sourcewell`](plugins/sourcewell/skills/sourcewell/SKILL.md) | CLI + skill. The `sourcewell` command (bundled single-file Node CLI, no dependencies) plus a skill: who holds a Sourcewell cooperative contract and when it expires, open and upcoming (planned) bids, past RFP bidders and awardees, re-bid candidates, and participating agencies by state or type. Read-only; JSON or CSV output | Anyone prospecting US public-sector buyers through cooperative purchasing | Claude Desktop (Cowork task) or Claude Code; no browser | Node 20+ (Cowork has it); only `docs download` needs your own procurement-portal login | `/plugin install sourcewell@ae-external-skills` |
| [`linkedin-emails`](plugins/linkedin-emails/skills/linkedin-emails/SKILL.md) | Skill + scripts (`emails.py`, `contact_info.js`, `download_export.js`). Fills the blank emails in your LinkedIn connections CSV (the export has about 3 in 100) by reading each person's Contact info from your own logged-in LinkedIn tab: 40 per run, at most 120 a day, 6 to 12 seconds apart, stops the day on any rate-limit or checkpoint. Read-only; no hosted service | A salesperson with a Connections.csv who wants emails for their own network | A Grok Bot box, Claude Code, Claude Desktop / Cowork or Codex, driving a browser you are logged into | Python 3, a logged-in linkedin.com tab the agent can run JavaScript in | `/plugin install linkedin-emails@ae-external-skills` (or paste the link, see Install by link) |
| [`linkedin-find-people`](plugins/linkedin/skills/linkedin-find-people/SKILL.md), [`linkedin-outreach`](plugins/linkedin/skills/linkedin-outreach/SKILL.md), [`linkedin-replies`](plugins/linkedin/skills/linkedin-replies/SKILL.md) | Three skills over one shared engine (`plugins/linkedin/skills/linkedin`: `find_people.py`, `outreach.py`, `replies.py`, `search_people.js`, `poll.js`). Find people with a normal LinkedIn search (10 result pages a day, 8 to 15 seconds apart); draft connection notes and messages and send them one at a time by UI click after you type approval of the exact batch (20 requests a day and 100 a week, 40 messages a day, 3 per person); read who accepted and who replied (4 polls a day, no message text kept). No hosted service | A salesperson or founder on a normal LinkedIn account | A Grok Bot box, Claude Code, Claude Desktop / Cowork or Codex, driving a browser you are logged into | Python 3, a logged-in linkedin.com tab the agent can run JavaScript in | `/plugin install linkedin-find-people@ae-external-skills`, `linkedin-outreach@ae-external-skills`, `linkedin-replies@ae-external-skills` (or paste the link from the table above) |

`grokbot` and `grokbot-box` are not the same thing: `grokbot` is for a human on a Mac, `grokbot-box`
is for an agent inside a box. Each skill points to the other.

The `sales-navigator` plugin's six skills:

- [`sales-navigator`](plugins/sales-navigator/skills/sales-navigator/SKILL.md): the slim toolkit for your own seat: exact counts, account and lead searches through the in-page API, website lookups, CSV and cap-tracking scripts, example flows. Read-only except account lists you name and confirm, and sends you explicitly approve per batch.
- [`salesnav-tam-accounts`](plugins/sales-navigator/skills/salesnav-tam-accounts/SKILL.md): build a company-side TAM: a broad industry/geo/headcount net (plus optional priority keyword lanes), rows at 100 per call, company details scored for fit, a qualified-account count, multi-segment merge, optional save to an account list you name. Read-only otherwise.
- [`salesnav-tam-people`](plugins/sales-navigator/skills/salesnav-tam-people/SKILL.md): build the people side: a lead search scoped to the qualified account ids, exact counts per variant, rows at 100 per call. Uses an account list (`ACCOUNT_LIST` filter) when one exists; saves no leads.
- [`salesnav-tam-tracker`](plugins/sales-navigator/skills/salesnav-tam-tracker/SKILL.md): cut a master search over the viewable cap into sub-lists, pull them, dedupe across shards, track coverage in `tam_tracker.csv`.
- [`salesnav-outreach`](plugins/sales-navigator/skills/salesnav-outreach/SKILL.md): daily connection requests, InMails, messages and follow-ups with an outreach ledger. Drafts by default; sends only after you type approval of the exact batch.
- [`salesnav-diy-linkedin`](plugins/sales-navigator/skills/salesnav-diy-linkedin/SKILL.md): what a hosted LinkedIn API does, from your own signed-in browser: profile and member-id lookup, who accepted, inbox replies, InMail credits, and approved sends by UI click after typed approval of the exact batch under conservative caps. Backed by KB 16.

> **Unofficial.** `desktop-cowork` is not affiliated with or endorsed by Anthropic. It drives the app by screenshots and clicks, which may break when the app's layout changes, and it takes over your mouse and keyboard while it runs: read the rules in its [`SKILL.md`](skills/claude-desktop/SKILL.md) first.
>
> **Unofficial.** `quickbooks` is not affiliated with or endorsed by Intuit. It uses QuickBooks Online's web-app interfaces from your signed-in browser, which may change. Writes change real books and run only with `--yes` after you approve them.
>
> **Unofficial.** `sourcewell` is not affiliated with or endorsed by Sourcewell. It reads Sourcewell's public website data and bid portal pages, which may change. It is read-only; it never registers for, submits or asks questions on a bid.
>
> **Unofficial.** `linkedin-emails` is not affiliated with or endorsed by LinkedIn. It calls LinkedIn's own web endpoints from your signed-in tab, which may change or be limited by LinkedIn, and LinkedIn's terms apply to your account. It is read-only and paced; read its [`SKILL.md`](plugins/linkedin-emails/skills/linkedin-emails/SKILL.md) hard rules first.
>
> **Unofficial.** `linkedin-find-people`, `linkedin-outreach` and `linkedin-replies` are not affiliated with or endorsed by LinkedIn. They read LinkedIn's own pages and web endpoints from your signed-in tab, which may change or be limited by LinkedIn (free accounts also have a monthly search limit), and LinkedIn's terms apply to your account. Every send is a click in the LinkedIn UI after you type approval of the exact batch; read their `SKILL.md` hard rules first.
>
> **Unofficial.** `grokbot` and `grokbot-box` are not affiliated with or endorsed by Cursor or xAI. They use Grok Bot's private, undocumented interfaces, which may change or break at any time. Use at your own risk: some commands can delete agents and sections.

## Install

**Claude Code**: add the marketplace once, then install the plugins you want:

```
/plugin marketplace add Agent-Everywhere/AE-external-skills
/plugin install grokbot@ae-external-skills
/plugin install grokbot-box@ae-external-skills
/plugin install desktop-cowork@ae-external-skills
/plugin install sales-navigator@ae-external-skills
/plugin install salesnav-find-people@ae-external-skills
/plugin install salesnav-find-companies@ae-external-skills
/plugin install salesnav-split-big-search@ae-external-skills
/plugin install salesnav-outreach@ae-external-skills
/plugin install salesnav-inbox@ae-external-skills
/plugin install quickbooks@ae-external-skills
/plugin install sourcewell@ae-external-skills
/plugin install linkedin-emails@ae-external-skills
/plugin install linkedin-find-people@ae-external-skills
/plugin install linkedin-outreach@ae-external-skills
/plugin install linkedin-replies@ae-external-skills
```

### Install by link (any agent)

For `linkedin-emails`, paste one sentence into your AI agent (Grok Bot, Claude Code, Claude Desktop / Cowork or Codex):

> Install the linkedin-emails skill from https://github.com/Agent-Everywhere/AE-external-skills (the folder
> `plugins/linkedin-emails/skills/linkedin-emails`), follow the Install section of its SKILL.md for your setup,
> then help me fill in the emails in my LinkedIn connections CSV.

The agent clones the public repo, puts the folder where your agent keeps skills, and walks you through it. You
only log into LinkedIn yourself in the browser it opens; it never needs your password.

### Install in Claude Desktop (no GitHub)

For the `sales-navigator` plugin, with no GitHub account, marketplace or Claude GitHub App:

1. Download [`sales-navigator.zip`](https://github.com/Agent-Everywhere/AE-external-skills/releases/download/sales-navigator-latest/sales-navigator.zip)
   from the `sales-navigator-latest` release. (The same file is also published as `sales-navigator.plugin`. Versioned
   `sales-navigator-v<version>` releases also exist if you want to pin one.)
2. In Claude Desktop, open Customize > Plugins > Add > Upload plugin, pick the zip, then click Upload.

Or, in a Cowork task, ask: "Download
https://github.com/Agent-Everywhere/AE-external-skills/releases/download/sales-navigator-latest/sales-navigator.plugin
and present the .plugin file to me so I can install it." Claude shows a plugin card; click **Save plugin**.

Use one install path only. An uploaded or saved copy shows up as "Sales navigator (Local uploads)" next to any
marketplace copy, "Sales navigator (AE-external-skills)", and Desktop gives no warning. If you see both, remove
one from its row's "..." menu.

Needs a Claude Pro, Max, Team or Enterprise plan. The skills work in chat, and in Cowork the plugin
runs in full (scripts included).

**Updating:** download the new `sales-navigator.zip` from the `sales-navigator-latest` release and upload it again.
Nothing updates on its own on this path. To build the same zip yourself:
`bash scripts/build-plugin-zip.sh sales-navigator` (writes `dist/sales-navigator.zip`).

### Auto-update option (marketplace)

**Claude Desktop**: Customize > Plugins > Add > Add marketplace > Add from a repository >
`Agent-Everywhere/AE-external-skills` > Sync, then Add the plugin you want. Auto-sync needs the
Claude GitHub App to have access to this repository; without that the plugin installs but does not
update itself. To update by hand: Add > Manage marketplaces > AE-external-skills "..." > Check for updates,
then the plugin's "..." > Check for updates, and click Update on the plugin page. The full URL
`https://github.com/Agent-Everywhere/AE-external-skills` also works in the repository field.

**Without plugins** (claude.ai, or a one-off skill): download the folder you want from
`skills/<skill-name>/` as a zip and add it as a skill. The Sales Navigator skills are the exception:
they share one engine, so a `salesnav-*` skill on its own has no tools. Zip all of
`plugins/sales-navigator/` (its `skills/` folder holds the engine and the purpose skills) and add the
skills from that zip together. The plain-LinkedIn skills work the same way: zip all of `plugins/linkedin/`
(`cd plugins/linkedin && zip -r ../../dist/linkedin.zip skills -x '*/__pycache__/*'`) and add the skills from that zip together. `grokbot` runs a local CLI, so it needs Claude
Code (or another agent with shell access) on the Mac that has Grok Bot installed.

**Just the `grokbot` CLI** (no Claude needed; Node 20+; rerun to update):

```
mkdir -p ~/.local/bin && curl -fsSL https://github.com/Agent-Everywhere/AE-external-skills/releases/latest/download/grokbot.mjs -o ~/.local/bin/grokbot && chmod +x ~/.local/bin/grokbot
```

The `sales-navigator` engine (used by the `salesnav-*` skills too) and `quickbooks` run in the user's own browser. The other skills ship their own tooling and need no browser connector.

## Upgrading

**`sales-navigator`: update the plugin from the marketplace; no reinstall needed.** Sync the marketplace
(Claude Desktop: Customize > Plugins > the marketplace > Sync; Claude Code: `/plugin marketplace update
ae-external-skills`), then update `sales-navigator`. The plugin name and the marketplace name did not change;
each release bumps the plugin `version` in `.claude-plugin/marketplace.json` (and the engine's `skill.yaml`)
so clients see the update. As of 0.5.0 the plugin ships only its five skills, and every `SKILL.md` finds the
shared engine through `ENGINE` (`${CLAUDE_PLUGIN_ROOT}/skills/sales-navigator`, else the `sales-navigator` folder
next to the skill's own), so Cowork runs the scripts instead of clicking the Sales Nav UI. 0.6.0 adds a standard front half to all TAM work: research the seller's site, one short intake
round (at most 5 questions), calibrate on example customers, then accounts, then people scoped to the qualified accounts.
0.6.1 finds the engine in Cowork (`/mnt/skills/plugin-files/sales-navigator`, where `CLAUDE_PLUGIN_ROOT` is empty) with a search fallback, does seller research and intake before the engine check, and never substitutes another data source for the Sales Nav count.
0.7.0 adds saving accounts to a Sales Nav list (`lists.js`, `list_create.js`, `list_save_accounts.js`; exact list name confirmed once per run, 50 accounts per call, paced, auto-sharded at the 1,000-account list cap (`list_save_sharded.js`, checks per-entry `EXCEED_LIMIT` and `entityCount`), not quota-capped), `segments.py` for multi-segment plans and merges, account-first people search through the `ACCOUNT_LIST` filter, and a field-notes KB in `plugins/sales-navigator/skills/sales-navigator/references/salesnav-kb/` (ships in the plugin zip).

0.7.1 adds a batch-scrape KB page (`15-batch-scrape.md`: the 100-id decoration batch-get tier, field lists with fill rates, what is not available, profile-view evidence, tier comparison), more default company fields in `companies_details.js` (employee and decision-maker display counts, location; the 2147483647 growth sentinel returns `new`), and an opt-in `extras: true` on `profiles_batch.js` (education, skills, languages, connections, badges, InMail restriction in the same single call).

0.7.2 wires the field-notes KB into `salesnav-outreach` (read KB 01 before step 1 and KB 05 before the send step) and points the runtime and log scripts at KB 05 / `reference.md` instead of the retired `references/guardrails.md`.

0.8.0 adds `salesnav-diy-linkedin` and KB page 16 (`16-diy-linkedin-endpoints.md`): the loop a hosted LinkedIn API (such as Unipile) provides, run from your own signed-in browser. Reads use same-origin fetches mapped in KB 16; writes stay UI clicks after typed approval of the exact batch, under the outreach caps (now including a 20-a-day InMail / Open Profile cap in `outreach_log.py`). Also covers saved searches (list verified; running one is a UI action that resets its counter). It also adds KB 17 (`17-bulk-pulls.md`: verified list reads — account list → companies via the `ACCOUNT_LIST` account search, 100/page, page until a short page, up to 1,000 rows; lead list → people via the `LEAD_LIST` lead search; company and profile deep-scrape at 100 per call; companies-then-people with `scripts/company_chunks.py`, up to 400 company ids per query) and KB 18 (`18-posts-and-engagers.md`: read-only creator posts, reactions, comments and content search). `profiles_batch.js` now takes bare profile ids and a URLs-only mode, and the `run_log.py` quota table shows InMails against the 20-a-day cap.

0.8.1 checks every page snippet's params before a session is claimed (unknown or missing params exit 2 with a did-you-mean; `typeahead.js` takes `query` as an alias of `term`) and adds field notes to the KB: per-seat limits from outside sources as reported on 2026-10-16 (vendor export caps, about 150 profile views a day, pacing tiers, seat cost per 1,000 rows) in KB 05; keyword and API quirks (`NOT` only drops companies that use the word, double-meaning keywords, self-labelled industries, the deprecated `salesApiCompanySearch`) in KB 04; notes for runners that read rendered result pages (never headless, one run per seat, human pacing, selectors, stop phrases) in KB 01; and 11 more US state ids in `reference.md`.

0.9.0 adds the five job plugins (each one skill of this plugin, installed with the shared engine), and drops the cloud-browser option: the runtime now attaches only to your own Chrome over CDP. `quickbooks` 0.2.0 does the same.

0.9.1 renames the five job plugins from `linkedin-*` to `salesnav-*` (the same day they were added in 0.9.0), because they run on LinkedIn Sales Navigator and need a Sales Navigator seat, which plain (classic) LinkedIn does not include: `salesnav-find-people`, `salesnav-find-companies`, `salesnav-split-big-search`, `salesnav-outreach` and `salesnav-inbox`. The old `linkedin-*` names were gone for that release. If you installed one under its old name, run `/plugin uninstall <old-name>@ae-external-skills`, then install the new one. `linkedin-emails` is unchanged.

`linkedin-find-people`, `linkedin-outreach` and `linkedin-replies` 0.10.0 are new: the plain-LinkedIn (no Sales Navigator) counterparts of the `salesnav-*` jobs, built over one shared `linkedin` engine folder. Three of the `linkedin-*` names are used again, now for classic LinkedIn. They start at 0.10.0, above the 0.9.x of the Sales Navigator plugins that used the same names for one day, so a client that installed one of those sees an update, never a downgrade. If you installed `linkedin-find-people`, `linkedin-outreach` or `linkedin-replies` before `sales-navigator` 0.9.1, that was the Sales Navigator version; run `/plugin uninstall <name>@ae-external-skills` and install the `salesnav-*` one you meant (`salesnav-find-people`, `salesnav-outreach`, `salesnav-inbox`) if you have a seat.

**Version rule.** Every plugin entry in `.claude-plugin/marketplace.json` carries its own `version`, and clients see an update only when that entry's version goes up. Bump the entry of each plugin you change on every release (for the three `linkedin-*` plugins, together with the `version` in the engine's and the three skills' `skill.yaml`; tests pin that they agree). Update them the same way as `sales-navigator`: sync the marketplace, then update the plugin.

The hosted cloud browser option was removed in `sales-navigator` 0.9.0 and `quickbooks` 0.2.0: `AB_CLAIM`, `AB_BASE` and `QBO_SESSION_FILE` are now ignored, and the tools attach only to your own Chrome over CDP.

If you installed the older `claude-desktop`, `salesnav-tam-accounts`, `salesnav-tam-people`,
`salesnav-tam-tracker` or `salesnav-outreach` plugins, run `/plugin uninstall <name>@ae-external-skills`
for each, then install `desktop-cowork` and `sales-navigator`.

If you installed `ae-desktop-operator` (the earlier name of `desktop-cowork`), run
`/plugin uninstall ae-desktop-operator@ae-external-skills`, then install `desktop-cowork`.

## Layout

```
.claude-plugin/
  marketplace.json  # Claude Code marketplace: one plugin per skill, except sales-navigator (bundles its six skills)
                    # the five salesnav-* job plugins (same source, one skill each) and the three
                    # linkedin-* job plugins (source plugins/linkedin, one skill each)
plugins/sales-navigator/   # the ONLY folder the sales-navigator plugin installs (marketplace `source`)
  skills/
    sales-navigator/        # the shared ENGINE: page/, scripts/, runtime/, reference.md, recipes.md, templates/
    salesnav-tam-accounts/  # SKILL.md + skill.yaml only; each reaches the engine through ENGINE (see below)
    salesnav-tam-people/
    salesnav-tam-tracker/
    salesnav-outreach/
    salesnav-diy-linkedin/
plugins/linkedin/          # plain LinkedIn (no Sales Navigator): the folder the three linkedin-* job plugins install
  skills/
    linkedin/               # the shared ENGINE (no SKILL.md): scripts/ (find_people.py, outreach.py, replies.py, li_common.py,
                            # search_people.js, poll.js), references/endpoints.md, skill.yaml
    linkedin-find-people/   # SKILL.md + skill.yaml only; each reaches the engine through ENGINE
    linkedin-outreach/
    linkedin-replies/       # fixtures in tests/fixtures/linkedin_classic/ (a redacted search page)
plugins/linkedin-emails/   # skill + scripts/ (emails.py, contact_info.js, download_export.js); fixtures in tests/fixtures/linkedin_emails/
packages/
  browser-runtime/  # SOURCE OF TRUTH for the shared browser runtime (session.py + one README)
build/
  sync_runtime.py   # vendors packages/browser-runtime into each skill that lists a runtime (only the
                    # engine does); --check fails on drift
skills/<skill-name>/    # the standalone plugins: grokbot, grokbot-box, claude-desktop
  SKILL.md          # entry point: frontmatter (name, description) + procedure
  skill.yaml        # manifest: name, version, category, runtimes ([] or [local])
  reference.md, recipes.md, references/   # optional on-demand docs, kept small
                    # (the `salesnav-*` purpose skills hold no copies: SKILL.md and skill.yaml only)
  scripts/          # optional helpers (Python 3 stdlib only, no network), run in the user's Claude
  page/             # optional JS snippets run inside the signed-in page by the browser runtime
  runtime/          # vendored copy of packages/browser-runtime (generated; never edit here)
  cli/              # optional Node CLI (Node >= 20), for skills that wrap a command-line tool
  cli/dist/         # committed single-file bundle of the CLI (no npm install needed); rebuild with `npm run build`
tests/              # Python tests for scripts, the runtime, page snippets, manifests and vendoring
```

Browser-runtime changes are made once, in `packages/browser-runtime/`, then propagated with
`python3 build/sync_runtime.py`, then run `python3 build/sync_runtime.py --check` before committing.
The four `salesnav-*` purpose skills carry no copies of the tools. They share one engine, the
`sales-navigator` skill next to them, and every command in their `SKILL.md` is written against `ENGINE`:
`ENGINE=${CLAUDE_PLUGIN_ROOT}/skills/sales-navigator` when `CLAUDE_PLUGIN_ROOT` is set, else the
`sales-navigator` folder beside the skill's own folder. A bare `scripts/x.py` would resolve against the user's
project folder, so a test fails any `SKILL.md` that has a bare `scripts/`, `page/`, `runtime/` or `templates/`
path. Step 0 of every flow is `python3 "$ENGINE/scripts/doctor.py"`, and a failing doctor means stop: never
drive the Sales Nav UI by hand. Fix a tool once, in the engine.
The tests run the same check and fail if a skill's `runtime/` copy has drifted (or a skill with
`runtimes: []` still has a `runtime/` folder).

Most marketplace entries use their own skill folder as the plugin source (`"source": "./skills/<name>"`,
`"skills": ["."]`), so a plugin installs only its own skill. The exception is `sales-navigator`, one
bundled plugin with `"source": "./plugins/sales-navigator"`, `"strict": false`, a `version` and an explicit
`skills` list of its six skill folders (paths relative to that source). The source folder holds only
`skills/`, so `tests/`, `build/`, `packages/` and `.github/` never ship into an install (a test pins this).
Do not point any plugin at the repo root. Bump the entry's `version` with the engine's `skill.yaml`
`version` on every release of the plugin, or clients will not see the update (a test pins that too). `grokbot-box` does not
ship the CLI; it installs it inside the box by cloning this repo.

## Conventions

- **Client-agnostic.** No customer names, data, or assumptions in a skill. Example profiles live
  under `examples/`, never inside a skill.
- **Ask once.** Skills read a user's Company Profile (kept wherever the user likes: chat, project
  file, CSV, Google Drive) and only ask for missing fields.
- **Standard hand-off files.** Skills in the same workflow share CSV columns so a user can start
  at any step.
- **Safe by default.** Read-only unless the skill's purpose is to act; outward actions (sending,
  posting) require the user's approval and documented limits.
- **Scripts:** Python 3 standard library only, no network, tested under `tests/`. (The `tests/`
  convention applies to Python scripts; `grokbot`'s CLI tests live in `skills/grokbot/cli/tests/` and run with `npm test`.)
- **Exception: the browser runtime.** `packages/browser-runtime/session.py` is the one place that
  touches the network (Playwright's CDP connection to the user's own Chrome; it needs
  `pip install playwright`, imported lazily). Skill scripts under
  `skills/<name>/scripts/` stay stdlib and no-network. Page snippets under `skills/<name>/page/` run
  inside the user's signed-in browser, return compact JSON, and never return cookies or tokens.
- **Runtimes manifest.** Every skill has a `skill.yaml` (`name`, `version`, `category`, `runtimes`)
  whose `category` matches its `marketplace.json` entry (the skill's own plugin entry, or, for the
  five Sales Navigator skills, the bundled `sales-navigator` plugin whose `skills` list names it).
  `runtimes` is `[]` for skills without a browser, or a
  list containing `local` (the user's own browser); a non-empty list
  gets `packages/browser-runtime` vendored into `runtime/`. Only the engine does; the purpose skills
  say `runtimes: []` plus `engine: sales-navigator`.
- **Exception: Node CLI.** A skill may ship a Node CLI under `cli/` (Node >= 20, with its own
  `package.json` and lockfile; install with `npm install --omit=dev`, or run the committed bundle
  `cli/dist/grokbot.mjs` directly). This is the one exception
  to the Python-stdlib scripts rule, and the skill's `SKILL.md` documents the install.
- **Packaging.** Each standalone skill folder zips into an installable skill:
  `cd skills && zip -r ../dist/<skill-name>.zip <skill-name> -x '*/node_modules/*'`. The Sales Navigator
  skills share one engine, so zip them together, as the plugin ships them (a purpose skill alone has no tools):
  `cd plugins/sales-navigator && zip -r ../../dist/sales-navigator.zip skills -x '*/__pycache__/*'`.
  `grokbot-box` needs nothing else (it clones this repo inside the box).
- **Plain-LinkedIn engine.** `plugins/linkedin/skills/linkedin` has no `SKILL.md`: it is not a job, only the shared
  tools. Its three job skills find it through `ENGINE` (`${CLAUDE_PLUGIN_ROOT}/skills/linkedin`, else the `linkedin`
  folder beside the skill's own, else a search under `/mnt/skills` and `~/.claude/plugins`) and stop if it is missing.
  They run only on LinkedIn's own pages from the user's signed-in browser, and every send is a UI click after typed approval.
- **Upload-ready plugin zip.** `scripts/build-plugin-zip.sh <plugin-name>` builds `dist/<name>.zip` (plus an
  identical `.plugin`) with `.claude-plugin/plugin.json` at the zip root, for Claude Desktop's Upload plugin. The
  repo's plugin folder has no `plugin.json` (the marketplace entry is the source of truth), so the script generates one in
  a staging copy from the `.claude-plugin/marketplace.json` entry. Pushing a tag `sales-navigator-v<version>` runs
  `.github/workflows/release-plugin-zip.yml`, which builds with the script, fails unless `<version>` equals the
  plugin version in `.claude-plugin/marketplace.json` (the tag must match it), and attaches both files to that tag's
  GitHub Release, which is never marked Latest (the Latest release belongs to grokbot; see the rule below). The
  same run also moves a rolling `sales-navigator-latest` release to the new build, which gives the stable download URL.
- **Releasing the grokbot CLI.** The curl install downloads `grokbot.mjs` from the latest GitHub
  Release. After a change to `skills/grokbot/cli/` merges, rebuild `dist/` (`npm run build`), bump
  `version` in `package.json`, and publish:
  `gh release create grokbot-v<version> skills/grokbot/cli/dist/grokbot.mjs --title "grokbot v<version>" --latest`.
  Only grokbot releases may be marked `--latest`: the install URL follows the repo's latest release.
