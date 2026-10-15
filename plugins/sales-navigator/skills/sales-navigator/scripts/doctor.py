#!/usr/bin/env python3
"""Check that the Sales Navigator engine is reachable and complete before any flow runs.

  doctor.py [--engine DIR] [--workspace DIR] [--profile FILE]

Prints the resolved engine folder, the Python version, every required snippet and script (present or
MISSING), and where the workspace is. Exit 0 when the engine is complete; exit 1 with a clear message
when anything required is missing. A workspace that is not set up yet is a NOTE, not a failure (the
flow asks the user once and runs `workspace.py init`).

The engine folder is the folder above this script's `scripts/` unless --engine is given. The skills
find it with $CLAUDE_PLUGIN_ROOT/skills/sales-navigator, or the `sales-navigator` folder next to the
skill's own folder.

Python 3 standard library only, no network.
"""
import argparse
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True   # never leave __pycache__ inside an installed plugin
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import workspace  # noqa: E402

MIN_PYTHON = (3, 8)
EXIT_OK, EXIT_MISSING = 0, 1

REQUIRED_PAGE = (
    "account.js", "account_search.js", "activity.js", "companies_details.js", "companies_websites.js",
    "count.js", "csrf_ready.js", "lead_search.js", "list_create.js", "list_save_accounts.js", "list_save_sharded.js",
    "lists.js",
    "profile.js", "profiles_batch.js", "typeahead.js",
)
REQUIRED_SCRIPTS = (
    "dedupe.py", "doctor.py", "outreach_log.py", "run_log.py", "salesnav_rows.py", "segments.py", "shard_plan.py",
    "tam_tracker.py", "validate_csv.py", "workspace.py",
)
KB_PAGES = (
    "00-index.md", "01-navigation-basics.md", "02-filters-and-ids.md", "03-view-cap-and-slicing.md",
    "04-industry-quirks.md", "05-rate-caps-and-pacing.md", "10-approach-segmented-merge.md",
    "11-approach-broad-net-slicing.md", "12-approach-lookalike-plus-lanes.md",
    "13-approach-account-first-people.md", "14-lists.md", "15-batch-scrape.md", "20-rubric-template.md",
)
REQUIRED_OTHER = ("reference.md", "runtime/session.py", "templates/company-profile.md", "templates/drafts.csv")


def required_paths():
    """Every file the engine must hold, as relative POSIX paths."""
    return (["page/" + n for n in REQUIRED_PAGE] + ["scripts/" + n for n in REQUIRED_SCRIPTS]
            + list(REQUIRED_OTHER) + ["references/salesnav-kb/" + n for n in KB_PAGES])


def check_engine(engine):
    """-> (present, missing) relative paths under `engine`."""
    present, missing = [], []
    for rel in required_paths():
        (present if (Path(engine) / rel).is_file() else missing).append(rel)
    return present, missing


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", metavar="DIR", help="engine folder to check (default: the folder holding this script)")
    ap.add_argument("--workspace", metavar="DIR")
    ap.add_argument("--profile", metavar="FILE", help="company-profile.md to read the workspace: field from")
    args = ap.parse_args(argv)

    engine = Path(os.path.expanduser(args.engine)).resolve() if args.engine else HERE.parent
    problems = []

    print("engine: %s" % engine)
    if not engine.is_dir():
        print("FAIL: engine folder not found: %s" % engine)
        print("Stop and tell the user the Sales Navigator engine is not installed. "
              "Do not drive the Sales Navigator UI by hand.")
        return EXIT_MISSING

    version = "%d.%d.%d" % sys.version_info[:3]
    print("python: %s%s" % (version, "" if sys.version_info[:2] >= MIN_PYTHON else
                            " (need %d.%d or newer)" % MIN_PYTHON))
    if sys.version_info[:2] < MIN_PYTHON:
        problems.append("python %s is older than %d.%d" % (version, MIN_PYTHON[0], MIN_PYTHON[1]))

    present, missing = check_engine(engine)
    print("files: %d of %d present" % (len(present), len(present) + len(missing)))
    for rel in missing:
        print("MISSING: %s" % rel)
        problems.append("missing %s" % rel)

    try:
        ws = workspace.resolve(args.workspace, profile_text=workspace.read_profile(args.profile))
    except OSError as exc:
        ws = None
        print("workspace: error reading profile: %s" % exc)
        problems.append("cannot read profile")
    if ws is not None:
        if ws.persistent:
            print("workspace: %s (source: %s%s)" % (ws.path, ws.source,
                                                    "" if ws.path.is_dir() else ", folder does not exist yet"))
        else:
            print("workspace: NOTE not set up (no --workspace, no $%s, no ~/Claude/%s). Ask the user once "
                  "to confirm the default (~/Claude) or name their Cowork folder, then run "
                  "`workspace.py init ~/Claude` (or that folder). Not a stop: seller research and intake go on."
                  % (workspace.ENV_VAR, workspace.FOLDER_NAME))

    if problems:
        print("FAIL: %s." % "; ".join(problems))
        print("Stop and tell the user the Sales Navigator engine is incomplete or not found. "
              "Do not drive the Sales Navigator UI by hand.")
        return EXIT_MISSING
    print("OK: engine complete.")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
