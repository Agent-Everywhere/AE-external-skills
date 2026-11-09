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

Last verified against **Grok Bot 0.79.3 / host 00b0aa1** (docs first written against 0.47.0 / 48cbefa). What moved
in between is in `../references/host-commands.md` ("Changes since 0.47") and `../references/internals.md`.

## Install

One command, no clone (single bundled file; rerun to update):

```sh
mkdir -p ~/.local/bin && curl -fsSL https://github.com/Agent-Everywhere/AE-external-skills/releases/latest/download/grokbot.mjs -o ~/.local/bin/grokbot && chmod +x ~/.local/bin/grokbot
grokbot doctor
```

Make sure `~/.local/bin` is on your `PATH`. Or from a clone of `Agent-Everywhere/AE-external-skills`:

```sh
cd skills/grokbot/cli && npm ci --omit=dev
chmod +x bin/grokbot.js
mkdir -p ~/.local/bin && ln -sfn "$PWD/bin/grokbot.js" ~/.local/bin/grokbot
grokbot doctor
```

Rebuild the bundle after editing the source: `npm ci && npm test && npm run build` (esbuild writes `dist/grokbot.mjs`).

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
grokbot agents send <ref> "prompt" --wait   # operator: control-plane SendGrokBotUserMessage; box: host sendPrompt
grokbot agents tail <ref> -n 40
grokbot agents search "invoice"             # host-side search across agents
grokbot agents search "invoice" --agent <ref>   # inside one agent's conversation
grokbot agents todos <ref>                  # todo list (control plane for operators, host under agent policy)
grokbot agents tasks <ref>                  # tasks + async tasks + subagents (read-only)

grokbot sections list --members
grokbot sections create "Clients" <refs…>
grokbot sections move "Clients" --name "acme-*"
grokbot sections rename|reorder|sort|prune|export|import
grokbot sections verify            # app store vs host mirror (exit 1 on drift)
grokbot sections sync [--yes]      # Mac only: push the host mirror into the app store
grokbot pins list|add|remove               # Cursor runtime store (what the app reads), host copy mirrored

