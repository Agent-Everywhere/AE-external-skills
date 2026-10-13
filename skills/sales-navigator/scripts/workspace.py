#!/usr/bin/env python3
"""Locate (or create) the Sales Navigator workspace folder that holds the state that must persist.

The caps, the outreach ledger and the company profile only protect the seat if they survive from one
task (and one day) to the next, so they all live in ONE folder the host always has access to:
  <workspace>/company-profile.md  quota.md  run_log.csv  outreach_log.csv  lists/  drafts/  results/

Claude Desktop Cowork's user-files folder is ~/Claude by default, so the default workspace is
~/Claude/sales-navigator. Resolution order (first hit wins), used by run_log.py and outreach_log.py:
  1. --workspace DIR
  2. $SALESNAV_WORKSPACE
  3. the `workspace:` field of company-profile.md (locate --profile FILE passes it in)
  4. ~/Claude/sales-navigator, if that folder exists
  5. the current folder, with a WARNING that nothing will persist (the agent must then ask the user)

  workspace.py locate [--workspace DIR] [--profile FILE]   print the workspace and how it was found;
                                                           exit 4 (NOT FOUND) when only the cwd is left
  workspace.py init FOLDER                                 create FOLDER/sales-navigator/ with lists/,
                                                           drafts/ and results/ (FOLDER is the Cowork
                                                           folder the user named); print the path to
                                                           save as `workspace:` in company-profile.md

Python 3 standard library only, no network.
"""
import argparse
import os
import re
import sys
from collections import namedtuple
from pathlib import Path

ENV_VAR = "SALESNAV_WORKSPACE"
FOLDER_NAME = "sales-navigator"
SUBDIRS = ("lists", "drafts", "results")
EXIT_OK, EXIT_BAD, EXIT_NOT_FOUND = 0, 1, 4

Workspace = namedtuple("Workspace", "path source persistent")

NOT_PERSISTENT_WARNING = (
    "WARNING: no Sales Nav workspace found (no --workspace, no $%s, no ~/Claude/%s): using the "
    "current folder, so the usage caps and the outreach ledger will NOT persist across tasks. "
    "Ask the user where their Cowork folder is (`workspace.py init <folder>`), then pass "
    "--workspace." % (ENV_VAR, FOLDER_NAME))


def default_dir(home=None):
    return Path(home or Path.home()) / "Claude" / FOLDER_NAME


def profile_workspace(text):
    """The `workspace:` value from company-profile.md text (None when absent or blank)."""
    for line in (text or "").splitlines():
        m = re.match(r"^\s*(?:[-*]\s*)?\**workspace\**\s*:\**\s*(.*?)\s*$", line, re.IGNORECASE)
        if m:
            value = m.group(1).strip().strip("`\"'").strip()
            if value and not value.startswith("(") and value.lower() not in ("skip", "none", "n/a"):
                return value
    return None


def resolve(flag=None, env=None, profile_text=None, home=None, cwd=None):
    """-> Workspace(path, source, persistent). source: flag|env|profile|default|cwd."""
    env = os.environ if env is None else env
    if flag:
        return Workspace(Path(os.path.expanduser(flag)), "flag", True)
    if (env.get(ENV_VAR) or "").strip():
        return Workspace(Path(os.path.expanduser(env[ENV_VAR].strip())), "env", True)
    from_profile = profile_workspace(profile_text)
    if from_profile:
        return Workspace(Path(os.path.expanduser(from_profile)), "profile", True)
    default = default_dir(home)
    if default.is_dir():
        return Workspace(default, "default", True)
    return Workspace(Path(cwd or os.getcwd()), "cwd", False)


def state_file(filename, log=None, workspace_flag=None, stream=None):
    """-> (path, located). `log` (an explicit --log) wins; otherwise <workspace>/<filename>.

    located is False only when no workspace could be found and the current folder is the fallback;
    the WARNING is printed once to `stream` (default stderr).
    """
    if log:
        return log, True
    ws = resolve(workspace_flag)
    if not ws.persistent:
        print(NOT_PERSISTENT_WARNING, file=stream or sys.stderr)
    return str(ws.path / filename), ws.persistent


def init_workspace(folder):
    """Create <folder>/sales-navigator/ (or folder itself when it already is one) with its subfolders."""
    base = Path(os.path.expanduser(folder))
    ws = base if base.name == FOLDER_NAME else base / FOLDER_NAME
    for sub in SUBDIRS:
        (ws / sub).mkdir(parents=True, exist_ok=True)
    return ws


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    loc = sub.add_parser("locate", help="print where the workspace is and how it was found")
    loc.add_argument("--workspace", metavar="DIR")
    loc.add_argument("--profile", metavar="FILE", help="company-profile.md to read the workspace: field from")
    ini = sub.add_parser("init", help="create <FOLDER>/sales-navigator/ with its subfolders")
    ini.add_argument("folder", metavar="FOLDER", help="the user's Cowork folder (usually ~/Claude)")
    args = ap.parse_args(argv)
    try:
        if args.command == "init":
            ws = init_workspace(args.folder)
            print("workspace: %s" % ws)
            print("created/kept: %s" % ", ".join(SUBDIRS))
            print("Save it in company-profile.md as:  workspace: %s" % ws)
            return EXIT_OK
        text = Path(args.profile).read_text(encoding="utf-8") if args.profile else None
        ws = resolve(args.workspace, profile_text=text)
    except OSError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_BAD
    if not ws.persistent:
        print("NOT FOUND: no workspace (no --workspace, no $%s, no profile `workspace:`, no ~/Claude/%s)."
              % (ENV_VAR, FOLDER_NAME))
        print("Ask the user ONCE where their Cowork folder is (the default is ~/Claude), run "
              "`workspace.py init <that folder>`, and save the printed path in company-profile.md.")
        return EXIT_NOT_FOUND
    print("workspace: %s" % ws.path)
    print("source: %s%s" % (ws.source, "" if ws.path.is_dir() else " (folder does not exist yet: `workspace.py init`)"))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
