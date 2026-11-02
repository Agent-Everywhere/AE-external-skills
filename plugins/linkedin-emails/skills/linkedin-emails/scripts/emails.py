#!/usr/bin/env python3
"""emails.py: working copy + ledger for filling a LinkedIn connections CSV with emails (Python 3 stdlib only, no network).

  emails.py init <csv> [--out DIR] [--daily-cap N]   build the working copy and ledger from Connections.csv
  emails.py next [--limit N] [--where col=regex] [--include-filled]   JSON {"vanities": [...]} to feed contact_info.js
  emails.py merge <results.json>                     write contact_info.js output into the working copy
  emails.py status                                   totals, hit rate, today's count, remaining
  emails.py export [--out FILE]                      final CSV with a best_email column
  emails.py cap <N> [--user-approved-raise]          change the per-day cap (above 120 needs the flag)

Working dir defaults to ./linkedin-emails-work/ (override with --dir on any subcommand). It holds
connections.csv (the working copy) and ledger.json. Only name/url/email/phone/website/status are stored.
"""
import argparse
import csv
import datetime
import hashlib
import io
import json
import os
import re
import sys
import tempfile
from urllib.parse import unquote

DEFAULT_DIR = "linkedin-emails-work"
WORK_CSV = "connections.csv"
LEDGER = "ledger.json"
DEFAULT_CAP = 120
MAX_PER_RUN = 40
CONTACT_COLS = ["contact_email", "contact_phone", "contact_website", "contact_status", "contact_checked_at"]
DONE = ("ok", "not_found")
URL_NAMES = ["url", "linkedin url", "linkedin profile url", "profile url", "linkedin", "linkedin link"]
EMAIL_NAMES = ["email address", "email", "e-mail", "e-mail address"]
# A stop on any of these ends the whole day. decoration_rotated is fixable, so it does not lock the day.
FIXABLE_STOPS = {"decoration_rotated"}


class Fail(Exception):
    pass


def today(args):
    return getattr(args, "today", None) or datetime.date.today().isoformat()


def vanity_of(url):
    """/in/<vanity> from a LinkedIn URL: URL-decoded, no trailing slash, query or fragment. '' when there is none."""
    m = re.search(r"linkedin\.com/in/([^/?#\s]+)", url or "", re.I)
    return unquote(m.group(1)).strip() if m else ""


def find_col(header, names):
    low = {h.strip().lower(): h for h in header}
    for n in names:
        if n in low:
            return low[n]
    return None


