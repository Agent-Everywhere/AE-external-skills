#!/usr/bin/env python3
"""Vendor packages/browser-runtime into every skill that lists a browser runtime.

A skill opts in through skills/<name>/skill.yaml:  runtimes: [local, agent-browser]
(an empty list, `runtimes: []`, means no browser runtime and nothing is copied).

  python3 build/sync_runtime.py           copy packages/browser-runtime -> skills/<name>/runtime/
                                          (files removed from the package are removed from the copy)
  python3 build/sync_runtime.py --check   change nothing; exit 1 if any copy drifted from the source

packages/browser-runtime is the single source of truth: edit it there, then run this script.
Python 3 standard library only, no network.
"""
import argparse
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PACKAGE_REL = Path("packages") / "browser-runtime"
IGNORED_DIRS = {"__pycache__"}
IGNORED_SUFFIXES = {".pyc"}


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
        if path.is_file() and not (set(rel.parts) & IGNORED_DIRS) and path.suffix not in IGNORED_SUFFIXES:
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


def sync(source, copy):
    copy = Path(copy)
    if copy.exists():
        shutil.rmtree(copy)
    for rel in package_files(source):
        dest = copy / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(Path(source) / rel, dest)


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
    if args.check and bad:
        print("runtime copies are out of date: run `python3 build/sync_runtime.py`", file=sys.stderr)
        return 1
    if not targets:
        print("no skill lists a browser runtime", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
