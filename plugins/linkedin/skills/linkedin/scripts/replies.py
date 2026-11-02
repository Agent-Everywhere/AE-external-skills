#!/usr/bin/env python3
"""replies.py: poll ledger for who accepted and who replied on classic LinkedIn (stdlib only, no network).

  replies.py next [--abandon-issue]        JSON {"params": {...}} for poll.js; reserves one of the 4 polls a day
  replies.py merge <poll.json> [--outreach-dir DIR]
                                           record poll.js output; moves matching people in the outreach ledger
                                           to connected / replied
  replies.py status

Working dir defaults to ./linkedin-replies-work/ (--dir on any subcommand): ledger.json with the last-seen cursors
(newest connection time, newest conversation activity) and the poll history. The outreach ledger is
./linkedin-outreach-work/ledger.json unless --outreach-dir says otherwise; if it does not exist, only the cursors
are kept. Message text is never stored here. Caps: 4 polls in a rolling 24 hours, at least 60 minutes apart.
"""
import argparse
import datetime
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import outreach  # noqa: E402
from li_common import (DAY, Fail, atomic_write, clean_text, dump_json, emit, in_window, load_json,  # noqa: E402
                       load_results_file, locked, now_of, parse_ts, run_main, safe_vanity, ts)

DEFAULT_DIR = "linkedin-replies-work"
LEDGER = "ledger.json"
POLLS_PER_DAY = 4
MIN_GAP = datetime.timedelta(minutes=60)
PAGE = 10
# No lock for these: nothing reached LinkedIn, or the fix is on our side.
NO_LOCK_STOPS = {"already_running", "wrong_page", "no_session", "queryid_not_found", "bad_params", "network_error",
                 "decoration_rotated", "queryid_rotated", "me_not_found"}
NOTES = {
    "queryid_not_found": "open linkedin.com/messaging once in the tab so the page makes its own request, then poll again",
    "no_session": "log into linkedin.com in the browser, then retry",
    "wrong_page": "open a linkedin.com tab, then retry",
    "already_running": "another run is live in that tab; wait for it",
    "decoration_rotated": "read the current connections decorationId from the page's own request, then poll again later",
    "queryid_rotated": "open linkedin.com/messaging once, read the current queryId from the page's requests, then poll again",
}


def paths(args):
    d = args.dir or DEFAULT_DIR
    return d, os.path.join(d, LEDGER)


def load_work(args):
    d, p = paths(args)
    if os.path.exists(p):
        led = load_json(p)
        if not isinstance(led, dict) or "polls" not in led:
            raise Fail("%s is not a replies ledger" % p)
        return led
    return {"version": 1, "polls": [], "stops": [], "merges": {},
            "connections": {"since": 0, "candidate": 0, "resume_start": 0}, "conversations_at": 0,
            "accepted": {}, "replied": {}}


def save_work(args, led):
    d, p = paths(args)
    atomic_write(p, dump_json(led))


def used_24h(led, now):
    return sum(1 for x in led["polls"] if x.get("counts", True) and in_window(x["at"], now))


def active_stop(led, now):
    live = [s for s in led["stops"] if in_window(s["at"], now)]
    return max(live, key=lambda s: s["at"]) if live else None


# ---- next -------------------------------------------------------------------------------------------------

def cmd_next(args):
    with locked(paths(args)[0], "replies.py"):
        led = load_work(args)
        now = now_of(args)
        changed = False
        if args.abandon_issue:
            for x in led["polls"]:
                if x["status"] == "open":
                    x["status"], x["abandoned_at"] = "abandoned", ts(now)   # still counts toward the cap
                    changed = True
        openp = next((x for x in led["polls"] if x["status"] == "open"), None)
        used = used_24h(led, now)
        stop = active_stop(led, now)
        last = max((parse_ts(x["at"]) for x in led["polls"] if x.get("counts", True)), default=None)
        reason, params, info = None, None, {}
        if openp:
            reason = "open_issue"
            info = {"hint": "merge its poll.json, or rerun `next --abandon-issue` (the poll stays counted)"}
        elif stop:
            reason = "stopped:" + stop["reason"]
            info = {"locked_until": ts(parse_ts(stop["at"]) + DAY)}
        elif used >= POLLS_PER_DAY:
            reason = "daily_cap_reached"
        elif last and now - last < MIN_GAP:
            reason = "too_soon"
            info = {"next_poll_after": ts(last + MIN_GAP), "hint": "poll at uneven times, at least 60 minutes apart"}
        else:
            c = led["connections"]
            params = {"since": c["since"], "start": c["resume_start"], "conversationsSince": led["conversations_at"]}
            led["polls"].append({"id": "%s-%d" % (now.strftime("%Y%m%dT%H%M%SZ"), len(led["polls"]) + 1),
                                 "at": ts(now), "status": "open"})
            changed = True
        if changed:
            save_work(args, led)
        used = used_24h(led, now)
        emit(dict({"params": params, "reason": reason, "used_24h": used, "daily_cap": POLLS_PER_DAY,
                   "remaining_24h": max(POLLS_PER_DAY - used, 0)}, **info))


