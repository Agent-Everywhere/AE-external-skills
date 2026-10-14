---
name: grokbot
description: >-
  Operate your Grok Bot desktop app on your Mac from Claude Code with the bundled `grokbot` CLI.
  Use when the user wants to check Grok Bot status or run doctor, list, find, create, rename, hide,
  or delete agents, create group chats, organize the sidebar into sections, pin agents, read an
  agent's transcript, send a prompt to an agent and wait for the reply, or restart the app. Needs
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
- **Groups:** create a group chat of agents (`grokbot groups create`)
- **Sections:** list, create, rename, move agents between sections, delete, import
- **Pins:** list, add, remove, clear
- **Transcripts:** `agents tail`, `agents thread`, `agents outline`, `agents memories`
- **Talking to agents:** `agents send <ref> "..." --wait` sends a prompt and prints the reply
- **App lifecycle:** `grokbot app restart` (add `--debug` to expose the DevTools port), `app quit`, `app open`
- **Lower layers (Mac only):** `gw` (raw host gateway), `cursor` (Cursor RPC), `cdp` (Electron
  DevTools), `settings`, `automations`, `events`, `local` (offline caches)

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

Refs are name-based: an agent's exact name, a unique substring, or its id / id prefix. Every
command takes `--json`.

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

grokbot pins list
grokbot pins add <ref...>
grokbot pins remove <ref...>

grokbot app restart --debug                          # relaunch the app with DevTools exposed
```

Deleting never runs blind: `grokbot agents delete --name "test-*" --created-before 7d --dry-run`
prints the exact targets first; the real run needs `--yes` plus `--confirm-count N` equal to the
matched count when there is more than one target. Show the user the dry-run list and get their
go-ahead before the real delete.

## References

- `references/host-commands.md`: full host gateway command catalog.
- `references/internals.md`: how the app stores credentials and state.
- `cli/README.md`: complete CLI reference (selection flags, environment variables, how sections work).
- Rebuild the bundle after editing the source: `cd cli && npm install && npm run build`.
