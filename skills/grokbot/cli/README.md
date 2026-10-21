# grokbot

Operate **Cursor's Grok Bot desktop app** ("Grok Bot", bundle `com.anysphere.sand`) from the terminal.
Not related to xAI's `grok` build CLI.

Grok Bot is a thin Electron client. The agents, transcripts, sections, and pins live on a per-user
cloud **host** ("box"). This CLI talks to every layer the app itself uses:

| Layer | What it is | Used for |
|---|---|---|
| **Host gateway** | `POST {box}/api/<command>` with the app's gateway token | roster, create/rename/hide/delete agents, sections, pins, send, transcripts, search, automations, events |
| **Cursor RPC** | Connect-RPC `api2.cursor.sh/aiserver.v1.GrokBotService/*` with the Cursor access token | server-side agent objects, sandbox state, templates, team agents, minting a gateway session |
| **CDP** | Chrome DevTools Protocol into the running Electron app | call `window.desktop.*`, read what the UI shows, screenshots, force refresh |
| **Local caches** | `~/Library/Application Support/Grok Bot/sand-client-persistence` | offline roster/sections/transcript mirrors and search |

Credentials are read from the signed-in app (Keychain item "Grok Bot Safe Storage" → Electron
safeStorage ciphertext). Nothing is copied or printed; every error path is redacted.

## Install

One command, no clone (single bundled file; rerun to update):

```sh
mkdir -p ~/.local/bin && curl -fsSL https://github.com/Agent-Everywhere/AE-external-skills/releases/latest/download/grokbot.mjs -o ~/.local/bin/grokbot && chmod +x ~/.local/bin/grokbot
grokbot doctor
```

Make sure `~/.local/bin` is on your `PATH`. Or from a clone of this repo:

```sh
cd skills/grokbot/cli && npm install --omit=dev
chmod +x bin/grokbot.js
mkdir -p ~/.local/bin && ln -sfn "$PWD/bin/grokbot.js" ~/.local/bin/grokbot
grokbot doctor
```

Node 20+ (Node 22+ only if you need `grokbot cdp` on the Mac — CDP needs the global `WebSocket`
built into Node 22). macOS only for `app`/`cdp`/Keychain-backed session discovery. The first run
on a Mac triggers a Keychain prompt for your **Mac login password**; choose "Always Allow".

## Everyday commands

```sh
grokbot status                              # host health, counts, running agents
grokbot agents list                         # visible agents (add --all / --hidden)
grokbot agents list --section "Agent Swarm" --idle-for 7d
grokbot agents get <ref>                    # ref = id, id prefix, exact name, or unique substring
grokbot agents create "Researcher" -d "…" --section Swarm --no-intro
grokbot agents rename <ref> "New name"
grokbot agents hide|unhide|read|unread <refs…>      # or selection flags
grokbot agents send <ref> "prompt" --wait
grokbot agents tail <ref> -n 40
grokbot agents search "invoice"             # host-side search

grokbot sections list --members
grokbot sections create "Clients" <refs…>
grokbot sections move "Clients" --name "acme-*"
grokbot sections rename|reorder|sort|prune|export|import
grokbot pins list|add|remove

grokbot events                              # live SSE stream from the host
grokbot gw countAgents                      # any raw host command
grokbot cursor whoami|agents|boxes|state|rpc <Method> '{}'
grokbot cdp status|keys agent|desktop agent.getSidebarSections|text|screenshot out.png
grokbot app restart --debug                 # relaunch with the CDP port (default 9340)
grokbot local roster|sections|search "text" # offline
```

Every command takes `--json`.

## Deleting at scale

`agents delete` never runs blind:

```sh
grokbot agents delete --name "test-*" --created-before 7d --dry-run     # prints the exact targets
grokbot agents delete --name "test-*" --created-before 7d --yes --confirm-count 37
grokbot agents delete --ids-file dead.txt --yes --confirm-count 120
```

Targets are printed first; `--yes` is required; more than one target additionally requires
`--confirm-count N` equal to the matched count. Deletes go through the host's bulk `deleteAgents`
in batches of 25 and dead section memberships are pruned afterwards.

## How sections work

Sections are **not** a field on the agent. They are `sidebarSections` inside host settings:
`[{ id, name, agentIds }]`, one section per agent (first wins). `__agents__` is the app's
built-in "Unassigned" bucket and is protected. The CLI writes them with `setHostSettings`; the app
re-reads host settings on window focus or reconnect, so the sidebar catches up when you click into
it (`grokbot cdp focus` nudges it when the app runs with the debug port).

## Selection flags

Available on `agents list|hide|unhide|read|unread|delete` and `sections move|unassign`:
`--name <glob>` `--match <text>` `--regex <re>` `--hidden` `--all` `--groups/--no-groups`
`--running` `--idle` `--unread` `--awaiting` `--idle-for 7d` `--created-before 2w`
`--created-after 1h` `--section <ref|none>` `--ids-file <file>`.

## Environment

