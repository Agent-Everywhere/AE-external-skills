---
name: grokbot
description: >-
  Operate your Grok Bot desktop app on your Mac from Claude Code with the bundled `grokbot` CLI.
  Use when the user wants to check Grok Bot status or run doctor, list, find, create, rename, hide,
  or delete agents, create group chats, organize the sidebar into sections, pin agents, read an
  agent's transcript, send a prompt to an agent and wait for the reply, list, enable, disable,
  delete, or back up its routines (automations), connect or install its Slack app, back up agents
  and transcripts, or restart the app. Verified against Grok Bot app 0.79.3. Needs
  Claude Code running on the Mac that has Grok Bot installed. Not for an agent running inside a
  Grok Bot box (use grokbot-box) and not related to xAI's `grok` build CLI.
---

# grokbot

> **Unofficial.** `grokbot` is not affiliated with or endorsed by Cursor or xAI. It uses Grok Bot's private, undocumented interfaces, which may change or break at any time. Use at your own risk: some commands can delete agents and sections.

**What this is:** a CLI plus this skill, for a person on a Mac. `grokbot` drives **Cursor's Grok Bot desktop app** (bundle `com.anysphere.sand`) from your own
Claude Code on your Mac, under the operator policy: everything is allowed, and destructive
commands still need their own `--yes` / `--confirm-count` gates. The app is a thin Electron client;
agents, transcripts, sections, and pins live on your per-user cloud **host** ("box"), and the CLI
talks to the same host API the app uses. Credentials come from the signed-in app (Keychain item
"Grok Bot Safe Storage"); nothing is copied or printed.

Not the same as **grokbot-box**: use that skill if you are a Grok Bot agent running inside your own cloud box.

## What it can do on the Mac

- **Health and diagnosis:** `grokbot status` (host health + counts), `grokbot doctor` (app, session,
  host, and Cursor checks), `grokbot app status`
- **Agents:** list, find, get, create, rename, hide / unhide, mark read / unread, search, delete
  (delete goes through the Cursor control plane and is verified against the control-plane roster)
- **Groups:** create a group chat of agents (`grokbot groups create`)
- **Sections:** list, create, rename, move agents between sections, delete, import
- **Pins:** list, add, remove, clear (stored in the Cursor runtime store, which the app reads first)
- **Auto-review rules:** `grokbot auto-review get|set|append` reads and updates only the
  `autoReviewInstructions` allow/block rule lists (allowed under the agent policy too; see below)
- **Routines (automations):** `grokbot automations` lists every routine with its prompt, trigger,
  and owner; `automations export <dir>` backs them up as markdown; `enable|disable|delete` and
  `resume-guard` change them (operator only, writes need `--yes`)
- **Slack:** `grokbot slack status|workspaces|link-url` read the link state; `slack connect <agent>
  --wait --install --yes`, `install|reinstall|uninstall`, and `unlink` set it up (operator only)
- **Backups:** `grokbot agents export <dir>` (profile, skills, access; no secrets) and
  `grokbot transcripts export <dir>`; `grokbot usage` shows allowance and spend
- **Transcripts:** `agents tail`, `agents thread`, `agents outline`, `agents todos|tasks`
- **Talking to agents:** `agents send <ref> "..." --wait` sends a prompt and prints the reply
  (through the Cursor control plane since app 0.79, so it needs the Mac's Cursor sign-in)
- **App lifecycle:** `grokbot app restart` (add `--debug` to expose the DevTools port), `app quit`, `app open`
- **Lower layers (Mac only):** `gw` (raw host gateway), `cursor` (Cursor RPC), `cdp` (Electron
  DevTools), `settings`, `events`, `local` (offline caches)

## Run it

Requires Node 20+ (Node 22+ only for `grokbot cdp`). macOS only for `app`, `cdp`, and
Keychain-backed session discovery. The first run triggers a Keychain prompt for the Mac login
password; choose "Always Allow". **No `npm install` is needed:** a single bundled file ships with
this skill.

```sh
node <skill-dir>/cli/dist/grokbot.mjs doctor
node <skill-dir>/cli/dist/grokbot.mjs agents list
```

`<skill-dir>` is the folder holding this `SKILL.md` (Claude Code shows it as the skill's base
directory). Optionally put it on your PATH so you can type `grokbot ...`:

```sh
mkdir -p ~/.local/bin && ln -sfn "<skill-dir>/cli/dist/grokbot.mjs" ~/.local/bin/grokbot
```

Start with `grokbot doctor`; it reports the app, the signed-in session, and the host in one pass.

## Common commands

Refs are name-based: an agent's exact name, a unique substring, or its id / id prefix (an exact
name or full id always wins over a prefix match). `agents delete` is stricter: only a full id or an
exact name. Every command takes `--json`.

