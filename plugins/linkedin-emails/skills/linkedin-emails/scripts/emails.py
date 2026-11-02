#!/usr/bin/env python3
"""emails.py: working copy + ledger for filling a LinkedIn connections CSV with emails (Python 3 stdlib only, no network).

  emails.py init <csv> [--out DIR] [--daily-cap N] [--force]   build the working copy and ledger from Connections.csv
  emails.py next [--limit N] [--where col=regex] [--include-filled] [--abandon-issue]
                                                     JSON {"vanities": [...]} to feed contact_info.js (reserves the cap)
  emails.py merge <results.json>                     write contact_info.js output into the working copy
  emails.py status                                   totals, hit rate, last-24h count, remaining
  emails.py export [--out FILE]                      final CSV with a best_email column
  emails.py cap <N> [--user-approved-raise]          change the per-day cap (above 120 needs the flag)

Working dir defaults to ./linkedin-emails-work/ (override with --dir on any subcommand). It holds
connections.csv (the working copy) and ledger.json. Only name/url/email/phone/website/status are stored.
The cap is a rolling 24 hours: `next` reserves what it issues, `merge` settles it against what actually ran.
"""
import argparse
import contextlib
import csv
import datetime
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
from urllib.parse import unquote

DEFAULT_DIR = "linkedin-emails-work"
WORK_CSV = "connections.csv"
LEDGER = "ledger.json"
LOCK = ".lock"
DEFAULT_CAP = 120
DEFAULT_RUN = 20
MAX_PER_RUN = 40
MAX_ATTEMPTS = 3
WINDOW = datetime.timedelta(hours=24)
CONTACT_COLS = ["contact_email", "contact_phone", "contact_website", "contact_status", "contact_checked_at",
                "contact_attempts", "contact_note"]
DONE = ("ok", "not_found", "error_final")
URL_NAMES = ["url", "linkedin url", "linkedin profile url", "profile url", "linkedin", "linkedin link"]
EMAIL_NAMES = ["email address", "email", "e-mail", "e-mail address"]
# A stop ends the next 24 hours, except these: no request was made, or the fix is on our side.
NO_LOCK_STOPS = {"decoration_rotated", "no_session", "wrong_page", "already_running"}
TS = "%Y-%m-%dT%H:%M:%SZ"


class Fail(Exception):
    pass


# ---- time -------------------------------------------------------------------------------------------------

def now_of(args):
    s = getattr(args, "now", None)
    if s:
        return datetime.datetime.strptime(s, TS)
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None, microsecond=0)


def ts(dt):
    return dt.strftime(TS)


def parse_ts(s):
    return datetime.datetime.strptime(s, TS)


def in_window(at, now):
    return now - WINDOW < parse_ts(at) <= now


# ---- vanity -----------------------------------------------------------------------------------------------

BAD_DECODED = re.compile(r"[\x00-\x20\x7f\"'`$\\/<>;|&(){}\[\]*?!#]")


def decoded_ok(dec):
    return bool(dec.strip(".")) and not BAD_DECODED.search(dec)


def parse_vanity(url):
    """(vanity, reason). The /in/<vanity> segment, URL-decoded; reason explains an empty vanity."""
    m = re.search(r"linkedin\.com/in/([^/?#\s]+)", url or "", re.I)
    if not m:
        return "", "no /in/ URL"
    raw = m.group(1)
    if not re.fullmatch(r"[A-Za-z0-9_.\-%]+", raw):
        return "", "unsafe characters in vanity"
    try:
        dec = unquote(raw, errors="strict")
    except UnicodeDecodeError:
        return "", "bad percent-encoding in vanity"
    if not decoded_ok(dec):
        return "", "unsafe characters in vanity"
    return dec, ""


def vanity_of(url):
    return parse_vanity(url)[0]


# ---- files ------------------------------------------------------------------------------------------------

def find_col(header, names):
    low = {h.strip().lower(): h for h in header}
    for n in names:
        if n in low:
            return low[n]
    return None


def stage(path, text):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        os.unlink(tmp)
        raise
    return tmp


def atomic_write_many(items):
    """Write every (path, text) to a temp file first, then rename them in order. Nothing half-written."""
    staged = []
    try:
        for path, text in items:
            staged.append((stage(path, text), path))
        for tmp, path in staged:
            os.replace(tmp, path)
            staged = [x for x in staged if x[0] != tmp]
    finally:
        for tmp, _ in staged:
            if os.path.exists(tmp):
                os.unlink(tmp)


