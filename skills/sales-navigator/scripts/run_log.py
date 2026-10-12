#!/usr/bin/env python3
"""Tiny daily usage log for a Sales Navigator seat (JSONL, one line per `add`).

  run_log.py add --pages 12 --profiles 3        append what you just did
  run_log.py today                              today's totals vs the daily limits

Each action is reported as:
  OK            below 80% of the daily default
  NEAR          at or above 80% of the default (slow down, plan to stop)
  OVER DEFAULT  above the default: needs the user's explicit go
  OVER CEILING  above the hard ceiling: stop for the day

"Today" is the local calendar date. The log defaults to ./salesnav_run_log.jsonl.
Override the limits with --limits-file, e.g.
  {"pages": {"default": 30, "ceiling": 60}}   (keys: pages, profiles, accounts, saved_searches)

Exit codes: 0 fine (incl. NEAR / OVER DEFAULT), 2 if any action is OVER CEILING,
1 on bad input.
"""
import argparse
import json
import sys
from datetime import date, datetime

# Daily per-seat limits from references/guardrails.md ("Daily volume defaults").
# Keep in sync with that table (a test checks it).
LIMITS = {
    "pages": {"default": 40, "ceiling": 80},            # search result pages read
    "profiles": {"default": 80, "ceiling": 150},        # individual profiles opened
    "accounts": {"default": 60, "ceiling": 120},        # account pages opened
    "saved_searches": {"default": 10, "ceiling": 25},   # saved searches created
}
NEAR_FRACTION = 0.8
DEFAULT_LOG = "salesnav_run_log.jsonl"


def load_limits(path=None):
    limits = {k: dict(v) for k, v in LIMITS.items()}
    if path:
        with open(path, encoding="utf-8") as fh:
            override = json.load(fh)
        if not isinstance(override, dict):
            raise ValueError("limits file must be a JSON object")
        for action, vals in override.items():
            if action not in limits or not isinstance(vals, dict):
                raise ValueError("limits file: unknown action %r (use %s)"
                                 % (action, ", ".join(limits)))
            for key, num in vals.items():
                if key not in ("default", "ceiling") or not isinstance(num, int) or num < 0:
                    raise ValueError("limits file: %s.%s must be default/ceiling = whole number"
                                     % (action, key))
                limits[action][key] = num
    for action, lim in limits.items():
        if lim["default"] > lim["ceiling"]:
            raise ValueError("limits: %s default %d is above its ceiling %d"
                             % (action, lim["default"], lim["ceiling"]))
    return limits


def append_entry(path, counts, now=None):
    now = now or datetime.now().astimezone()
    entry = dict(ts=now.isoformat(timespec="seconds"), **counts)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")
    return entry


def read_entries(path):
    """Return entries; skip unreadable lines with a warning. Missing file -> []."""
    entries = []
    try:
        fh = open(path, encoding="utf-8")
    except FileNotFoundError:
        return entries
    with fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                datetime.fromisoformat(entry["ts"])
                entries.append(entry)
            except (ValueError, KeyError, TypeError):
                print("warning: %s line %d skipped (not a valid log entry)" % (path, n),
                      file=sys.stderr)
    return entries


def totals_for(entries, day):
    """Sum each action over entries whose LOCAL date is `day`."""
    totals = dict.fromkeys(LIMITS, 0)
    for e in entries:
        ts = datetime.fromisoformat(e["ts"])
        if ts.astimezone().date() == day:  # a naive timestamp is read as local time
            for action in totals:
                totals[action] += int(e.get(action, 0) or 0)
    return totals


def classify(total, limit):
    if total > limit["ceiling"]:
        return "OVER CEILING"
    if total > limit["default"]:
        return "OVER DEFAULT"
    if limit["default"] > 0 and total >= NEAR_FRACTION * limit["default"]:
        return "NEAR"
    return "OK"


def report(totals, limits, day):
    lines = ["Sales Nav usage for %s (local date)" % day.isoformat(),
             "%-15s %6s %8s %8s  %s" % ("action", "used", "default", "ceiling", "status")]
    statuses = {}
    for action in LIMITS:
        statuses[action] = classify(totals[action], limits[action])
        lines.append("%-15s %6d %8d %8d  %s" % (action, totals[action], limits[action]["default"],
                                                limits[action]["ceiling"], statuses[action]))
    if "OVER CEILING" in statuses.values():
        lines.append("STOP: a hard ceiling is exceeded. End the run and wait for tomorrow.")
    elif "OVER DEFAULT" in statuses.values():
        lines.append("Above the daily default: continue only with the user's explicit go.")
    return "\n".join(lines), statuses


def main(argv=None):
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--log", default=DEFAULT_LOG, metavar="FILE",
                        help="JSONL log file (default %(default)s)")
    common.add_argument("--limits-file", metavar="FILE",
                        help="JSON file overriding the default/ceiling numbers")
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", parents=[common], help="append a usage entry, then show today's totals")
    for flag, helptext in (("pages", "search result pages read"),
                           ("profiles", "individual profiles opened"),
                           ("accounts", "account pages opened"),
                           ("saved-searches", "saved searches created")):
        add.add_argument("--" + flag, type=int, default=0, metavar="N", help=helptext)
    today = sub.add_parser("today", parents=[common], help="show today's totals vs the limits")
    today.add_argument("--date", metavar="YYYY-MM-DD", help="report another local date")
    args = p.parse_args(argv)
    try:
        limits = load_limits(args.limits_file)
        if args.command == "add":
            counts = {a: getattr(args, a) for a in LIMITS}
            if any(n < 0 for n in counts.values()):
                raise ValueError("counts must not be negative")
            if not any(counts.values()):
                raise ValueError("nothing to add: give at least one of --pages, --profiles, "
                                 "--accounts, --saved-searches")
            append_entry(args.log, counts)
            day = date.today()
        else:
            day = date.fromisoformat(args.date) if args.date else date.today()
        text, statuses = report(totals_for(read_entries(args.log), day), limits, day)
    except (OSError, ValueError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    print(text)
    return 2 if "OVER CEILING" in statuses.values() else 0


if __name__ == "__main__":
    sys.exit(main())
