#!/usr/bin/env python3
"""Track a TAM that is pulled as many sub-lists, each under the viewable cap.

A master search that is over the cap (1,000 accounts, 2,500 leads) is cut into sub-lists (by state,
then headcount band, then metro: see shard_plan.py). This file is the checklist: one row per
sub-list, so a later task knows what is counted, what is pulled and what is next.

  tam_tracker.py add    --list-id ID --master NAME --filters-delta "state=Texas; headcount=C" --count N
                        [--file results/texas-c.csv] [--cap 1000]
        add a sub-list (status new, pulled 0). Refuses (exit 3) an id already in the file, and
        (exit 2) a count over --cap: split it further first.
  tam_tracker.py update --list-id ID [--count N] [--pulled N] [--status new|partial|done]
                        [--file PATH] [--date YYYY-MM-DD]
        record progress. --pulled without --status sets partial, or done once pulled >= count;
        a pull stamps last_pulled (default today).
  tam_tracker.py status [--master NAME]
        counts per status, rows pulled against the sum of counts, and the lists not done. Shards
        overlap, so the sum over-counts: dedupe the pulled files (dedupe.py) for the unique total.
  tam_tracker.py next   [--master NAME]
        the one list to pull next: a partial list first (oldest pull first), then a new one.

CSV (<workspace>/tam_tracker.csv): list_id,master,filters_delta,count,pulled,status,last_pulled,file

Where it lives: the workspace folder (workspace.py): --workspace DIR, else the `workspace:` field of the
profile (--profile FILE), else $SALESNAV_WORKSPACE, else ~/Claude/sales-navigator when it exists; --log FILE
overrides the path. Exit codes: 0 ok, 1 bad input, 2 count over --cap, 3 duplicate or unknown list id,
4 workspace not located or tracker file missing (ask the user; never start a fresh tracker by mistake).

Python 3 standard library only, no network.
"""
import argparse
import csv
import os
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace  # noqa: E402

DEFAULT_FILE = "tam_tracker.csv"
COLUMNS = ["list_id", "master", "filters_delta", "count", "pulled", "status", "last_pulled", "file"]
STATUSES = ["new", "partial", "done"]
EXIT_OK, EXIT_BAD, EXIT_CAP, EXIT_ID, EXIT_NO_FILE = 0, 1, 2, 3, 4


class TrackerError(Exception):
    pass