def atomic_write(path, text):
    atomic_write_many([(path, text)])


@contextlib.contextmanager
def locked(d):
    """Simple lock file (O_EXCL) so two emails.py runs never write the same working copy together."""
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, LOCK)
    try:
        if time.time() - os.path.getmtime(path) > 120:   # left behind by a crashed run
            os.unlink(path)
    except OSError:
        pass
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise Fail("another emails.py is running on %s (lock file %s); wait a moment and retry" % (d, path))
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    try:
        yield
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def csv_text(header, rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=header, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return "﻿" + buf.getvalue()   # BOM so Excel reads UTF-8 names correctly


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))


def parse_connections(path):
    """Find the header row (LinkedIn's export has a few 'Notes:' lines before it) and return (header, dict rows)."""
    rows = read_csv(path)
    if not any(any(c.strip() for c in r) for r in rows):
        raise Fail("%s is empty" % path)
    for i, r in enumerate(rows[:40]):
        if find_col(r, URL_NAMES):
            header = [h.strip() for h in r]
            out = []
            for data in rows[i + 1:]:
                if not any(c.strip() for c in data):
                    continue
                data = (data + [""] * len(header))[: len(header)]
                out.append(dict(zip(header, data)))
            if not out:
                raise Fail("%s has a header but no connection rows after it" % path)
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
    if not rows:
        raise Fail("%s is empty" % work)
    header = rows[0]
    data = [dict(zip(header, (r + [""] * len(header))[: len(header)])) for r in rows[1:]]
    with open(ledger, encoding="utf-8") as f:
        led = json.load(f)
    if not isinstance(led, dict) or "issues" not in led:
        raise Fail("%s is not a linkedin-emails ledger" % ledger)
    return header, data, led


def save_work(args, header, data, led):
    d, work, ledger = paths(args)
    atomic_write_many([(work, csv_text(header, data)), (ledger, json.dumps(led, indent=2, sort_keys=True) + "\n")])


def check_cap(n, approved):
    if n < 1:
        raise Fail("daily cap must be at least 1")
    if n > DEFAULT_CAP and not approved:
        raise Fail("a cap above %d needs the user's explicit OK; ask them, then pass --user-approved-raise" % DEFAULT_CAP)
    return n