grokbot automations [--agent <ref>]         # routines: prompt, trigger/schedule, enabled, owner (read-only)
grokbot automations export <dir>            # one markdown file per agent, verbatim prompts (backup)
grokbot automations enable|disable <agent> <routine> --yes   # WRITE, operator-only
grokbot automations delete <agent> <routine> --yes           # WRITE, irreversible, operator-only
grokbot automations slack-workspace <agent> <routine> <teamId> --yes   # WRITE: route a routine through a linked Slack workspace
grokbot automations resume-guard --allow <file> [--dry-run]  # WRITE: re-enable allowlisted routines that got disabled (launchd)
grokbot slack status [--agent <ref>]        # per-agent Slack link state (read-only)
grokbot slack workspaces [--agent <ref>]    # Grok Bot app workspaces (per agent) + the separate routine-trigger link (read-only)
grokbot slack link-url [--reconnect <teamId>]   # Slack OAuth URL to link/refresh a workspace
grokbot slack connect <agent> [--wait [secs]] [--install --yes [--workspace T…]]   # URL, then wait/install
grokbot slack claim <claim> --yes           # rarely needed (see below)
grokbot slack install|reinstall|uninstall <agent> [--workspace T… --replace --forget] --yes
grokbot slack unlink <teamId> --yes
grokbot usage                               # allowance %, reset (PT), included spend, personal cap
grokbot agents export <dir>                 # per-agent JSON (profile, skills, plugins, access) + account workflows; no secrets
grokbot transcripts export <dir> [--agent <ref>] [--since <seq>]   # one JSONL per agent, full paging
grokbot events                              # live SSE stream from the host
grokbot gw countAgents                      # any raw host command
grokbot auto-review get|set|append         # allow/block rules (structured since app 0.79; see Policy)
grokbot cursor whoami|agents|boxes|state|settings|rpc <Method> '{}'
grokbot cdp status|keys main|desktop main.getCursorAuthStatus|text|screenshot out.png
grokbot app restart --debug                 # relaunch with the CDP port (default 9340)
grokbot local roster|sections|search "text" # offline
```

Every command takes `--json`. `grokbot doctor` prints the resolved host, the descriptor file version and any Keychain
or descriptor error on its own `keychain` line (a bad descriptor no longer blanks the host line).

## Deleting at scale

`agents delete` never runs blind:

```sh
grokbot agents delete --name "test-*" --created-before 7d --dry-run     # prints the exact targets
grokbot agents delete --name "test-*" --created-before 7d --yes --confirm-count 37
grokbot agents delete --ids-file dead.txt --yes --confirm-count 120
```

Targets are printed first; `--yes` is required; more than one target additionally requires
`--confirm-count N` equal to the matched count. Positional refs must be a **full agent id or the exact agent name**: an
id prefix or a partial name never selects a delete target (other commands accept prefixes; an exact name or full id
always wins over an id-prefix match). Section membership is refetched right before the cleanup write, so a section edited
meanwhile is not clobbered.

Since app 0.79 the host's `deleteAgents` is a silent no-op for server-hosted agents (it reports success and the agent
stays on the Cursor control plane), so `agents delete` calls control-plane `DeleteGrokBotAgent {id}` for each target and
then re-reads `ListGrokBotAgents` (an empty, truncated, or failed read is unverified: exit 1, nothing mirrored; an id whose RPC failed never counts as deleted; the loop stops on HTTP 401/403/429; deleting every roster agent needs `--allow-empty`). It reports `deleted N/M` only for ids that are gone; any id still listed is printed as
`still present` and the command exits 1. Verified deletes are then mirrored best effort on the host (the bulk
`deleteAgents`, in batches of `--batch`; it is the only host removal command and may do nothing) and dropped from
sections. This needs the owner's Cursor sign-in: under the agent policy (or with nobody signed in) the command refuses
with exit 77 / 1 after the targets and `--yes` gate, and nothing is sent. The host roster can keep listing a deleted
agent for minutes; `agents list` marks any roster agent the control plane no longer lists as `(deleted?)` (JSON:
`deletedOnControlPlane: true`) when a Cursor sign-in is available (operator policy) and a 5s-timeout read returned a complete, non-empty list.

## Slack, routine deletion, and the resume guard (operator-only)

All of these go straight to the Cursor control plane, so the agent policy denies the whole `slack` family and every
`automations` subcommand. Reads (`slack status|workspaces|link-url`) change nothing; every write names its target and needs
`--yes` before anything is sent (`slack claim` also needs `--yes`: it consumes a one-time claim and links a workspace).

- **`slack workspaces`** prints two clearly labelled sections, because Cursor keeps two unrelated Slack links: **Grok Bot app
  workspaces** (the union of `workspaces` from `GetGrokBotSlackInstallState` across **all** agents, at most 6 reads at a time, or just `--agent <ref>`, which must match exactly one agent; this is
  what `slack connect`/`install` use) and the **Routine-trigger link** (`DashboardService`, what `automations slack-workspace`
  uses). The second one is routinely `(none)` while the first lists a workspace; that is normal. `--json` has both
  (`appWorkspaces` and `workspaces`).
- **`slack connect <agent> [--wait [secs]] [--install] [--workspace T…] [--yes]`** prints the OAuth URL plus a note that it must
  be opened in a browser signed in to **both Slack and cursor.com**; the server records the workspace itself when you finish
  there (no client-side claim). With `--json` the URL, note and waiting line go to **stderr** before polling, and stdout carries
  one JSON document at the end. `--wait` polls `GetGrokBotSlackInstallState` every 5s (default timeout 600s) until a workspace
  with a `managerAuthUpdatedAtMs` newer than before the start appears (or the agent becomes `CONNECTED`) and prints it;
  **exit 4 on timeout**. A transient read error (network, 5xx, a read over 15s) is logged to stderr and polling continues; 5
  consecutive failures stop with exit 1. `--install` (implies `--wait`, requires `--yes`, checked before anything starts) then
  installs the app:
  - the single new workspace is picked automatically; only a team id not seen before the start counts, so a bumped timestamp on
    a known workspace never selects an install target; several new ones need `--workspace <teamId>` (exit 4 otherwise);
  - `--workspace` is format-checked up front (`T0123ABCD`); a team that is not recorded yet just keeps being polled;
  - if the agent turned `CONNECTED` during the wait the server already installed it, so no second install is sent;
  - the baseline is taken per run, so finishing the OAuth just after a timeout and re-running `connect --wait --install` would
    wait for a *further* new workspace. Re-run instead as `slack connect <agent> --install --workspace <teamId> --yes` (an
    already-recorded workspace skips the connect URL and the wait) or just `slack install <agent> --yes`.
  The install outcome maps to the usual exit codes below.
- **`slack claim`** is rarely needed: completing the URL in a browser is enough for the server to record the workspace, so
  prefer `connect --wait`. It stays for a one-time claim token that was handed out explicitly.

- **`slack install|reinstall|uninstall|connect|claim`** map the server's outcome enum to an exit code: **0** done
  (`INSTALLED`, `UPDATED`, `UP_TO_DATE`, `REMOVED`, `STARTED`, `CLAIMED`); **4** a human step is needed and nothing is broken
  (`PENDING_ADMIN_APPROVAL`, `WORKSPACE_REQUIRED` with the candidate team ids listed for `--workspace`, `NOT_CONNECTED`,
  `MANAGER_REAUTH_REQUIRED`, `INSUFFICIENT_SCOPES`, `RECREATE_REQUIRED`, `THROTTLED`, `WRONG_CURSOR_ACCOUNT`); **1** refused or
  failed (`NOT_PUBLISHED`, `UNSUPPORTED_HARNESS`, `SLACK_REJECTED`, `RATELIMITED` with the retry hint, `INSTALL_CONFLICT`
  (add `--replace`), `WORKSPACE_NOT_ALLOWED`, an empty or unknown outcome). An OAuth URL in the reply is printed as `open: <url>`.
- **`automations delete`** uses `DeleteGrokBotAgentAutomation`; the host's `deleteAgentAutomation` is a silent no-op for
  control-plane routines. It prints the routine and prompt size, needs `--yes`, then re-reads and fails (exit 1) if the routine
  is still listed. Run `automations export <dir>` first: the prompt is gone for good.
- **`automations slack-workspace`** refuses a team id that is not in `slack workspaces` before writing.
- **`automations resume-guard --allow <file>`** re-enables routines that were disabled (for example by the app or a
  usage cap). The allowlist is one `<agent> | <routine id or name>` per line, or a bare routine id (any agent); `#` starts a
  comment. Matching is **exact and case-insensitive** (agent id or name, routine id or name); a prefix or substring is
  `not-found` and is never written (`--dry-run` adds a "did you mean" hint to help fix the file). Only allowlisted routines that are disabled are ever written (one `SetGrokBotAgentAutomationEnabled` each, then a
  re-read confirms it). It is quiet when nothing changed, prints one timestamped line per action or problem, and exits 1 on any
  error (an entry that matches nothing, an ambiguous entry, a failed or unconfirmed write); an empty allowlist is refused.
  `--dry-run` lists what it would change and writes nothing. Install the LaunchAgent (every 15 min, log
  `~/Library/Logs/grokbot-resume-guard.log`) after creating `~/.grokbot/resume-allow.txt`:
  `launchd/install.sh resume-guard`.

