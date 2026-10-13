#!/usr/bin/env python3
"""Vendor packages/browser-runtime into every skill that lists a browser runtime.

A skill opts in through skills/<name>/skill.yaml:  runtimes: [local, agent-browser]
(an empty list, `runtimes: []`, means no browser runtime and nothing is copied).

  python3 build/sync_runtime.py           copy packages/browser-runtime -> skills/<name>/runtime/
                                          (files removed from the package are removed from the copy;
                                          the copy is built in a temp dir and renamed into place)
  python3 build/sync_runtime.py --check   change nothing; exit 1 if any copy drifted from the source,
                                          or a skill with `runtimes: []` still has a runtime/ folder

packages/browser-runtime is the single source of truth: edit it there, then run this script.

Purpose skills (salesnav-*) also bundle the toolkit files they need, so each works installed alone.
A skill opts in through skills/<name>/skill.yaml:
  uses_toolkit: [page/count.js, scripts/run_log.py, reference.md]
The listed paths are copied from skills/sales-navigator (the single source) to the same relative path
inside the purpose skill. Directories such as page/ or scripts/ that hold listed files are managed:
a file there that is not listed is stale. --check fails on a missing, differing or stale file, and on a
listed path the source does not have. Never edit a bundled copy.

Python 3 standard library only, no network.
"""
import argparse
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PACKAGE_REL = Path("packages") / "browser-runtime"
TOOLKIT_SKILL = "sales-navigator"  # the single source of the files a purpose skill lists in uses_toolkit
RESERVED_FILES = {"skill.yaml", "SKILL.md"}  # a skill's own files, never vendored from the toolkit
IGNORED_DIRS = {"__pycache__"}
IGNORED_SUFFIXES = {".pyc", ".pyo", ".swp", ".swo"}
IGNORED_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}  # OS litter, never vendored and never drift


def is_ignored(rel):
    """True for caches and OS/editor litter (.DS_Store, AppleDouble ._x files, *.pyc, editor swap/backups)."""
    name = rel.name
    return bool((set(rel.parts) & IGNORED_DIRS) or rel.suffix in IGNORED_SUFFIXES
                or name in IGNORED_NAMES or name.startswith("._") or name.endswith("~"))


def parse_skill_yaml(text):
    """Parse the small, flat subset of YAML used by skill.yaml.

    Supported: `key: value` lines, `# comments`, and inline lists `key: [a, b]` / `key: []`.
    Values are strings (quotes stripped) or lists of strings.
    """
    data = {}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if ":" not in line or line[0] in " \t":
            raise ValueError("skill.yaml line %d: expected 'key: value', got %r" % (number, raw))
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip()
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            data[key] = [v.strip().strip("'\"") for v in inner.split(",") if v.strip()] if inner else []
        elif value.startswith("[") or value.endswith("]"):
            raise ValueError("skill.yaml line %d: unbalanced list in %r" % (number, raw))
        else:
            data[key] = value.strip("'\"")
    return data


def load_manifest(skill_dir):
    path = Path(skill_dir) / "skill.yaml"
    return parse_skill_yaml(path.read_text(encoding="utf-8"))


def package_files(root):
    """Relative paths of every file in the package (sorted, caches excluded)."""
    base = Path(root)
    out = []
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(base)
        if path.is_file() and not is_ignored(rel):
            out.append(rel)
    return out


def skills_with_runtime(repo):
    """Skill directories whose skill.yaml lists at least one runtime."""
    found = []
    for skill_dir in sorted((Path(repo) / "skills").iterdir()):
        if skill_dir.is_dir() and (skill_dir / "skill.yaml").is_file():
            if load_manifest(skill_dir).get("runtimes"):
                found.append(skill_dir)
    return found


def drift(source, copy):
    """List differences between the package and one vendored copy (empty when identical)."""
    problems = []
    want = package_files(source)
    have = package_files(copy) if Path(copy).is_dir() else []
    if not Path(copy).is_dir():
        return ["missing directory"]
    for rel in want:
        if rel not in have:
            problems.append("missing: %s" % rel)
        elif (Path(source) / rel).read_bytes() != (Path(copy) / rel).read_bytes():
            problems.append("differs: %s" % rel)
    for rel in have:
        if rel not in want:
            problems.append("stale: %s" % rel)
    return problems


def orphan_runtimes(repo):
    """Skills whose skill.yaml lists no runtime but that still have a runtime/ folder."""
    found = []
    for skill_dir in sorted((Path(repo) / "skills").iterdir()):
        if skill_dir.is_dir() and (skill_dir / "skill.yaml").is_file():
            if not load_manifest(skill_dir).get("runtimes") and (skill_dir / "runtime").exists():
                found.append(skill_dir)
    return found


def toolkit_list(skill_dir):
    """The validated `uses_toolkit` paths of one skill (relative POSIX paths, no .. or absolute)."""
    names = load_manifest(skill_dir).get("uses_toolkit") or []
    if isinstance(names, str):
        raise ValueError("%s: uses_toolkit must be a list like [page/count.js, reference.md]" % Path(skill_dir).name)
    out = []
    for name in names:
        rel = Path(name)
        if rel.is_absolute() or ".." in rel.parts or not rel.parts or is_ignored(rel):
            raise ValueError("%s: bad uses_toolkit path %r" % (Path(skill_dir).name, name))
        if rel.parts[0] == "runtime" or str(rel) in RESERVED_FILES:
            raise ValueError("%s: uses_toolkit path %r is owned elsewhere (runtime/ is vendored from "
                             "packages/browser-runtime; skill.yaml and SKILL.md are the skill's own)"
                             % (Path(skill_dir).name, name))
        if rel not in out:
            out.append(rel)
    return out


