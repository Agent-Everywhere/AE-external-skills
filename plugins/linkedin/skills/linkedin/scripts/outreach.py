#!/usr/bin/env python3
"""outreach.py: drafts, caps and ledger for classic LinkedIn connection requests and messages (stdlib only, no network).

  outreach.py init <csv> [--new-account] [--force]    people from any CSV with a LinkedIn URL column
  outreach.py draft --kind connect|message --template FILE [--where col=regex ...] [--limit N]
  outreach.py batch --kind connect|message --limit N [--retry-failed] [--abandon-batch]
                                                      prints the EXACT batch for approval and reserves it
  outreach.py approve --typed "approve N"             records the user's typed approval of the open batch
  outreach.py record <vanity> --status sent|skipped|failed [--note TEXT] [--member ID]   after each UI send
  outreach.py stop --reason R                         lock sending for 24 hours (limit banner, captcha, 429...)
  outreach.py account --new-account | --established   halve (or restore) the caps
  outreach.py status | export [--out FILE]

This script never sends anything. Every send is a human-approved click in the LinkedIn UI; `record` only writes down
what happened. Working dir defaults to ./linkedin-outreach-work/ (--dir on any subcommand): ledger.json.
Caps (rolling windows): 20 connection requests per 24h and 100 per 7 days, 40 messages per 24h, 3 messages per
person, one connection request per person. A new or long-idle account runs at half for two weeks (--new-account).
Reservation: `batch` counts its people against the caps at once; `record sent` and `failed` keep them counted,
`skipped` gives the slot back, and an abandoned batch keeps its unrecorded people counted.
"""
import argparse
import datetime
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from li_common import (DAY, WEEK, Fail, atomic_write, atomic_write_many, clean_text, compile_where, csv_text,  # noqa: E402
                       defuse, dump_json, emit, find_col, in_window, load_json, locked, norm_key, now_of,
                       parse_ts, parse_vanity, profile_url, read_csv, run_main, ts)

DEFAULT_DIR = "linkedin-outreach-work"
LEDGER = "ledger.json"
CONNECT_DAY = 20
CONNECT_WEEK = 100
MESSAGE_DAY = 40
PER_PERSON_MESSAGES = 3
NEW_ACCOUNT_DAYS = 14
CONNECT_MAX = 300
MESSAGE_MAX = 8000
DEFAULT_BATCH = 10
COUNTED = ("sent", "failed", "abandoned")     # event statuses that use up a cap
URL_KEYS = ["url", "linkedin_url", "linkedin_profile_url", "profile_url", "linkedin", "linkedin_link",
            "person_linkedin_url", "linkedin_profile"]
STATES = ("new", "pending", "connected", "messaged", "replied")


# ---- ledger -----------------------------------------------------------------------------------------------

def ledger_path(d):
    return os.path.join(d, LEDGER)


def load_ledger(d):
    p = ledger_path(d)
    if not os.path.exists(p):
        raise Fail("no outreach ledger in %s: run `outreach.py init <people.csv>` first" % d)
    led = load_json(p)
    if not isinstance(led, dict) or "people" not in led:
        raise Fail("%s is not an outreach ledger" % p)
    return led


def save_ledger(d, led):
    atomic_write(ledger_path(d), dump_json(led))


def dir_of(args):
    return args.dir or DEFAULT_DIR


# ---- caps -------------------------------------------------------------------------------------------------

def is_new_account(led, now):
    u = led.get("new_account_until")
    return bool(u) and now < parse_ts(u)