def read_rows(path):
    p = Path(path)
    if not p.is_file():
        return []
    with open(p, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != COLUMNS:
            raise TrackerError("%s: header must be %s" % (path, ",".join(COLUMNS)))
        return [dict(r) for r in reader]


def write_rows(path, rows):
    """Write the whole file to a temp file beside it, then rename: a crash never leaves half a file."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tam_tracker-", suffix=".tmp", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
        os.replace(tmp, p)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def to_int(value, label):
    try:
        number = int(str(value).replace(",", "").strip())
    except ValueError:
        raise TrackerError("%s must be a whole number, got %r" % (label, value))
    if number < 0:
        raise TrackerError("%s must not be negative" % label)
    return number


def check_date(text):
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        raise TrackerError("--date must be YYYY-MM-DD, got %r" % text)
    return text


def find(rows, list_id):
    for row in rows:
        if row["list_id"] == list_id:
            return row
    return None


def auto_status(count, pulled):
    if count > 0 and pulled >= count:
        return "done"
    return "partial" if pulled > 0 else "new"


def cmd_add(args, rows):
    list_id = args.list_id.strip()
    if not list_id:
        raise TrackerError("--list-id must not be empty")
    if find(rows, list_id):
        print("refused: list %s is already in the tracker (use `update`)" % list_id, file=sys.stderr)
        return EXIT_ID
    count = to_int(args.count, "--count")
    if args.cap is not None and count > args.cap:
        print("refused: %s has %d results, over the cap of %d: split it by the next dimension "
              "(shard_plan.py) and add the pieces" % (list_id, count, args.cap), file=sys.stderr)
        return EXIT_CAP
    rows.append({"list_id": list_id, "master": args.master.strip(), "filters_delta": args.filters_delta.strip(),
                 "count": str(count), "pulled": "0", "status": "new", "last_pulled": "",
                 "file": (args.file or "").strip()})
    write_rows(args.log, rows)
    print("added %s (count %d, status new); %d lists tracked" % (list_id, count, len(rows)))
    return EXIT_OK


def cmd_update(args, rows):
    row = find(rows, args.list_id.strip())
    if not row:
        print("refused: no list %s in the tracker" % args.list_id, file=sys.stderr)
        return EXIT_ID
    if args.count is not None:
        row["count"] = str(to_int(args.count, "--count"))
    if args.file is not None:
        row["file"] = args.file.strip()
    if args.pulled is not None:
        row["pulled"] = str(to_int(args.pulled, "--pulled"))
        row["status"] = args.status or auto_status(int(row["count"] or 0), int(row["pulled"]))
        row["last_pulled"] = check_date(args.date) if args.date else date.today().isoformat()
    elif args.status:
        row["status"] = args.status
        if args.status != "new":
            row["last_pulled"] = check_date(args.date) if args.date else (row["last_pulled"] or date.today().isoformat())
    elif args.date:
        row["last_pulled"] = check_date(args.date)
    write_rows(args.log, rows)
    print("updated %s: %s/%s pulled, status %s" % (row["list_id"], row["pulled"], row["count"], row["status"]))
    return EXIT_OK


def scoped(rows, master):
    return [r for r in rows if not master or r["master"] == master]


def cmd_status(args, rows):
    rows = scoped(rows, args.master)
    if not rows:
        print("no lists tracked%s" % (" for master %r" % args.master if args.master else ""))
        return EXIT_OK
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in STATUSES}
    total = sum(int(r["count"] or 0) for r in rows)
    pulled = sum(int(r["pulled"] or 0) for r in rows)
    pct = (100.0 * pulled / total) if total else 0.0
    print("lists: %d (new %d, partial %d, done %d)" % (len(rows), counts["new"], counts["partial"], counts["done"]))
    print("rows: pulled %d of %d counted (%.0f%%); shards overlap, so run dedupe.py for the unique total"
          % (pulled, total, pct))
    open_rows = [r for r in rows if r["status"] != "done"]
    for r in open_rows:
        print("  %-8s %s  %s/%s  %s" % (r["status"], r["list_id"], r["pulled"], r["count"], r["filters_delta"]))
    if not open_rows:
        print("all lists done")
    return EXIT_OK


def pick_next(rows):
    partial = sorted((r for r in rows if r["status"] == "partial"), key=lambda r: r["last_pulled"] or "")
    if partial:
        return partial[0]
    new = [r for r in rows if r["status"] == "new"]
    return new[0] if new else None


def cmd_next(args, rows):
    row = pick_next(scoped(rows, args.master))
    if not row:
        print("next: none (nothing new or partial%s)" % (" for master %r" % args.master if args.master else ""))
        return EXIT_OK
    print("next: %s (%s, %s/%s pulled) %s" % (row["list_id"], row["status"], row["pulled"], row["count"],
                                              row["filters_delta"]))
    if row["file"]:
        print("file: %s" % row["file"])
    return EXIT_OK


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--log", metavar="FILE", help="tracker CSV, overriding <workspace>/%s" % DEFAULT_FILE)
    common.add_argument("--workspace", metavar="DIR", help="workspace folder (see workspace.py)")
    common.add_argument("--profile", metavar="FILE", help="company-profile.md whose `workspace:` field locates it")
    sub = ap.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add", parents=[common], help="add a sub-list")
    add.add_argument("--list-id", required=True)
    add.add_argument("--master", required=True, help="name of the master search this list belongs to")
    add.add_argument("--filters-delta", required=True, help="what this list adds to the master, e.g. 'state=Texas'")
    add.add_argument("--count", required=True, help="exact count from count=1")
    add.add_argument("--file", help="where the pulled rows are saved")
    add.add_argument("--cap", type=int, metavar="N", help="viewable cap (1000 accounts, 2500 leads): refuse a bigger list")

    upd = sub.add_parser("update", parents=[common], help="record counts, progress or status")
    upd.add_argument("--list-id", required=True)
    upd.add_argument("--count")
    upd.add_argument("--pulled")
    upd.add_argument("--status", choices=STATUSES)
    upd.add_argument("--file")
    upd.add_argument("--date", metavar="YYYY-MM-DD")

    for name, helptext in (("status", "coverage summary"), ("next", "the next list to pull")):
        p = sub.add_parser(name, parents=[common], help=helptext)
        p.add_argument("--master", help="only this master search")
    return ap


COMMANDS = {"add": cmd_add, "update": cmd_update, "status": cmd_status, "next": cmd_next}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.log, located = workspace.state_file(DEFAULT_FILE, args.log, args.workspace, profile=args.profile)
        if not located:
            print("refused: the workspace could not be located. Ask the user where their Cowork folder is "
                  "(workspace.py init <folder>) and pass --workspace", file=sys.stderr)
            return EXIT_NO_FILE
        if args.command != "add" and not Path(args.log).is_file():
            print("refused: no tracker at %s. If lists were tracked before, the workspace is wrong: ask the "
                  "user. Otherwise start with `add`" % args.log, file=sys.stderr)
            return EXIT_NO_FILE
        return COMMANDS[args.command](args, read_rows(args.log))
    except (TrackerError, OSError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_BAD


if __name__ == "__main__":
    sys.exit(main())
