---
name: claude-desktop
description: >-
  Operate the Claude Desktop app on your Mac from Claude Code: open Chat, Cowork or Code tasks with a
  prompt, send, read replies, click approvals; manage projects, skills, connectors and scheduled tasks.
  Uses claude:// deep links plus Peekaboo. Needs macOS 15+. Not for the Claude API, claude.ai in a
  browser, or Claude Code's own sessions.
---

# claude-desktop

> **Unofficial.** Not affiliated with or endorsed by Anthropic. It drives the app by screenshots and
> clicks, so it can break when the layout changes.

A skill plus the `desktop.py` helper, for Claude Code on a Mac driving the Claude Desktop app (plugin `ae-desktop-operator`). Work from screenshots and window-relative coordinates. `references/ui-map.md` has click paths.

## Tools

Deep links prefill a new task and never submit (14,000 characters at most): `claude://claude.ai/new?q=`
(Chat), `claude://cowork/new?q=`, `claude://code/new?q=...&folder=` (the user confirms the folder in
Desktop; the user decides it, not you).

`scripts/desktop.py` (stdlib; shells out to `peekaboo` and `open`; install with `brew install
openclaw/tap/peekaboo`):

- `doctor`, `activate`, `frontmost-check`, `open --mode chat|cowork|code --prompt-file F`.
- `shot PNG` (then read it), `click X Y`, `type "text"`, `press cmd+a`, `scroll down --amount 10 --at X,Y`.
- `wait-idle --timeout 180 --out PNG`: returns when two screenshots match.
- `config-mcp list|add|remove --restart`; `approvals-log start|add|show`.

## Rules

1. **Preflight.** Run `doctor`; the terminal running Claude Code needs Screen Recording, Accessibility
   and Automation permission (only the user can grant them). Tell the user to leave the Mac alone, close anything sensitive on screen, and wait for their go-ahead.
2. **Screenshot before every click**: fresh `shot`, read it, click, `shot` again to confirm. Click Send
   rather than pressing Return; input goes to the frontmost window.
3. **Stop if the wrong window is frontmost** or you see another app, an unexpected dialog or a login.
   Send no more input and tell the user.
4. **Never type secrets** (passwords, keys, tokens, 2FA codes) or put them in a prompt or link. Hand
   sign-in and OAuth or consent pages to the user.
5. **Approvals: ask once.** Before a run with many routine approvals, ask the user in chat: Auto mode,
   "Allow all for this website", or approve each. Record their words with `approvals-log start --user-ok
   "<words>"`. Without that OK use only limited buttons ("Allow once") and stop after 5 (the tool refuses
   the 6th). Read the whole prompt in a fresh screenshot, click one at a time, never script clicks, log
   each with `approvals-log add --prompt --button --shot`, and report the log at the end.
6. **Outward-facing or destructive actions need the user's explicit yes in chat for that action**:
   sending or posting, payments, deleting, new connectors or permissions, other people's data, anything
   you cannot fully read. "Run the demo" does not cover them. Code mode may default to bypassing
   permissions: do not send there without the user's OK, a folder and a permission mode.
7. **Account changes** (projects, skills, connectors, schedules, MCP config): prefix what you create with
   `zz-`, remove only that, never touch the user's own items, use Manual schedules, ask before restarting
   Desktop.

## Flow

`open` with a prompt file, `shot` and check the text, click Send, `wait-idle`, read the final screenshot.
Idle may mean blocked on an approval; scroll for stacked prompts. Follow-up: click
the message box, `type`, `shot`, click Send.

"Window minimized": run `activate` (-1743 means Automation permission is missing). `type "-x"` needs
`--` first. "Outcome is indeterminate" is normal: verify by screenshot, never retype. Keep screenshots local.
