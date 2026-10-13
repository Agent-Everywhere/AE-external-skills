#!/usr/bin/env python3
"""Track a TAM that is pulled as many sub-lists, each under the viewable cap.

A master search that is over the cap (1,000 accounts, 2,500 leads) is cut into sub-lists (by state,
then headcount band, then metro: see shard_plan.py). This file is the checklist: one row per
sub-list, so a later task knows what is counted, what is pulled and what is next.

  tam_tracker.py add    --list-id ID --master NAME --filters-delta "state=Texas; headcount=C" --count N
                        --kind account|lead [--cap N] [--file results/texas-c.csv]
        add a sub-list (status new, pulled 0). --kind sets the viewable cap (account 1000, lead 2500);
        --cap N may only lower it; one of the two is required. Refuses (exit 5) a count over the cap:
        split it further first. Refuses (exit 3) an id already used under the same master.
  tam_tracker.py update --master NAME --list-id ID [--count N] [--kind account|lead] [--pulled N]
                        [--status new|partial|done] [--file PATH] [--date YYYY-MM-DD]
        record progress on one list. A list is identified by (master, list id), so two masters may both
        have a "tx-c"; give ids the master as a prefix (acme-tx-c) anyway. --pulled without --status
        sets partial, or done once pulled >= count; a pull stamps last_pulled (default today).
        --count without --status re-derives the status from the new count (a done list whose count
        grows becomes partial); --kind with --count re-checks the new count against the cap.
  tam_tracker.py status [--master NAME]
        counts per status, rows pulled against the sum of counts, and the lists not done. Shards
        overlap, so the sum over-counts: dedupe the pulled files (dedupe.py) for the unique total.
  tam_tracker.py next   [--master NAME]
        the one list to pull next: a partial list first (oldest pull first), then a new one.

CSV (<workspace>/tam_tracker.csv): list_id,master,filters_delta,count,pulled,status,last_pulled,file

Where it lives: the workspace folder (workspace.py): --workspace DIR, else the `workspace:` field of the
profile (--profile FILE), else $SALESNAV_WORKSPACE, else ~/Claude/sales-navigator when it exists; --log FILE
overrides the path. Exit codes: 0 ok, 1 bad input (including a damaged tracker file or a lock held too
long), 2 command-line usage error (argparse), 3 duplicate or unknown list id, 4 workspace not located or
tracker file missing (ask the user; never start a fresh tracker by mistake), 5 count over the cap (split it).

`add` and `update` take a lock file (<tracker>.lock) around reading and rewriting the tracker, so two
tasks cannot lose each other's update.

Python 3 standard library only, no network.
"""
import argparse
import csv
import os
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace  # noqa: E402

DEFAULT_FILE = "tam_tracker.csv"
COLUMNS = ["list_id", "master", "filters_delta", "count", "pulled", "status", "last_pulled", "file"]
STATUSES = ["new", "partial", "done"]
EXIT_OK, EXIT_BAD, EXIT_ID, EXIT_NO_FILE, EXIT_CAP = 0, 1, 3, 4, 5   # 2 stays argparse's usage error
CAPS = {"account": 1000, "lead": 2500}   # viewable results per search
LOCK_WAIT_SECONDS = 10
LOCK_STALE_SECONDS = 120


class TrackerError(Exception):
    pass


def to_int(value, label):
    try:
        number = int(str(value).replace(",", "").strip())
    except ValueError:
        raise TrackerError("%s must be a whole number, got %r" % (label, value))
    if number < 0:
        raise TrackerError("%s must not be negative" % label)
    return number


