# Agent Browser skills

Customer-facing skills for **Agent Browser** (Agent Everywhere's cloud-browser MCP). Each skill is
portable: it works for any company, asks the user only for what it needs, and runs inside the
user's own Claude (Claude Desktop, claude.ai, Claude Code, Codex, and other MCP clients).

## Skills

| Skill | What it does |
|---|---|
| [`sales-navigator`](skills/sales-navigator/SKILL.md) | Build account, lead, and decision-maker lists in LinkedIn Sales Navigator, with guardrails |

## Layout

```
skills/<skill-name>/
  SKILL.md          # entry point: frontmatter (name, description) + procedure
  references/       # loaded on demand: guardrails, gotchas, schemas
  scripts/          # optional helpers (Python 3 stdlib only), run in the user's Claude
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
- **Scripts:** Python 3 standard library only, no network, tested under `tests/`.

## Packaging

Each skill folder zips into an installable skill:

```
cd skills && zip -r ../dist/<skill-name>.zip <skill-name>
```

## Requirements for users

- Agent Browser connector: `https://browser-mcp-production-6535.up.railway.app/mcp` (Google sign-in).
- Any other connector the skill names (e.g. their CRM's MCP).