## Pins and auto-review rules (app 0.79+)

Both moved from host settings to the Cursor per-user runtime store, next to sections. `pins list|add|remove|clear` and
`auto-review get|set|append` read the runtime store first (what the app shows) and, as an operator, write it and mirror host
settings. A box has no Cursor auth, so it writes host settings only: the CLI warns on stderr that the app may not show a
pin written from a box (the app falls back to the host list only when the server holds none). `grokbot cursor settings`
prints the whole runtime settings object, read-only. Clearing every pin also mirrors the empty list to host settings and
exits non-zero if that mirror fails (otherwise the app would fall back to the stale host list and bring the old pins back).

## Sending messages (app 0.79+)

The host gateway's `sendPrompt` now answers a Mac-side caller `502 A Sand box session may not make this request on this
endpoint`. `agents send` therefore goes through the control plane (`SendGrokBotUserMessage {agentId, messageId, text,
sentAtMs}` → `{dispatched, mode: ACCEPTED_TEMPORAL}`) for an operator with a Cursor sign-in, and keeps the gateway call under
the agent policy (a box session), where the 502 is turned into an explanation. `--wait` polls the roster and prints the
transcript tail either way: it scans the last 200 entries and anchors on the message just sent (entry id, nonce, or the
prompt text, never an older turn with the same text), so a long run of tool entries cannot hide the reply. `--timeout`
must be a positive number of seconds. A message sent this way is a real user turn: the agent can act on it (including creating or
pausing its own routines through its tools).

## How sections work

Sections are **not** a field on the agent. The primary store is Cursor's per-user runtime settings
(`GetGrokBotUserRuntimeSettings` / `UpdateGrokBotUserRuntimeSettings`, `settings.sidebarSections.sections`):
`[{ id, name, agentIds }]`, one section per agent (first wins). Writes carry `sidebarSectionsBase`, the
list read just before editing, for optimistic concurrency. `__agents__` is the app's built-in
"Unassigned" bucket and is protected. Host settings (`sidebarSections`) are a best-effort mirror (of the list the server stored, not the request) for
older apps; the mirror is skipped, with a stderr warning, whenever the host holds a non-empty layout that
differs from the server list (so a host-only layout is never overwritten), and a mirror failure only warns
on stderr. `sections list` / `export` warn on stderr when the server list is empty but the host holds a layout. The app picks changes up on window focus or reconnect
(`grokbot cdp focus` nudges it when the app runs with the debug port).

**Two stores.** The app reads the Cursor runtime store; a box agent has no Cursor auth, so its `sections` writes
land only in the host mirror (`sidebarSections`) and the CLI says so on stderr (JSON carries
`store: "host-mirror", pendingSync: true`). The Mac, which is signed in, pushes the mirror upstream with
`grokbot sections sync` (preview and `--yes`; `--auto` is the non-interactive form for launchd, never forces and
is quiet when there is nothing to do). Sync reads the app list as the optimistic-concurrency base, refuses an empty
mirror (it would wipe the app), and refuses when both sides changed since the last sync unless `--force`.

The last-sync snapshot (`{ at, key, conflictKey? }`) is a Mac-local file, `~/.grokbot/sections-sync.json`
(override with `GROKBOT_SECTIONS_SYNC_FILE`; written atomically, mode 0600). It is not a host setting: the live
host silently drops unknown settings keys. Consequently `sections verify` run inside the box has no snapshot to
compare against.

**Auto-sync (launchd).** `launchd/install.sh` installs the LaunchAgent `com.grokbot.sections-sync`
(runs `grokbot sections sync --auto` at load and every 2 minutes; log `~/Library/Logs/grokbot-sections-sync.log`).
`--auto` semantics: box (host mirror) edits are pushed only when the app store is unchanged since the last sync. On
a real conflict (both sides changed) the **app copy wins**: nothing is written, the command exits 0, and one
timestamped line with the app-vs-host diff goes to stderr (the log), once per distinct conflict (tracked as
`conflictKey` in the snapshot file). With no snapshot yet, `--auto` writes one only if the two stores already agree;
otherwise it skips with a note until you review (`--dry-run`) and run `sections sync --yes --force` once.
Without `--auto`, a conflict still refuses (use `--force` to push the mirror anyway).

`sections verify` (or `sections list --stores`) shows both stores and says "in sync" or "DRIFT". Exit code 1 means
drift or a pending sync.

## Selection flags

Available on `agents list|hide|unhide|read|unread|delete` and `sections move|unassign`:
`--name <glob>` `--match <text>` `--regex <re>` `--hidden` `--all` `--groups/--no-groups`
`--running` `--idle` `--unread` `--awaiting` `--idle-for 7d` `--created-before 2w`
`--created-after 1h` `--section <ref|none>` `--ids-file <file>`.

## Environment

| Var | Purpose |
|---|---|
| `GROKBOT_GATEWAY_URL` + `GROKBOT_GATEWAY_TOKEN` (+ `GROKBOT_GATEWAY_HEADERS` JSON) | bypass the app's descriptor |
| `GROKBOT_CDP_PORT` | default CDP port (9340; pwkit uses 9333+) |
| `GROKBOT_SAFE_STORAGE_PASSWORD` | skip the Keychain lookup (CI/tests) |
| `GROKBOT_APP_SUPPORT`, `GROKBOT_APP_BUNDLE`, `GROKBOT_HOME` | alternate paths |
| `GROKBOT_DEBUG=1` | stack traces |

`cdp desktop <path>` calls `window.desktop.<path>`. The 0.47 paths `agent.getSidebarSections`, `agent.getPinnedAgents`,
`cursorAccount.getStatus` and `getBoxHostPhase` are rewritten onto the 0.79 `main.*` bridge (reads only); use
`grokbot cdp keys main` to browse the new surface. Every CDP call times out (default 30s; known-slow calls such as
restart/update/sign-in paths get 120s); `cdp eval|desktop --timeout <sec>` overrides it (max 2147483 seconds), and a closed
websocket rejects in-flight calls instead of hanging. After a section write the CLI nudges the running app to re-read its
sections over CDP; that nudge is skipped under the agent policy, where `cdp` is denied.

See `../references/host-commands.md` for the full host command catalog and `../references/internals.md` for how the
app stores credentials and state.

## Running inside a Grok Bot box (no Mac)

A Grok Bot agent's own cloud computer ("box") is itself a place `grokbot` can run — no Electron,
no Keychain. The host writes a plain-JSON gateway descriptor (`{scheme, host, port, token, pid,
startedAt}`); the CLI checks, in order, `$SAND_DATA_ROOT/gateway.json`,
`$GROKBOT_BOX_GATEWAY_JSON`, then the hardcoded `/home/box/agent-data/gateway.json`,
`/home/box/sand-data/gateway.json`, `~/agent-data/gateway.json`, `~/sand-data/gateway.json` — the
first that exists wins (unchanged in app 0.79.3: the host data roots are still `/home/box/sand-data` and
`/home/box/agent-data`). It always dials `127.0.0.1:<port>` (never the bound `0.0.0.0` host) and
skips every Mac-only surface. `grokbot policy`/`grokbot doctor` print exactly which file was used.

```sh
mkdir -p ~/.local/bin && curl -fsSL https://github.com/Agent-Everywhere/AE-external-skills/releases/latest/download/grokbot.mjs -o ~/.local/bin/grokbot && chmod +x ~/.local/bin/grokbot
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
  duplicate, interrupt, import sections, clear all pins, patch raw settings, or reach the
  lower-level `gw`/`cursor`/`cdp`/`app`/`automations`/`slack` surfaces (including
  `doctor`'s Cursor section, which is skipped under agent policy). A denied command exits **77**
  and is never run.

  **Auto-review rules are agent-allowed.** `grokbot auto-review get|set|append` reads and updates only the
  `autoReviewInstructions` setting, which since app 0.79 is `{isEnabled, allowInstructions[], blockInstructions[]}` (it was a
  free-form string in 0.47). One rule per line; `--list allow|block` picks the list (default allow). Raw `settings set` stays
  denied, because a free-form key/value patch is too broad. `set` replaces one list (text argument, `--file <path>`, or
  `--stdin`; exactly one), keeps the other list and `isEnabled`, and rejects an empty value unless `--clear` is passed
  (with no other source); it prints the previous list's size to stderr before writing. `isEnabled` is never guessed: when no
  value is stored yet, `set`/`append` need `--enable`; a pre-0.79 free-form string in host settings is refused outright (it is
  not silently converted to lists). `append` adds one single-line rule
  and is a no-op when the rule is already in the list; it is a single-writer read-modify-write, not atomic. Every
  `set`/`append` write adds an audit record (`path`, `sha256`, `length` of the new rule list as JSON, never the rules
  themselves; plus which `list`) under every policy, operator included.

  **`GROKBOT_POLICY=operator` cannot downgrade a real box.** An agent controls its own process
  environment, so once `resolvePolicy()` detects an actual box gateway file it always returns
  `agent`, regardless of what `GROKBOT_POLICY` is set to — operator mode is only reachable
  off-box. `GROKBOT_POLICY=agent` can still be forced off-box (useful for testing).

  **Removing every pin one at a time reaches the same end state as the denied `pins clear`.**
  Per-item removal is allowed and audited individually, so the action stays visible in the audit
  log even though it isn't blocked outright — the policy prevents casual wholesale resets, not a
  deliberate loop.

Under the agent policy the CLI never builds a Cursor client, even when a Cursor token is readable (for example
`GROKBOT_POLICY=agent` on a Mac): sections, pins and auto-review edits are host-settings writes only.

Run `grokbot policy` to see the active mode, the box gateway path (if any), and the full denylist.
Every invocation under `agent` policy — allowed or denied — appends one JSONL record (timestamp,
policy, command path, argv redacted, decision) to the audit log. Inside a real box the log always
lives next to the host's own `gateway.json` (e.g. `/home/box/agent-data/grokbot-audit.jsonl`) and
`$GROKBOT_AUDIT_LOG` is ignored there, so the agent cannot redirect or silence it via its own env;
off-box, `$GROKBOT_AUDIT_LOG` (else `~/.grokbot/grokbot-audit.jsonl`) applies. Operator-mode runs
are not audited.