```sh
grokbot status                                       # host health + counts
grokbot agents list                                  # visible agents (--all / --hidden)
grokbot agents get <ref>
grokbot agents create "<name>" -d "<description>" --no-intro
grokbot agents rename <ref> "<new name>"
grokbot agents hide|unhide|read|unread <ref...>      # sidebar housekeeping
grokbot agents send <ref> "<prompt>" --wait --timeout 300
grokbot agents tail <ref> -n 40                      # recent transcript
grokbot agents search "invoice"                      # host-side search

grokbot groups create "<name>" <ref...>              # a room of agents

grokbot sections list --members
grokbot sections create "<name>" <ref...>
grokbot sections move "<section>" <ref...>           # or --name/--match to select
grokbot sections rename <section> "<new name>"
grokbot sections verify                              # app store vs host mirror (exit 1 on drift)
grokbot sections sync --yes                          # push the host mirror into the app store

grokbot pins list
grokbot pins add <ref...>
grokbot pins remove <ref...>

grokbot auto-review get                              # current allow/block rules
grokbot auto-review set "<rules>" --list allow|block # or --file <path> | --stdin (exactly one); --clear to empty
grokbot auto-review append "<rule>" --list allow     # no-op if already in the list; --enable to turn it on

grokbot automations                                  # routines: prompt, trigger, enabled, owner (read-only)
grokbot automations export <dir>                     # one markdown file per agent, verbatim prompts
grokbot automations enable|disable <agent> <routine> --yes
grokbot automations delete <agent> <routine> --yes   # irreversible
grokbot automations resume-guard --allow <file> --dry-run   # re-enable allowlisted routines Grok Bot disabled

grokbot slack status                                 # per-agent Slack link state
grokbot slack workspaces                             # linked Slack workspaces
grokbot slack connect <agent> --wait --install --yes # print the OAuth URL, wait for it, install the app

grokbot agents export <dir>                          # backup (no secrets)
grokbot transcripts export <dir> --agent <ref>
grokbot usage

grokbot app restart --debug                          # relaunch the app with DevTools exposed
```

`auto-review` is a narrow, agent-allowed alternative to the denied raw `settings set`: it writes
only the `autoReviewInstructions` rule lists (`{isEnabled, allowInstructions[], blockInstructions[]}`
since app 0.79). `set` rejects empty values unless `--clear` is passed (alone) and prints the
previous list size to stderr. `append` is a single-writer read-modify-write, not atomic. Each write
adds an audit record (`sha256` and `length` of the new rules, never the rules) under every policy,
operator included.

Deleting never runs blind: `grokbot agents delete --name "test-*" --created-before 7d --dry-run`
prints the exact targets first; the real run needs `--yes` plus `--confirm-count N` equal to the
matched count when there is more than one target. Show the user the dry-run list and get their
go-ahead before the real delete. `automations delete`, `slack install|uninstall|unlink`, and the
other routine and Slack writes also need `--yes`; confirm with the user before running them.
`agents send` is a real user turn: the agent can act on it, including changing its own routines.

Optional: `cli/launchd/install.sh sections-sync` installs a LaunchAgent
(`com.grokbot.sections-sync`) that keeps the app's sidebar in step with the host mirror every 2
minutes; `install.sh resume-guard` re-enables allowlisted routines every 15 minutes.

## References

- `references/host-commands.md`: full host gateway command catalog (host 00b0aa1, app 0.79.3).
- `references/internals.md`: how the app stores credentials and state, plus how routines, Slack
  and the control plane fit together.
- `cli/README.md`: complete CLI reference (selection flags, environment variables, how sections work, policy).
- Rebuild the bundle after editing the source: `cd cli && npm ci && npm test && npm run build`.
