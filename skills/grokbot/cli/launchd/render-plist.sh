#!/bin/sh
# Print a plist template with __HOME__ replaced by $HOME, escaped for both XML and sed (a HOME containing & | \ < > or
# spaces must neither corrupt the file nor inject into it). Usage: render-plist.sh <template> [home]
set -eu
SRC="$1"
H="${2:-$HOME}"
ESC=$(printf '%s' "$H" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' | sed -e 's/[\\&|]/\\&/g')
sed "s|__HOME__|$ESC|g" "$SRC"
