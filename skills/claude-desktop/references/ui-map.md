# Claude Desktop UI map

Landmarks observed on **2026-10-13**, Claude Desktop 2.31 on macOS 15, window 1200x800 capture px
(`desktop.py shot` prints the size). **Coordinates are hints.** The window size, sidebar width, banners,
and the app version all move things: always `shot`, read the PNG, locate the control visually, click,
`shot` again to confirm. Coordinates below are capture pixels from the window's top-left. The sidebar is
about 315 px wide; with the "Search" box visible (after a restart) the sidebar items sit about 37 px lower
than listed (New y~110 instead of 73).

Rules that apply everywhere:

- **Hover first.** Row-level hover controls (the `...` at the right of a sidebar row) often need the pointer
  to arrive before a click registers: click twice (about 0.7 s apart) and check the menu opened.
- **Typing:** click the field, `desktop.py type "text"`. Peekaboo 4.9.2 usually exits with "outcome is
  indeterminate" even though the text landed; the helper reports that. **Screenshot to confirm; never retype
  blindly.** `press cmd+a` then `type` replaces the content of a field.
- **Native file pickers** (upload dialogs) are separate macOS windows and `peekaboo --app Claude` cannot see
  them. Drive them with System Events: `keystroke "g" using {command down, shift down}`, `keystroke "<absolute
  path>"`, `key code 36` (Return) to go to the path, `key code 36` again to Open. Confirm with
  `screencapture -x <file>` (full screen) because `shot` shows only the Claude window.
- `Escape` through `press` can fail with "changed exact focus identity" while a modal animates; wait a second
  and retry, or click the dialog's X.
- Confirm-delete dialogs often do **not** name the target. Confirm from the screenshot taken just before
  (the row or page you opened) and verify afterwards that the right item is gone.

## Window and sidebar

Left sidebar (Chat mode): New (60,73), Projects (73,102), Artifacts (73,131), Scheduled (73,160),
Customize (80,189), More (63,218), then Pinned, then chats grouped Today / Yesterday. Top bar: sidebar
toggle (105,26), back/forward, and the mode switch at the top left of the content: **Chat/Cowork** icon
(249,26) and **Code** icon (287,26). Account row bottom left ("<name> . Max"). `cmd+,` opens Settings.

## New Chat / Cowork / Code task

- **New** (sidebar) opens the home screen: greeting, one big message box (~y 392), below it
  `Project or folder` (left, ~486,499), the **model chip** ("Haiku 5.5 Medium", ~975,499) and a permissions
  chip ("Auto", ~1066,499). The small `+` at the left bottom of the box (433,451) opens the attachments
  and connectors menu. The send arrow (return icon) is at the right end of the box (~1082,451 on the home
  screen; ~1152,730 on an open conversation).
- **Deep links** prefill and never submit: `desktop.py open --mode chat|cowork|code --prompt-file F`. In this
  version the Chat and Cowork links both land in the same chat window (the Cowork one with a Cowork-style
  session, shown by a laptop icon next to the title). After the link, `shot`, check the prompt text, click the
  send arrow.
- **Code** (mode switch (287,26)): left list of Code sessions grouped by folder, a "Welcome back" panel, and at
  the bottom `Local` / `No folder` chips, the message box, and a **permissions chip that defaulted to
  "Bypass permissions"** plus model chip ("Opus 5.5 Low"). A Code session can edit files and run commands:
  **do not send in Code mode without the user's explicit OK, a chosen folder, and a sane permission mode.**
  Verified: the deep link prefilled the box. Send was deliberately not exercised.
- **Send and wait:** click the arrow, then `desktop.py wait-idle`. A one-line reply settled in about 6 s; a
  120-line reply in about 9 s. Success looks like: your message right-aligned in a grey bubble, the answer
  below it in serif text, and a row of small icons (copy, speaker, thumbs, retry) under the answer. While
  generating there is a Stop control where send was.