def read_rows(path):
    """The tracker rows, validated: counts are whole numbers, status is known, no short or long lines.

    A missing or empty (zero-byte) file is a tracker with no rows. A damaged file raises TrackerError."""
    p = Path(path)
    if not p.is_file() or not p.read_bytes().strip():
        return []
    with open(p, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != COLUMNS:
            raise TrackerError("%s: header must be %s" % (path, ",".join(COLUMNS)))
        rows, seen = [], set()
        for row in reader:
            where = "%s line %d" % (path, reader.line_num)
            if None in row or any(v is None for v in row.values()):
                raise TrackerError("%s: expected %d fields" % (where, len(COLUMNS)))
            row = {k: v.strip() for k, v in row.items()}
            row["count"] = str(to_int(row["count"], "%s: count" % where))
            row["pulled"] = str(to_int(row["pulled"], "%s: pulled" % where))
            if row["status"] not in STATUSES:
                raise TrackerError("%s: status must be one of %s, got %r" % (where, "|".join(STATUSES), row["status"]))
            if not row["list_id"]:
                raise TrackerError("%s: list_id is empty" % where)
            key = (row["master"], row["list_id"])
            if key in seen:
                raise TrackerError("%s: list %s is listed twice under master %r" % (where, row["list_id"], row["master"]))
            seen.add(key)
            rows.append(row)
        return rows


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


@contextmanager
def locked(path):
    """Hold <tracker>.lock (created exclusively) while a command reads, changes and rewrites the file."""
    lock = Path(str(path) + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while True:
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > LOCK_STALE_SECONDS:   # a crashed task left it
                    lock.unlink()
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() > deadline:
                raise TrackerError("%s is held by another task; try again in a moment" % lock)
            time.sleep(0.1)
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


def check_date(text):
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        raise TrackerError("--date must be YYYY-MM-DD, got %r" % text)
    return text


def find(rows, master, list_id):
    for row in rows:
        if row["list_id"] == list_id and row["master"] == master:
            return row
    return None


def auto_status(count, pulled):
    if count > 0 and pulled >= count:
        return "done"
    return "partial" if pulled > 0 else "new"


def cap_for(kind, cap):
    """The viewable cap that applies: --kind sets it, --cap may only lower it. One of them is required."""
    if cap is not None and cap <= 0:
        raise TrackerError("--cap must be a positive whole number, got %d" % cap)
    if kind is None and cap is None:
        raise TrackerError("give --kind account|lead (cap %s) so an oversize list cannot be recorded"
                           % " / ".join("%s %d" % (k, v) for k, v in CAPS.items()))
    return min(n for n in (CAPS.get(kind), cap) if n is not None)


def refuse_over_cap(list_id, count, cap):
    print("refused: %s has %d results, over the cap of %d: split it by the next dimension "
          "(shard_plan.py) and add the pieces" % (list_id, count, cap), file=sys.stderr)
    return EXIT_CAP


def cmd_add(args, rows):
    list_id = args.list_id.strip()
    master = args.master.strip()
    if not list_id:
        raise TrackerError("--list-id must not be empty")
    if not master:
        raise TrackerError("--master must not be empty")
    count = to_int(args.count, "--count")
    cap = cap_for(args.kind, args.cap)
    if find(rows, master, list_id):
        print("refused: list %s is already in the tracker under master %r (use `update --master %s`)"
              % (list_id, master, master), file=sys.stderr)
        return EXIT_ID
    if count > cap:
        return refuse_over_cap(list_id, count, cap)
    rows.append({"list_id": list_id, "master": master, "filters_delta": args.filters_delta.strip(),
                 "count": str(count), "pulled": "0", "status": "new", "last_pulled": "",
                 "file": (args.file or "").strip()})
    write_rows(args.log, rows)
    print("added %s (count %d, status new); %d lists tracked" % (list_id, count, len(rows)))
    return EXIT_OK


def cmd_update(args, rows):
    master, list_id = args.master.strip(), args.list_id.strip()
    row = find(rows, master, list_id)
    if not row:
        print("refused: no list %s under master %r in the tracker" % (list_id, master), file=sys.stderr)
        return EXIT_ID
    if args.kind is not None and args.count is None:
        raise TrackerError("--kind re-checks a new --count: give --count with it")
    if args.count is not None:
        count = to_int(args.count, "--count")
        if args.kind is not None and count > CAPS[args.kind]:
            return refuse_over_cap(list_id, count, CAPS[args.kind])
        row["count"] = str(count)
        if args.pulled is None and not args.status:   # a changed count can change what "done" means
            row["status"] = auto_status(count, int(row["pulled"]))
    if args.file is not None:
        row["file"] = args.file.strip()
    if args.pulled is not None:
        row["pulled"] = str(to_int(args.pulled, "--pulled"))
        row["status"] = args.status or auto_status(int(row["count"]), int(row["pulled"]))
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
    total = sum(int(r["count"]) for r in rows)
    pulled = sum(int(r["pulled"]) for r in rows)
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
    add.add_argument("--kind", choices=sorted(CAPS), help="account (cap 1000) or lead (cap 2500)")
    add.add_argument("--cap", type=int, metavar="N", help="a lower cap than --kind's; one of --kind and --cap is required")

    upd = sub.add_parser("update", parents=[common], help="record counts, progress or status")
    upd.add_argument("--master", required=True, help="the master search the list belongs to (ids are per master)")
    upd.add_argument("--list-id", required=True)
    upd.add_argument("--count")
    upd.add_argument("--kind", choices=sorted(CAPS), help="with --count: refuse a count over this kind's cap")
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
        if args.command in ("add", "update"):
            with locked(args.log):
                return COMMANDS[args.command](args, read_rows(args.log))
        return COMMANDS[args.command](args, read_rows(args.log))
    except (TrackerError, OSError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_BAD


if __name__ == "__main__":
    sys.exit(main())