def limits(led, now):
    half = is_new_account(led, now)
    f = (lambda n: n // 2) if half else (lambda n: n)
    return {"connect_day": f(CONNECT_DAY), "connect_week": f(CONNECT_WEEK), "message_day": f(MESSAGE_DAY),
            "per_person_messages": PER_PERSON_MESSAGES, "new_account_half": half}


def open_batch(led):
    b = led.get("batch")
    return b if b and b.get("status") == "open" else None


def used(led, kind, now, window):
    n = sum(1 for e in led["events"] if e["kind"] == kind and e["status"] in COUNTED and in_window(e["at"], now, window))
    b = open_batch(led)
    if b and b["kind"] == kind and in_window(b["at"], now, window):
        n += sum(1 for it in b["items"] if it["status"] is None)
    return n


def messages_to(led, vanity):
    low = vanity.lower()
    n = sum(1 for e in led["events"] if e["kind"] == "message" and e["status"] in COUNTED and e["vanity"].lower() == low)
    b = open_batch(led)
    if b and b["kind"] == "message":
        n += sum(1 for it in b["items"] if it["status"] is None and it["vanity"].lower() == low)
    return n


def has_connect_event(led, vanity, statuses=COUNTED + ("skipped",)):
    low = vanity.lower()
    return any(e["kind"] == "connect" and e["vanity"].lower() == low and e["status"] in statuses for e in led["events"])


def active_stop(led, now):
    live = [s for s in led["stops"] if in_window(s["at"], now)]
    return max(live, key=lambda s: s["at"]) if live else None


def remaining(led, kind, now):
    lim = limits(led, now)
    if kind == "connect":
        day = lim["connect_day"] - used(led, "connect", now, DAY)
        week = lim["connect_week"] - used(led, "connect", now, WEEK)
        return max(min(day, week), 0), {"day": max(day, 0), "week": max(week, 0)}
    day = lim["message_day"] - used(led, "message", now, DAY)
    return max(day, 0), {"day": max(day, 0)}


# ---- init -------------------------------------------------------------------------------------------------

def parse_people_csv(path):
    """Find the header row (LinkedIn's export has a few 'Notes:' lines before it); return list of field dicts."""
    rows = read_csv(path)
    for i, r in enumerate(rows[:40]):
        keys = [norm_key(h) for h in r]
        col = next((k for k in URL_KEYS if k in keys), None)
        if col is None:
            continue
        out = []
        for data in rows[i + 1:]:
            if not any(c.strip() for c in data):
                continue
            data = (data + [""] * len(keys))[: len(keys)]
            rec = {}
            for k, v in zip(keys, data):
                if k and k not in rec:
                    rec[k] = clean_text(v, 300)
            out.append((rec, rec.get(col, "")))
        if not out:
            raise Fail("%s has a header but no people after it" % path)
        return col, out
    raise Fail("no header row with a LinkedIn URL column (url, linkedin_url, profile_url...) found in %s" % path)


def derive(f):
    name = f.get("name", "")
    if not f.get("first_name") and name:
        f["first_name"] = name.split(" ", 1)[0]
    if not f.get("last_name") and " " in name:
        f["last_name"] = name.split(" ", 1)[1]
    if not name and f.get("first_name"):
        f["name"] = ("%s %s" % (f["first_name"], f.get("last_name", ""))).strip()
    if not f.get("headline") and f.get("position"):
        f["headline"] = f["position"]
    if not f.get("position") and f.get("headline"):
        f["position"] = f["headline"]
    if not f.get("degree") and f.get("connected_on"):
        f["degree"] = "1st"   # LinkedIn's Connections.csv (and the linkedin-emails copy) lists only 1st-degree people
    return f


def cmd_init(args):
    d = dir_of(args)
    now = now_of(args)
    with locked(d, "outreach.py"):
        exists = os.path.exists(ledger_path(d))
        if exists and not args.force:
            raise Fail("%s already exists (progress would be lost); pass --force to start over" % ledger_path(d))
        old, backup = None, None
        if exists:
            old = load_ledger(d)
            backup = "%s.bak-%s" % (ledger_path(d), now.strftime("%Y%m%dT%H%M%SZ"))
            atomic_write(backup, dump_json(old))
        col, rows = parse_people_csv(args.csv)
        people, dupes, no_url = {}, 0, 0
        for rec, url in rows:
            v, _ = parse_vanity(url)
            if not v:
                no_url += 1
                continue
            rec = derive(rec)
            cur = people.get(v.lower())
            if cur:
                dupes += 1
                for k, val in rec.items():
                    if val and not cur["fields"].get(k):
                        cur["fields"][k] = val
                continue
            prev = (old or {}).get("people", {}).get(v.lower())
            if prev:   # progress carries over a --force restart
                rec_state = {k: prev.get(k) for k in ("state", "member", "accepted_at", "replied_at") if prev.get(k)}
            else:
                rec_state = {}
            p = {"vanity": v, "fields": rec, "state": "new", "member": None, "accepted_at": None,
                 "replied_at": None, "n": len(people)}   # n keeps the CSV order (the ledger file sorts its keys)
            p.update(rec_state)
            people[v.lower()] = p
        led = {"version": 1, "created": ts(now), "source": os.path.basename(args.csv), "url_column": col,
               "new_account_until": ts(now + datetime.timedelta(days=NEW_ACCOUNT_DAYS)) if args.new_account else
               (old or {}).get("new_account_until"),
               "people": people, "drafts": {"connect": {}, "message": {}}, "events": [], "batch": None, "stops": []}
        if old:   # cap history and drafts survive a restart
            for k in ("events", "batch", "stops", "drafts"):
                led[k] = old.get(k, led[k])
        save_ledger(d, led)
    emit({"working_dir": d, "people": len(people), "duplicates_dropped": dupes, "no_url": no_url, "backup": backup,
          "new_account_half_caps_until": led["new_account_until"] if is_new_account(led, now) else None,
          "fields_available_for_templates": sorted({k for p in people.values() for k, v in p["fields"].items() if v})})


# ---- draft ------------------------------------------------------------------------------------------------

PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def eligible_to_draft(led, p, kind, retry_failed=False):
    """None when the person may be drafted or batched for this kind, else the reason they may not."""
    v = p["vanity"]
    if kind == "connect":
        if p["state"] != "new" or p["fields"].get("degree") == "1st":
            return "not a new, non-1st-degree person"
        blocking = tuple(s for s in COUNTED + ("skipped",) if not (retry_failed and s == "failed"))
        if has_connect_event(led, v, blocking):
            return "already invited"
        return None
    if p["state"] == "replied":
        return "already replied"
    if p["fields"].get("degree") != "1st" and p["state"] not in ("connected", "messaged"):
        return "not known to be a 1st-degree connection"
    if messages_to(led, v) >= PER_PERSON_MESSAGES:
        return "already messaged %d times" % PER_PERSON_MESSAGES
    return None


def in_order(led):
    return sorted(led["people"].values(), key=lambda p: p.get("n", 0))


def in_open_batch(led, vanity):
    b = open_batch(led)
    return bool(b) and any(it["vanity"].lower() == vanity.lower() and it["status"] is None for it in b["items"])


def cmd_draft(args):
    d = dir_of(args)
    try:
        with open(args.template, encoding="utf-8") as f:
            template = f.read().strip()
    except OSError as e:
        raise Fail("cannot read template %s: %s" % (args.template, e))
    if not template:
        raise Fail("the template is empty")
    now = now_of(args)
    with locked(d, "outreach.py"):
        led = load_ledger(d)
        known = {k for p in led["people"].values() for k, v in p["fields"].items() if v}
        unknown = sorted({m for m in PLACEHOLDER.findall(template) if m not in known})
        if unknown:
            raise Fail("unknown placeholder(s) %s; available: %s" % (", ".join("{%s}" % u for u in unknown),
                                                                      ", ".join(sorted(known))))
        columns = sorted(known)
        conds = compile_where(args.where, columns)
        cap = CONNECT_MAX if args.kind == "connect" else MESSAGE_MAX
        drafted, ineligible, problems, samples = 0, {}, [], []
        for p in in_order(led):
            if args.limit is not None and drafted >= args.limit:
                break
            if not all(rx.search(p["fields"].get(c, "")) for c, rx in conds):
                continue
            why = eligible_to_draft(led, p, args.kind)
            if why:
                ineligible[why] = ineligible.get(why, 0) + 1
                continue
            if in_open_batch(led, p["vanity"]):
                continue   # its text is frozen until the open batch is closed
            missing = sorted({m for m in PLACEHOLDER.findall(template) if not p["fields"].get(m)})
            if missing:
                problems.append({"vanity": p["vanity"], "reason": "missing " + ", ".join(missing)})
                continue
            text = PLACEHOLDER.sub(lambda m: p["fields"][m.group(1)], template)
            if len(text) > cap:
                problems.append({"vanity": p["vanity"], "reason": "%d characters, the %s limit is %d"
                                 % (len(text), args.kind, cap)})
                continue
            led["drafts"][args.kind][p["vanity"].lower()] = {"text": text, "status": None, "at": ts(now)}
            drafted += 1
            if len(samples) < 3:
                samples.append({"vanity": p["vanity"], "text": text, "chars": len(text)})
        save_ledger(d, led)
    emit({"kind": args.kind, "drafted": drafted, "problems": problems, "not_eligible": ineligible,
          "samples": samples, "limit_chars": cap})


# ---- batch / approve / record -----------------------------------------------------------------------------

def abandon(led, now, why="abandoned"):
    b = open_batch(led)
    if not b:
        return 0
    n = 0
    for it in b["items"]:
        if it["status"] is None:
            led["events"].append({"at": b["at"], "vanity": it["vanity"], "kind": b["kind"], "status": "abandoned",
                                  "batch": b["id"]})
            it["status"] = "abandoned"
            n += 1
    b["status"], b["closed_at"] = "closed", ts(now)
    return n


def candidates(led, kind, retry_failed):
    out = []
    for p in in_order(led):
        dr = led["drafts"][kind].get(p["vanity"].lower())
        if not dr or dr["status"] not in ((None, "failed") if retry_failed else (None,)):
            continue
        if eligible_to_draft(led, p, kind, retry_failed):
            continue
        out.append((p, dr))
    return out


def cmd_batch(args):
    d = dir_of(args)
    now = now_of(args)
    with locked(d, "outreach.py"):
        led = load_ledger(d)
        abandoned = 0
        if args.abandon_batch:
            abandoned = abandon(led, now)
        b = open_batch(led)
        stop = active_stop(led, now)
        room, detail = remaining(led, args.kind, now)
        cands = candidates(led, args.kind, args.retry_failed)
        limit = max(0, min(args.limit, room))
        reason, items, info = None, [], {}
        if b:
            reason = "open_batch"
            info = {"open_batch": {"id": b["id"], "kind": b["kind"], "approved": bool(b.get("approved_at")),
                                   "unrecorded": [it["vanity"] for it in b["items"] if it["status"] is None]},
                    "hint": "record each person, or rerun with --abandon-batch (unrecorded people stay counted)"}
        elif stop:
            reason = "stopped:" + stop["reason"]
            info = {"locked_until": ts(parse_ts(stop["at"]) + DAY)}
        elif room == 0:
            reason = "weekly_cap_reached" if args.kind == "connect" and detail["week"] == 0 else "daily_cap_reached"
        elif not cands:
            reason = "nothing_left"
        elif limit == 0:
            reason = "limit_zero"
        else:
            for p, dr in cands[:limit]:
                items.append({"vanity": p["vanity"], "name": p["fields"].get("name", ""),
                              "profile_url": profile_url(p["vanity"]), "degree": p["fields"].get("degree", ""),
                              "text": dr["text"], "chars": len(dr["text"]), "status": None})
            led["batch"] = {"id": "%s-%s" % (now.strftime("%Y%m%dT%H%M%SZ"), args.kind), "kind": args.kind,
                            "at": ts(now), "status": "open", "approved_at": None, "typed": None, "items": items}
            save_ledger(d, led)
        if abandoned and not items:
            save_ledger(d, led)
        shown = [{"n": i + 1, **{k: v for k, v in it.items() if k != "status"}} for i, it in enumerate(items)]
        emit(dict({"kind": args.kind, "count": len(items), "items": shown, "reason": reason,
                   "abandoned": abandoned, "remaining_after_batch": max(room - len(items), 0),
                   "caps": limits(led, now),
                   "to_approve": ("the user must type exactly: approve %d" % len(items)) if items else None}, **info))


APPROVE = re.compile(r"\s*approve\s+(\d+)\s*", re.I)


def cmd_approve(args):
    d = dir_of(args)
    now = now_of(args)
    with locked(d, "outreach.py"):
        led = load_ledger(d)
        b = open_batch(led)
        if not b:
            raise Fail("no open batch: run `outreach.py batch --kind ... --limit N` first")
        if b.get("approved_at"):
            emit({"already_approved": True, "batch": b["id"], "count": len(b["items"])})
            return
        m = APPROVE.fullmatch(args.typed or "")
        if not m or int(m.group(1)) != len(b["items"]):
            raise Fail("approval must be the user's own typed words `approve %d` (the number of people in the batch); "
                       "anything else is not approval. Show the batch again and ask." % len(b["items"]))
        b["approved_at"], b["typed"] = ts(now), clean_text(args.typed, 40)
        save_ledger(d, led)
    emit({"approved": True, "batch": b["id"], "kind": b["kind"], "count": len(b["items"])})


def cmd_record(args):
    d = dir_of(args)
    now = now_of(args)
    with locked(d, "outreach.py"):
        led = load_ledger(d)
        b = open_batch(led)
        low = args.vanity.lower()
        item = next((it for it in b["items"] if it["vanity"].lower() == low), None) if b else None
        if item is None:
            prior = next((e for e in reversed(led["events"]) if e["vanity"].lower() == low), None)
            if prior and prior["status"] == args.status:
                emit({"already_recorded": True, "vanity": args.vanity, "status": args.status})
                return
            raise Fail("%s is not in the open batch; only people from an approved `batch` can be recorded" % args.vanity)
        if not b.get("approved_at"):
            raise Fail("the batch has no typed approval yet: show it to the user and run `approve --typed ...`")
        if item["status"] is not None:
            if item["status"] == args.status:
                emit({"already_recorded": True, "vanity": item["vanity"], "status": args.status})
                return
            raise Fail("%s was already recorded as %s" % (item["vanity"], item["status"]))
        item["status"] = args.status
        kind = b["kind"]
        led["events"].append({"at": ts(now), "vanity": item["vanity"], "kind": kind, "status": args.status,
                              "batch": b["id"], "note": clean_text(args.note, 80)})
        led["drafts"][kind][low]["status"] = args.status
        p = led["people"][low]
        if args.member:
            p["member"] = clean_text(args.member, 60)
        if args.status == "sent":
            if kind == "connect":
                p["state"] = "pending"
            elif p["state"] != "replied":
                p["state"] = "messaged"
        if all(it["status"] is not None for it in b["items"]):
            b["status"], b["closed_at"] = "closed", ts(now)
        save_ledger(d, led)
        left = sum(1 for it in b["items"] if it["status"] is None)
    emit({"recorded": item["vanity"], "status": args.status, "state": p["state"], "batch_left": left})


# ---- stop / account / status / export ---------------------------------------------------------------------

def cmd_stop(args):
    d = dir_of(args)
    now = now_of(args)
    with locked(d, "outreach.py"):
        led = load_ledger(d)
        reason = re.sub(r"[^a-z0-9_:.-]", "", (args.reason or "").lower())[:60] or "stopped"
        led["stops"].append({"at": ts(now), "reason": reason})
        save_ledger(d, led)
    emit({"stopped": reason, "locked_until": ts(now + DAY)})


def cmd_account(args):
    d = dir_of(args)
    now = now_of(args)
    with locked(d, "outreach.py"):
        led = load_ledger(d)
        led["new_account_until"] = ts(now + datetime.timedelta(days=NEW_ACCOUNT_DAYS)) if args.new_account else None
        save_ledger(d, led)
    emit({"new_account_half_caps_until": led["new_account_until"], "caps": limits(led, now)})


def cmd_status(args):
    led = load_ledger(dir_of(args))
    now = now_of(args)
    states = {s: 0 for s in STATES}
    for p in led["people"].values():
        states[p["state"]] = states.get(p["state"], 0) + 1
    b = open_batch(led)
    stop = active_stop(led, now)
    lim = limits(led, now)
    emit({"people": len(led["people"]), "states": states, "caps": lim,
          "connect": {"used_24h": used(led, "connect", now, DAY), "used_7d": used(led, "connect", now, WEEK),
                      "remaining_now": remaining(led, "connect", now)[0]},
          "message": {"used_24h": used(led, "message", now, DAY), "remaining_now": remaining(led, "message", now)[0]},
          "drafts": {k: sum(1 for x in v.values() if x["status"] is None) for k, v in led["drafts"].items()},
          "open_batch": b and {"id": b["id"], "kind": b["kind"], "approved": bool(b.get("approved_at")),
                               "unrecorded": sum(1 for it in b["items"] if it["status"] is None)},
          "stopped": stop and {"reason": stop["reason"], "locked_until": ts(parse_ts(stop["at"]) + DAY)}})


EXPORT_COLS = ["vanity", "name", "profile_url", "state", "connect_status", "connect_at", "messages_sent",
               "last_message_at", "accepted_at", "replied_at"]


def cmd_export(args):
    d = dir_of(args)
    with locked(d, "outreach.py"):
        led = load_ledger(d)
        rows = []
        for p in in_order(led):
            key = p["vanity"].lower()
            ev = [e for e in led["events"] if e["vanity"].lower() == key and e["status"] == "sent"]
            conn = next((e for e in ev if e["kind"] == "connect"), None)
            msgs = [e for e in ev if e["kind"] == "message"]
            rows.append({"vanity": p["vanity"], "name": p["fields"].get("name", ""), "profile_url": profile_url(p["vanity"]),
                         "state": p["state"], "connect_status": "sent" if conn else "", "connect_at": conn["at"] if conn else "",
                         "messages_sent": str(len(msgs)), "last_message_at": msgs[-1]["at"] if msgs else "",
                         "accepted_at": p.get("accepted_at") or "", "replied_at": p.get("replied_at") or ""})
        rows = [{c: defuse(r[c]) for c in EXPORT_COLS} for r in rows]
        out = args.out or os.path.join(d, "outreach_status.csv")
        atomic_write(out, csv_text(EXPORT_COLS, rows))
    emit({"written": out, "rows": len(rows)})


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--now", help=argparse.SUPPRESS)   # tests: pretend it is this UTC time (YYYY-MM-DDTHH:MM:SSZ)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, **kw):
        p = sub.add_parser(name, **kw)
        p.add_argument("--dir", default=None, help="working dir (default ./%s)" % DEFAULT_DIR)
        p.set_defaults(fn=fn)
        return p

    kinds = ("connect", "message")
    p = add("init", cmd_init, help="load people from a CSV")
    p.add_argument("csv")
    p.add_argument("--new-account", action="store_true", help="new or long-idle account: half the caps for 14 days")
    p.add_argument("--force", action="store_true", help="restart; the old ledger is backed up, history kept")
    p = add("draft", cmd_draft, help="fill a template for each eligible person (writes drafts only)")
    p.add_argument("--kind", choices=kinds, required=True)
    p.add_argument("--template", required=True, help="text file with {first_name} {company} {headline} ... fields")
    p.add_argument("--where", action="append", metavar="COL=REGEX")
    p.add_argument("--limit", type=int, default=None)
    p = add("batch", cmd_batch, help="print the exact batch for approval (reserves the caps)")
    p.add_argument("--kind", choices=kinds, required=True)
    p.add_argument("--limit", type=int, default=DEFAULT_BATCH, help="default %d" % DEFAULT_BATCH)
    p.add_argument("--retry-failed", action="store_true")
    p.add_argument("--abandon-batch", action="store_true",
                   help="close the open batch; its unrecorded people stay counted against the caps")
    p = add("approve", cmd_approve, help="record the user's typed approval of the open batch")
    p.add_argument("--typed", required=True, help='the user\'s own words, exactly "approve N"')
    p = add("record", cmd_record, help="write down what happened to one person after the UI click")
    p.add_argument("vanity")
    p.add_argument("--status", choices=("sent", "skipped", "failed"), required=True)
    p.add_argument("--note", default="")
    p.add_argument("--member", default=None, help="LinkedIn member id, if you read it")
    p = add("stop", cmd_stop, help="lock sending for 24 hours")
    p.add_argument("--reason", required=True)
    p = add("account", cmd_account, help="set or clear the new-account half caps")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--new-account", action="store_true")
    g.add_argument("--established", action="store_true")
    add("status", cmd_status, help="caps, states, open batch")
    p = add("export", cmd_export, help="write outreach_status.csv")
    p.add_argument("--out")
    return ap


def main(argv=None):
    return run_main(build_parser, argv)


if __name__ == "__main__":
    sys.exit(main())
