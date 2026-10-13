---
name: claude-desktop
description: >-
  Operate the Claude Desktop app on your Mac from Claude Code. Use when the user wants to open a
  Chat, Cowork, or Code task in Claude Desktop with a prompt, send it, read the reply, send
  follow-ups, or click approval prompts; for example to dry-run a skill in Cowork, hand work off to
  Desktop, or run a live demo. Drives the app's screen with Peekaboo and the official claude://
  deep links. Needs Claude Code on the Mac that has Claude Desktop installed and signed in. Not for
  the Claude API, claude.ai in a browser, or Claude Code's own sessions.
---

# claude-desktop

> **Unofficial.** Not affiliated with or endorsed by Anthropic. It drives the app by looking at the screen and clicking, so it can break whenever Claude Desktop's layout changes. Use at your own risk.

Your Claude Code operates the **Claude Desktop** app on your Mac the way a person would: open a task
with a prompt, press Send, watch for the reply, read it, follow up, and click approvals. Typical uses:
dry-run a skill in Cowork before shipping it, hand a job to Desktop, or run a demo.

Claude Desktop is an Electron app and exposes almost no accessibility labels, so this skill works from
**screenshots and window-relative click coordinates**. Tasks start from the official `claude://` deep
links, which prefill a prompt but never submit it.

**Read `references/safety.md` before the first action.** The short version: the user must not touch the
Mac while you drive it, you never click an outward-facing or destructive approval without the user's
explicit OK in this chat, you never type secrets, and screenshots stay on this machine.

## Helper script

`scripts/desktop.py` (Python 3 standard library; shells out to `peekaboo` and `open` only; no network).
`<skill-dir>` is the folder holding this `SKILL.md`.

```sh
python3 <skill-dir>/scripts/desktop.py doctor
python3 <skill-dir>/scripts/desktop.py open --mode cowork --prompt-file prompt.txt   # cowork | chat | code
python3 <skill-dir>/scripts/desktop.py activate                  # bring Claude to the front, any Space
python3 <skill-dir>/scripts/desktop.py frontmost-check           # exit 1 unless Claude is frontmost
python3 <skill-dir>/scripts/desktop.py shot /tmp/cd-1.png        # activates first, prints PNG size
python3 <skill-dir>/scripts/desktop.py click 640 700             # refuses unless Claude is frontmost
python3 <skill-dir>/scripts/desktop.py type "follow-up text"     # click the field first
python3 <skill-dir>/scripts/desktop.py press cmd+a
python3 <skill-dir>/scripts/desktop.py scroll down --amount 10 --at 900,400
python3 <skill-dir>/scripts/desktop.py config-mcp list           # also: add NAME --command C --arg=A | remove NAME, --restart
python3 <skill-dir>/scripts/desktop.py wait-idle --timeout 180 --interval 6 --out /tmp/cd-done.png
```

Every subcommand is a thin wrapper over the raw commands in `references/peekaboo.md`; use those
directly if the helper is in your way.

## What it can do

Verified live on 2026-10-13 (see `references/ui-map.md` for the screens and click paths):

- Chat, Cowork and Code tasks: open with a prompt, send, wait, read the reply, type a follow-up, pick a model, switch modes. (Code: prefill only; sending runs with the permission mode shown, so ask the user first.)
- Projects: create (name, goal, a file), edit instructions, start a chat in it, delete.
- Skills (Customize > Skills): upload a zip, enable/disable, replace, remove.
- Connectors (Customize > Connectors): add a custom connector by URL, per-chat on/off, refresh tools, remove. Sign-in/OAuth is always handed to the user.
- Local MCP servers: `desktop.py config-mcp` edits `claude_desktop_config.json` with a backup, then restarts Desktop.
- Scheduled tasks: create (manual), list, run now, delete.
- Settings (`cmd+,`) and sidebar navigation.

Before any of these, read the matching section of `references/ui-map.md` and the matching rule in
`references/safety.md`. Every click is: screenshot, read, locate, click, screenshot to confirm.

## Preflight (every session)

1. **Run `desktop.py doctor`.** It checks, and you fix in this order:
   - macOS 15 or newer (`sw_vers -productVersion`).
   - Peekaboo installed: `brew install openclaw/tap/peekaboo` (or run it ad hoc with `npx -y @steipete/peekaboo`).
   - Permissions granted to the **terminal app that runs Claude Code**: Screen Recording and
     Accessibility (Event Synthesizing is optional but needed for some input). Verify with
     `peekaboo permissions status`. The user grants them in System Settings > Privacy & Security;
     you cannot.
   - Claude Desktop is running (`open -a Claude`).
2. **Confirm sign-in from a screenshot.** If you see a login screen, stop and ask the user to sign in;
   never type credentials.
3. **Tell the user** you are about to take over mouse and keyboard, and ask them to leave the Mac alone
   and close anything sensitive on screen. Wait for their go-ahead.

## Procedure

1. **Write the prompt to a file** (keep it under about 14,000 characters; for longer material, put it in
   a file the task can read and prefill a short prompt that points at it).