def skills_with_toolkit(repo):
    """Skill directories whose skill.yaml lists uses_toolkit paths (never the toolkit skill itself)."""
    found = []
    for skill_dir in sorted((Path(repo) / "skills").iterdir()):
        if skill_dir.is_dir() and (skill_dir / "skill.yaml").is_file():
            if load_manifest(skill_dir).get("uses_toolkit") and skill_dir.name != TOOLKIT_SKILL:
                found.append(skill_dir)
    return found


def toolkit_drift(repo, skill_dir):
    """Differences between the toolkit source files a skill lists and its bundled copies."""
    source = Path(repo) / "skills" / TOOLKIT_SKILL
    wanted = toolkit_list(skill_dir)
    problems = []
    for rel in wanted:
        src, dst = source / rel, Path(skill_dir) / rel
        if not src.is_file():
            problems.append("source missing: %s/%s" % (TOOLKIT_SKILL, rel.as_posix()))
        elif not dst.is_file():
            problems.append("missing: %s" % rel.as_posix())
        elif src.read_bytes() != dst.read_bytes():
            problems.append("differs: %s" % rel.as_posix())
    for rel in toolkit_stale(skill_dir, wanted):
        problems.append("stale: %s" % rel.as_posix())
    return problems


def toolkit_stale(skill_dir, wanted):
    """Files inside the managed directories (page/, scripts/, ...) that are not listed."""
    stale = []
    for top in sorted({rel.parts[0] for rel in wanted if len(rel.parts) > 1}):
        base = Path(skill_dir) / top
        if base.is_dir():
            for path in sorted(base.rglob("*")):
                rel = path.relative_to(skill_dir)
                if path.is_file() and not is_ignored(rel.relative_to(top)) and rel not in wanted:
                    stale.append(rel)
    return stale


def sync_toolkit(repo, skill_dir):
    """Copy the listed toolkit files into the skill and remove stale files from managed directories."""
    source = Path(repo) / "skills" / TOOLKIT_SKILL
    wanted = toolkit_list(skill_dir)
    for rel in wanted:
        if not (source / rel).is_file():
            raise ValueError("%s: %s/%s does not exist" % (Path(skill_dir).name, TOOLKIT_SKILL, rel.as_posix()))
    for rel in toolkit_stale(skill_dir, wanted):
        (Path(skill_dir) / rel).unlink()
    for rel in wanted:
        dst = Path(skill_dir) / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / rel, dst)
    return len(wanted)


def sync(source, copy):
    """Replace `copy` with the package files: build in a temp dir beside it, then swap by rename.

    A crash or a failed copy leaves the old copy in place (never a half-written one).
    """
    copy = Path(copy)
    copy.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".runtime-new-", dir=copy.parent))
    old = copy.parent / (".runtime-old-" + staging.name.rsplit("-", 1)[-1])
    try:
        for rel in package_files(source):
            dest = staging / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(Path(source) / rel, dest)
        if copy.exists():
            copy.rename(old)
        try:
            staging.rename(copy)
        except OSError:
            if old.exists():
                old.rename(copy)
            raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(old, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="report drift and exit 1; change nothing")
    ap.add_argument("--root", default=str(REPO), help="repo root (default: this repo)")
    args = ap.parse_args(argv)

    repo = Path(args.root)
    source = repo / PACKAGE_REL
    if not source.is_dir():
        print("error: %s not found" % source, file=sys.stderr)
        return 1
    targets = skills_with_runtime(repo)
    bad = 0
    for skill_dir in targets:
        copy = skill_dir / "runtime"
        if args.check:
            problems = drift(source, copy)
            if problems:
                bad += 1
                print("DRIFT %s/runtime: %s" % (skill_dir.name, "; ".join(problems)))
            else:
                print("ok    %s/runtime" % skill_dir.name)
        else:
            sync(source, copy)
            print("synced %s/runtime (%d files)" % (skill_dir.name, len(package_files(source))))
    failed = 0
    for skill_dir in skills_with_toolkit(repo):
        try:
            if args.check:
                problems = toolkit_drift(repo, skill_dir)
                if problems:
                    bad += 1
                    print("DRIFT %s/toolkit: %s" % (skill_dir.name, "; ".join(problems)))
                else:
                    print("ok    %s/toolkit" % skill_dir.name)
            else:
                print("synced %s/toolkit (%d files)" % (skill_dir.name, sync_toolkit(repo, skill_dir)))
        except ValueError as exc:
            failed += 1
            print("ERROR %s" % exc, file=sys.stderr)
    for skill_dir in orphan_runtimes(repo):
        print("%s %s/runtime: the skill lists no runtimes (`runtimes: []`) but has a runtime/ folder: "
              "delete it or list a runtime in skill.yaml" % ("ORPHAN" if args.check else "warning:", skill_dir.name))
        bad += 1
    if args.check and bad:
        print("vendored copies are out of date: run `python3 build/sync_runtime.py` (and fix any ORPHAN above)",
              file=sys.stderr)
        return 1
    if failed:
        return 1
    if not targets:
        print("no skill lists a browser runtime", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
