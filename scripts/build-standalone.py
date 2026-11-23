#!/usr/bin/env python3
"""Generate the slim standalone plugin folders listed in scripts/standalone.json (Python 3, standard library only).

A skill that shares an "engine" folder with sibling skills (for example the four linkedin-* skills over
plugins/linkedin/skills/linkedin) can be handed over on its own, with only the engine files it uses. The sources stay
where they are (one source of truth); the standalone folder is generated from them and must not be edited by hand.

For each manifest entry the output folder holds:
  skills/<skill>/      byte-identical copy of the source skill folder
  skills/<engine>/     only the whitelisted engine files, at the same relative paths
  .claude-plugin/plugin.json   generated from the plugin's entry in .claude-plugin/marketplace.json
  GENERATED.md         says the folder is generated and where from

  python3 scripts/build-standalone.py            write (or refresh) every output folder
  python3 scripts/build-standalone.py --check    write nothing; exit 1 and list the differences if a committed
                                                 output differs from what would be generated

Fails loudly (exit 2) when a whitelisted file or a source folder is missing or the manifest is malformed. Every manifest
path is validated before anything is written: names are plain slugs, all paths are clean relative paths that resolve
inside the repository, output is exactly plugins/<name>, and symlinks (in the sources, the whitelisted engine files or
the output folder) are refused rather than followed. A refused run touches nothing.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath

DEFAULT_ROOT = Path(__file__).resolve().parent.parent
MANIFEST = "scripts/standalone.json"
MARKETPLACE = ".claude-plugin/marketplace.json"
JUNK_PARTS = {"__pycache__", ".DS_Store"}
JUNK_SUFFIXES = {".pyc", ".pyo"}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class BuildError(Exception):
    pass


def is_junk(rel):
    return bool(set(rel.parts) & JUNK_PARTS) or rel.suffix in JUNK_SUFFIXES


def read_files(folder):
    """{posix relative path: bytes} of every real file under folder (caches and .DS_Store left out)."""
    out = {}
    for path in sorted(folder.rglob("*")):
        rel = path.relative_to(folder)
        if path.is_file() and not is_junk(rel):
            out[rel.as_posix()] = path.read_bytes()
    return out


def safe_rel(value, what):
    """A clean relative POSIX path: a string, not absolute, no '.', '..' or empty segments."""
    if not isinstance(value, str) or not value or "\0" in value:
        raise BuildError("%s must be a clean relative path, got %r" % (what, value))
    p = PurePosixPath(value)
    if p.is_absolute() or not p.parts or ".." in p.parts or "." in p.parts or str(p) != value:
        raise BuildError("%s must be a clean relative path, got %r" % (what, value))
    return p


def inside(base, path):
    """True when path (resolved) is strictly below base (resolved)."""
    try:
        rel = path.resolve().relative_to(base.resolve())
    except ValueError:
        return False
    return bool(rel.parts)


def reject_symlinks_on_path(root, rel, what):
    """Refuse when any component of root/rel is a symlink (a broken one counts)."""
    cur = root
    for part in rel.parts:
        cur = cur / part
        if cur.is_symlink():
            raise BuildError("%s must not go through a symlink: %s" % (what, cur.relative_to(root).as_posix()))


def reject_symlinks_in(folder, what):
    """Refuse when anything under folder is a symlink (files, folders, broken links; junk names included)."""
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        for name in dirnames + filenames:
            path = Path(dirpath) / name
            if path.is_symlink():
                raise BuildError("%s contains a symlink, which is refused: %s" % (what, path.relative_to(folder).as_posix()))


def source_path(root, value, what):
    """root/value after validation: clean relative, no symlink on the way, resolves inside root."""
    rel = safe_rel(value, what)
    reject_symlinks_on_path(root, rel, what)
    path = root / rel
    if not inside(root, path):
        raise BuildError("%s resolves outside the repository: %r" % (what, value))
    return path


def load_json(path, what):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BuildError("%s not found: %s" % (what, path))
    except ValueError as e:
        raise BuildError("%s is not valid JSON (%s): %s" % (what, e, path))


def validate_entry(root, e):
    """Every path rule for one manifest entry; raises BuildError, touches nothing."""
    if not isinstance(e, dict):
        raise BuildError("%s: every plugins entry must be an object, got %r" % (MANIFEST, e))
    for key in ("name", "skill_source", "engine_source", "engine_files", "output"):
        if key not in e:
            raise BuildError("%s: entry %r lacks %r" % (MANIFEST, e.get("name"), key))
    name = e["name"]
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise BuildError("%s: name must match %s, got %r" % (MANIFEST, NAME_RE.pattern, name))
    if not isinstance(e["engine_files"], list) or not e["engine_files"]:
        raise BuildError("%s: %s engine_files must be a non-empty list" % (MANIFEST, name))
    if not all(isinstance(f, str) for f in e["engine_files"]):
        raise BuildError("%s: %s engine_files entries must be strings" % (MANIFEST, name))
    if len(set(e["engine_files"])) != len(e["engine_files"]):
        raise BuildError("%s: %s engine_files has duplicates" % (MANIFEST, name))
    if e["output"] != "plugins/" + name:
        raise BuildError("%s: output of %s must be plugins/%s" % (MANIFEST, name, name))
    # output folder: exactly <root>/plugins/<name>, never a symlink, never holding symlinks
    plugins = (root / "plugins").resolve()
    out = root / safe_rel(e["output"], "output")
    reject_symlinks_on_path(root, safe_rel(e["output"], "output"), "output folder")
    resolved = out.resolve()
    if resolved.parent != plugins or resolved in (plugins, root) or resolved.name != name:
        raise BuildError("%s: output of %s must resolve to plugins/%s inside the repository" % (MANIFEST, name, name))
    if out.exists() and not out.is_dir():
        raise BuildError("output folder is not a folder: %s" % e["output"])
    if out.is_dir():
        reject_symlinks_in(out, "output folder %s" % e["output"])
    # sources: clean, inside the repository, not overlapping the output
    skill_src = source_path(root, e["skill_source"], "skill_source")
    engine_src = source_path(root, e["engine_source"], "engine_source")
    for what, src in (("skill_source", skill_src), ("engine_source", engine_src)):
        r = src.resolve()
        if r == resolved or inside(resolved, r) or inside(r, resolved):
            raise BuildError("%s of %s overlaps its output folder" % (what, name))
    for rel in e["engine_files"]:
        safe_rel(rel, "engine_files entry")
        if not inside(engine_src, source_path(engine_src, rel, "engine_files entry")):
            raise BuildError("engine_files entry resolves outside the engine folder: %r" % rel)


def load_entries(root):
    root = root.resolve()
    doc = load_json(root / MANIFEST, "manifest")
    entries = doc.get("plugins") if isinstance(doc, dict) else None
    if not isinstance(entries, list) or not entries:
        raise BuildError("%s must hold a non-empty \"plugins\" list" % MANIFEST)
    for e in entries:
        validate_entry(root, e)
    names = [e["name"] for e in entries]
    if len(set(names)) != len(names):
        raise BuildError("%s: duplicate plugin names" % MANIFEST)
    return entries


def plugin_json(root, entry):
    """Same fields and shape as the other plugins' plugin.json, from the marketplace entry (version source of truth)."""
    market = load_json(root / MARKETPLACE, "marketplace.json")
    found = [p for p in market.get("plugins", []) if p.get("name") == entry["name"]]
    if len(found) != 1:
        raise BuildError("%s needs exactly one entry named %s" % (MARKETPLACE, entry["name"]))
    m = found[0]
    skill = PurePosixPath(entry["skill_source"]).name
    if m.get("source") != "./" + entry["output"] or m.get("skills") != ["./skills/" + skill]:
        raise BuildError("marketplace entry %s must have source ./%s and skills [./skills/%s]"
                         % (entry["name"], entry["output"], skill))
    if not m.get("version"):
        raise BuildError("marketplace entry %s has no version" % entry["name"])
    doc = {"name": entry["name"], "version": m["version"], "description": m.get("description", ""),
           "author": {"name": "Agent Everywhere", "url": "https://github.com/Agent-Everywhere"},
           "keywords": m.get("tags", [])}
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def generated_md(entry):
    engine_names = "\n".join("- `%s`" % f for f in entry["engine_files"])
    return ("""# Generated folder: do not edit by hand

This folder is generated by `scripts/build-standalone.py` from the sources below. Edit the sources, then run
`python3 scripts/build-standalone.py`; a test runs `python3 scripts/build-standalone.py --check` and fails when this
folder is out of date.

- Skill: `%s`, copied as it is.
- Engine: only these files of `%s`:
%s
- `.claude-plugin/plugin.json`: built from the `%s` entry in `.claude-plugin/marketplace.json`.

The whitelist and the other settings are in `scripts/standalone.json`.
""" % (entry["skill_source"], entry["engine_source"], engine_names, entry["name"])).encode("utf-8")