2. **Open the task:** `desktop.py open --mode cowork|chat|code --prompt-file prompt.txt`. This prefills
   a new task and never submits. `--mode code` accepts `--folder <path>`, which makes Desktop show a
   confirmation dialog the user may need to approve (see `references/deep-links.md`). A caution banner
   for linked prompts is normal.
3. **Screenshot and read it:** `desktop.py shot /tmp/cd-1.png`, then read the PNG. Check that the
   Claude window is the one in front and the prompt text is in the message box. Work out the capture
   scale from this first screenshot (see `references/peekaboo.md`, "Coordinates").
4. **Click Send** (the arrow button at the right of the message box) with `desktop.py click X Y`. Prefer
   clicking Send over pressing Return: a key press goes to whatever window has focus.
5. **Wait for the reply:** `desktop.py wait-idle --timeout 180`. It captures every few seconds and
   returns when two consecutive screenshots look the same (decoded pixels compared in 8x8 blocks,
   tolerating a few changed blocks and ignoring the bottom 140 px where the blinking caret lives). Then **read the final screenshot**
   and confirm it is really finished (see below). Tune `--interval` and `--timeout` to the task; a
   Cowork task that runs tools can take many minutes, so loop: wait, read, decide.
6. **Read the reply** from the screenshot. Scroll the conversation if the reply is longer than the
   window (see `references/peekaboo.md`, "Scrolling"). Summarize for the user; quote exactly when they
   asked for the verbatim text.

## Reading replies and knowing when it is done

`wait-idle` is a heuristic, not a signal. A still screen can mean finished, but also "waiting on an
approval", "paused between tool calls", or "error banner". After every `wait-idle`, read the
screenshot and look for:

- the **Stop** button where Send was (still generating) versus the Send arrow (finished);
- an **approval or permission prompt** (Allow / Deny buttons) that is blocking progress;
- an **error or rate-limit banner**, or a "Continue" button;
- a running spinner can keep two screenshots from ever matching. `wait-idle` already tolerates a
  blinking caret (`--tolerance 0.002`, `--ignore-bottom 140`); if the screen has clearly stopped
  changing but it times out, raise `--tolerance` (e.g. 0.01) or `--ignore-bottom`, use
  `--interval 10`, or compare by eye. `--ignore-bottom 0` compares the whole window.

## Follow-ups

Click the message box (near the bottom of the window), then
`desktop.py type "<text>"`, then click Send. Take a screenshot between the type and the click to confirm
the text landed in the Claude window and not elsewhere. Then wait-idle and read again.

For long follow-ups, prefer `open --mode ... --prompt-file` for a new task over typing a wall of text.

## Approvals

When Desktop asks for permission (run a tool, access a folder or connector, edit a file):

- **Read what it is asking.** Screenshot, read the full text of the request.
- **Routine and local, inside what the user asked for** (for example reading a file in the task folder):
  you may click Allow, and tell the user you did.
- **Outward-facing or destructive** (sending a message or email, posting, payments or purchases,
  deleting or overwriting, granting a connector or new permission, anything touching other people's
  data): **stop and ask the user in this chat.** Show them the exact request. Click only after an
  explicit yes for that specific action. Approval to "run the demo" is not approval for the actions
  inside it.
- When unsure which kind it is, treat it as outward-facing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `window minimized` / `target not found` although Claude runs | Claude is not frontmost (or is on another Space). `desktop.py activate` (System Events `set frontmost`; `open -a` and AppleScript `activate` do not work for this). `shot`, `click`, `type`, `press`, `scroll` and `wait-idle` call it for you |
| `type` says "indeterminate" | Normal with Peekaboo 4.9.2: the text usually landed. Screenshot to confirm; do not retype blindly |
| A native file picker is open and `shot` shows a dimmed Claude | The picker is a separate window; drive it with System Events (see `references/ui-map.md`) and look with `screencapture -x` |
| Screenshot is blank, or `see` fails with a permission error | Screen Recording not granted to the terminal app; grant it, restart the terminal, rerun `doctor` |
| Clicks land in the wrong place | Re-derive the scale from a fresh screenshot; the window may have moved or resized; use `--foreground`; see `references/peekaboo.md` |
| Click or keys refused ("background" / "consent") | Add `--foreground` (the helper always does) |
| Text or Return went to a different app | **Stop.** Something else had focus. Follow `references/safety.md`, then ask the user before continuing |
| Deep link does nothing | Claude Desktop not running or not signed in, or the link was over about 14,000 characters; open the app first and retry |
| `peekaboo see` returns almost no elements | Expected for this Electron app; use `--no-elements` and coordinates |
| `wait-idle` never settles | Spinner or other animation; try `--tolerance 0.01`; read the screenshot yourself; see "Reading replies" |
| Dialog asking to confirm a folder | Deep-link `folder` safety prompt; the user decides, not you |

## References

- `references/peekaboo.md`: install, permissions, every command and flag used, coordinates, gotchas.
- `references/deep-links.md`: the `claude://` links, parameters, limits.
- `references/ui-map.md`: dated screen landmarks and click paths for every operation above.
- `references/safety.md`: rules for driving someone's Mac. Read first.
