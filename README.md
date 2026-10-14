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
| [`ae-desktop-operator`](skills/claude-desktop/SKILL.md) | Skill + helper script (`desktop.py`, using Peekaboo). The skill folder is `claude-desktop`; the plugin name avoids the `claude-` prefix, which the marketplace reserves | Claude Code on a Mac driving the Claude Desktop app: Cowork tasks, replies, approvals, projects, skills, connectors, plugins, scheduled tasks | Claude Code on your Mac, controlling the Desktop app by screenshots and clicks | macOS 15+, Peekaboo, Screen Recording / Accessibility / Automation permission | `/plugin install ae-desktop-operator@ae-external-skills` |
| [`sales-navigator`](skills/sales-navigator/SKILL.md) | One plugin bundling 5 skills: the `sales-navigator` toolkit plus `salesnav-tam-accounts`, `salesnav-tam-people`, `salesnav-tam-tracker` and `salesnav-outreach` | Anyone with a LinkedIn Sales Navigator seat who sizes markets, builds lists and runs outreach | Claude Desktop / Cowork's built-in browser, your own Chrome, or Agent Browser | A signed-in Sales Navigator seat; Agent Browser only: the connector `https://browser-mcp-production-6535.up.railway.app/mcp` (Google sign-in) | `/plugin install sales-navigator@ae-external-skills` |

`grokbot` and `grokbot-box` are not the same thing: `grokbot` is for a human on a Mac, `grokbot-box`
is for an agent inside a box. Each skill points to the other.

The `sales-navigator` plugin's five skills:

- [`sales-navigator`](skills/sales-navigator/SKILL.md): the slim toolkit for your own seat: exact counts, account and lead searches through the in-page API, website lookups, CSV and cap-tracking scripts, example flows. Read-only unless you explicitly ask it to send, and then only for batches you approve.
- [`salesnav-tam-accounts`](skills/salesnav-tam-accounts/SKILL.md): size a company-side market: account filters, exact counts per variant, one master search. Counts only.
- [`salesnav-tam-people`](skills/salesnav-tam-people/SKILL.md): size a people-side market: title, seniority, function, geography and headcount filters, a master lead search under the 2,500 cap. Counts and samples only.
- [`salesnav-tam-tracker`](skills/salesnav-tam-tracker/SKILL.md): cut a master search over the viewable cap into sub-lists, pull them, dedupe across shards, track coverage in `tam_tracker.csv`.
- [`salesnav-outreach`](skills/salesnav-outreach/SKILL.md): daily connection requests, InMails, messages and follow-ups with an outreach ledger. Drafts by default; sends only after you type approval of the exact batch.

> **Unofficial.** `ae-desktop-operator` is not affiliated with or endorsed by Anthropic. It drives the app by screenshots and clicks, which may break when the app's layout changes, and it takes over your mouse and keyboard while it runs: read the rules in its [`SKILL.md`](skills/claude-desktop/SKILL.md) first.
>
> **Unofficial.** `grokbot` and `grokbot-box` are not affiliated with or endorsed by Cursor or xAI. They use Grok Bot's private, undocumented interfaces, which may change or break at any time. Use at your own risk: some commands can delete agents and sections.

## Install

**Claude Code**: add the marketplace once, then install the plugins you want:

```
/plugin marketplace add Agent-Everywhere/AE-external-skills
/plugin install grokbot@ae-external-skills
/plugin install grokbot-box@ae-external-skills
/plugin install ae-desktop-operator@ae-external-skills
/plugin install sales-navigator@ae-external-skills
```

**Claude Desktop**: Customize > Plugins > Add > Add marketplace > Add from a repository >
`Agent-Everywhere/AE-external-skills` > Sync, then Add the plugin you want. Auto-sync needs the
Claude GitHub App to have access to this repository; without that the plugin installs but does not
update itself.

**Without plugins** (claude.ai, or a one-off skill): download the folder you want from
`skills/<skill-name>/` as a zip and add it as a skill. `grokbot` runs a local CLI, so it needs Claude
Code (or another agent with shell access) on the Mac that has Grok Bot installed.

**Just the `grokbot` CLI** (no Claude needed; Node 20+; rerun to update):

```
mkdir -p ~/.local/bin && curl -fsSL https://github.com/Agent-Everywhere/AE-external-skills/releases/latest/download/grokbot.mjs -o ~/.local/bin/grokbot && chmod +x ~/.local/bin/grokbot
```

