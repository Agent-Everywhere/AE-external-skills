# AE external skills

Agent Everywhere's shareable Claude skills and plugins, installable from one marketplace
(`Agent-Everywhere/AE-external-skills`). Each skill is portable: it works for any company, asks the
user only for what it needs, and runs inside the user's own Claude (Claude Code, Claude Desktop, or
another agent with shell or browser access, as noted per plugin below).

## What's in here

Four plugins. Install only the ones you need.

| Plugin | What it is | Who it's for | Where it runs | Needs | Install |
|---|---|---|---|---|---|
| [`grokbot`](skills/grokbot/SKILL.md) | CLI + skill. The `grokbot` command (bundled single-file Node CLI) plus a skill that drives it: status/doctor, agents, groups, sections, pins, transcripts, `send --wait`, app restart | A person on their Mac who wants Claude Code to drive their Grok Bot desktop app | Claude Code on the Mac that has Grok Bot installed | Node 20+, the signed-in Grok Bot app | `/plugin install grokbot@ae-external-skills` (CLI alone: see Install) |
| [`grokbot-box`](skills/grokbot-box/SKILL.md) | Skill only. No CLI bundled: it clones this repo inside the box and uses the `grokbot` CLI from there | A Grok Bot agent inside its own cloud box that manages its sibling workers (list, create, organize, send, delete) under a restricted, audited agent policy | Inside a Grok Bot cloud box | Node 20+ in the box, a clone of this repo | `/plugin install grokbot-box@ae-external-skills` |
| [`desktop-cowork`](skills/claude-desktop/SKILL.md) | Skill + helper script (`desktop.py`, using Peekaboo). The skill folder is `claude-desktop`; the plugin name avoids the `claude-` prefix, which the marketplace reserves | Claude Code on a Mac driving the Claude Desktop app: Cowork tasks, replies, approvals, projects, skills, connectors, plugins, scheduled tasks | Claude Code on your Mac, controlling the Desktop app by screenshots and clicks | macOS 15+, Peekaboo, Screen Recording / Accessibility / Automation permission | `/plugin install desktop-cowork@ae-external-skills` |
| [`sales-navigator`](plugins/sales-navigator/skills/sales-navigator/SKILL.md) | One plugin bundling 5 skills: the `sales-navigator` toolkit plus `salesnav-tam-accounts`, `salesnav-tam-people`, `salesnav-tam-tracker` and `salesnav-outreach` | Anyone with a LinkedIn Sales Navigator seat who sizes markets, builds lists and runs outreach | Claude Desktop / Cowork's built-in browser, your own Chrome, or Agent Browser | A signed-in Sales Navigator seat; Agent Browser only: the connector `https://browser-mcp-production-6535.up.railway.app/mcp` (Google sign-in) | `/plugin install sales-navigator@ae-external-skills` |

`grokbot` and `grokbot-box` are not the same thing: `grokbot` is for a human on a Mac, `grokbot-box`
is for an agent inside a box. Each skill points to the other.

The `sales-navigator` plugin's five skills:

- [`sales-navigator`](plugins/sales-navigator/skills/sales-navigator/SKILL.md): the slim toolkit for your own seat: exact counts, account and lead searches through the in-page API, website lookups, CSV and cap-tracking scripts, example flows. Read-only except account lists you name and confirm, and sends you explicitly approve per batch.
- [`salesnav-tam-accounts`](plugins/sales-navigator/skills/salesnav-tam-accounts/SKILL.md): build a company-side TAM: a broad industry/geo/headcount net (plus optional priority keyword lanes), rows at 100 per call, company details scored for fit, a qualified-account count, multi-segment merge, optional save to an account list you name. Read-only otherwise.
- [`salesnav-tam-people`](plugins/sales-navigator/skills/salesnav-tam-people/SKILL.md): build the people side: a lead search scoped to the qualified account ids, exact counts per variant, rows at 100 per call. Uses an account list (`ACCOUNT_LIST` filter) when one exists; saves no leads.
- [`salesnav-tam-tracker`](plugins/sales-navigator/skills/salesnav-tam-tracker/SKILL.md): cut a master search over the viewable cap into sub-lists, pull them, dedupe across shards, track coverage in `tam_tracker.csv`.
- [`salesnav-outreach`](plugins/sales-navigator/skills/salesnav-outreach/SKILL.md): daily connection requests, InMails, messages and follow-ups with an outreach ledger. Drafts by default; sends only after you type approval of the exact batch.

