---
name: grokbot
description: >-
  Operate Cursor's Grok Bot desktop app (and its cloud agents) from the terminal with the
  `grokbot` CLI. Use when a Claude needs to list or look up Grok Bot agents, create agents or
  group chats, organize the sidebar into sections, pin or hide agents, rename them, read an
  agent's transcript, or send a prompt to another agent and wait for its reply. Runs from a Mac
  (operator policy) or from inside a Grok Bot box (restricted, audited agent policy). Not related
  to xAI's `grok` build CLI.
---

# grokbot

`grokbot` is a Node CLI that drives **Cursor's Grok Bot desktop app** (bundle
`com.anysphere.sand`) from the terminal. The app is a thin Electron client: agents, transcripts,
sections, and pins live on a per-user cloud **host** ("box"), and the CLI talks to the same host
API the app uses. It also reaches Cursor RPC, the Electron DevTools port (CDP), and the app's
local caches, but those lower layers are for a human on a Mac.

Credentials come from the signed-in app (Keychain item "Grok Bot Safe Storage"). Nothing is copied
or printed, and every error path is redacted.

## When to use it

- see the roster, check host health, or find an agent: `grokbot status`, `grokbot agents list`
- create an agent or a group chat of agents: `grokbot agents create`, `grokbot groups create`
- organize the sidebar into sections, move agents between them, pin or hide agents:
  `grokbot sections *`, `grokbot pins add`, `grokbot agents hide`
- rename an agent, or read its transcript: `grokbot agents rename`, `grokbot agents tail`
- send a prompt to another agent and wait for the reply: `grokbot agents send <ref> "..." --wait`

## Install

Requires Node 20+ (Node 22+ only for `grokbot cdp`, which needs the built-in `WebSocket`). macOS
only for `app`, `cdp`, and Keychain-backed session discovery. The first run on a Mac triggers a
Keychain prompt for the Mac login password; choose "Always Allow".

From a checkout of this repo, or the unzipped skill folder:

```sh
cd skills/grokbot/cli && npm install --omit=dev
chmod +x bin/grokbot.js
mkdir -p ~/.local/bin && ln -sfn "$PWD/bin/grokbot.js" ~/.local/bin/grokbot
grokbot doctor      # on a Mac
grokbot policy      # inside a box; should print "policy agent" and the box gateway.json path
```

## Policy

`grokbot` runs under one of two policies (`resolvePolicy()` in `cli/src/policy.js`):

- **operator** (default off-box, e.g. on a Mac): everything is allowed. Destructive commands
  still need their own `--yes` / `--confirm-count` gates.
- **agent** (forced as soon as the CLI detects it is inside a real box; `GROKBOT_POLICY=agent`
  forces it off-box for testing): a Grok Bot agent is driving itself. It may create, rename,
  hide, and delete agents, create/move/delete sections, add/remove pins, send, tail, and list.
  Deletes still need `--yes` / `--confirm-count`. These families are denied and exit **77**:
  `agents duplicate`, `agents interrupt`, `sections import`, `pins clear`, `settings set`, `gw`,
  `cursor`, `cdp`, `app`, `automations` (and `doctor`'s Cursor section is skipped).

The agent policy is an **advisory guardrail with a best-effort audit log, not a security
boundary or sandbox**. It is enforced only inside this CLI: an agent that can run arbitrary code
in its box can still call the host gateway directly, so the policy catches accidents and casual
overreach, not a determined actor. Do not try to route around a denial with an alias or a raw `gw`
call; if a human needs a denied command run, ask them to run it from their Mac. Inside a real box
the CLI ignores `GROKBOT_POLICY=operator` and stays on the agent policy. It also tries to append
one JSON line (timestamp, policy, command path, redacted argv, decision) per agent-policy
invocation to an audit log placed next to the box's `gateway.json` (for example
`/home/box/agent-data/grokbot-audit.jsonl`). That logging is best-effort: write failures are
silently ignored, and `--help` output and argument parse errors are not audited. Removing pins one
at a time reaches the same end state as the denied `pins clear`; it is allowed (and logged on a
best-effort basis), so do not treat "not denied" as "off the record."

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
```

Deleting never runs blind: `grokbot agents delete --name "test-*" --created-before 7d --dry-run`
prints the exact targets first; the real run needs `--yes` plus `--confirm-count N` equal to the
matched count when there is more than one target.

Also available: `events` (live host event stream) and `local ...` (offline caches); both are
allowed under agent policy. Operator-only surfaces (denied under agent policy): `gw <command>`,
`cursor ...`, `cdp ...`, `app restart --debug`. See the references.

## References

- `references/host-commands.md`: full host gateway command catalog.
- `references/internals.md`: how the app stores credentials and state.
- `cli/README.md`: complete CLI reference (selection flags, environment variables, how sections
  work, running inside a box).
