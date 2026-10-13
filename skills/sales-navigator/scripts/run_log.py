#!/usr/bin/env python3
"""Daily usage log for a Sales Navigator seat (CSV, one line per `add`) and the quota summary.

  run_log.py add --pages 12 --profiles 3        append what you just did
  run_log.py add --small-calls 20               counts, typeahead and website batches count too
  run_log.py today                              today's totals vs the daily limits
  run_log.py quota                              rewrite <workspace>/quota.md (pulls AND outreach, today
                                                and the last 7 days vs the caps) and print one summary
                                                line, e.g.  Today: 87/150 calls · 12/20 invites · week 41/100

End every action with `quota`: it is how the next task (tomorrow, another Cowork task) sees what is left.

Where the files live: the workspace folder (workspace.py): --workspace DIR, else $SALESNAV_WORKSPACE,
else ~/Claude/sales-navigator when it exists, else the current folder with a WARNING that the caps will
not persist. The log is <workspace>/run_log.csv; --log FILE overrides it.

CSV columns: date,time,pages,profiles,accounts,saved_searches,small_calls,note  (local date and time).
A legacy salesnav_run_log.jsonl beside the log is read until the CSV exists, then migrated into the CSV
on the first write (the old file is kept).

Each action is reported as:
  OK            below 80% of the daily default
  NEAR          at or above 80% of the default (slow down, plan to stop)
  OVER DEFAULT  above the default: needs the user's explicit go
  OVER CEILING  above the hard ceiling: stop for the day

"Today" is the local calendar date; "week" is the last 7 days, today included.
Override the limits with --limits-file, e.g.
  {"pages": {"default": 30, "ceiling": 60}}   (keys: pages, small_calls, profiles, accounts, saved_searches)

Exit codes: 0 fine (incl. NEAR / OVER DEFAULT), 2 if any action is OVER CEILING (add, today),
1 on bad input.
"""
import argparse
import csv
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace  # noqa: E402

# Daily per-seat limits from references/guardrails.md ("Daily volume defaults").
# Keep in sync with that table (a test checks it).
LIMITS = {
    "pages": {"default": 40, "ceiling": 80},            # search result pages read
    "small_calls": {"default": 150, "ceiling": 200},    # counts, typeahead, website batches
    "profiles": {"default": 80, "ceiling": 150},        # individual profiles opened
    "accounts": {"default": 60, "ceiling": 120},        # account pages opened
    "saved_searches": {"default": 10, "ceiling": 25},   # saved searches created
}
NEAR_FRACTION = 0.8
WEEK_DAYS = 7
DEFAULT_LOG = "run_log.csv"
LEGACY_LOG = "salesnav_run_log.jsonl"
QUOTA_FILE = "quota.md"
OUTREACH_LOG = "outreach_log.csv"
COLUMNS = ["date", "time", "pages", "profiles", "accounts", "saved_searches", "small_calls", "note"]


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


# ----------------------------------------------------------------------------- the file

def legacy_path(path):
    return Path(path).with_name(LEGACY_LOG)


def _csv_ready(path):
    p = Path(path)
    return p.is_file() and p.stat().st_size > 0


def legacy_entries(path):
    """Entries from a salesnav_run_log.jsonl: dicts shaped like CSV rows. Bad lines are skipped, with a warning."""
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
                raw = json.loads(line)
                local = datetime.fromisoformat(raw["ts"]).astimezone()  # a naive timestamp is read as local
                entry = {"date": local.date().isoformat(), "time": local.strftime("%H:%M:%S"), "note": ""}
                for action in LIMITS:
                    entry[action] = int(raw.get(action, 0) or 0)
                entries.append(entry)
            except (ValueError, KeyError, TypeError, AttributeError):
                print("warning: %s line %d skipped (not a valid log entry)" % (path, n), file=sys.stderr)
    return entries


def _write_rows(fh, rows, header):
    writer = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
    if header:
        writer.writeheader()
    for row in rows:
        writer.writerow({c: row.get(c, "") for c in COLUMNS})
    fh.flush()


def append_entry(path, counts, note="", now=None):
    """Append one row, creating the folder and the header. The first write migrates a legacy jsonl log."""
    now = now or datetime.now()
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fresh = not _csv_ready(p)
    old = legacy_entries(legacy_path(p)) if fresh else []
    entry = dict(date=now.date().isoformat(), time=now.strftime("%H:%M:%S"), note=note or "", **counts)
    with open(p, "a", newline="", encoding="utf-8") as fh:
        _write_rows(fh, old + [entry], header=fresh)
    return entry


