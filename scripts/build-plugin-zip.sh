#!/usr/bin/env bash
# Build an "Upload plugin"-ready zip of plugins/<name>/ into dist/.
#   scripts/build-plugin-zip.sh <plugin-name> [expected-version]
# Produces dist/<name>.zip and an identical dist/<name>.plugin, with .claude-plugin/plugin.json at the zip root.
# If the plugin folder has no .claude-plugin/plugin.json, one is generated (in a staging copy, never in the
# repo) from the plugin's entry in .claude-plugin/marketplace.json, which stays the version source of truth.
# If expected-version is given, the build fails unless plugin.json's version equals it.
# Used by .github/workflows/release-plugin-zip.yml; run it locally to get the same files.
set -euo pipefail

name="${1:?usage: build-plugin-zip.sh <plugin-name> [expected-version]}"
expect="${2:-}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo/plugins/$name"
out="$repo/dist"
max_bytes=$((200 * 1024 * 1024))

[ -d "$src" ] || { echo "error: no such plugin folder: $src" >&2; exit 1; }
command -v zip >/dev/null || { echo "error: zip not installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 not installed" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# Stage a clean copy (no dev junk), then work only on the copy.
(cd "$src" && tar -cf - \
  --exclude='.DS_Store' --exclude='.git' --exclude='.gitignore' --exclude='.gitattributes' \
  --exclude='.github' --exclude='__pycache__' --exclude='*.pyc' --exclude='node_modules' \
  --exclude='tests' --exclude='*.log' --exclude='*.swp' .) | (cd "$stage" && tar -xf -)

# marketplace.json is the version source of truth. Generate plugin.json when the plugin folder lacks one;
# when it has one, its version must equal marketplace.json's.
python3 -I - "$repo/.claude-plugin/marketplace.json" "$stage" "$name" <<'PY'
import json, os, sys
market, stage, name = sys.argv[1:4]
entries = [p for p in json.load(open(market))["plugins"] if p["name"] == name]
if not entries:
    sys.exit(f"error: no marketplace.json entry for {name}")
e = entries[0]
if not e.get("version"):
    sys.exit(f"error: marketplace.json entry for {name} has no version")
pj = os.path.join(stage, ".claude-plugin", "plugin.json")
if not os.path.exists(pj):
    doc = {"name": name, "version": e["version"], "description": e.get("description", ""),
           "author": {"name": "Agent Everywhere", "url": "https://github.com/Agent-Everywhere"},
           "homepage": "https://github.com/Agent-Everywhere/AE-external-skills",
           "keywords": e.get("tags", [])}
    os.makedirs(os.path.dirname(pj), exist_ok=True)
    with open(pj, "w") as f:
        json.dump(doc, f, indent=2); f.write("\n")
doc = json.load(open(pj))
if doc.get("name") != name:
    sys.exit(f"error: plugin.json name {doc.get('name')!r} != {name!r}")
if not doc.get("version"):
    sys.exit("error: plugin.json has no version")
if doc["version"] != e["version"]:
    sys.exit(f"error: plugin.json version {doc['version']} != marketplace.json version {e['version']}")
PY
version="$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$stage/.claude-plugin/plugin.json")"

if [ -n "$expect" ] && [ "$expect" != "$version" ]; then
  echo "error: plugin version $version does not match expected $expect" >&2
  exit 1
fi

mkdir -p "$out"
rm -f "$out/$name.zip" "$out/$name.plugin"
# Zip from inside the staged plugin dir so .claude-plugin/plugin.json is at the zip root.
(cd "$stage" && zip -X -q -r "$out/$name.zip" .)
cp "$out/$name.zip" "$out/$name.plugin"

# Verify the artifact itself.
listing="$(unzip -Z1 "$out/$name.zip")"
grep -qx '.claude-plugin/plugin.json' <<<"$listing" \
  || { echo "error: .claude-plugin/plugin.json not at zip root" >&2; exit 1; }
if junk="$(grep -E '(^|/)(\.DS_Store|\.git[^/]*|__pycache__|node_modules|tests)(/|$)' <<<"$listing")"; then
  echo "error: dev junk found in zip:" >&2; echo "$junk" >&2; exit 1
fi
size="$(wc -c < "$out/$name.zip" | tr -d ' ')"
[ "$size" -lt "$max_bytes" ] || { echo "error: zip is $size bytes (limit $max_bytes)" >&2; exit 1; }
cmp -s "$out/$name.zip" "$out/$name.plugin" || { echo "error: .plugin differs from .zip" >&2; exit 1; }

echo "built $out/$name.zip and $out/$name.plugin  (version $version, $size bytes)"
