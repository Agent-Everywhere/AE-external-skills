# Claude Desktop UI map

Observed 2026-10-13, Claude Desktop 2.31, macOS 15, window about 1200x800 capture px (`desktop.py shot`
prints the size). **Coordinates are hints** (from the window's top-left; the sidebar is about 315 px
wide). Window size, banners and app version move things: `shot`, read, locate the control, click, `shot`
to confirm. Check the click scale against your first screenshot.

## Everywhere

- **Hover first**: row-level `...` controls often need the pointer to arrive; click twice (about 0.7 s
  apart) and confirm the menu opened.
- **Typing**: click the field, `type`; "indeterminate" is normal, so screenshot. `cmd+a` then `type` replaces.
- **Native file pickers** are separate windows that `shot` cannot see. Drive them with System Events:
  `keystroke "g" using {command down, shift down}`, `keystroke "<absolute path>"`, `key code 36` to go,
  `key code 36` again to Open. Confirm with `screencapture -x <file>` that the picker is frontmost before
  typing a path.
- Confirm-delete dialogs often do not name the target: confirm from the screenshot before, and verify
  afterwards that the right item is gone.

## Sidebar and tasks

Sidebar: New (60,73), Projects (73,102), Artifacts, Scheduled (73,160), Customize (80,189), then Pinned
and chats. Top left mode switch: Chat/Cowork (249,26), Code (287,26). `cmd+,` opens Settings.

- **New task**: the home screen has a message box (~y 392), a project/folder chip, a model chip (~975,499)
  and a permissions chip. The send arrow is at the right end of the box (~1082,451 on the home screen,
  ~1152,730 in a conversation). The `+` at the left of the box opens attachments and connectors.
- **Deep link**: `desktop.py open` lands in the same chat window for Chat and Cowork (Cowork shows a laptop
  icon). A caution banner shifts the layout.
- **Code**: its own session list; the permissions chip may default to "Bypass permissions". Do not send
  without the user's OK, a folder and a sane permission mode.
- **Send and wait**: click the arrow, then `wait-idle`. Done looks
  like your grey bubble, the answer in serif text, and a row of small icons under it; a Stop control where
  Send was means still generating.
- **Stacked approvals** in Cowork can push the `Reply` box off screen. When `wait-idle` says idle but
  nothing finished, `scroll up|down --amount 10 --at 900,400` until each prompt is whole, then follow the
  approval rules and log each click.
- **Follow-up**: click `Reply` (~700,730), `type`, `shot`, click send, `wait-idle`.
- **Model**: click the model chip, pick one, confirm the chip text changed (this chat only).

## Projects

Sidebar Projects, **New project** (1097,79): name (~600,292), goal textarea (~600,405), **Add context**
(405,530) for a file via the picker, **Create project** (791,593). Project page: instructions Add/Edit
(~1130,211), then textarea, `cmd+a`, `type`, **Save instructions** (891,636). Start a chat from the session
box. Delete: breadcrumb chevron (592,26), **Delete**, confirm (755,442); sessions go with it. Project files are
shared with every chat in it.

## Skills

Customize > **Skills** (391,140) > **Yours**. **Add** (1105,140) > **Upload skill**, click the drop area
(757,310), choose a `.zip`, `.skill` or `.md` (a zip needs `SKILL.md`), check the Preview name and
description, **Upload** (397,659). The detail page has the enable toggle (1090,144) and `...` (1138,144) for
**Replace** and **Remove** (permanently deletes version history). The Contents tab can lag. Upload only files the user has seen.

## Connectors

Customize > **Connectors** (479,140) > **Yours**. **Add** > **Add custom connector**: name, remote MCP URL
(only a URL the user gave you), **Add** (819,602). The page lists tool permissions (default "Needs
approval"). If it shows **Connect**, stop and hand the sign-in or consent page to the user: never click
Allow or enter credentials. Per chat: `+` > Connectors toggle. `...` (1151,140) has **Refresh tools list**
and **Remove** (verify the named connector). Never use **Disconnect** or change permissions on connectors
you did not add. Its tool-call approvals are outward-facing.

## Local MCP servers

`desktop.py config-mcp list|add|remove` edits `~/Library/Application Support/Claude/claude_desktop_config.json`
(stdio servers): validates JSON, writes a unique `.bak-` copy, touches only the named entry. `list` redacts secret-looking values. Use `--restart` (it quits Desktop first, since the
running app rewrites the file); a restart interrupts running tasks, so ask first. Never put secrets in
`--env`.

## Scheduled tasks

Sidebar Scheduled > **New task** (1097,79) > **Set up manually** (1057,160): name, instructions, folder,
model, **Frequency** (default Manual), **Permissions** (pick **Manual**; the dialog defaulted to Auto and
"Skip all approvals" never pauses), **Require this computer** off unless the user decides. Scroll the
dialog, **Save** (936,707). A task's page has edit, delete (trash 1023,96) and **Run now** (1100,96).
Deleting also deletes its runs. Schedule nothing that sends, posts or deletes.

## Settings

`press cmd+comma`; the search box has focus (typed text goes into it). Close with X (1130,79). Change only
what the user asked about.