def read_entries(path):
    """Return entries (dicts with date, time, the five counts, note); skip bad rows with a warning.

    A missing or empty CSV falls back to a legacy salesnav_run_log.jsonl beside it, else [].
    """
    p = Path(path)
    if not _csv_ready(p):
        return legacy_entries(legacy_path(p))
    entries = []
    with open(p, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != COLUMNS:
            raise ValueError("%s: header must be %s" % (path, ",".join(COLUMNS)))
        for n, row in enumerate(reader, 2):
            try:
                date.fromisoformat(row["date"])
                for action in LIMITS:
                    row[action] = int(row[action] or 0)
                entries.append(row)
            except (ValueError, TypeError, KeyError):
                print("warning: %s line %d skipped (not a valid log entry)" % (path, n), file=sys.stderr)
    return entries


# ----------------------------------------------------------------------------- numbers

def totals_between(entries, first, last):
    """Sum each action over entries whose LOCAL date is in [first, last]."""
    totals = dict.fromkeys(LIMITS, 0)
    for e in entries:
        if first <= date.fromisoformat(e["date"]) <= last:
            for action in totals:
                totals[action] += int(e.get(action, 0) or 0)
    return totals


def totals_for(entries, day):
    return totals_between(entries, day, day)


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
        lines.append("STOP: a hard ceiling is exceeded. End the run and wait for tomorrow. "
                     "Tell the user how many rows remain and offer to continue tomorrow.")
    elif "OVER DEFAULT" in statuses.values():
        lines.append("Above the daily default: continue only with the user's explicit go. "
                     "If this stopped a pull, tell the user how many rows remain and offer to "
                     "continue tomorrow or raise today's cap with their explicit OK.")
    return "\n".join(lines), statuses


# ----------------------------------------------------------------------------- quota.md

def quota_data(pull_entries, outreach_events, limits, today, outreach_found=True):
    """Everything quota.md and the summary line show, as plain numbers."""
    import outreach_log as ol
    week_first = today - timedelta(days=WEEK_DAYS - 1)
    day_t = totals_for(pull_entries, today)
    week_t = totals_between(pull_entries, week_first, today)
    used = ol.usage(outreach_events, today)
    return {"today": today, "day": day_t, "week": week_t, "limits": limits,
            "statuses": {a: classify(day_t[a], limits[a]) for a in LIMITS},
            "outreach_found": outreach_found, "used": used,
            "caps": {"daily": ol.DAILY_CONNECTION_CAP, "weekly": ol.WEEKLY_CONNECTION_CAP,
                     "followup": ol.DAILY_FOLLOWUP_CAP},
            "invite_status": {"day": ol.classify(used["day_n"], ol.DAILY_CONNECTION_CAP),
                              "week": ol.classify(used["week_n"], ol.WEEKLY_CONNECTION_CAP),
                              "followup": ol.classify(used["followups_day"], ol.DAILY_FOLLOWUP_CAP)}}


def summary_line(q):
    """'Today: 87/150 calls · 12/20 invites · week 41/100' plus pages (and anything else used)."""
    lim, day = q["limits"], q["day"]
    parts = ["%d/%d calls" % (day["small_calls"], lim["small_calls"]["default"]),
             "%d/%d pages" % (day["pages"], lim["pages"]["default"])]
    for action, label in (("profiles", "profiles"), ("accounts", "accounts"), ("saved_searches", "saved searches")):
        if day[action]:
            parts.append("%d/%d %s" % (day[action], lim[action]["default"], label))
    parts.append("%d/%d invites" % (q["used"]["day_n"], q["caps"]["daily"]))
    if q["used"]["followups_day"]:
        parts.append("%d/%d follow-ups" % (q["used"]["followups_day"], q["caps"]["followup"]))
    parts.append("week %d/%d" % (q["used"]["week_n"], q["caps"]["weekly"]))
    line = "Today: " + " · ".join(parts)
    flags = ["%s %s" % (a.replace("_", " "), s) for a, s in q["statuses"].items() if s.startswith("OVER")]
    flags += ["%s cap reached" % k for k, s in (("daily invite", q["invite_status"]["day"]),
                                                ("weekly invite", q["invite_status"]["week"]),
                                                ("follow-up", q["invite_status"]["followup"]))
              if s == "CAP REACHED"]
    if flags:
        line += "  !! " + ", ".join(flags)
    if not q["outreach_found"]:
        line += "  (no outreach ledger yet)"
    return line


def quota_markdown(q, workspace_dir, now):
    lim, day, week = q["limits"], q["day"], q["week"]
    lines = ["# Sales Navigator quota", "",
             "Last updated: %s (local time). Rewritten by `run_log.py quota` at the end of every action; "
             "do not edit." % now.strftime("%Y-%m-%d %H:%M"),
             "Workspace: %s" % workspace_dir, "",
             "**%s**" % summary_line(q), "",
             "## Pulling (Sales Nav reads), %s" % q["today"].isoformat(), "",
             "| Action | Today | Daily default | Hard ceiling | Status | Last 7 days |",
             "|---|---|---|---|---|---|"]
    for action in LIMITS:
        lines.append("| %s | %d | %d | %d | %s | %d |" % (
            action.replace("_", " "), day[action], lim[action]["default"], lim[action]["ceiling"],
            q["statuses"][action], week[action]))
    used, caps, st = q["used"], q["caps"], q["invite_status"]
    lines += ["", "## Outreach", "", "| What | Used | Cap | Status |", "|---|---|---|---|",
              "| Connection requests today | %d | %d | %s |" % (used["day_n"], caps["daily"], st["day"]),
              "| Connection requests, last 7 days | %d | %d | %s |" % (used["week_n"], caps["weekly"], st["week"]),
              "| Follow-up messages today | %d | %d | %s |" % (used["followups_day"], caps["followup"], st["followup"]),
              "| InMails today / last 7 days | %d / %d | your credits | n/a |" % (used["inmail_day"], used["inmail_week"])]
    if not q["outreach_found"]:
        lines += ["", "No `outreach_log.csv` in the workspace yet, so outreach shows 0. That is only true if "
                      "nothing was ever sent (see the profile's `Outreach started`)."]
    lines += ["", "Statuses: OK below 80% of the default, NEAR from 80%, OVER DEFAULT needs the user's "
                  "explicit go, OVER CEILING stops the day, CAP REACHED sends nothing more of that kind.",
              "Optional: mirror this file or `lists/` to a Google Sheet through your Drive connector. "
              "The local CSV files stay the source of truth.", ""]
    return "\n".join(lines)


def cmd_quota(args, log_path, limits):
    import outreach_log as ol
    today = date.fromisoformat(args.today) if args.today else date.today()
    ws_dir = Path(log_path).resolve().parent
    out_path = args.outreach_log or str(Path(log_path).with_name(OUTREACH_LOG))
    found = Path(out_path).is_file() and Path(out_path).stat().st_size > 0
    events = ol.read_events(out_path)
    q = quota_data(read_entries(log_path), events, limits, today, found)
    quota_path = Path(args.quota_file) if args.quota_file else ws_dir / QUOTA_FILE
    quota_path.parent.mkdir(parents=True, exist_ok=True)
    quota_path.write_text(quota_markdown(q, ws_dir, datetime.now()), encoding="utf-8")
    print(summary_line(q))
    print("quota.md updated: %s" % quota_path)
    return 0


# ----------------------------------------------------------------------------- command line

def main(argv=None):
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--workspace", metavar="DIR",
                        help="workspace folder (default: $SALESNAV_WORKSPACE, else ~/Claude/sales-navigator "
                             "if it exists, else the current folder with a WARNING)")
    common.add_argument("--log", metavar="FILE",
                        help="log file, overriding <workspace>/%s" % DEFAULT_LOG)
    common.add_argument("--limits-file", metavar="FILE",
                        help="JSON file overriding the default/ceiling numbers")
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", parents=[common], help="append a usage entry, then show today's totals")
    for flag, helptext in (("pages", "search result pages read"),
                           ("small-calls", "small API calls (counts, typeahead, website batches)"),
                           ("profiles", "individual profiles opened"),
                           ("accounts", "account pages opened"),
                           ("saved-searches", "saved searches created")):
        add.add_argument("--" + flag, type=int, default=0, metavar="N", help=helptext)
    add.add_argument("--note", default="", help="short free text, no personal details")
    today = sub.add_parser("today", parents=[common], help="show today's totals vs the limits")
    today.add_argument("--date", metavar="YYYY-MM-DD", help="report another local date")
    quota = sub.add_parser("quota", parents=[common],
                           help="rewrite quota.md (pulls + outreach, today and 7 days) and print one summary line")
    quota.add_argument("--outreach-log", metavar="FILE", help="outreach ledger (default <workspace>/outreach_log.csv)")
    quota.add_argument("--quota-file", metavar="FILE", help="where to write quota.md (default beside the log)")
    quota.add_argument("--today", metavar="YYYY-MM-DD", help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    try:
        limits = load_limits(args.limits_file)
        log_path, _ = workspace.state_file(DEFAULT_LOG, args.log, args.workspace)
        if args.command == "quota":
            return cmd_quota(args, log_path, limits)
        if args.command == "add":
            counts = {a: getattr(args, a) for a in LIMITS}
            if any(n < 0 for n in counts.values()):
                raise ValueError("counts must not be negative")
            if not any(counts.values()):
                raise ValueError("nothing to add: give at least one of --pages, --small-calls, "
                                 "--profiles, --accounts, --saved-searches")
            append_entry(log_path, counts, args.note)
            day = date.today()
        else:
            day = date.fromisoformat(args.date) if args.date else date.today()
        text, statuses = report(totals_for(read_entries(log_path), day), limits, day)
    except (OSError, ValueError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    print(text)
    return 2 if "OVER CEILING" in statuses.values() else 0


if __name__ == "__main__":
    sys.exit(main())
