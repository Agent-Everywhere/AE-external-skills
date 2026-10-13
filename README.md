# AE external skills

Agent Everywhere's shareable skills for subscribers and readers. Each skill is portable: it works
for any company, asks the user only for what it needs, and runs inside the user's own Claude
(Claude Desktop, claude.ai, Claude Code, Codex, and other MCP clients).

## Install

**Claude Code** (pick only the skills you need):

```
/plugin marketplace add Agent-Everywhere/AE-external-skills
/plugin install grokbot@ae-external-skills
/plugin install grokbot-box@ae-external-skills
/plugin install sales-navigator@ae-external-skills
```

**Other Claude apps** (Claude Desktop, claude.ai): download the skill folder you want from
`skills/<skill-name>/` as a zip and add it as a skill. Note that `grokbot` runs a local CLI and
needs Claude Code (or another agent with shell access) on the Mac that has Grok Bot installed;
`grokbot-box` runs inside a Grok Bot box.

**Just the `grokbot` CLI** (no Claude needed; Node 20+; rerun to update):

```
mkdir -p ~/.local/bin && curl -fsSL https://github.com/Agent-Everywhere/AE-external-skills/releases/latest/download/grokbot.mjs -o ~/.local/bin/grokbot && chmod +x ~/.local/bin/grokbot
```

Skills that list `agent-browser` in their `skill.yaml` `runtimes` can drive Agent Everywhere's
cloud-browser MCP; `sales-navigator` can also run in the user's own browser (`local`). Other skills
(such as `grokbot`) ship their own tooling and do not need that connector.

## Skills

| Skill | What it does |
|---|---|
| [`sales-navigator`](skills/sales-navigator/SKILL.md) | Build account, lead, and decision-maker lists in LinkedIn Sales Navigator, with guardrails: fast in-page API in your own browser (local) or a cloud browser (Agent Browser), slow page-reading fallback |
| [`grokbot`](skills/grokbot/SKILL.md) | Your own Claude Code operates your Grok Bot desktop app on your Mac: status/doctor, agents, groups, sections, pins, transcripts, `send --wait`, app restart (bundled Node CLI, no `npm install`) |
| [`grokbot-box`](skills/grokbot-box/SKILL.md) | For a Grok Bot agent inside its own cloud box: list, create, organize, send to, and delete its sibling workers under an advisory, audited agent policy (uses the `grokbot` CLI) |

> **Unofficial.** `grokbot` and `grokbot-box` are not affiliated with or endorsed by Cursor or xAI. It uses Grok Bot's private, undocumented interfaces, which may change or break at any time. Use at your own risk: some commands can delete agents and sections.

## Layout

```
.claude-plugin/
  marketplace.json  # Claude Code marketplace: one plugin per skill, each rooted at skills/<name>
packages/
  browser-runtime/  # SOURCE OF TRUTH for the shared browser runtime (session.py + runtime docs)
build/
  sync_runtime.py   # vendors packages/browser-runtime into each skill that lists a runtime; --check fails on drift
skills/<skill-name>/
  SKILL.md          # entry point: frontmatter (name, description) + procedure
  skill.yaml        # manifest: name, version, category, runtimes ([] or [local, agent-browser])
  references/       # loaded on demand: guardrails, gotchas, schemas
  scripts/          # optional helpers (Python 3 stdlib only, no network), run in the user's Claude
  page/             # optional JS snippets run inside the signed-in page by the browser runtime
  runtime/          # vendored copy of packages/browser-runtime (generated; never edit here)
  cli/              # optional Node CLI (Node >= 20), for skills that wrap a command-line tool
  cli/dist/         # committed single-file bundle of the CLI (no npm install needed); rebuild with `npm run build`
tests/              # Python tests for scripts, the runtime, page snippets, manifests and vendoring
```

Browser-runtime changes are made once, in `packages/browser-runtime/`, then propagated with
`python3 build/sync_runtime.py`. The tests run `python3 build/sync_runtime.py --check` and fail if a
skill's `runtime/` copy has drifted.

Each marketplace entry uses its own skill folder as the plugin source (`"source": "./skills/<name>"`,
`"skills": ["."]`), so a plugin installs only its own skill. Do not point a plugin at the repo root:
the `skills` key adds to the default `skills/` scan, so every skill would load. `grokbot-box` does not
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
  that matches its `marketplace.json` entry. `runtimes` is `[]` for skills without a browser, or a
  list from `local` (the user's own browser) and `agent-browser` (cloud browser); a non-empty list
  gets `packages/browser-runtime` vendored into `runtime/`.
- **Exception: Node CLI.** A skill may ship a Node CLI under `cli/` (Node >= 20, with its own
  `package.json` and lockfile; install with `npm install --omit=dev`, or run the committed bundle
  `cli/dist/grokbot.mjs` directly). This is the one exception
  to the Python-stdlib scripts rule, and the skill's `SKILL.md` documents the install.

## Packaging

Each skill folder zips into an installable skill:

```
cd skills && zip -r ../dist/<skill-name>.zip <skill-name> -x '*/node_modules/*'
```

`grokbot-box` does not bundle the CLI or the `grokbot` references; its install section clones this
repo inside the box, and the zip needs nothing else.

### Releasing the grokbot CLI

The curl install downloads `grokbot.mjs` from the latest GitHub Release, which also gives a
download count. After a change to `skills/grokbot/cli/` merges, rebuild `dist/` (`npm run build`),
bump `version` in `package.json`, and publish:

```
gh release create grokbot-v<version> skills/grokbot/cli/dist/grokbot.mjs --title "grokbot v<version>" --latest
```

Only grokbot releases may be marked `--latest`: the install URL follows the repo's latest release.

## Requirements for users

- Agent Browser skills only: the Agent Browser connector,
  `https://browser-mcp-production-6535.up.railway.app/mcp` (Google sign-in).
- Any other connector the skill names (e.g. their CRM's MCP).
- Skills with a `cli/`: Node >= 20, plus whatever the skill's `SKILL.md` lists (`grokbot` needs
  the Grok Bot desktop app on a Mac; `grokbot-box` runs inside a Grok Bot box).