# ---- merge ------------------------------------------------------------------------------------------------

def int_ms(x):
    return x if isinstance(x, int) and not isinstance(x, bool) and x > 0 else 0


def clean_member(x):
    x = clean_text(x, 60) if isinstance(x, str) else ""
    return x if x and all(c.isalnum() or c in "-_" for c in x) else ""


def clean_rows(rows, keys):
    out = []
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue
        v, m = safe_vanity(r.get("vanity")), clean_member(r.get("member"))
        if not (v or m):
            continue
        row = {"vanity": v, "member": m}
        for k in keys:
            row[k] = int_ms(r.get(k))
        out.append(row)
    return out


def find_person(out_led, row):
    people = out_led["people"]
    if row["vanity"] and row["vanity"].lower() in people:
        return people[row["vanity"].lower()]
    if row["member"]:
        return next((p for p in people.values() if p.get("member") == row["member"]), None)
    return None


def apply_to_outreach(out_led, accepted, replied, now):
    c = {"accepted_applied": 0, "accepted_not_pending": 0, "replied_applied": 0, "replied_not_in_flight": 0,
         "unmatched": 0, "newly_connected": [], "newly_replied": []}
    unresolved = []
    for kind, rows, stamp in (("accepted", accepted, "connectedAt"), ("replied", replied, "lastMessageAt")):
        for r in rows:
            p = find_person(out_led, r)
            if not p:
                c["unmatched"] += 1
                if not r["vanity"] and len(unresolved) < 20:
                    unresolved.append({"member": r["member"], "kind": kind})
                continue
            if r["member"] and not p.get("member"):
                p["member"] = r["member"]
            when = ts(datetime.datetime.fromtimestamp(r[stamp] / 1000, datetime.timezone.utc).replace(tzinfo=None)) \
                if r[stamp] else ts(now)
            if kind == "accepted":
                if p["state"] == "pending":
                    p["state"], p["accepted_at"] = "connected", when
                    c["accepted_applied"] += 1
                    c["newly_connected"].append(p["vanity"])
                else:
                    c["accepted_not_pending"] += 1
            elif p["state"] in ("pending", "connected", "messaged"):
                p["state"], p["replied_at"] = "replied", when
                c["replied_applied"] += 1
                c["newly_replied"].append(p["vanity"])
            else:
                c["replied_not_in_flight"] += 1
    return c, unresolved


