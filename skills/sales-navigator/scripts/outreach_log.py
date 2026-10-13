#!/usr/bin/env python3
"""Outreach ledger for a Sales Navigator seat: who was contacted, when, and what happened since.

A CSV file (default ./outreach_log.csv), append-only. One person is one Sales Nav lead id; each
line is an event and the LATEST line for a lead id is that person's current state. The message
text is never stored, only a short hash (so a repeat of the same text can be spotted).

  outreach_log.py check   --lead-id ID [--lead-id ID ...] [--ids-file FILE]
        exit 3 if ANY of them is already in the log (any status), else 0. Run this before drafting
        or sending to anyone. IDs may be given as a Sales Nav lead URL or an entityUrn.
  outreach_log.py add     --lead-id ID --kind connection|inmail --message TEXT [--date YYYY-MM-DD]
        record a send. Refuses (exit 3) a person who is already in the log.
  outreach_log.py status  --lead-id ID --status accepted|replied|withdrawn [--date YYYY-MM-DD]
        record what happened afterwards (the person must already be in the log).
  outreach_log.py followup --lead-id ID --message TEXT [--date YYYY-MM-DD]
        record a follow-up message to someone who accepted (touches +1, status stays accepted,
        the no-reply clock restarts). Refused once the person has had the maximum touches.
  outreach_log.py caps    [--for connection|followup|all] [--date YYYY-MM-DD] [--daily N] [--weekly N]
        connection requests sent today and in the last 7 days, and follow-up messages sent today,
        against the limits. Exit 2 when a cap in scope is reached (do not send), else 0. InMails
        are not capped here: they use credits.
  outreach_log.py summary [--stale-days N] [--max-touches N]
        counts per status and kind; with --stale-days, the people who accepted at least N days ago,
        have not replied and still have touches left (the follow-up candidates).

Status: sent -> accepted -> replied; withdrawn can follow sent or accepted. `replied` and
`withdrawn` are final. `touches` counts messages we sent a person: the first one plus
follow-ups. Dates are local calendar dates, written YYYY-MM-DD.
Limits come from references/guardrails.md ("Outreach caps"); lowering them is always fine, raising
them needs the user's explicit go (the report says so).

Exit codes: 0 fine, 1 bad input, 2 a cap is reached (caps), 3 already contacted (check, add).
Python 3 standard library only, no network.
"""
import argparse
import csv
import hashlib
import re
import sys
from datetime import date, timedelta
from pathlib import Path

# Source of truth: references/guardrails.md ("Outreach caps"). A test fails if these drift.
DAILY_CONNECTION_CAP = 20
WEEKLY_CONNECTION_CAP = 100
DAILY_FOLLOWUP_CAP = 20
MAX_TOUCHES = 3  # the first message plus two follow-ups
NEAR_FRACTION = 0.8
WEEK_DAYS = 7  # rolling window, today included

COLUMNS = ["lead_id", "kind", "status", "sent_at", "status_at", "touches", "message_hash", "note"]
KINDS = ["connection", "inmail"]
FOLLOWUP_STATUSES = ["accepted", "replied", "withdrawn"]
STATUSES = ["sent"] + FOLLOWUP_STATUSES
# Allowed next statuses from the current one.
TRANSITIONS = {"sent": ["accepted", "replied", "withdrawn"],
               "accepted": ["replied", "withdrawn"],
               "replied": [], "withdrawn": []}
DEFAULT_LOG = "outreach_log.csv"

EXIT_OK, EXIT_BAD, EXIT_CAP, EXIT_CONTACTED = 0, 1, 2, 3


class LogError(ValueError):
    pass


# ----------------------------------------------------------------------------- keys and hashes

def lead_key(value):
    """The Sales Nav lead id from a bare id, a /sales/lead/ URL or a salesProfile urn.

    The id is case sensitive and is used exactly as LinkedIn gives it.
    """
    s = (value or "").strip()
    m = re.search(r"/sales/lead/([^,/?#\s]+)", s)
    if m:
        s = m.group(1)
    else:
        m = re.search(r"salesProfile:\(([^,)\s]+)", s)
        if m:
            s = m.group(1)
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,}", s):
        raise LogError("not a Sales Nav lead id: %r (give the id, a /sales/lead/ URL or an entityUrn)" % value)
    return s


def message_hash(text):
    """First 12 hex digits of sha256 over the message with whitespace collapsed."""
    norm = " ".join((text or "").split())
    if not norm:
        raise LogError("the message is empty")
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:12]