> **Unofficial.** `desktop-cowork` is not affiliated with or endorsed by Anthropic. It drives the app by screenshots and clicks, which may break when the app's layout changes, and it takes over your mouse and keyboard while it runs: read the rules in its [`SKILL.md`](skills/claude-desktop/SKILL.md) first.
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
```

### Install in Claude Desktop (no GitHub)

For the `sales-navigator` plugin, with no GitHub account, marketplace or Claude GitHub App:

1. Download [`sales-navigator.zip`](https://github.com/Agent-Everywhere/AE-external-skills/releases/download/sales-navigator-latest/sales-navigator.zip)
   from the `sales-navigator-latest` release. (The same file is also published as `sales-navigator.plugin`. Versioned
   `sales-navigator-v<version>` releases also exist if you want to pin one.)
2. In Claude Desktop, open Customize > Plugins > Upload plugin and pick the zip.

Needs a Claude Pro, Max, Team or Enterprise plan. The skills work in chat, and in Cowork the plugin
runs in full (scripts included).

**Updating:** download the new `sales-navigator.zip` from the `sales-navigator-latest` release and upload it again.
Nothing updates on its own on this path. To build the same zip yourself:
`bash scripts/build-plugin-zip.sh sales-navigator` (writes `dist/sales-navigator.zip`).

### Auto-update option (marketplace)

**Claude Desktop**: Customize > Plugins > Add > Add marketplace > Add from a repository >
`Agent-Everywhere/AE-external-skills` > Sync, then Add the plugin you want. Auto-sync needs the
Claude GitHub App to have access to this repository; without that the plugin installs but does not
update itself.

**Without plugins** (claude.ai, or a one-off skill): download the folder you want from
`skills/<skill-name>/` as a zip and add it as a skill. The Sales Navigator skills are the exception:
they share one engine, so a `salesnav-*` skill on its own has no tools. Zip all of
`plugins/sales-navigator/` (its `skills/` folder holds the engine and the four purpose skills) and add the
skills from that zip together. `grokbot` runs a local CLI, so it needs Claude
Code (or another agent with shell access) on the Mac that has Grok Bot installed.

**Just the `grokbot` CLI** (no Claude needed; Node 20+; rerun to update):

```
mkdir -p ~/.local/bin && curl -fsSL https://github.com/Agent-Everywhere/AE-external-skills/releases/latest/download/grokbot.mjs -o ~/.local/bin/grokbot && chmod +x ~/.local/bin/grokbot
```

Skills that list `agent-browser` in their `skill.yaml` `runtimes` can drive Agent Everywhere's
cloud-browser MCP; the `sales-navigator` engine (used by the `salesnav-*` skills too) can also run in the
user's own browser (`local`). The other skills ship their own tooling and do not need that connector.

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
0.7.0 adds saving accounts to a Sales Nav list (`lists.js`, `list_create.js`, `list_save_accounts.js`; exact list name confirmed once per run, 50 accounts per call, paced and sharded at 900 accounts per list, not quota-capped), `segments.py` for multi-segment plans and merges, account-first people search through the `ACCOUNT_LIST` filter, and a field-notes KB in `docs/salesnav-kb/`.

If you installed the older `claude-desktop`, `salesnav-tam-accounts`, `salesnav-tam-people`,
`salesnav-tam-tracker` or `salesnav-outreach` plugins, run `/plugin uninstall <name>@ae-external-skills`
for each, then install `desktop-cowork` and `sales-navigator`.

If you installed `ae-desktop-operator` (the earlier name of `desktop-cowork`), run
`/plugin uninstall ae-desktop-operator@ae-external-skills`, then install `desktop-cowork`.

## Layout

```
.claude-plugin/
  marketplace.json  # Claude Code marketplace: one plugin per skill, except sales-navigator (bundles its five skills)
plugins/sales-navigator/   # the ONLY folder the sales-navigator plugin installs (marketplace `source`)
  skills/
    sales-navigator/        # the shared ENGINE: page/, scripts/, runtime/, reference.md, recipes.md, templates/
    salesnav-tam-accounts/  # SKILL.md + skill.yaml only; each reaches the engine through ENGINE (see below)
    salesnav-tam-people/
    salesnav-tam-tracker/
    salesnav-outreach/
packages/
  browser-runtime/  # SOURCE OF TRUTH for the shared browser runtime (session.py + one README)
build/
  sync_runtime.py   # vendors packages/browser-runtime into each skill that lists a runtime (only the
                    # engine does); --check fails on drift
skills/<skill-name>/    # the standalone plugins: grokbot, grokbot-box, claude-desktop
  SKILL.md          # entry point: frontmatter (name, description) + procedure
  skill.yaml        # manifest: name, version, category, runtimes ([] or [local, agent-browser])
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
`skills` list of its five skill folders (paths relative to that source). The source folder holds only
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
  touches the network (the Agent Browser claim/auth/heartbeat calls and Playwright's CDP
  connection; it needs `pip install playwright`, imported lazily). Skill scripts under
  `skills/<name>/scripts/` stay stdlib and no-network. Page snippets under `skills/<name>/page/` run
  inside the user's signed-in browser, return compact JSON, and never return cookies or tokens.
- **Runtimes manifest.** Every skill has a `skill.yaml` (`name`, `version`, `category`, `runtimes`)
  whose `category` matches its `marketplace.json` entry (the skill's own plugin entry, or, for the
  five Sales Navigator skills, the bundled `sales-navigator` plugin whose `skills` list names it).
  `runtimes` is `[]` for skills without a browser, or a
  list from `local` (the user's own browser) and `agent-browser` (cloud browser); a non-empty list
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
