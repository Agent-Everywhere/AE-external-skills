# AE external skills

Agent Everywhere's shareable skills for subscribers and readers. Each skill is portable: it works
for any company, asks the user only for what it needs, and runs inside the user's own Claude
(Claude Desktop, claude.ai, Claude Code, Codex, and other MCP clients).

The **Agent Browser** skills drive Agent Everywhere's cloud-browser MCP. Other skills (such as
`grokbot`) ship their own tooling and do not need that connector.

## Skills

| Skill | What it does |
|---|---|
| [`sales-navigator`](skills/sales-navigator/SKILL.md) | Build account, lead, and decision-maker lists in LinkedIn Sales Navigator, with guardrails (Agent Browser) |
| [`grokbot`](skills/grokbot/SKILL.md) | Operate Cursor's Grok Bot desktop app and agents from the terminal: agents, sections, pins, transcripts, groups, sending prompts (Node CLI) |

## Layout

```
skills/<skill-name>/
  SKILL.md          # entry point: frontmatter (name, description) + procedure
  references/       # loaded on demand: guardrails, gotchas, schemas
  scripts/          # optional helpers (Python 3 stdlib only), run in the user's Claude
  cli/              # optional Node CLI (Node >= 20), for skills that wrap a command-line tool
```

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
  convention applies to Python scripts; `grokbot`'s CLI tests are not included in this repo.)
- **Exception: Node CLI.** A skill may ship a Node CLI under `cli/` (Node >= 20, with its own
  `package.json` and lockfile; install with `npm install --omit=dev`). This is the one exception
  to the Python-stdlib scripts rule, and the skill's `SKILL.md` documents the install.

## Packaging

Each skill folder zips into an installable skill:

```
cd skills && zip -r ../dist/<skill-name>.zip <skill-name> -x '*/node_modules/*'
```

## Requirements for users

- Agent Browser skills only: the Agent Browser connector,
  `https://browser-mcp-production-6535.up.railway.app/mcp` (Google sign-in).
- Any other connector the skill names (e.g. their CRM's MCP).
- Skills with a `cli/`: Node >= 20, plus whatever the skill's `SKILL.md` lists (`grokbot` needs
  the Grok Bot desktop app, or to run inside a Grok Bot box).
