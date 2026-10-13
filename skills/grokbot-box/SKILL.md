---
name: grokbot-box
description: >-
  For a Grok Bot agent running inside its own cloud box that needs to manage its sibling Grok Bot
  workers with the `grokbot` CLI. Use to list the other workers, create a worker or a group chat,
  organize workers into sections or pins, send a prompt to a worker and wait for its reply, read a
  worker's transcript, or delete workers that are no longer needed. Runs under a restricted,
  audited agent policy. For a person driving the Grok Bot desktop app from a Mac, use the grokbot
  skill instead.
---

# grokbot-box

> **Unofficial.** `grokbot` is not affiliated with or endorsed by Cursor or xAI. It uses Grok Bot's private, undocumented interfaces, which may change or break at any time. Use at your own risk: some commands can delete agents and sections.

This skill is for a **Grok Bot agent inside its own cloud box** that manages its sibling Grok Bot
workers. The CLI, command reference, and internals live in the `grokbot` skill and are not
duplicated here. This skill is installed on its own, so it does not ship the CLI: install it in
the box by cloning the repo (see "Install inside the box"), and read the docs from that clone
(`AE-external-skills/skills/grokbot/...`) or from GitHub
(<https://github.com/Agent-Everywhere/AE-external-skills/tree/main/skills/grokbot>). A human on a
Mac uses the `grokbot` skill directly.

## What you can do

- **List and look up workers:** `grokbot agents list`, `agents get <ref>`, `agents search "..."`
- **Create:** `grokbot agents create "<name>" -d "<description>" --no-intro` (add `--section <name>`
  to place it), and `grokbot groups create "<name>" <ref...>` for a group chat
- **Organize:** `agents rename|hide|unhide|read|unread`, `sections create|rename|move|delete`,
  `pins add|remove`
- **Send to a worker:** `grokbot agents send <ref> "<prompt>" --wait --timeout 300` prints the reply
- **Read a worker:** `agents tail <ref> -n 40`, `agents thread`, `agents outline`
- **Delete workers** you no longer need (see below)

Refs are name-based: an exact name, a unique substring, or an id / id prefix. Every command takes
`--json`.

## Deleting workers

`grokbot agents delete` is allowed under the agent policy, with extra gates:

- **Full id or exact name only.** Id prefixes and substrings are refused when deleting, so a typo
  cannot match the wrong worker.
- Preview first: `grokbot agents delete --name "scratch-*" --created-before 7d --dry-run`
  prints the exact targets and deletes nothing.
- The real run needs `--yes`, plus `--confirm-count N` equal to the matched count when more than
  one worker matches.
- Never delete your own agent. Tell the person (or the orchestrating agent) which workers you are
  about to delete, using the dry-run output, before you run the real delete.

## Install inside the box

Needs Node 20+ in the box. Clone the repo and install the CLI's one dependency:

```sh
git clone https://github.com/Agent-Everywhere/AE-external-skills.git
cd AE-external-skills/skills/grokbot/cli && npm install --omit=dev
chmod +x bin/grokbot.js
mkdir -p ~/.local/bin && ln -sfn "$PWD/bin/grokbot.js" ~/.local/bin/grokbot
grokbot policy    # expect "policy agent" and the box's gateway.json path
grokbot status
```

(The repo's bundled `cli/dist/grokbot.mjs` also runs without `npm install`:
`node AE-external-skills/skills/grokbot/cli/dist/grokbot.mjs status`.) The CLI finds the host
through the box's own `gateway.json`; no Keychain, no Electron.

## The agent policy (read this)

Inside a real box the CLI forces the **agent** policy. It is an **advisory guardrail with a
best-effort audit log, not a security boundary or sandbox.** It is enforced only inside this CLI:
an agent that can run arbitrary code in its box can still reach the host gateway directly, so the
policy catches accidents and casual overreach, not a determined actor. Do not route around a
denial with an alias, a raw `gw` call, or another tool; if a denied command is genuinely needed,
ask the human to run it from their Mac.

Commands denied under the agent policy (exit code **77**, never run):

```
agents duplicate
agents interrupt
sections import
pins clear
settings set
gw
cursor
cdp
app
automations
```

(`doctor` still runs, but its Cursor section is skipped.) Removing pins one at a time reaches the
same end state as the denied `pins clear`; it is allowed, so do not treat "not denied" as "off the
record."

**Audit log:** every agent-policy invocation, allowed or denied, is appended on a best-effort
basis as one JSON line (timestamp, policy, command path, redacted argv, decision) to
`grokbot-audit.jsonl` next to the box's `gateway.json` (for example
`/home/box/agent-data/grokbot-audit.jsonl`). Write failures are silently ignored, and `--help`
output and argument parse errors are not logged. `GROKBOT_POLICY=operator` is ignored inside a
real box.

## References

In the repo clone (`AE-external-skills/`), or at
<https://github.com/Agent-Everywhere/AE-external-skills/tree/main/skills/grokbot>:

- `skills/grokbot/cli/README.md`: complete CLI reference, including the box section.
- `skills/grokbot/references/host-commands.md`: host gateway command catalog.
- `skills/grokbot/references/internals.md`: how the app stores credentials and state.
