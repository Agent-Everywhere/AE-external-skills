#!/usr/bin/env python3
"""find_people.py: ledger for classic LinkedIn people search (Python 3 stdlib only, no network).

  find_people.py init --keywords K [--network F,S] [--geo ID] [--extra QS] [--daily-cap N] [--force]
  find_people.py add-search --keywords K [--network F,S] [--geo ID] [--extra QS]
  find_people.py next-pages [--search sN] [--pages N] [--abandon-issue]
                                         JSON {"params": {...}} to feed search_people.js (reserves the cap)
  find_people.py merge <results.json>    write search_people.js output into the people list (dedupe by vanity)
  find_people.py status
  find_people.py export [--out FILE] [--where col=regex ...] [--emails-csv]
  find_people.py cap <N> [--user-approved-raise]

Working dir defaults to ./linkedin-find-people-work/ (--dir on any subcommand). It holds people.csv and ledger.json.
The cap counts search PAGES in a rolling 24 hours (default 10): free LinkedIn accounts also hit a monthly
"commercial use limit" on searches, so the cap is deliberately small. `next-pages` reserves what it issues and
`merge` settles it against what actually ran.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from li_common import (DAY, Fail, atomic_write, atomic_write_many, clean_text, compile_where, csv_text, defuse,  # noqa: E402
                       dump_json, emit, in_window, load_json, load_results_file, locked, now_of, parse_ts,
                       profile_url, read_dict_csv, run_main, safe_vanity, ts)

DEFAULT_DIR = "linkedin-find-people-work"
PEOPLE = "people.csv"
LEDGER = "ledger.json"
DEFAULT_CAP = 10
DEFAULT_RUN_PAGES = 3
MAX_RUN_PAGES = 5
LAST_PAGE = 100          # LinkedIn serves at most 100 result pages per search
PEOPLE_COLS = ["name", "headline", "location", "degree", "profile_url", "keywords", "found_at", "vanity"]
EXPORT_COLS = ["name", "headline", "location", "degree", "profile_url", "keywords", "found_at"]
# LinkedIn's own Connections.csv header, so the export can feed linkedin-emails' `emails.py init`.
EMAILS_COLS = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"]
DEGREES = {"1st", "2nd", "3rd+"}
# No lock for these: nothing was requested, or the search simply ran out of results.
NO_LOCK_STOPS = {"already_running", "wrong_page", "bad_params", "end_of_results", "no_results", "network_error"}
NOTES = {
    "end_of_results": "that search has no more pages; it is marked done",
    "no_results": "the search returned no people; check the keywords",
    "bad_params": "fix the params given to search_people.js",
    "wrong_page": "open a linkedin.com tab, then retry",
    "already_running": "another run is live in that tab; wait for it",
    "network_error": "a request failed before LinkedIn answered; the page was not read, retry later",
    "commercial_use_limit": "LinkedIn's monthly search limit for free accounts. Stop searching, tell the user, and do "
                            "not retry until LinkedIn lifts it (usually the next calendar month)",
}


# ---- inputs -----------------------------------------------------------------------------------------------

def parse_network(s):
    out = []
    for c in re.split(r"[\s,]+", (s or "").strip().upper()):
        if not c:
            continue
        if c not in ("F", "S", "O"):
            raise Fail("--network takes F (1st), S (2nd), O (3rd and beyond), e.g. F,S; got %r" % c)
        if c not in out:
            out.append(c)
    if not out:
        raise Fail("--network must list at least one of F, S, O")
    return out


def clean_geo(s):
    if s is None:
        return None
    m = re.fullmatch(r"(?:urn:li:fsd_geo:)?(\d{1,12})", s.strip())
    if not m:
        raise Fail("--geo takes a LinkedIn geo id such as 103644278 (or urn:li:fsd_geo:103644278)")
    return m.group(1)


EXTRA_OK = re.compile(r"[A-Za-z0-9_%.\-=&~+,:()'!\[\]*]*")
EXTRA_RESERVED = {"keywords", "network", "page", "geourn"}


def clean_extra(s):
    """Raw extra query string for other LinkedIn search filters. keywords/network/page/geoUrn cannot be overridden."""
    s = (s or "").strip().lstrip("?&")
    if not s:
        return ""
    if not EXTRA_OK.fullmatch(s):
        raise Fail("--extra holds characters a LinkedIn query string never needs; copy only the filter part of a "
                   "LinkedIn search URL")
    pairs = [p for p in s.split("&") if p and p.split("=", 1)[0].lower() not in EXTRA_RESERVED]
    return "&".join(pairs)


def new_search(args, sid):
    kw = clean_text(args.keywords, 200)
    if not kw:
        raise Fail("--keywords is required")
    return {"id": sid, "keywords": kw, "network": parse_network(args.network), "geo": clean_geo(args.geo),
            "extra": clean_extra(args.extra), "next_page": 1, "done": False, "pages_read": 0}


# ---- files ------------------------------------------------------------------------------------------------

def paths(args):
    d = args.dir or DEFAULT_DIR
    return d, os.path.join(d, PEOPLE), os.path.join(d, LEDGER)


def load_work(args):
    d, people, ledger = paths(args)
    if not os.path.exists(people) or not os.path.exists(ledger):
        raise Fail("no working dir in %s: run `find_people.py init --keywords ...` first" % d)
    _, rows = read_dict_csv(people)
    led = load_json(ledger)
    if not isinstance(led, dict) or "searches" not in led:
        raise Fail("%s is not a find_people ledger" % ledger)
    return rows, led


def save_work(args, rows, led):
    d, people, ledger = paths(args)
    atomic_write_many([(people, csv_text(PEOPLE_COLS, rows)), (ledger, dump_json(led))])


def check_cap(n, approved):
    if n < 1:
        raise Fail("daily cap must be at least 1")
    if n > DEFAULT_CAP and not approved:
        raise Fail("a cap above %d search pages a day needs the user's explicit OK; ask them, then pass "
                   "--user-approved-raise" % DEFAULT_CAP)
    return n


def used_24h(led, now):
    return sum(i["count"] for i in led["issues"] if in_window(i["at"], now))


def open_issue(led):
    return next((i for i in led["issues"] if i["status"] == "open"), None)


def active_stop(led, now):
    live = [s for s in led["stops"] if in_window(s["at"], now)]
    return max(live, key=lambda s: s["at"]) if live else None


def search_by_id(led, sid):
    s = next((x for x in led["searches"] if x["id"] == sid), None)
    if not s:
        raise Fail("no search %r; have: %s" % (sid, ", ".join(x["id"] for x in led["searches"])))
    return s


def params_of(s, page_from, pages):
    p = {"keywords": s["keywords"], "network": s["network"], "page_from": page_from, "pages": pages,
         "search": s["id"]}
    if s.get("geo"):
        p["geoUrn"] = s["geo"]
    if s.get("extra"):
        p["extra"] = s["extra"]
    return p


# ---- init / add-search ------------------------------------------------------------------------------------

def cmd_init(args):
    d, people, ledger = paths(args)
    now = now_of(args)
    with locked(d, "find_people.py"):
        exists = os.path.exists(people) or os.path.exists(ledger)
        if exists and not args.force:
            raise Fail("%s already holds a search (progress would be lost): use `add-search` for another keyword "
                       "set, or pass --force to start over" % d)
        rows, old, backups = [], None, []
        if exists:
            for p in (people, ledger):   # the old files are kept, never wiped
                if os.path.exists(p):
                    b = "%s.bak-%s" % (p, now.strftime("%Y%m%dT%H%M%SZ"))
                    shutil.copy2(p, b)
                    backups.append(b)
            if os.path.exists(people):
                rows = read_dict_csv(people)[1]
            if os.path.exists(ledger):
                old = load_json(ledger)
        cap = args.daily_cap if args.daily_cap is not None else (old or {}).get("daily_cap", DEFAULT_CAP)
        cap = check_cap(cap, args.user_approved_raise or bool(old and cap == old.get("daily_cap")))
        led = {"version": 1, "created": ts(now), "daily_cap": cap, "searches": [new_search(args, "s1")],
               "issues": [], "merges": {}, "stops": []}
        if old:   # cap history survives a restart
            for k in ("issues", "merges", "stops"):
                led[k] = old.get(k, led[k])
        save_work(args, rows, led)
    emit({"working_dir": d, "search": led["searches"][0], "daily_cap": cap, "kept_people": len(rows),
          "backups": backups})


def cmd_add_search(args):
    with locked(paths(args)[0], "find_people.py"):
        rows, led = load_work(args)
        s = new_search(args, "s%d" % (len(led["searches"]) + 1))
        led["searches"].append(s)
        save_work(args, rows, led)
    emit({"added": s, "searches": len(led["searches"])})


# ---- next-pages -------------------------------------------------------------------------------------------

def cmd_next_pages(args):
    with locked(paths(args)[0], "find_people.py"):
        rows, led = load_work(args)
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
        stop = active_stop(led, now)
        s = search_by_id(led, args.search) if args.search else next((x for x in led["searches"] if not x["done"]), None)
        pages = max(0, min(args.pages, MAX_RUN_PAGES, max(cap - used, 0), (LAST_PAGE - s["next_page"] + 1) if s else 0))
        reason, params, info = None, None, {}
        if issue:
            reason = "open_issue"
            info = {"open_issue": {"id": issue["id"], "search": issue["search"], "page_from": issue["page_from"],
                                   "pages": issue["pages"], "issued_at": issue["at"]},
                    "hint": "merge its results.json, or rerun `next-pages --abandon-issue` (the reserved pages "
                            "stay against the cap)"}
        elif stop:
            reason = "stopped:" + stop["reason"]
            info = {"locked_until": ts(parse_ts(stop["at"]) + DAY)}
        elif s is None or s["done"]:
            reason = "nothing_left"
        elif used >= cap:
            reason = "daily_cap_reached"
        elif pages == 0:
            reason = "nothing_left" if s["next_page"] > LAST_PAGE else "limit_zero"
        else:
            params = params_of(s, s["next_page"], pages)
            led["issues"].append({"id": "%s-%d" % (now.strftime("%Y%m%dT%H%M%SZ"), len(led["issues"]) + 1),
                                  "at": ts(now), "search": s["id"], "page_from": s["next_page"], "pages": pages,
                                  "count": pages, "status": "open"})
            changed = True
        if changed:
            save_work(args, rows, led)
        used = used_24h(led, now)
        emit(dict({"params": params, "count": params["pages"] if params else 0, "reason": reason,
                   "used_24h": used, "daily_cap": cap, "remaining_24h": max(cap - used, 0)}, **info))


# ---- merge ------------------------------------------------------------------------------------------------

def match_search(led, req):
    req = req if isinstance(req, dict) else {}
    sid = req.get("search")
    if isinstance(sid, str) and any(x["id"] == sid for x in led["searches"]):
        return search_by_id(led, sid)
    kw = clean_text(req.get("keywords"), 200)
    net = req.get("network") if isinstance(req.get("network"), list) else ["F", "S"]
    for x in led["searches"]:
        if x["keywords"] == kw and x["network"] == net:
            return x
    raise Fail("these results do not match any search in the ledger (keywords %r); run `next-pages` and use its "
               "params unchanged" % kw)


def int_of(x, default=0):
    return x if isinstance(x, int) and not isinstance(x, bool) and x >= 0 else default


def clean_row(r):
    v = safe_vanity(r.get("vanity")) if isinstance(r, dict) else ""
    if not v:
        return None
    deg = r.get("degree")
    return {"vanity": v, "name": clean_text(r.get("name"), 120), "headline": clean_text(r.get("headline"), 300),
            "location": clean_text(r.get("location"), 120), "degree": deg if deg in DEGREES else ""}


def cmd_merge(args):
    res = load_results_file(args.results, "search_people.js")
    if not isinstance(res.get("rows"), list):
        raise Fail("%s must be the search_people.js output ({rows: [...], pages_read, stopped_reason})" % args.results)
    with locked(paths(args)[0], "find_people.py"):
        rows, led = load_work(args)
        now = now_of(args)
        digest = hashlib.sha256(json.dumps(res, sort_keys=True).encode()).hexdigest()
        stop = res.get("stopped_reason")
        if digest in led["merges"]:
            emit({"already_merged": True, "added": 0, "stopped_reason": stop})
            return
        s = match_search(led, res.get("request"))
        by_vanity = {r["vanity"].lower(): r for r in rows}
        added = known = ignored = 0
        for raw in res["rows"]:
            r = clean_row(raw)
            if not r:
                ignored += 1
                continue
            cur = by_vanity.get(r["vanity"].lower())
            if cur is None:
                r.update(profile_url=profile_url(r["vanity"]), keywords=s["keywords"], found_at=ts(now))
                rows.append(r)
                by_vanity[r["vanity"].lower()] = r
                added += 1
                continue
            known += 1
            kws = [k for k in cur["keywords"].split("; ") if k]
            if s["keywords"] not in kws:
                kws.append(s["keywords"])
            cur["keywords"] = "; ".join(kws)
            for k in ("name", "headline", "location", "degree"):
                if not cur[k] and r[k]:
                    cur[k] = r[k]
        read = int_of(res.get("pages_read"))
        attempted = max(int_of(res.get("pages_attempted"), read), read)
        page_from = int_of((res.get("request") or {}).get("page_from"), s["next_page"]) or s["next_page"]
        mine = [i for i in led["issues"] if i["status"] in ("open", "abandoned") and i["search"] == s["id"]
                and i["page_from"] == page_from]
        if mine:
            mine[0].update(count=attempted, status="merged", merged_at=ts(now))
        elif attempted:   # pages nobody reserved: still counted
            led["issues"].append({"id": "adhoc-%s-%d" % (now.strftime("%Y%m%dT%H%M%SZ"), len(led["issues"]) + 1),
                                  "at": ts(now), "search": s["id"], "page_from": page_from, "pages": attempted,
                                  "count": attempted, "status": "merged", "adhoc": True})
        s["pages_read"] += read
        s["next_page"] = max(s["next_page"], page_from + read)
        if stop in ("end_of_results", "no_results") or s["next_page"] > LAST_PAGE:
            s["done"] = True
        if stop and stop not in NO_LOCK_STOPS:
            led["stops"].append({"at": ts(now), "reason": str(stop)[:60]})
        led["merges"][digest] = ts(now)
        save_work(args, rows, led)
        used = used_24h(led, now)
    emit({"added": added, "already_known": known, "ignored_rows": ignored, "total_people": len(rows),
          "search": s["id"], "pages_read": read, "next_page": s["next_page"], "search_done": s["done"],
          "already_merged": False, "stopped_reason": stop, "used_24h": used, "daily_cap": led["daily_cap"],
          "note": NOTES.get(stop, "stop for 24 hours: do not run again until then; tell the user" if stop else None)})


# ---- status / export / cap --------------------------------------------------------------------------------

def cmd_status(args):
    rows, led = load_work(args)
    now = now_of(args)
    used = used_24h(led, now)
    stop = active_stop(led, now)
    by_degree = {}
    for r in rows:
        by_degree[r["degree"] or "unknown"] = by_degree.get(r["degree"] or "unknown", 0) + 1
    emit({"people": len(rows), "by_degree": by_degree,
          "searches": [{k: s[k] for k in ("id", "keywords", "network", "next_page", "pages_read", "done")}
                       for s in led["searches"]],
          "used_24h": used, "daily_cap": led["daily_cap"], "remaining_24h": max(led["daily_cap"] - used, 0),
          "open_issue": open_issue(led) is not None,
          "stopped": stop and {"reason": stop["reason"], "locked_until": ts(parse_ts(stop["at"]) + DAY)}})


def cmd_export(args):
    d = paths(args)[0]
    with locked(d, "find_people.py"):
        rows, led = load_work(args)
        conds = compile_where(args.where, EXPORT_COLS)
        keep = [r for r in rows if all(rx.search(r.get(c, "")) for c, rx in conds)]
        if args.emails_csv:
            cols, out_rows = EMAILS_COLS, []
            for r in keep:
                first, _, last = (r["name"] or "").partition(" ")
                out_rows.append({"First Name": first, "Last Name": last, "URL": r["profile_url"],
                                 "Email Address": "", "Company": "", "Position": r["headline"],
                                 "Connected On": ""})
            default = "people_for_linkedin_emails.csv"
        else:
            cols, out_rows, default = EXPORT_COLS, [dict(r) for r in keep], "people.export.csv"
        out_rows = [{c: defuse(r.get(c, "")) for c in cols} for r in out_rows]
        out = args.out or os.path.join(d, default)
        atomic_write(out, csv_text(cols, out_rows))
    emit({"written": out, "rows": len(out_rows), "of": len(rows)})


def cmd_cap(args):
    with locked(paths(args)[0], "find_people.py"):
        rows, led = load_work(args)
        led["daily_cap"] = check_cap(args.n, args.user_approved_raise)
        save_work(args, rows, led)
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

    def search_args(p):
        p.add_argument("--keywords", required=True)
        p.add_argument("--network", default="F,S", help="F=1st S=2nd O=3rd+ (default F,S)")
        p.add_argument("--geo", default=None, help="LinkedIn geo id (optional)")
        p.add_argument("--extra", default=None, help="raw query string for other LinkedIn search filters")

    p = add("init", cmd_init, help="start a working dir with the first search")
    search_args(p)
    p.add_argument("--daily-cap", type=int, default=None, help="search pages per rolling 24h, default %d" % DEFAULT_CAP)
    p.add_argument("--user-approved-raise", action="store_true")
    p.add_argument("--force", action="store_true", help="restart; old files are backed up, people and cap history kept")
    p = add("add-search", cmd_add_search, help="add another keyword set to the same people list")
    search_args(p)
    p = add("next-pages", cmd_next_pages, help="print the params for the next search_people.js run (reserves pages)")
    p.add_argument("--search", default=None, help="search id such as s1 (default: first unfinished)")
    p.add_argument("--pages", type=int, default=DEFAULT_RUN_PAGES,
                   help="default %d, max %d" % (DEFAULT_RUN_PAGES, MAX_RUN_PAGES))
    p.add_argument("--abandon-issue", action="store_true",
                   help="drop the unmerged run from the previous call (it still counts toward the cap)")
    p = add("merge", cmd_merge, help="merge search_people.js output")
    p.add_argument("results")
    add("status", cmd_status, help="people found, searches, cap use")
    p = add("export", cmd_export, help="write the people CSV")
    p.add_argument("--out")
    p.add_argument("--where", action="append", metavar="COL=REGEX", help="for example headline=realtor|loan officer")
    p.add_argument("--emails-csv", action="store_true",
                   help="write LinkedIn's Connections.csv header so linkedin-emails can read it (use on 1st-degree rows)")
    p = add("cap", cmd_cap, help="change the search pages per rolling 24h")
    p.add_argument("n", type=int)
    p.add_argument("--user-approved-raise", action="store_true")
    return ap


def main(argv=None):
    return run_main(build_parser, argv)


if __name__ == "__main__":
    sys.exit(main())
