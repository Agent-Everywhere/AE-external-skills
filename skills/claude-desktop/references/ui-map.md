# Claude Desktop UI map

Observed 2026-10-13, Claude Desktop 2.31, macOS 15, window about 1200x800 capture px. **Coordinates are
hints** (from the window's top-left; the sidebar is about 315 px wide). Window size, banners and app version
move things: `shot`, read, locate the control, click, `shot` to confirm. Check the click scale against your first screenshot.

## Everywhere

- **Hover first**: row-level `...` controls need care: click once, `shot`; click again only if the menu did not open.
- **Native file pickers** are separate windows that `shot` cannot see. Drive them with System Events:
  `keystroke "g" using {command down, shift down}`, `keystroke "<absolute path>"`, `key code 36` twice
  (go, Open). Confirm with `screencapture -x <file>` that the picker is frontmost first.
- Confirm-delete dialogs often do not name the target: confirm from the screenshot before, and verify
  afterwards that the right item is gone.

## Sidebar and tasks

Sidebar: New (60,73), Projects (73,102), Artifacts, Scheduled (73,160), Customize (80,189), then Pinned
and chats. Top left mode switch: Chat/Cowork (249,26), Code (287,26). `cmd+,` opens Settings.

- **New task**: the home screen has a message box, project/folder, model and permissions chips. The send
  arrow is at the right end of the box (~1082,451 home, ~1152,730 in a conversation). `+` opens attachments and connectors.
- **Deep link**: `desktop.py open` lands in the same chat window for Chat and Cowork.
- **Code**: its own session list; the permissions chip may default to "Bypass permissions". Do not send
  without the user's OK, a folder and a sane permission mode.
- **Send and wait**: click the arrow, then `wait-idle`. A Stop control where Send was means still generating.
- **Stacked approvals** in Cowork can push the `Reply` box off screen. When `wait-idle` says idle but
  nothing finished, `scroll up|down --amount 10 --at 900,400` until each prompt is whole, then follow the
  approval rules and log each click.
- **Follow-up**: click `Reply` (~700,730), `type`, `shot`, send, `wait-idle`.

## Projects

Sidebar Projects, **New project** (1097,79): name, goal, **Add context** (405,530) for a file via the picker,
**Create project** (791,593). Instructions: Add/Edit (~1130,211), `cmd+a`, `type`, **Save instructions**
(891,636). Delete: breadcrumb chevron (592,26), **Delete**, confirm (755,442); sessions go with it.
Project files are shared with every chat in it.

## Skills

Customize > **Skills** (391,140) > **Yours**. **Add** (1105,140) > **Upload skill**, click the drop area
(757,310), choose a `.zip`, `.skill` or `.md` (a zip needs `SKILL.md`), check the Preview name, **Upload**
(397,659). Upload only files the user has seen. The Contents tab can lag (don't re-upload). Plugin skills are not listed here.

**Remove an uploaded skill**: Customize > Skills > **Yours** > **Created by you**, screenshot the row first (the **Remove skill?**
dialog does not name it), row `...` > **Remove** (permanently deletes version history) > confirm. Rows shift up afterwards.

## Plugins

Customize > **Plugins** > **Yours** / **Discover**. Plugin skills appear only on the plugin's own **Skills** tab.

- **Add a GitHub marketplace**: **Add** > **Add marketplace** > **Add from a repository**. Type
  `owner/repo`, click the matched repo row (not the typed-text row), keep **Sync automatically** on,
  **Sync** (5-10 s).
- **Install**: on **Discover**, **Add** on the plugin (no confirm dialog; a toast says installed).
- **Auto-sync toast** ("requires the Claude GitHub App to have access"; **Grant access**): a new
  permission grant, so ask the user; never click it yourself.

## Connectors

Customize > **Connectors** (479,140) > **Yours**. **Add** > **Add custom connector**: name, remote MCP URL
(only a URL the user gave you), **Add** (819,602). The page lists tool permissions (default "Needs
approval"). If it shows **Connect**, stop and hand the sign-in or consent page to the user: never click
Allow or enter credentials. Per chat: `+` > Connectors toggle. `...` (1151,140) has **Refresh tools list**
and **Remove** (verify the named connector). Never use **Disconnect** or change permissions on connectors
you did not add. Its tool-call approvals are outward-facing.

## Local MCP servers

`desktop.py config-mcp list|add|remove` edits `~/Library/Application Support/Claude/claude_desktop_config.json`
(stdio servers): validates JSON, writes a unique `.bak-` copy, touches only the named entry; `list` redacts secrets. `--restart`
quits Desktop first and interrupts running tasks, so ask first. Never put secrets in `--env`.

## Scheduled tasks

Sidebar Scheduled > **New task** (1097,79) > **Set up manually** (1057,160): name, instructions, folder,
model, **Frequency** (default Manual), **Permissions** (pick **Manual**; the dialog defaults to Auto, which
never pauses), **Require this computer** off unless the user decides. **Save** (936,707). A task's page has edit, delete (trash 1023,96) and **Run now** (1100,96).
Deleting deletes its runs. Schedule nothing that sends, posts or deletes.

## Settings

`press cmd+comma`; the search box has focus (typed text goes into it). Close with X (1130,79). Change only what the user asked about.