def emit(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


# ---- ledger helpers ---------------------------------------------------------------------------------------

def used_24h(led, now):
    return sum(i["count"] for i in led["issues"] if in_window(i["at"], now))


def open_issue(led):
    return next((i for i in led["issues"] if i["status"] == "open"), None)


def active_stop(led, now):
    live = [s for s in led["stops"] if in_window(s["at"], now)]
    return max(live, key=lambda s: s["at"]) if live else None


# ---- init -------------------------------------------------------------------------------------------------

def cmd_init(args):
    d, work, ledger = paths(args)
    now = now_of(args)
    with locked(d):
        exists = os.path.exists(work)
        if exists and not args.force:
            raise Fail("%s already exists (progress would be lost); pass --force to start over" % work)
        old_led, old_by_vanity, backup = None, {}, None
        if exists:
            backup = "%s.bak-%s" % (work, now.strftime("%Y%m%dT%H%M%SZ"))
            shutil.copy2(work, backup)   # the old working copy is kept, never wiped
            if os.path.exists(ledger):
                with open(ledger, encoding="utf-8") as f:
                    old_led = json.load(f)
            old_rows = read_csv(work)
            if old_rows:
                oh = old_rows[0]
                for r in old_rows[1:]:
                    rec = dict(zip(oh, (r + [""] * len(oh))[: len(oh)]))
                    if rec.get("vanity"):
                        old_by_vanity[rec["vanity"].lower()] = rec
        cap = args.daily_cap if args.daily_cap is not None else (old_led or {}).get("daily_cap", DEFAULT_CAP)
        cap = check_cap(cap, args.user_approved_raise or bool(old_led and cap == old_led.get("daily_cap")))
        header, rows = parse_connections(args.csv)
        url_col = find_col(header, URL_NAMES)
        email_col = find_col(header, EMAIL_NAMES)
        if not email_col:
            email_col = "Email Address"
            header.append(email_col)
            for r in rows:
                r[email_col] = ""
        out_header = header + [c for c in ["vanity"] + CONTACT_COLS if c not in header]
        kept, by_vanity, dupes, unsafe = [], {}, 0, 0
        for r in rows:
            v, why = parse_vanity(r.get(url_col, ""))
            r["vanity"] = v
            for c in CONTACT_COLS:
                r.setdefault(c, "")
            if not v:
                r["contact_status"], r["contact_note"] = "no_url", why
                unsafe += why != "no /in/ URL"
                kept.append(r)
                continue
            first = by_vanity.get(v.lower())
            if first is None:
                by_vanity[v.lower()] = r
                prev = old_by_vanity.get(v.lower())
                if prev:   # carry earlier results over a --force restart
                    for c in CONTACT_COLS:
                        r[c] = prev.get(c, "")
                kept.append(r)
            else:
                dupes += 1
                for k, val in r.items():   # keep the first row, fill its blanks from the duplicate
                    if not (first.get(k) or "").strip() and (val or "").strip():
                        first[k] = val
        led = {"version": 2, "source": os.path.basename(args.csv), "email_column": email_col, "url_column": url_col,
               "created": ts(now), "daily_cap": cap, "issues": [], "merges": {}, "stops": []}
        if old_led:   # cap history survives a restart
            for k in ("issues", "merges", "stops"):
                led[k] = old_led.get(k, led[k])
        save_work(args, out_header, kept, led)
    emit({"working_dir": d, "working_copy": work, "backup": backup, "rows": len(kept), "duplicates_dropped": dupes,
          "no_url": sum(1 for r in kept if not r["vanity"]), "unsafe_vanity": unsafe,
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


def attempts_of(r):
    try:
        return int(r.get("contact_attempts") or 0)
    except ValueError:
        return 0


def pending(header, data, led, where, include_filled):
    email_col = led["email_column"]
    conds = compile_where(where, header)
    out = []
    for idx, r in enumerate(data):
        if not r["vanity"] or not decoded_ok(r["vanity"]) or r["contact_status"] in DONE:
            continue
        if r[email_col].strip() and not include_filled:
            continue
        if all(rx.search(r.get(col, "")) for col, rx in conds):
            out.append((r["contact_status"] == "error", idx, r))
    out.sort(key=lambda t: (t[0], t[1]))   # people who errored go to the back of the queue
    return [t[2] for t in out]


def cmd_next(args):
    d = paths(args)[0]
    with locked(d):
        header, data, led = load_work(args)
        now = now_of(args)
        cap = led["daily_cap"]
        changed = False
        if args.abandon_issue:
            for i in led["issues"]:
                if i["status"] == "open":
                    i["status"], i["abandoned_at"] = "abandoned", ts(now)   # still counts toward the cap
                    changed = True
        issue = open_issue(led)
        used = used_24h(led, now)
        rows = pending(header, data, led, args.where, args.include_filled)
        stop = active_stop(led, now)
        limit = max(0, min(args.limit, MAX_PER_RUN, max(cap - used, 0)))
        reason, batch, info = None, [], {}
        if issue:
            reason = "open_issue"
            info = {"open_issue": {"id": issue["id"], "count": issue["count"], "issued_at": issue["at"],
                                   "vanities": issue["vanities"]},
                    "hint": "merge its results.json, or rerun `next --abandon-issue` (the reserved count stays "
                            "against the cap)"}
        elif stop:
            reason = "stopped:" + stop["reason"]
            info = {"locked_until": ts(parse_ts(stop["at"]) + WINDOW)}
        elif used >= cap:
            reason = "daily_cap_reached"
        elif not rows:
            reason = "nothing_left"
        elif limit == 0:
            reason = "limit_zero"
        else:
            batch = rows[:limit]
            led["issues"].append({"id": "%s-%d" % (now.strftime("%Y%m%dT%H%M%SZ"), len(led["issues"]) + 1),
                                  "at": ts(now), "vanities": [r["vanity"] for r in batch], "count": len(batch),
                                  "status": "open"})
            changed = True
        if changed:
            save_work(args, header, data, led)
        used = used_24h(led, now)
        emit(dict({"vanities": [r["vanity"] for r in batch], "count": len(batch), "reason": reason,
                   "used_24h": used, "daily_cap": cap, "remaining_24h": max(cap - used, 0),
                   "matching_pending": len(rows)}, **info))


# ---- merge ------------------------------------------------------------------------------------------------

def load_results(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.loads(f.read().strip())
        if isinstance(data, str):   # console output saved as a quoted string
            data = json.loads(data)
    except json.JSONDecodeError as e:
        raise Fail("%s is not valid JSON (%s); save the exact output of contact_info.js" % (path, e))
    if isinstance(data, list):
        data = {"rows": data, "stopped_reason": None}
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
        raise Fail("%s must be the contact_info.js output ({rows: [...], stopped_reason})" % path)
    data["rows"] = [r for r in data["rows"] if isinstance(r, dict) and isinstance(r.get("vanity"), str)]
    return data


def clean_email(x):
    t = x.strip() if isinstance(x, str) else ""
    return t if len(t) <= 254 and re.fullmatch(r"[^\s@=+\-][^\s@]*@[^\s@]+", t) else ""


def clean_list(x):
    items = x if isinstance(x, list) else []
    return "; ".join(re.sub(r"[\x00-\x1f\x7f]", " ", str(i)).strip()[:200] for i in items[:5] if str(i).strip())


def settle_issues(led, vanities, now, no_request=False):
    """Match a merged run to the issues that reserved it: the count drops to what actually ran (no double count)."""
    left = {v.lower() for v in vanities}
    if no_request:   # the snippet refused before any request: nothing ran, so nothing stays reserved
        for i in led["issues"]:
            if i["status"] == "open":
                i["count"], i["status"], i["merged_at"] = 0, "merged", ts(now)
        return
    for i in led["issues"]:
        if i["status"] not in ("open", "abandoned"):
            continue
        hit = {v.lower() for v in i["vanities"]} & left
        if hit:
            i["count"], i["status"], i["merged_at"] = len(hit), "merged", ts(now)
            left -= hit
    if left:   # rows nobody reserved: still counted
        led["issues"].append({"id": "adhoc-%s-%d" % (now.strftime("%Y%m%dT%H%M%SZ"), len(led["issues"]) + 1),
                              "at": ts(now), "vanities": sorted(left), "count": len(left), "status": "merged",
                              "adhoc": True})


def cmd_merge(args):
    res = load_results(args.results)
    d = paths(args)[0]
    with locked(d):
        header, data, led = load_work(args)
        now = now_of(args)
        digest = hashlib.sha256(json.dumps(res, sort_keys=True).encode()).hexdigest()
        if digest in led["merges"]:
            emit({"already_merged": True, "merged_rows": 0, "stopped_reason": res.get("stopped_reason")})
            return
        by_vanity = {r["vanity"].lower(): r for r in data if r["vanity"]}
        updated = unknown = skipped = 0
        for row in res["rows"]:
            t = by_vanity.get(row["vanity"].lower())
            status = row.get("status")
            if t is None or status not in ("ok", "not_found", "error"):
                unknown += 1
                continue
            old = t["contact_status"]
            if status == "ok":
                email = clean_email(row.get("email")) or (t["contact_email"] if old == "ok" else "")
                t.update(contact_email=email, contact_phone=clean_list(row.get("phones")),
                         contact_website=clean_list(row.get("websites")), contact_status="ok",
                         contact_attempts="", contact_note="")
            elif old == "ok" or (status == "error" and old in DONE):
                skipped += 1   # never downgrade a finished row
                continue
            elif status == "not_found":
                t.update(contact_email="", contact_phone="", contact_website="", contact_status="not_found",
                         contact_note="")
            else:
                n = attempts_of(t) + 1
                t["contact_attempts"] = str(n)
                t["contact_status"] = "error_final" if n >= MAX_ATTEMPTS else "error"
                t["contact_note"] = re.sub(r"[^A-Za-z0-9_ :.-]", "", str(row.get("reason") or ""))[:60]
            t["contact_checked_at"] = ts(now)
            updated += 1
        stop = res.get("stopped_reason")
        settle_issues(led, [r["vanity"] for r in res["rows"]], now,
                      no_request=stop in ("no_session", "wrong_page") and not res["rows"])
        if stop and stop not in NO_LOCK_STOPS:
            led["stops"].append({"at": ts(now), "reason": str(stop)[:60]})
        led["merges"][digest] = ts(now)
        save_work(args, header, data, led)
        used = used_24h(led, now)
    emit({"merged_rows": updated, "ignored_rows": unknown, "kept_existing": skipped, "already_merged": False,
          "stopped_reason": stop, "used_24h": used, "daily_cap": led["daily_cap"],
          "note": {"decoration_rotated": "read the current decorationId from the Contact info request in the "
                                         "page's network tab and pass it as decorationId",
                   "no_session": "log into linkedin.com in the browser, then retry",
                   "wrong_page": "open a linkedin.com tab, then retry",
                   "already_running": "another run is live in that tab; wait for it"}.get(
              stop, "stop for 24 hours: do not run again until then; tell the user" if stop else None)})


# ---- status / export / cap --------------------------------------------------------------------------------

def best_email(r, email_col):
    return r[email_col].strip() or r["contact_email"].strip()


def defuse(s):
    """Spreadsheet formula guard: a leading = + - @ tab or CR gets a single quote in front."""
    return "'" + s if s and s[0] in "=+-@\t\r" else s


def cmd_status(args):
    header, data, led = load_work(args)
    now = now_of(args)
    ec = led["email_column"]
    checked = [r for r in data if r["contact_status"] in ("ok", "not_found")]
    with_contact = sum(1 for r in checked if r["contact_email"].strip())
    pend = pending(header, data, led, None, False)
    used = used_24h(led, now)
    stop = active_stop(led, now)
    count = lambda s: sum(1 for r in data if r["contact_status"] == s)
    emit({"total_rows": len(data),
          "with_export_email": sum(1 for r in data if r[ec].strip()),
          "checked": len(checked), "ok": count("ok"), "not_found": count("not_found"),
          "errors": count("error"), "error_final": count("error_final"), "no_url": count("no_url"),
          "with_contact_email": with_contact,
          "hit_rate": round(with_contact / len(checked), 3) if checked else None,
          "hit_rate_note": "contact emails found / profiles checked (ok + not_found)",
          "rows_with_any_email": sum(1 for r in data if best_email(r, ec)),
          "used_24h": used, "daily_cap": led["daily_cap"], "remaining_24h": max(led["daily_cap"] - used, 0),
          "open_issue": open_issue(led) is not None,
          "remaining_unchecked": len(pend),
          "stopped": stop and {"reason": stop["reason"], "locked_until": ts(parse_ts(stop["at"]) + WINDOW)}})


def cmd_export(args):
    d = paths(args)[0]
    with locked(d):
        header, data, led = load_work(args)
        ec = led["email_column"]
        out = args.out or os.path.join(d, "connections_with_emails.csv")
        cols = [h for h in header if h != "vanity"] + ["best_email"]
        rows = []
        for r in data:
            r = dict(r)
            r["best_email"] = best_email(r, ec)
            for c in CONTACT_COLS + ["best_email"]:
                r[c] = defuse(r.get(c, ""))
            rows.append(r)
        atomic_write(out, csv_text(cols, rows))
    emit({"written": out, "rows": len(rows), "with_best_email": sum(1 for r in rows if r["best_email"])})


def cmd_cap(args):
    with locked(paths(args)[0]):
        header, data, led = load_work(args)
        led["daily_cap"] = check_cap(args.n, args.user_approved_raise)
        save_work(args, header, data, led)
    emit({"daily_cap": led["daily_cap"]})


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--now", help=argparse.SUPPRESS)   # tests: pretend it is this UTC time (YYYY-MM-DDTHH:MM:SSZ)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, **kw):
        p = sub.add_parser(name, **kw)
        p.add_argument("--dir", default=None, help="working dir (default ./%s)" % DEFAULT_DIR)
        p.set_defaults(fn=fn)
        return p

    p = add("init", cmd_init, help="build the working copy and ledger")
    p.add_argument("csv")
    p.add_argument("--out", dest="dir", help="working dir (same as --dir)")
    p.add_argument("--daily-cap", type=int, default=None, help="default %d" % DEFAULT_CAP)
    p.add_argument("--user-approved-raise", action="store_true")
    p.add_argument("--force", action="store_true",
                   help="restart from a new CSV; the old working copy is backed up and the ledger history kept")
    p = add("next", cmd_next, help="print the next batch of vanities (reserves them against the cap)")
    p.add_argument("--limit", type=int, default=DEFAULT_RUN, help="default %d, max %d" % (DEFAULT_RUN, MAX_PER_RUN))
    p.add_argument("--where", action="append", metavar="COL=REGEX")
    p.add_argument("--include-filled", action="store_true", help="also re-check rows that already have an email")
    p.add_argument("--abandon-issue", action="store_true",
                   help="drop the unmerged batch from the previous `next` (it still counts toward the cap)")
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
    except (OSError, ValueError, csv.Error, KeyError) as e:
        print("error: %s: %s" % (type(e).__name__, e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
