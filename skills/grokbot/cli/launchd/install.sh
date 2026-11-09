#!/bin/sh
# Install a Mac-side grokbot LaunchAgent. Usage: install.sh [sections-sync|resume-guard]   (default: sections-sync)
#   sections-sync  runs `grokbot sections sync --auto` every 2 min.
#   resume-guard   runs `grokbot automations resume-guard --allow ~/.grokbot/resume-allow.txt` every 15 min; the allowlist
#                  file must exist first (one "<agent> | <routine id or name>" per line).
# Templates $HOME into the plist via render-plist.sh (escaped; launchd does not expand ~ in log paths), then (re)loads the agent.
set -eu
WHICH="${1:-sections-sync}"
case "$WHICH" in
  sections-sync) LABEL="com.grokbot.sections-sync"; LOG="grokbot-sections-sync.log" ;;
  resume-guard)
    LABEL="com.grokbot.resume-guard"; LOG="grokbot-resume-guard.log"
    [ -s "$HOME/.grokbot/resume-allow.txt" ] || { echo "create \"$HOME/.grokbot/resume-allow.txt\" first (preview with: grokbot automations resume-guard --allow <file> --dry-run)" >&2; exit 1; }
    ;;
  *) echo "usage: $0 [sections-sync|resume-guard]" >&2; exit 64 ;;
esac
SRC="$(cd "$(dirname "$0")" && pwd)/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
"$(cd "$(dirname "$0")" && pwd)/render-plist.sh" "$SRC" > "$DEST"
plutil -lint "$DEST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "installed $DEST (log: $HOME/Library/Logs/$LOG)"