def expected_files(root, entry):
    """{path relative to the output folder: bytes} for one manifest entry."""
    skill_src = source_path(root, entry["skill_source"], "skill_source")
    engine_src = source_path(root, entry["engine_source"], "engine_source")
    if not skill_src.is_dir():
        raise BuildError("source skill folder missing: %s" % entry["skill_source"])
    if not engine_src.is_dir():
        raise BuildError("source engine folder missing: %s" % entry["engine_source"])
    reject_symlinks_in(skill_src, "source skill folder %s" % entry["skill_source"])
    skill, engine = skill_src.name, engine_src.name
    out = {}
    skill_files = read_files(skill_src)
    if "SKILL.md" not in skill_files:
        raise BuildError("source skill has no SKILL.md: %s" % entry["skill_source"])
    for rel, data in skill_files.items():
        out["skills/%s/%s" % (skill, rel)] = data
    for rel in entry["engine_files"]:
        path = source_path(engine_src, rel, "engine_files entry")
        if not path.is_file():
            raise BuildError("whitelisted engine file missing: %s/%s" % (entry["engine_source"], rel))
        out["skills/%s/%s" % (engine, rel)] = path.read_bytes()
    out[".claude-plugin/plugin.json"] = plugin_json(root, entry)
    out["GENERATED.md"] = generated_md(entry)
    return out