Skills that list `agent-browser` in their `skill.yaml` `runtimes` can drive Agent Everywhere's
cloud-browser MCP; `sales-navigator` and the `salesnav-*` skills can also run in the user's own
browser (`local`). The other skills ship their own tooling and do not need that connector.

## Upgrading

If you installed the older `claude-desktop`, `salesnav-tam-accounts`, `salesnav-tam-people`,
`salesnav-tam-tracker` or `salesnav-outreach` plugins, run `/plugin uninstall <name>@ae-external-skills`
for each, then install `ae-desktop-operator` and `sales-navigator`.

## Layout

```
.claude-plugin/
  marketplace.json  # Claude Code marketplace: one plugin per skill, except sales-navigator (bundles its five skills)
packages/
  browser-runtime/  # SOURCE OF TRUTH for the shared browser runtime (session.py + one README)
build/
  sync_runtime.py   # vendors packages/browser-runtime into each skill that lists a runtime, and the
                    # sales-navigator files a purpose skill lists in `uses_toolkit`; --check fails on drift
skills/<skill-name>/
  SKILL.md          # entry point: frontmatter (name, description) + procedure
  skill.yaml        # manifest: name, version, category, runtimes ([] or [local, agent-browser])
  reference.md, recipes.md, references/   # optional on-demand docs, kept small
                    # (purpose skills `salesnav-*` hold generated copies of the toolkit files listed in
                    # their skill.yaml `uses_toolkit`; the source stays in skills/sales-navigator)
  scripts/          # optional helpers (Python 3 stdlib only, no network), run in the user's Claude
  page/             # optional JS snippets run inside the signed-in page by the browser runtime
  runtime/          # vendored copy of packages/browser-runtime (generated; never edit here)
  cli/              # optional Node CLI (Node >= 20), for skills that wrap a command-line tool
  cli/dist/         # committed single-file bundle of the CLI (no npm install needed); rebuild with `npm run build`
tests/              # Python tests for scripts, the runtime, page snippets, manifests and vendoring
```

Browser-runtime changes are made once, in `packages/browser-runtime/`, then propagated with
`python3 build/sync_runtime.py`, then run `python3 build/sync_runtime.py --check` before committing.
The `salesnav-*` purpose skills each work as a standalone skill folder: their `skill.yaml` lists the files it needs
in `uses_toolkit` (for example `[page/count.js, scripts/run_log.py]`), and the same script copies them from
`skills/sales-navigator` to the same relative paths (a stale or edited copy fails `--check`). Fix a tool in
`skills/sales-navigator`, never in a purpose skill.
The tests run the same check and fail if a skill's `runtime/` copy has drifted (or a skill with
`runtimes: []` still has a `runtime/` folder).

Most marketplace entries use their own skill folder as the plugin source (`"source": "./skills/<name>"`,
`"skills": ["."]`), so a plugin installs only its own skill. The exception is `sales-navigator`, one
bundled plugin with `"source": "./"`, `"strict": false` and an explicit `skills` list of its five skill
folders; with an explicit list only those skills load (checked with `claude plugin details`). Do not
point any other plugin at the repo root without listing its skills. `grokbot-box` does not
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
  gets `packages/browser-runtime` vendored into `runtime/`.
- **Exception: Node CLI.** A skill may ship a Node CLI under `cli/` (Node >= 20, with its own
  `package.json` and lockfile; install with `npm install --omit=dev`, or run the committed bundle
  `cli/dist/grokbot.mjs` directly). This is the one exception
  to the Python-stdlib scripts rule, and the skill's `SKILL.md` documents the install.
- **Packaging.** Each skill folder zips into an installable skill:
  `cd skills && zip -r ../dist/<skill-name>.zip <skill-name> -x '*/node_modules/*'`.
  `grokbot-box` needs nothing else (it clones this repo inside the box).
- **Releasing the grokbot CLI.** The curl install downloads `grokbot.mjs` from the latest GitHub
  Release. After a change to `skills/grokbot/cli/` merges, rebuild `dist/` (`npm run build`), bump
  `version` in `package.json`, and publish:
  `gh release create grokbot-v<version> skills/grokbot/cli/dist/grokbot.mjs --title "grokbot v<version>" --latest`.
  Only grokbot releases may be marked `--latest`: the install URL follows the repo's latest release.