| Var | Purpose |
|---|---|
| `GROKBOT_GATEWAY_URL` + `GROKBOT_GATEWAY_TOKEN` (+ `GROKBOT_GATEWAY_HEADERS` JSON) | bypass the app's descriptor |
| `GROKBOT_CDP_PORT` | default CDP port (9340) |
| `GROKBOT_SAFE_STORAGE_PASSWORD` | skip the Keychain lookup (CI/tests) |
| `GROKBOT_APP_SUPPORT`, `GROKBOT_APP_BUNDLE`, `GROKBOT_HOME` | alternate paths |
| `GROKBOT_DEBUG=1` | stack traces |

See `../references/host-commands.md` for the full host command catalog and `../references/internals.md` for how the
app stores credentials and state.

## Running inside a Grok Bot box (no Mac)

A Grok Bot agent's own cloud computer ("box") is itself a place `grokbot` can run — no Electron,
no Keychain. The host writes a plain-JSON gateway descriptor (`{scheme, host, port, token, pid,
startedAt}`); the CLI checks, in order, `$SAND_DATA_ROOT/gateway.json`,
`$GROKBOT_BOX_GATEWAY_JSON`, then the hardcoded `/home/box/agent-data/gateway.json`,
`/home/box/sand-data/gateway.json`, `~/agent-data/gateway.json`, `~/sand-data/gateway.json` — the
first that exists wins. It always dials `127.0.0.1:<port>` (never the bound `0.0.0.0` host) and
skips every Mac-only surface. `grokbot policy`/`grokbot doctor` print exactly which file was used.

```sh
# from a checkout of this repo, or the unzipped skill folder
cd skills/grokbot/cli && npm install --omit=dev
chmod +x bin/grokbot.js
mkdir -p ~/.local/bin && ln -sfn "$PWD/bin/grokbot.js" ~/.local/bin/grokbot
grokbot policy   # confirm: policy agent, box gateway /home/box/agent-data/gateway.json
grokbot status
```

`app`, `cdp`, and Keychain-backed descriptor/EnsureSandBox lookups are Mac-only and unused inside
a box; `GROKBOT_GATEWAY_URL`/`GROKBOT_GATEWAY_TOKEN` or the box's `gateway.json` are the only
session sources that matter there.

## Policy

`grokbot` runs under one of two policies, resolved by `resolvePolicy()` in `src/policy.js`:

- **operator** (default off-box, e.g. on a Mac) — everything is allowed; destructive commands
  still need their own `--yes`/`--confirm-count` gates.
- **agent** (always on once the CLI detects it is actually inside a box; force it early with
  `GROKBOT_POLICY=agent` off-box too) — a Grok Bot agent is driving itself. It may organize the
  sidebar (create/rename/hide/**delete** agents, sections move/create/**delete**, pins add/remove,
  send, tail, list). Destructive deletes still need `--yes` / `--confirm-count`. It may **not**
  duplicate, interrupt, import sections, clear all pins, patch raw settings (`settings set`; use
  `grokbot auto-review get|set|append` instead, which writes only `autoReviewInstructions`, rejects
  empty values without `--clear`, and audits each write by sha256 + length under every policy), or reach the
  lower-level `gw`/`cursor`/`cdp`/`app`/`automations` surfaces (including
  `doctor`'s Cursor section, which is skipped under agent policy). A denied command exits **77**
  and is never run.

  **This is an advisory guardrail plus a best-effort audit log, not a security boundary or
  sandbox.** It is enforced only inside this CLI; an agent that can run arbitrary code in its box
  can still reach the host gateway directly. It catches accidents and casual overreach, not a
  determined actor.

  **`GROKBOT_POLICY=operator` is ignored in a real box.** Once `resolvePolicy()` detects an
  actual box gateway file it returns `agent` regardless of what `GROKBOT_POLICY` is set to, so
  operator mode is normally only reachable off-box. `GROKBOT_POLICY=agent` can still be forced
  off-box (useful for testing).

  **Removing every pin one at a time reaches the same end state as the denied `pins clear`.**
  Per-item removal is allowed and logged individually (best effort), so the action is visible in
  the audit log even though it isn't blocked outright. The policy discourages casual wholesale
  resets, not a deliberate loop.

Run `grokbot policy` to see the active mode, the box gateway path (if any), and the full denylist.
Invocations under `agent` policy — allowed or denied — are logged on a best-effort basis as one
JSONL record each (timestamp, policy, command path, argv redacted, decision). Write failures are
silently ignored, and `--help` output and argument parse errors are not audited. Inside a real box
the log is placed next to the host's own `gateway.json` (e.g.
`/home/box/agent-data/grokbot-audit.jsonl`) and `$GROKBOT_AUDIT_LOG` is ignored there, so the
agent's own env does not redirect it; this does not stop a process with file access from editing
or deleting the log. Off-box, `$GROKBOT_AUDIT_LOG` (else `~/.grokbot/grokbot-audit.jsonl`)
applies. Operator-mode runs are not audited.