def parse_day(text, what="date"):
    try:
        return date.fromisoformat(text)
    except (TypeError, ValueError):
        raise LogError("%s must be YYYY-MM-DD, got %r" % (what, text))


# ----------------------------------------------------------------------------- the file

def read_events(path):
    p = Path(path)
    if not p.is_file() or p.stat().st_size == 0:
        return []
    with open(p, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != COLUMNS:
            raise LogError("%s: header must be %s" % (path, ",".join(COLUMNS)))
        rows = list(reader)
    for n, row in enumerate(rows, 2):
        if row["status"] not in STATUSES or row["kind"] not in KINDS:
            raise LogError("%s line %d: bad kind/status %r/%r" % (path, n, row["kind"], row["status"]))
        for col in ("sent_at", "status_at"):
            parse_day(row[col], "%s line %d %s" % (path, n, col))
        if not row["touches"].isdigit() or int(row["touches"]) < 1:
            raise LogError("%s line %d: touches must be a whole number >= 1" % (path, n))
    return rows


def current_state(events):
    """{lead_id: latest event} (events are in file order, so the last one wins)."""
    state = {}
    for ev in events:
        state[ev["lead_id"]] = ev
    return state


def append_event(path, event):
    p = Path(path)
    fresh = not p.is_file() or p.stat().st_size == 0
    with open(p, "a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
        if fresh:
            writer.writeheader()
        writer.writerow({c: event.get(c, "") for c in COLUMNS})
        fh.flush()


# ----------------------------------------------------------------------------- commands

def cmd_check(args):
    keys = [lead_key(v) for v in args.lead_id]
    if args.ids_file:
        with open(args.ids_file, encoding="utf-8") as fh:
            keys += [lead_key(l) for l in (ln.split("#", 1)[0] for ln in fh) if l.strip()]
    if not keys:
        raise LogError("give --lead-id or --ids-file")
    state = current_state(read_events(args.log))
    hits = [(k, state[k]) for k in dict.fromkeys(keys) if k in state]
    for key, ev in hits:
        print("CONTACTED %s  %s %s (sent %s, status %s since %s)"
              % (key, ev["kind"], ev["status"], ev["sent_at"], ev["status"], ev["status_at"]))
    print("%d checked, %d already contacted, %d clear"
          % (len(set(keys)), len(hits), len(set(keys)) - len(hits)))
    return EXIT_CONTACTED if hits else EXIT_OK


def cmd_add(args):
    key = lead_key(args.lead_id)
    text = Path(args.message_file).read_text(encoding="utf-8") if args.message_file else args.message
    digest = message_hash(text)
    day = parse_day(args.date) if args.date else date.today()
    state = current_state(read_events(args.log))
    if key in state:
        ev = state[key]
        print("refused: %s is already in the log (%s %s, sent %s)" % (key, ev["kind"], ev["status"], ev["sent_at"]),
              file=sys.stderr)
        return EXIT_CONTACTED
    append_event(args.log, {"lead_id": key, "kind": args.kind, "status": "sent", "sent_at": day.isoformat(),
                            "status_at": day.isoformat(), "touches": 1, "message_hash": digest,
                            "note": args.note or ""})
    print("logged: %s %s sent %s (message %s)" % (key, args.kind, day.isoformat(), digest))
    return EXIT_OK


def cmd_status(args):
    key = lead_key(args.lead_id)
    day = parse_day(args.date) if args.date else date.today()
    state = current_state(read_events(args.log))
    if key not in state:
        raise LogError("%s is not in the log: record the send first" % key)
    cur = state[key]
    if args.status not in TRANSITIONS[cur["status"]]:
        raise LogError("%s is already %s; cannot go to %s" % (key, cur["status"], args.status))
    if day < parse_day(cur["status_at"]):
        raise LogError("%s: date %s is before the last event (%s)" % (key, day, cur["status_at"]))
    append_event(args.log, {"lead_id": key, "kind": cur["kind"], "status": args.status, "sent_at": cur["sent_at"],
                            "status_at": day.isoformat(), "touches": cur["touches"],
                            "message_hash": cur["message_hash"], "note": args.note or ""})
    print("logged: %s %s -> %s on %s" % (key, cur["status"], args.status, day.isoformat()))
    return EXIT_OK


def cmd_followup(args):
    key = lead_key(args.lead_id)
    text = Path(args.message_file).read_text(encoding="utf-8") if args.message_file else args.message
    digest = message_hash(text)
    day = parse_day(args.date) if args.date else date.today()
    state = current_state(read_events(args.log))
    if key not in state:
        raise LogError("%s is not in the log: record the send first" % key)
    cur = state[key]
    if cur["status"] != "accepted":
        raise LogError("%s is %s: a follow-up is only logged for someone who accepted and has not replied"
                       % (key, cur["status"]))
    if int(cur["touches"]) >= args.max_touches:
        raise LogError("%s already had %s touches (maximum %d): no more follow-ups"
                       % (key, cur["touches"], args.max_touches))
    if day < parse_day(cur["status_at"]):
        raise LogError("%s: date %s is before the last event (%s)" % (key, day, cur["status_at"]))
    append_event(args.log, {"lead_id": key, "kind": cur["kind"], "status": "accepted", "sent_at": cur["sent_at"],
                            "status_at": day.isoformat(), "touches": int(cur["touches"]) + 1,
                            "message_hash": digest, "note": args.note or ""})
    print("logged: %s follow-up %d sent %s (message %s)" % (key, int(cur["touches"]), day.isoformat(), digest))
    return EXIT_OK


def classify(used, cap):
    if used >= cap:
        return "CAP REACHED"
    if used >= NEAR_FRACTION * cap:
        return "NEAR"
    return "OK"


def cmd_caps(args):
    today = parse_day(args.date) if args.date else date.today()
    daily = args.daily if args.daily is not None else DAILY_CONNECTION_CAP
    weekly = args.weekly if args.weekly is not None else WEEKLY_CONNECTION_CAP
    if daily < 0 or weekly < 0:
        raise LogError("limits must not be negative")
    events = read_events(args.log)
    sends = [ev for ev in events if ev["status"] == "sent"]
    # A follow-up event is an `accepted` row with touches >= 2 (plain status changes carry touches 1).
    followups_today = sum(1 for e in events if e["status"] == "accepted" and int(e["touches"]) >= 2
                          and parse_day(e["status_at"]) == today)
    first = today - timedelta(days=WEEK_DAYS - 1)
    day_n = sum(1 for e in sends if e["kind"] == "connection" and parse_day(e["sent_at"]) == today)
    week_n = sum(1 for e in sends if e["kind"] == "connection" and first <= parse_day(e["sent_at"]) <= today)
    inmail_day = sum(1 for e in sends if e["kind"] == "inmail" and parse_day(e["sent_at"]) == today)
    inmail_week = sum(1 for e in sends if e["kind"] == "inmail" and first <= parse_day(e["sent_at"]) <= today)
    d_status, w_status = classify(day_n, daily), classify(week_n, weekly)
    followup_cap = args.followup_daily if args.followup_daily is not None else DAILY_FOLLOWUP_CAP
    f_status = classify(followups_today, followup_cap)
    print("Connection requests (%s)" % today.isoformat())
    print("  today      %3d / %-3d  %s" % (day_n, daily, d_status))
    print("  last %d d   %3d / %-3d  %s" % (WEEK_DAYS, week_n, weekly, w_status))
    print("  can still send today: %d" % max(0, min(daily - day_n, weekly - week_n)))
    print("Follow-up messages")
    print("  today      %3d / %-3d  %s" % (followups_today, followup_cap, f_status))
    print("InMails sent: %d today, %d in the last %d days (not capped here: use the credits left)"
          % (inmail_day, inmail_week, WEEK_DAYS))
    if (daily > DAILY_CONNECTION_CAP or weekly > WEEKLY_CONNECTION_CAP
            or followup_cap > DAILY_FOLLOWUP_CAP):
        print("A limit is above its default (%d/day, %d/7 days, %d follow-ups/day): only with the user's explicit go."
              % (DAILY_CONNECTION_CAP, WEEKLY_CONNECTION_CAP, DAILY_FOLLOWUP_CAP))
    scope = {"connection": (d_status, w_status), "followup": (f_status,),
             "all": (d_status, w_status, f_status)}[args.scope]
    reached = "CAP REACHED" in scope
    if reached:
        print("STOP: a cap is reached. Send nothing more of this kind until it clears.")
    return EXIT_CAP if reached else EXIT_OK


def cmd_summary(args):
    events = read_events(args.log)
    state = current_state(events)
    print("%d people in the log" % len(state))
    for kind in KINDS:
        row = [sum(1 for e in state.values() if e["kind"] == kind and e["status"] == s) for s in STATUSES]
        print("  %-10s %s" % (kind, "  ".join("%s %d" % (s, n) for s, n in zip(STATUSES, row))))
    if state:
        print("last send: %s" % max(e["sent_at"] for e in state.values()))
    if args.stale_days is not None:
        today = parse_day(args.today) if args.today else date.today()
        cutoff = today - timedelta(days=args.stale_days)
        due = sorted(k for k, e in state.items()
                     if e["status"] == "accepted" and parse_day(e["status_at"]) <= cutoff
                     and int(e["touches"]) < args.max_touches)
        print("accepted, no reply, last touch %d+ days ago, touches left: %d" % (args.stale_days, len(due)))
        for key in due:
            print("  %s (last touch %s, touches %s)" % (key, state[key]["status_at"], state[key]["touches"]))
    return EXIT_OK


# ----------------------------------------------------------------------------- command line

def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--log", default=DEFAULT_LOG, metavar="FILE", help="ledger CSV (default %(default)s)")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    chk = sub.add_parser("check", parents=[common], help="exit 3 if anyone was already contacted")
    chk.add_argument("--lead-id", action="append", default=[], metavar="ID")
    chk.add_argument("--ids-file", metavar="FILE", help="one lead id / URL per line (# comments allowed)")

    add = sub.add_parser("add", parents=[common], help="record a send")
    add.add_argument("--lead-id", required=True, metavar="ID")
    add.add_argument("--kind", required=True, choices=KINDS)
    group = add.add_mutually_exclusive_group(required=True)
    group.add_argument("--message", help="the exact text that was sent (only its hash is stored)")
    group.add_argument("--message-file", metavar="FILE")
    add.add_argument("--date", metavar="YYYY-MM-DD", help="send date (default today)")
    add.add_argument("--note", default="", help="short free text, no personal details")

    st = sub.add_parser("status", parents=[common], help="record accepted / replied / withdrawn")
    st.add_argument("--lead-id", required=True, metavar="ID")
    st.add_argument("--status", required=True, choices=FOLLOWUP_STATUSES)
    st.add_argument("--date", metavar="YYYY-MM-DD", help="when it happened (default today)")
    st.add_argument("--note", default="")

    fu = sub.add_parser("followup", parents=[common], help="record a follow-up message to someone who accepted")
    fu.add_argument("--lead-id", required=True, metavar="ID")
    fgroup = fu.add_mutually_exclusive_group(required=True)
    fgroup.add_argument("--message", help="the exact text that was sent (only its hash is stored)")
    fgroup.add_argument("--message-file", metavar="FILE")
    fu.add_argument("--date", metavar="YYYY-MM-DD", help="send date (default today)")
    fu.add_argument("--max-touches", type=int, default=MAX_TOUCHES, metavar="N",
                    help="stop after this many messages to one person (default %(default)s)")
    fu.add_argument("--note", default="")

    caps = sub.add_parser("caps", parents=[common], help="today / last 7 days vs the connection-request caps")
    caps.add_argument("--date", metavar="YYYY-MM-DD", help="treat this as today")
    caps.add_argument("--daily", type=int, metavar="N", help="daily limit (default %d)" % DAILY_CONNECTION_CAP)
    caps.add_argument("--weekly", type=int, metavar="N", help="7-day limit (default %d)" % WEEKLY_CONNECTION_CAP)
    caps.add_argument("--followup-daily", type=int, metavar="N",
                      help="follow-up messages per day (default %d)" % DAILY_FOLLOWUP_CAP)
    caps.add_argument("--for", dest="scope", choices=["connection", "followup", "all"], default="all",
                      help="which caps decide the exit code (default %(default)s)")

    summ = sub.add_parser("summary", parents=[common], help="counts per status; follow-up candidates")
    summ.add_argument("--stale-days", type=int, metavar="N", help="list people accepted >= N days ago, no reply")
    summ.add_argument("--max-touches", type=int, default=MAX_TOUCHES, metavar="N",
                      help="leave out people who already had this many messages (default %(default)s)")
    summ.add_argument("--today", metavar="YYYY-MM-DD", help=argparse.SUPPRESS)
    return ap


COMMANDS = {"check": cmd_check, "add": cmd_add, "status": cmd_status, "followup": cmd_followup, "caps": cmd_caps, "summary": cmd_summary}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return COMMANDS[args.command](args)
    except (LogError, OSError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_BAD


if __name__ == "__main__":
    sys.exit(main())