def atomic_write(path, text):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def csv_text(header, rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=header, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return "﻿" + buf.getvalue()   # BOM so Excel reads UTF-8 names correctly


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    return rows


def parse_connections(path):
    """Find the header row (LinkedIn's export has a few 'Notes:' lines before it) and return (header, dict rows)."""
    rows = read_csv(path)
    for i, r in enumerate(rows[:40]):
        if find_col(r, URL_NAMES):
            header = [h.strip() for h in r]
            out = []
            for data in rows[i + 1:]:
                if not any(c.strip() for c in data):
                    continue
                data = (data + [""] * len(header))[: len(header)]
                out.append(dict(zip(header, data)))
            return header, out
    raise Fail("no header row with a URL / LinkedIn URL column found in %s" % path)


def paths(args):
    d = args.dir or DEFAULT_DIR
    return d, os.path.join(d, WORK_CSV), os.path.join(d, LEDGER)


def load_work(args):
    d, work, ledger = paths(args)
    if not os.path.exists(work) or not os.path.exists(ledger):
        raise Fail("no working copy in %s: run `emails.py init <connections.csv>` first" % d)
    rows = read_csv(work)
    header = rows[0]
    data = [dict(zip(header, (r + [""] * len(header))[: len(header)])) for r in rows[1:]]
    with open(ledger, encoding="utf-8") as f:
        led = json.load(f)
    return header, data, led


def save_work(args, header, data, led):
    d, work, ledger = paths(args)
    atomic_write(work, csv_text(header, data))
    atomic_write(ledger, json.dumps(led, indent=2, sort_keys=True) + "\n")


def check_cap(n, approved):
    if n < 1:
        raise Fail("daily cap must be at least 1")
    if n > DEFAULT_CAP and not approved:
        raise Fail("a cap above %d needs the user's explicit OK; ask them, then pass --user-approved-raise" % DEFAULT_CAP)
    return n


def emit(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


# ---- init -------------------------------------------------------------------------------------------------

def cmd_init(args):
    d, work, ledger = paths(args)
    if os.path.exists(work) and not args.force:
        raise Fail("%s already exists (progress would be lost); pass --force to start over" % work)
    cap = check_cap(args.daily_cap, args.user_approved_raise)
    header, rows = parse_connections(args.csv)
    url_col = find_col(header, URL_NAMES)
    email_col = find_col(header, EMAIL_NAMES)
    if not email_col:
        email_col = "Email Address"
        header.append(email_col)
        for r in rows:
            r[email_col] = ""
    out_header = header + [c for c in ["vanity"] + CONTACT_COLS if c not in header]
    kept, by_vanity, dupes = [], {}, 0
    for r in rows:
        v = vanity_of(r.get(url_col, ""))
        r["vanity"] = v
        for c in CONTACT_COLS:
            r.setdefault(c, "")
        if not v:
            r["contact_status"] = "no_url"
            kept.append(r)
            continue
        first = by_vanity.get(v.lower())
        if first is None:
            by_vanity[v.lower()] = r
            kept.append(r)
        else:
            dupes += 1
            for k, val in r.items():   # keep the first row, fill its blanks from the duplicate
                if not (first.get(k) or "").strip() and (val or "").strip():
                    first[k] = val
    led = {"version": 1, "source": os.path.basename(args.csv), "email_column": email_col, "url_column": url_col,
           "created": today(args), "daily_cap": cap, "days": {}, "merges": {}, "stopped": {}}
    save_work(args, out_header, kept, led)
    emit({"working_dir": d, "working_copy": work, "rows": len(kept), "duplicates_dropped": dupes,
          "no_url": sum(1 for r in kept if not r["vanity"]),
          "with_export_email": sum(1 for r in kept if r[email_col].strip()), "daily_cap": cap,
          "columns": out_header})


# ---- next -------------------------------------------------------------------------------------------------

def compile_where(items, header):
    out = []
    low = {h.lower(): h for h in header}
    for item in items or []:
        col, sep, pat = item.partition("=")
        if not sep or not col.strip():
            raise Fail("--where expects column=regex, got %r" % item)
        real = low.get(col.strip().lower())
        if not real:
            raise Fail("--where column %r not found; columns: %s" % (col, ", ".join(header)))
        try:
            out.append((real, re.compile(pat, re.I)))
        except re.error as e:
            raise Fail("bad regex in --where %r: %s" % (item, e))
    return out


def pending(header, data, led, where, include_filled):
    email_col = led["email_column"]
    conds = compile_where(where, header)
    out = []
    for r in data:
        if not r["vanity"] or r["contact_status"] in DONE:
            continue
        if r[email_col].strip() and not include_filled:
            continue
        if all(rx.search(r.get(col, "")) for col, rx in conds):
            out.append(r)
    return out


def cmd_next(args):
    header, data, led = load_work(args)
    day = today(args)
    cap = led["daily_cap"]
    used = led["days"].get(day, 0)
    rows = pending(header, data, led, args.where, args.include_filled)
    stop = led["stopped"].get(day)
    limit = min(args.limit, MAX_PER_RUN, max(cap - used, 0))
    reason = None
    if stop:
        reason, limit = "stopped_today:" + stop, 0
    elif used >= cap:
        reason = "daily_cap_reached"
    elif not rows:
        reason = "nothing_left"
    emit({"vanities": [r["vanity"] for r in rows[:limit]], "count": len(rows[:limit]), "reason": reason,
          "today_done": used, "daily_cap": cap, "remaining_today": max(cap - used, 0),
          "matching_pending": len(rows)})


# ---- merge ------------------------------------------------------------------------------------------------

def load_results(path):
    with open(path, encoding="utf-8-sig") as f:
        text = f.read().strip()
    data = json.loads(text)
    if isinstance(data, str):   # console output saved as a quoted string
        data = json.loads(data)
    if isinstance(data, list):
        data = {"rows": data, "stopped_reason": None}
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
        raise Fail("results file must be the contact_info.js output ({rows: [...], stopped_reason})")
    return data


def cmd_merge(args):
    header, data, led = load_work(args)
    res = load_results(args.results)
    day = today(args)
    by_vanity = {r["vanity"].lower(): r for r in data if r["vanity"]}
    digest = hashlib.sha256(json.dumps(res, sort_keys=True).encode()).hexdigest()
    already = digest in led["merges"]
    updated = unknown = 0
    for row in res["rows"]:
        target = by_vanity.get(str(row.get("vanity", "")).lower())
        status = row.get("status")
        if target is None or status not in ("ok", "not_found", "error"):
            unknown += 1
            continue
        if status == "error" and target["contact_status"] in DONE:
            continue   # never downgrade a finished row
        email = row.get("email")
        target["contact_email"] = email.strip() if isinstance(email, str) else ""
        target["contact_phone"] = "; ".join(str(x) for x in row.get("phones") or [])
        target["contact_website"] = "; ".join(str(x) for x in row.get("websites") or [])
        target["contact_status"] = status
        target["contact_checked_at"] = day
        updated += 1
    if not already:
        led["merges"][digest] = day
        led["days"][day] = led["days"].get(day, 0) + len(res["rows"])
    stop = res.get("stopped_reason")
    if stop and stop not in FIXABLE_STOPS:
        led["stopped"][day] = stop
    save_work(args, header, data, led)
    emit({"merged_rows": updated, "ignored_rows": unknown, "already_merged": already, "stopped_reason": stop,
          "today_done": led["days"].get(day, 0), "daily_cap": led["daily_cap"],
          "note": {"decoration_rotated": "read the current decorationId from the Contact info request in the "
                                         "page's network tab and pass it as decorationId"}.get(
              stop, "stop for the day: do not run again until tomorrow" if stop else None)})


# ---- status / export / cap --------------------------------------------------------------------------------

def best_email(r, email_col):
    return r[email_col].strip() or r["contact_email"].strip()


def cmd_status(args):
    header, data, led = load_work(args)
    day = today(args)
    ec = led["email_column"]
    checked = [r for r in data if r["contact_status"] in DONE]
    with_contact = sum(1 for r in checked if r["contact_email"].strip())
    pend = pending(header, data, led, None, False)
    emit({"total_rows": len(data),
          "with_export_email": sum(1 for r in data if r[ec].strip()),
          "checked": len(checked),
          "ok": sum(1 for r in data if r["contact_status"] == "ok"),
          "not_found": sum(1 for r in data if r["contact_status"] == "not_found"),
          "errors": sum(1 for r in data if r["contact_status"] == "error"),
          "no_url": sum(1 for r in data if r["contact_status"] == "no_url"),
          "with_contact_email": with_contact,
          "hit_rate": round(with_contact / len(checked), 3) if checked else None,
          "hit_rate_note": "contact emails found / profiles checked (ok + not_found)",
          "rows_with_any_email": sum(1 for r in data if best_email(r, ec)),
          "today_done": led["days"].get(day, 0), "daily_cap": led["daily_cap"],
          "remaining_today": max(led["daily_cap"] - led["days"].get(day, 0), 0),
          "remaining_unchecked": len(pend), "stopped_today": led["stopped"].get(day)})


def cmd_export(args):
    header, data, led = load_work(args)
    ec = led["email_column"]
    d = paths(args)[0]
    out = args.out or os.path.join(d, "connections_with_emails.csv")
    cols = [h for h in header if h != "vanity"] + ["best_email"]
    rows = []
    for r in data:
        r = dict(r)
        r["best_email"] = best_email(r, ec)
        rows.append(r)
    atomic_write(out, csv_text(cols, rows))
    emit({"written": out, "rows": len(rows), "with_best_email": sum(1 for r in rows if r["best_email"])})


def cmd_cap(args):
    header, data, led = load_work(args)
    led["daily_cap"] = check_cap(args.n, args.user_approved_raise)
    save_work(args, header, data, led)
    emit({"daily_cap": led["daily_cap"]})


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--today", help=argparse.SUPPRESS)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, **kw):
        p = sub.add_parser(name, **kw)
        p.add_argument("--dir", default=None, help="working dir (default ./%s)" % DEFAULT_DIR)
        p.set_defaults(fn=fn)
        return p

    p = add("init", cmd_init, help="build the working copy and ledger")
    p.add_argument("csv")
    p.add_argument("--out", dest="dir", help="working dir (same as --dir)")
    p.add_argument("--daily-cap", type=int, default=DEFAULT_CAP)
    p.add_argument("--user-approved-raise", action="store_true")
    p.add_argument("--force", action="store_true", help="overwrite an existing working copy")
    p = add("next", cmd_next, help="print the next batch of vanities")
    p.add_argument("--limit", type=int, default=MAX_PER_RUN)
    p.add_argument("--where", action="append", metavar="COL=REGEX")
    p.add_argument("--include-filled", action="store_true", help="also re-check rows that already have an email")
    p = add("merge", cmd_merge, help="merge contact_info.js output")
    p.add_argument("results")
    add("status", cmd_status, help="progress and hit rate")
    p = add("export", cmd_export, help="write the final CSV with best_email")
    p.add_argument("--out")
    p = add("cap", cmd_cap, help="change the per-day cap")
    p.add_argument("n", type=int)
    p.add_argument("--user-approved-raise", action="store_true")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.fn(args)
    except Fail as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
    except (OSError, ValueError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
