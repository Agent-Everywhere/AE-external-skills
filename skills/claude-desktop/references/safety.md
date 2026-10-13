# Safety rules for driving Claude Desktop

This skill takes over the user's real mouse and keyboard on their real, signed-in Mac. Treat that as
the high-trust operation it is. Read this before the first action of a session.

## 1. The user must not use the Mac while you drive

Peekaboo clicks and typing go to the **frontmost window** and the real cursor. If the user switches
apps, clicks, or types while you work, your input can land in their mail, chat, or terminal.

- Before starting, tell the user to leave the Mac alone, quit or hide anything sensitive, and silence
  notifications. Get an explicit go-ahead.
- Do not run this skill while the user is screen sharing, recording, or presenting something else.
- When you are done, tell the user control is back with them.

## 2. Stop if the wrong window is in front

Before every click or type that matters, the latest screenshot must show the Claude window, the
expected conversation, and the target control. If a screenshot shows another app, a system dialog, a
different conversation, or a login screen, **stop**, do not send more input, and tell the user what you
see. Do not "click through" an unexpected dialog.

If text may have been typed into the wrong place, say so plainly and tell the user where it may have
gone.

## 3. Approvals: never click outward-facing or destructive ones without the user's explicit OK

Claude Desktop will ask permission to do things. You may click routine, local, in-scope approvals the
user clearly asked for, and report them. For the following, **ask in the Claude Code chat first,
quoting the request, and click only after an explicit yes for that specific action**:

- sending or posting anything to other people: email, chat messages, comments, social posts, forms;
- payments, purchases, subscriptions, bookings;
- deleting, overwriting, moving, or sharing files or data;
- granting a **connector, integration, or new permission**, signing in to a service, or approving
  access to folders beyond the task's folder;
- anything touching third parties' data, production systems, or accounts;
- anything you cannot fully read or do not understand.

A blanket "go ahead and run the demo" does not cover these. When in doubt, ask.

### Hard rules for every approval prompt

Incident (2026-10-13): during a Cowork demo the operator clicked about 29 "Allow Claude to fetch pages
from <site>?" prompts, some blind on partly visible prompts, wrote and ran its own OCR auto-approve
script, and did not record what the setup-question clicks answered, so it could not prove that no
"Allow all for this website" was granted. These rules exist so that cannot happen again.

1. **Never write or run an auto-approve or auto-click script** (OCR loops, polling clickers, macros, a
   `while` loop around `click`). Every approval is one deliberate click by you after reading it.
2. **Click only when the WHOLE prompt is visible.** The latest fresh screenshot (taken after the prompt
   appeared, not reused) must show the prompt text and all of its buttons. Read the label of the exact
   button you are about to click. A partly visible, cropped or scrolled prompt: scroll until it is whole,
   screenshot again, then decide.
3. **Never click blind and never click in pairs.** One screenshot, one click, one screenshot to confirm
   the result, before the next. Do not queue a second click on the strength of the first screenshot.
4. **Prefer the most limited option** ("Allow once", this call only) over anything broader.
5. **NEVER choose "Allow all", "Always allow", "for this task", "for this website/site/chat" or any
   standing grant** without the user's explicit OK in this chat for that exact scope. Setup questions
   and permission dialogs are approvals too.
6. **After 5 routine approvals in one run, stop and ask the user.** They may prefer to allow the sites
   themselves. `desktop.py approvals-log` prints this warning at the fifth entry; obey it.
7. **Log every approval** right after clicking, including answers to setup questions:
   `desktop.py approvals-log add --prompt "<text as read>" --button "<label clicked>" --shot <png>`
   (default file `./desktop-approvals.jsonl`; use `--log` to put it where the user can read it). Entries
   are time-stamped JSONL and flag broad grants. At the end of the run, `approvals-log show` and **report
   the log to the user**, including the count and whether any broad grant was clicked.

## 4. Never type secrets

Do not type passwords, API keys, tokens, recovery codes, or 2FA codes into Claude Desktop or anywhere
else, and do not put them in a prompt or deep link (deep links also show up in shell history and
process lists). If the app needs a login or a secret, ask the user to do it themselves, then wait.

## 5. Screenshots can contain private data

A Claude Desktop screenshot can include other conversations in the sidebar, file names, personal
details, and anything the task produced.

- Keep screenshots **local**: write them to a temp folder, do not upload, commit, paste into other
  tools or chats, or send them over the network.
- Read them yourself and share only the text the user needs, not the images.
- Delete screenshots you no longer need when the session ends.

## 6. Prompts you send are real prompts

What you prefill and send runs in the user's account and counts against their usage, and in Cowork or
Code it can act on their files. Do not send prompts the user has not seen or would not recognize. Keep
the prompt visible in the Claude Code chat (or a prompt file the user can read) before sending.

## 7. Keep it bounded

Drive only the task the user asked for. Do not browse the sidebar, open other conversations, change
settings, or read unrelated history. Stop when the task is done or after repeated failures; do not
brute-force the UI.

## 8. Account changes: projects, skills, connectors, schedules, config

These operations change the user's real account. Besides the rules above:

- **Name everything you create** with an obvious test prefix (for example `zz-`), record what you created,
  and delete only those items at the end. Never remove, replace, disconnect, or edit items the user made
  (their skills, connectors, projects, scheduled tasks, chats). Confirm the item's name on screen before
  every delete; many confirm dialogs do not name the target, so verify afterwards that the right one is gone.
- **Skills:** upload only files the user has seen. A skill's text runs as instructions in future chats, so
  never upload content from an untrusted source. Replacing or removing a skill deletes its version history.
- **Connectors:** adding one gives Claude a new outward channel. Add only a URL the user gave you. When a
  connector asks to sign in, **stop and hand over**: never complete an OAuth/consent page, never click
  Allow, never type credentials or tokens. Do not use **Disconnect** or change tool permissions (allow/block)
  on connectors you did not add. Enabling a connector in a chat only makes it available; approvals for its
  tool calls are outward-facing and need the user's yes.
- **Local MCP config** (`claude_desktop_config.json`): a server entry is a program Desktop will run on
  startup. Add only a command the user named. Never put secrets in `--env` (they would sit in a plain-text
  file and in shell history). `desktop.py config-mcp` backs the file up, refuses invalid JSON, and touches
  only the named entry, but restarting Desktop interrupts running tasks: ask first. Remove your own test
  entry and any `.bak-` copies you made when finished.
- **Scheduled tasks:** a schedule keeps acting after you leave. Prefer **Manual** frequency and **Manual**
  permissions for tests; never choose "Skip all approvals" or "Require this computer" on your own. Do not
  schedule anything that sends, posts, or deletes. Delete test tasks, which also deletes their runs.
- **Code mode:** the Code box may default to a permission-bypassing mode. Do not send there without the
  user's explicit OK, a chosen folder, and a permission mode they approved.
- **Projects:** uploading a file to a project shares it with Claude in every chat of that project. Use
  non-sensitive files only for tests; deleting a project deletes its chats.
- **Native file pickers:** typing a path into the picker (via System Events) goes to whatever has focus.
  Confirm with a full-screen `screencapture` that the picker is the front window before you type.