- **Approval prompts stack and hide the reply box.** In Cowork, several "Allow Claude to ..." prompts can
  pile up in the conversation and push the `Reply` box (and the prompts' own buttons) out of view. When the
  reply box is missing or `wait-idle` says "idle" but nothing finished, scroll up and down
  (`desktop.py scroll up|down --amount 10 --at 900,400`) to find the prompts, make the whole prompt visible,
  and only then follow the approval rules in `safety.md`. Log each click with `desktop.py approvals-log`.
- **Follow-up:** click the `Reply` box (~700,730), `type`, screenshot, click send (~1152,730), `wait-idle`.
- **Scroll long replies:** `desktop.py scroll down --amount 30 --at 900,400` (clicks that point first, so pick
  empty space in the conversation, then scrolls).
- **Pick a model:** click the model chip (home screen ~975,499; in a conversation bottom right, ~1010,778). A
  list opens with model names and an effort level; click one and confirm the chip text changed. Changing it
  affects only the new/current chat.
- **Switch Chat <-> Cowork <-> Code:** the top-left mode switch. Chat/Cowork share one sidebar; Code has its own
  session list (the sidebar drops Projects/Scheduled).

## Projects

Sidebar **Projects**: a grid of cards, **New project** button top right (1097,79).

1. New project dialog ("Create a project"): name field (~600,292), "What are you trying to achieve?"
   textarea (~600,405), **Add context** (405,530) for a file, **Create project** (791,593). Name and goal
   typed fine. For a file, click Add context, choose the file in the native picker (see rules above); the file
   shows as a chip next to Add context. After Create, the project page opens.
2. Project page: title and description, a "New session in <project>" box (~530,206), and a right column:
   **Instructions** (Add/Edit, ~1130,211), **Context** (file count, Add), **Memory**, **Scheduled**.
3. Edit instructions: click Add/Edit, click the big textarea (~600,400), `cmd+a`, `type`, click **Save
   instructions** (891,636). The link turns from Add to Edit.
4. Start a chat in the project: click the session box, type, click the return arrow at its right (~702,265).
   Success: the project name shows in the title bar breadcrumb and the reply uses the project file and
   instructions (verified: the reply quoted the file phrase and ended with the instruction token).
5. Delete: project page, the chevron next to the title in the breadcrumb (592,26) > **Delete** (535,149) >
   confirm (755,442). The confirm dialog names the project and says its sessions are deleted too.

## Skills (Customize)

Sidebar **Customize** > tab **Skills** (391,140) > **Yours** (685,140) lists "Created by you" and "From
Anthropic & Partners". (In this version skills live under Customize, not Settings.)

- **Upload:** **Add** (1105,140) > **Upload skill** (1040,186). The page "Upload a skill" has a drop area
  (757,310); click it to open the native picker (see rules), choose a `.zip`/`.skill`/`.md` (a zip must contain
  `SKILL.md`). A **Preview** card shows the parsed name and description; verify them, then **Upload**
  (397,659). Success: a toast "Uploaded <name>" and the skill's detail page (Overview / Contents tabs).
- **Enable/disable:** the toggle on the detail page (1090,144). Off turns the toggle grey and greys "Try in chat".
- **Replace with a new version:** detail page `...` (1138,144) > **Replace** (1050,260) > same upload flow >
  Upload. Success toast "Replaced <name>"; the **Overview** tab shows the new description immediately. The
  Contents tab and its version dropdown can lag and keep showing the old text ("No other versions"): trust
  Overview, reopen the skill, or re-screenshot after a few seconds.
- **Delete:** `...` > **Remove** (1050,375) > confirm dialog "Remove skill?" (Remove 750,442). It deletes
  version history permanently. Success: the skill is gone from the list and the "Created by you" count drops.
- Never touch skills you did not create for the task.

## Connectors

Sidebar **Customize** > **Connectors** (479,140) > **Yours** shows a table (name, type Web/Desktop,
status: check mark, Reconnect, or Connect).

- **Add a custom connector:** **Add** (1105,140) > **Add custom connector**. Dialog: Name field (~600,294),
  Remote MCP server URL field (~600,375), possibly an advanced section for OAuth client id/secret (not
  inspected; leave empty), **Add** (819,602; scroll the dialog if the button is below the fold). Use a harmless public URL that needs no sign-in. Success: the connector's page opens
  with its URL and a **Tool permissions** list (per-tool allow / needs approval / block icons, default
  "Needs approval").
- **If it needs sign-in:** the page shows **Connect** instead. **Stop here and hand over to the user** for the
  sign-in/consent page in their browser. Never click Allow, never enter credentials.
- **Enable/disable per chat:** in a chat, the `+` at the left of the message box > **Connectors**; the
  submenu lists connectors with toggles (verified: the test connector appeared with a toggle that turned
  off and on). Per-chat only; it does not remove the connector.
- **Refresh tools / Remove:** connector page `...` (1151,140) > **Refresh tools list** or **Remove** (1062,231).
  Remove's dialog names the connector (verify it) > **Remove** (750,486). **Disconnect** (1070,140) is a
  separate button for signing out of a service: do not use it on connectors you did not add.
- Connector tool calls in a chat raise approval prompts: these are outward-facing, see `safety.md`.

### Local MCP servers (config file)

`desktop.py config-mcp list|add|remove` edits `~/Library/Application Support/Claude/claude_desktop_config.json`
`mcpServers` (stdio servers only): validates JSON, writes a unique (microsecond-stamped, never overwritten)
`.bak-` copy next to the file, only adds/removes the one named entry, and replaces the file atomically with its
original permissions. `list` shows env variable names only and redacts secret-looking args (`KEY=...`,
`--token X`, long random strings). **Use `--restart`**: it validates the request first (invalid input never
quits the app), quits Claude Desktop (the app rewrites this file while running and would clobber an edit),
re-reads the file, edits, then relaunches (also after a failure, without masking the original error). Restart stops any task in progress, so ask first. Verified: adding a dummy server made Desktop
show a yellow toast "MCP <name>: Server disconnected" after relaunch (the entry was read); removing it and
restoring the backup left the file byte-identical to the original. Delete the `.bak-` files you created when
done if the user does not want them.

## Scheduled tasks

Sidebar **Scheduled** shows "Scheduled tasks": existing task cards (or "No scheduled tasks yet") and
suggestion templates (Daily briefing, ...). **New task** (1097,79) > **Create with Claude** or **Set up
manually** (1057,160).

- **Set up manually** dialog: Name (~600,157), Instructions (~600,285), `Work in a project or folder`,
  `Default model`, **Frequency** (Manual / hourly / daily ..., default Manual), **Permissions** (Manual /
  Auto / Skip all approvals; the dialog default was **Auto**, and "Skip all approvals" never pauses, so pick
  **Manual** unless the user decides otherwise), Advanced settings (notifications; Push on by default),
  **Require this computer** toggle. The dialog scrolls: `scroll down --at 600,530`, then **Save** (936,707).
- Success: toast `"<name>" created.`, a card on the page and a row (with a clock icon) in the sidebar.
- **List:** the cards on the Scheduled page. **Open** one: its page shows Active badge, Instructions, Repeats,
  History, and icons: edit (pencil 984,96), **delete** (trash 1023,96), **Run now** (1100,96).
- **Run now:** starts a run (toast "started", an entry under History, sidebar dot). A manual-only task runs only
  when started.
- **Delete:** trash > dialog "Delete scheduled task?" naming it > **Delete** (755,442). Its past runs are
  deleted too. After deleting, the app lands on a new empty chat, and the sidebar run entry disappears after a
  moment. A pause control was not found in the manual-frequency task page; use edit to change frequency, or
  delete.

## Settings

`desktop.py press cmd+comma` opens a full-screen-ish Settings dialog: left list (General, Account, Privacy,
Billing, Usage, Capabilities, Memory, Design systems, Reflect, Time and focus, Claude Code, Claude in Chrome;
under "This computer": System, Extensions, Developer) and a search box (focused on open: anything typed goes
into it). Close with the X at the top right (1130,79). Do not change settings the user did not ask about.
The Developer section is where the app's MCP/local-server settings and logs live.