def diff(root, entry, expected):
    """Human-readable differences between the committed output folder and the expected files."""
    folder = root / entry["output"]
    have = read_files(folder) if folder.is_dir() else {}
    problems = []
    for rel in sorted(expected):
        if rel not in have:
            problems.append("missing: %s/%s" % (entry["output"], rel))
        elif have[rel] != expected[rel]:
            problems.append("differs: %s/%s" % (entry["output"], rel))
    for rel in sorted(set(have) - set(expected)):
        problems.append("stale (not generated): %s/%s" % (entry["output"], rel))
    return problems


def check_write(root, entry, expected):
    """Refuse (BuildError) unless every path to write or delete resolves under the output folder; touches nothing."""
    folder = root / entry["output"]
    if folder.is_symlink():
        raise BuildError("output folder is a symlink, refused: %s" % entry["output"])
    have = read_files(folder) if folder.is_dir() else {}
    for rel in sorted(set(expected) | set(have)):
        if not inside(folder, folder / rel):
            raise BuildError("refusing to write or delete outside %s: %s" % (entry["output"], rel))
    return have


def write(root, entry, expected):
    folder = root / entry["output"]
    have = check_write(root, entry, expected)
    changed = []
    for rel, data in sorted(expected.items()):
        if have.get(rel) != data:
            target = folder / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            changed.append(rel)
    for rel in sorted(set(have) - set(expected)):
        (folder / rel).unlink()
        changed.append("removed " + rel)
    for path in sorted((p for p in folder.rglob("*") if p.is_dir()), reverse=True):   # drop emptied folders
        if inside(folder, path) and not any(path.iterdir()):
            path.rmdir()
    return changed


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate the standalone plugin folders listed in scripts/standalone.json.")
    ap.add_argument("--check", action="store_true", help="write nothing; exit 1 and list differences if a committed output is out of date")
    ap.add_argument("--root", default=str(DEFAULT_ROOT), help="repository root (default: this script's repository)")
    args = ap.parse_args(argv)
    root = Path(args.root).resolve()
    try:
        entries = load_entries(root)
        plans = [(e, expected_files(root, e)) for e in entries]
        if not args.check:
            for e, files in plans:
                check_write(root, e, files)
    except BuildError as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
    if args.check:
        problems = [p for e, files in plans for p in diff(root, e, files)]
        if problems:
            print("standalone folders are out of date; run `python3 scripts/build-standalone.py`:")
            print("\n".join("  " + p for p in problems))
            return 1
        for e, files in plans:
            print("ok: %s (%d files)" % (e["output"], len(files)))
        return 0
    for e, files in plans:
        changed = write(root, e, files)
        print("%s: %d files, %s" % (e["output"], len(files), ("%d written or removed" % len(changed)) if changed else "already up to date"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
