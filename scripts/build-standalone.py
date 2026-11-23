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

Fails loudly (exit 2) when a whitelisted file or a source folder is missing or the manifest is malformed.
"""
import argparse
import json
import sys
from pathlib import Path, PurePosixPath

DEFAULT_ROOT = Path(__file__).resolve().parent.parent
MANIFEST = "scripts/standalone.json"
MARKETPLACE = ".claude-plugin/marketplace.json"
JUNK_PARTS = {"__pycache__", ".DS_Store"}
JUNK_SUFFIXES = {".pyc", ".pyo"}


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
    p = PurePosixPath(value)
    if not value or p.is_absolute() or ".." in p.parts or str(p) != value:
        raise BuildError("%s must be a clean relative path, got %r" % (what, value))
    return p


def load_json(path, what):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BuildError("%s not found: %s" % (what, path))
    except ValueError as e:
        raise BuildError("%s is not valid JSON (%s): %s" % (what, e, path))


def load_entries(root):
    doc = load_json(root / MANIFEST, "manifest")
    entries = doc.get("plugins")
    if not isinstance(entries, list) or not entries:
        raise BuildError("%s must hold a non-empty \"plugins\" list" % MANIFEST)
    for e in entries:
        for key in ("name", "skill_source", "engine_source", "engine_files", "output"):
            if key not in e:
                raise BuildError("%s: entry %r lacks %r" % (MANIFEST, e.get("name"), key))
        if not isinstance(e["engine_files"], list) or not e["engine_files"]:
            raise BuildError("%s: %s engine_files must be a non-empty list" % (MANIFEST, e["name"]))
        if len(set(e["engine_files"])) != len(e["engine_files"]):
            raise BuildError("%s: %s engine_files has duplicates" % (MANIFEST, e["name"]))
        if e["output"] != "plugins/" + e["name"]:
            raise BuildError("%s: output of %s must be plugins/%s" % (MANIFEST, e["name"], e["name"]))
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
    skill_src = root / safe_rel(entry["skill_source"], "skill_source")
    engine_src = root / safe_rel(entry["engine_source"], "engine_source")
    if not skill_src.is_dir():
        raise BuildError("source skill folder missing: %s" % entry["skill_source"])
    if not engine_src.is_dir():
        raise BuildError("source engine folder missing: %s" % entry["engine_source"])
    skill, engine = skill_src.name, engine_src.name
    out = {}
    skill_files = read_files(skill_src)
    if "SKILL.md" not in skill_files:
        raise BuildError("source skill has no SKILL.md: %s" % entry["skill_source"])
    for rel, data in skill_files.items():
        out["skills/%s/%s" % (skill, rel)] = data
    for rel in entry["engine_files"]:
        safe_rel(rel, "engine_files entry")
        path = engine_src / rel
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


def write(root, entry, expected):
    folder = root / entry["output"]
    have = read_files(folder) if folder.is_dir() else {}
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
        if not any(path.iterdir()):
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