def cmd_merge(args):
    res = load_results_file(args.results, "poll.js")
    if not any(k in res for k in ("accepted", "pending", "replied", "stopped_reason")):
        raise Fail("%s must be the poll.js output ({accepted, pending, replied, stopped_reason})" % args.results)
    accepted = clean_rows(res.get("accepted"), ("connectedAt",))
    replied = clean_rows(res.get("replied"), ("lastMessageAt",))
    pending = clean_rows(res.get("pending"), ("sentAt",))
    cursor = res.get("cursor") if isinstance(res.get("cursor"), dict) else {}
    stop = res.get("stopped_reason")
    with locked(paths(args)[0], "replies.py"):
        led = load_work(args)
        now = now_of(args)
        digest = hashlib.sha256(json.dumps(res, sort_keys=True).encode()).hexdigest()
        if digest in led["merges"]:
            emit({"already_merged": True, "stopped_reason": stop})
            return
        out_dir = args.outreach_dir or outreach.DEFAULT_DIR
        counts, unresolved, out_found = None, [], os.path.exists(outreach.ledger_path(out_dir))
        if out_found:
            with locked(out_dir, "outreach.py"):
                out_led = outreach.load_ledger(out_dir)
                counts, unresolved = apply_to_outreach(out_led, accepted, replied, now)
                outreach.save_ledger(out_dir, out_led)
        for r in accepted:
            led["accepted"].setdefault(r["vanity"] or "member:" + r["member"], ts(now))
        for r in replied:
            led["replied"][r["vanity"] or "member:" + r["member"]] = {"last_message_at": r["lastMessageAt"]}
        c = led["connections"]
        start = int_ms((res.get("request") or {}).get("start")) if isinstance(res.get("request"), dict) else 0
        c["candidate"] = max(c["candidate"], int_ms(cursor.get("connectedAt")))
        if res.get("has_more_connections"):
            c["resume_start"] = start + PAGE
        else:
            c["since"], c["candidate"], c["resume_start"] = max(c["since"], c["candidate"]), 0, 0
        led["conversations_at"] = max(led["conversations_at"], int_ms(cursor.get("conversationsAt")))
        # a snippet that refused before any request (not signed in, wrong tab, already running, no queryId) used no poll
        ran = not (stop in ("no_session", "wrong_page", "already_running", "bad_params", "queryid_not_found")
                   and not (accepted or replied or pending))
        done = next((x for x in led["polls"] if x["status"] in ("open", "abandoned")), None)
        if done:
            done.update(status="merged", merged_at=ts(now), counts=ran)
        elif ran:
            led["polls"].append({"id": "adhoc-%s-%d" % (now.strftime("%Y%m%dT%H%M%SZ"), len(led["polls"]) + 1),
                                 "at": ts(now), "status": "merged", "adhoc": True})
        if stop and stop not in NO_LOCK_STOPS:
            led["stops"].append({"at": ts(now), "reason": str(stop)[:60]})
        led["merges"][digest] = ts(now)
        save_work(args, led)
        used = used_24h(led, now)
    emit({"already_merged": False, "accepted": len(accepted), "pending": len(pending), "replied": len(replied),
          "outreach_ledger": out_found, "outreach_updates": counts, "unresolved_members": unresolved,
          "more_connections_to_read": bool(res.get("has_more_connections")), "stopped_reason": stop,
          "used_24h": used, "daily_cap": POLLS_PER_DAY,
          "note": NOTES.get(stop, "stop for 24 hours: do not run again until then; tell the user" if stop else None)})


# ---- status -----------------------------------------------------------------------------------------------

def cmd_status(args):
    led = load_work(args)
    now = now_of(args)
    used = used_24h(led, now)
    stop = active_stop(led, now)
    last = max((x["at"] for x in led["polls"]), default=None)
    emit({"polls_24h": used, "daily_cap": POLLS_PER_DAY, "remaining_24h": max(POLLS_PER_DAY - used, 0),
          "last_poll": last, "connections_since_ms": led["connections"]["since"],
          "conversations_since_ms": led["conversations_at"], "accepted_seen": len(led["accepted"]),
          "replied_seen": len(led["replied"]),
          "open_poll": any(x["status"] == "open" for x in led["polls"]),
          "stopped": stop and {"reason": stop["reason"], "locked_until": ts(parse_ts(stop["at"]) + DAY)}})


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--now", help=argparse.SUPPRESS)   # tests: pretend it is this UTC time (YYYY-MM-DDTHH:MM:SSZ)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, **kw):
        p = sub.add_parser(name, **kw)
        p.add_argument("--dir", default=None, help="working dir (default ./%s)" % DEFAULT_DIR)
        p.set_defaults(fn=fn)
        return p

    p = add("next", cmd_next, help="print the params for the next poll.js run (reserves a poll)")
    p.add_argument("--abandon-issue", action="store_true",
                   help="drop the unmerged poll from the previous call (it still counts toward the cap)")
    p = add("merge", cmd_merge, help="merge poll.js output and update the outreach ledger")
    p.add_argument("results")
    p.add_argument("--outreach-dir", default=None, help="default ./%s" % outreach.DEFAULT_DIR)
    add("status", cmd_status, help="poll count and cursors")
    return ap


def main(argv=None):
    return run_main(build_parser, argv)


if __name__ == "__main__":
    sys.exit(main())
