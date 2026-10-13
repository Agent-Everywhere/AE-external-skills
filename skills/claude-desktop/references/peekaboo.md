# Peekaboo commands for driving Claude Desktop

Peekaboo is a macOS automation CLI. Everything here was run against Peekaboo 4.9.2 on macOS 15.7
with Claude Desktop. Peekaboo's output formats and flags change between major versions: if a command
errors on an unknown flag, run `peekaboo <command> --help`.

## Install and permissions

```sh
brew install openclaw/tap/peekaboo          # or, without installing: npx -y @steipete/peekaboo <command>
peekaboo --version
peekaboo permissions status
```

- Requires macOS 15 or newer.
- Grant **Screen Recording** and **Accessibility** (and, optionally, **Event Synthesizing**) to the
  **terminal app that runs Claude Code** (Terminal, iTerm, Ghostty, the IDE terminal, and so on) in
  System Settings > Privacy & Security. Restart that terminal app after granting.
- `permissions status` prints one line per permission, for example `Screen Recording (Required): Granted`.
  Both required lines must say Granted.

## Screenshot

```sh
peekaboo see --app Claude --no-elements --path /tmp/cd-1.png
```

- `peekaboo image` was removed in v4; `see` is the capture command.
- `--no-elements` skips accessibility element detection. Claude Desktop is Electron, so
  `peekaboo see --app Claude --json` returns almost no labeled elements anyway. Drive by coordinates.
- Read the PNG (your image-capable file reader) to see the state.
- If it errors with "window minimized" or "target not found" while Claude is running, Claude is not the
  frontmost app (or its window is on another Space). Run
  `osascript -e 'tell application "System Events" to tell process "Claude" to set frontmost to true'`
  (`open -a Claude` and `tell application "Claude" to activate` did not help on the tested Mac) and retry.
  `scripts/desktop.py activate` does this and verifies; `shot` calls it automatically.
- `--ocr` (adds OCR text to the output) exists in `peekaboo see --help`; it was not part of the tested
  flow. Treat it as unverified, and still look at the screenshot.

## Coordinates

`peekaboo click --app Claude --at X,Y` takes **window-relative** coordinates. By default `see` captures
at 1x logical scale (`--retina` switches to native pixels), and the click coordinates are in that same
logical space. The tested flow read pixel positions straight off the screenshot and clicked there.

**Verify the scale from the first screenshot of a session:** note the image width and height in pixels,
click something you can see (such as the message box), and confirm with a second screenshot that the
click landed where intended. If clicks land at about half or double the intended offset, you captured
at a different scale than you are reading; fix the scale before doing anything consequential. Re-check
after the window is moved or resized.

## Click

```sh
peekaboo click --app Claude --foreground --at 640,700
```

- `--foreground` is required. Background clicks and key presses are refused without consent
  (background coordinates need a fresh exact-window snapshot).
- The click goes to whatever is at that point, so the Claude window must be unobscured. If another
  window covers the spot, the click lands on it.

## Type

```sh
peekaboo type --app Claude --foreground "text to enter"
```

Verified from `peekaboo type --help` (4.9.2):

- Escape sequences in the text: `\n` newline (this presses Return, which may **submit** the message),
  `\t` tab, `\b` backspace, `\e` escape, `\\` literal backslash. Avoid `\n` in follow-ups unless you
  mean to submit.
- Without `--foreground`, background delivery needs a window snapshot; the helper uses `--foreground`.
- `--clear` clears the field first (it is documented with snapshots; not exercised here, so verify
  before relying on it). `--delay`, `--wpm`, `--profile human` control typing speed.
- **Click the message box first** so the caret is in it, then type. After typing, take a screenshot to
  confirm the text appeared in the Claude window.
- Verified live: click the message box, then type, works end to end, but 4.9.2 usually exits non-zero
  with "Action outcome is indeterminate" even though the text was entered. The helper treats that as
  "typed, confirm by screenshot". Never retype blindly.
- `cmd+a` then `type` replaces a field's content.

## Press keys

```sh
peekaboo press return --app Claude --foreground
peekaboo press cmd+a --app Claude --foreground
```

Key names are case-insensitive, chords join with `+` (`cmd+shift+t`). Key presses go to whatever has
focus, which may not be Claude if focus is elsewhere. **Prefer clicking the Send button** (or clicking
the message box and then typing) over Return.

## Scrolling

```sh
peekaboo scroll --app Claude --direction down --amount 5 --foreground
```

Verified live. In 4.9.2 `--foreground` cannot be combined with `--at` (and a background `--at` needs a
snapshot id), so `desktop.py scroll --at X,Y` clicks that point first and then scrolls with
`--foreground`; pick an inert spot. Verify with a screenshot after each scroll.

## Gotchas

- **Foreground input means the user's Mac is busy.** Input goes to the frontmost window; see
  `safety.md`.
- Electron apps give no usable accessibility tree here: no element IDs, no label-based clicks.
- Layout shifts: banners (the linked-prompt caution banner), sidebars opening or closing, and window
  resizing move the Send button. Re-screenshot before every click that matters.
- The same Send button position is not guaranteed between Chat, Cowork, and Code; read each screen.
- `see` writes where `--path` says; pixel-only captures otherwise go to Peekaboo's configured save
  directory.
- Screenshots may contain private data: keep them in a temp folder, do not upload or paste them
  anywhere (see `safety.md`).
