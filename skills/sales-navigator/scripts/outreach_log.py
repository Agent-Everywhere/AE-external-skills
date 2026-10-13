#!/usr/bin/env python3
"""Outreach ledger for a Sales Navigator seat: who was contacted, when, and what happened since.

A CSV file (default ./outreach_log.csv), append-only. One person is one Sales Nav lead id; each
line is an event and the LATEST line for a lead id is that person's current state. The message
text is never stored, only a short hash (so a repeat of the same text can be spotted). Every
command that writes holds a file lock (a hidden .<log>.lock beside the log) while it reads and
appends, so two runs cannot both log the same person or both slip under a cap.

  outreach_log.py check   --lead-id ID [--lead-id ID ...] [--ids-file FILE]
        exit 3 if ANY of them is already in the log (any status, pending included), else 0. Run
        this before drafting or sending to anyone. IDs may be a Sales Nav lead URL or an entityUrn.
  outreach_log.py add     --lead-id ID --kind connection|inmail --message TEXT [--pending] [--date YYYY-MM-DD]
        record a send. Refuses (exit 3) a person who is already in the log, and (exit 2) a
        connection request when the daily or 7-day cap is already reached. With --pending it
        records the INTENT (status pending, touches 0) and is run BEFORE the click, so a crash
        between the click and the log can never lead to a second send; after the send is verified
        run `status --status sent`. A pending row counts toward the caps and as contacted.
  outreach_log.py status  --lead-id ID --status sent|accepted|replied|withdrawn [--date YYYY-MM-DD]
        record what happened (the person must already be in the log). `sent` confirms a pending
        row; `withdrawn` on a pending row means it was never sent.
  outreach_log.py followup --lead-id ID --message TEXT [--date YYYY-MM-DD]
        record a follow-up message to someone who accepted (touches +1, status stays accepted,
        the no-reply clock restarts). Refused once the person has had the maximum touches, and
        (exit 2) when the follow-up daily cap is already reached.
  outreach_log.py caps    [--for connection|followup|all] [--date YYYY-MM-DD] [--daily N] [--weekly N]
        connection requests sent today and in the last 7 days, and follow-up messages sent today,
        against the limits. Exit 2 when a cap in scope is reached (do not send), else 0. InMails
        are not capped here: they use credits.
  outreach_log.py summary [--stale-days N] [--max-touches N]
        counts per status and kind; the pending rows (intent recorded, send not confirmed); with
        --stale-days, the people who accepted at least N days ago, have not replied and still have
        touches left (the follow-up candidates).

Status: pending -> sent -> accepted -> replied; withdrawn can follow any of pending, sent and
accepted. `replied` and `withdrawn` are final. `touches` counts messages we sent a person: the
first one plus follow-ups (0 while only pending). Dates are local calendar dates, written
YYYY-MM-DD; for add and followup --date may not be in the future or more than 2 days in the past
(log a send when it happens).

Limits come from references/guardrails.md ("Outreach caps"). --daily, --weekly and --followup-daily
can lower a limit; a value above the default is ignored (with a note) unless --allow-over-cap is
given, and --allow-over-cap is only for the user's explicit go. Likewise --max-touches is clamped
to the default maximum, and add / followup stop at a reached cap, unless --allow-over-cap.

Exit codes: 0 fine, 1 bad input, 2 a cap is reached (caps, add, followup), 3 already contacted
(check, add).
Python 3 standard library only, no network.
"""
import argparse
import contextlib
import csv
import hashlib
import re
import sys
from datetime import date, timedelta
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows: no advisory locks; the ledger is then only safe for one run at a time
    fcntl = None

# Source of truth: references/guardrails.md ("Outreach caps"). A test fails if these drift.
DAILY_CONNECTION_CAP = 20
WEEKLY_CONNECTION_CAP = 100
DAILY_FOLLOWUP_CAP = 20
MAX_TOUCHES = 3  # the first message plus two follow-ups
NEAR_FRACTION = 0.8
WEEK_DAYS = 7  # rolling window, today included
MAX_BACKDATE_DAYS = 2  # add / followup --date: today, or at most this many days ago

COLUMNS = ["lead_id", "kind", "status", "sent_at", "status_at", "touches", "message_hash", "note"]
KINDS = ["connection", "inmail"]
FOLLOWUP_STATUSES = ["accepted", "replied", "withdrawn"]
STATUS_CHOICES = ["sent"] + FOLLOWUP_STATUSES  # what `status --status` accepts
STATUSES = ["pending"] + STATUS_CHOICES
# Allowed next statuses from the current one.
TRANSITIONS = {"pending": ["sent", "withdrawn"],
               "sent": ["accepted", "replied", "withdrawn"],
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
        # touches is 0 only while nothing was sent: a pending row, or a pending row that was withdrawn
        floor = 0 if row["status"] in ("pending", "withdrawn") else 1
        if not row["touches"].isdigit() or int(row["touches"]) < floor:
            raise LogError("%s line %d: touches must be a whole number >= %d" % (path, n, floor))
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


@contextlib.contextmanager
def locked(path):
    """Exclusive advisory lock for a read-then-append on the ledger (a hidden .<name>.lock beside it)."""
    if fcntl is None:
        yield
        return
    p = Path(path)
    with open(p.with_name("." + p.name + ".lock"), "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


# ----------------------------------------------------------------------------- counts and limits

def counts_as_send(ev):
    """A person's current row stands for a send that happened or may have happened (pending included)."""
    return ev["status"] == "pending" or int(ev["touches"]) >= 1


def usage(events, today, day=None):
    """The numbers caps, add and followup all use, so they cannot disagree.

    `today` anchors the rolling 7 days; `day` (default today) is the day the daily numbers are for.
    Each person is counted once, on the day of their first message, whatever happened afterwards.
    """
    day = day or today
    first = today - timedelta(days=WEEK_DAYS - 1)
    sent = [e for e in current_state(events).values() if counts_as_send(e)]

    def count(kind, lo, hi):
        return sum(1 for e in sent if e["kind"] == kind and lo <= parse_day(e["sent_at"]) <= hi)

    # A follow-up event is an `accepted` row with touches >= 2 (plain status changes carry touches 1).
    followups = sum(1 for e in events if e["status"] == "accepted" and int(e["touches"]) >= 2
                    and parse_day(e["status_at"]) == day)
    return {"day_n": count("connection", day, day), "week_n": count("connection", first, today),
            "inmail_day": count("inmail", day, day), "inmail_week": count("inmail", first, today),
            "followups_day": followups}


def resolve_limits(args):
    """(daily, weekly, followup_daily, notes). Lowering is free; raising needs --allow-over-cap."""
    notes = []
    out = []
    for value, default, label in ((args.daily, DAILY_CONNECTION_CAP, "daily"),
                                  (args.weekly, WEEKLY_CONNECTION_CAP, "weekly"),
                                  (args.followup_daily, DAILY_FOLLOWUP_CAP, "follow-up daily")):
        if value is None:
            out.append(default)
            continue
        if value < 0:
            raise LogError("limits must not be negative")
        if value > default and not args.allow_over_cap:
            notes.append("note: the %s limit %d is above its default %d and was ignored: raising a cap needs "
                         "--allow-over-cap, and only on the user's explicit go" % (label, value, default))
            value = default
        out.append(value)
    return out[0], out[1], out[2], notes


def resolve_max_touches(args):
    """(max_touches, notes): clamped to MAX_TOUCHES unless --allow-over-cap."""
    value = args.max_touches
    if value > MAX_TOUCHES and not args.allow_over_cap:
        return MAX_TOUCHES, ["note: --max-touches %d is above the default %d and was ignored: raising it needs "
                             "--allow-over-cap, and only on the user's explicit go" % (value, MAX_TOUCHES)]
    return value, []


def send_day(args):
    """(day, today) for add / followup: --date may be today or at most MAX_BACKDATE_DAYS days ago."""
    today = parse_day(args.today, "--today") if args.today else date.today()
    day = parse_day(args.date) if args.date else today
    if day > today:
        raise LogError("--date %s is in the future: log a send when it happens" % day)
    if (today - day).days > MAX_BACKDATE_DAYS:
        raise LogError("--date %s is more than %d days in the past: log a send when it happens"
                       % (day, MAX_BACKDATE_DAYS))
    return day, today


def cap_reached(used, daily, weekly):
    """Which connection cap (if any) a new request would exceed, as text."""
    if used["day_n"] >= daily:
        return "daily connection cap reached (%d / %d today)" % (used["day_n"], daily)
    if used["week_n"] >= weekly:
        return "7-day connection cap reached (%d / %d)" % (used["week_n"], weekly)
    return ""


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
    if any(ev["status"] == "pending" for _, ev in hits):
        print("PENDING: a send was intended but never confirmed. Open the lead and look for a pending "
              "invitation or an existing thread (outreach.md rule 8), then `status --status sent` if it "
              "went out or `status --status withdrawn` if it did not. Never send again before that.")
    print("%d checked, %d already contacted, %d clear"
          % (len(set(keys)), len(hits), len(set(keys)) - len(hits)))
    return EXIT_CONTACTED if hits else EXIT_OK


def cmd_add(args):
    key = lead_key(args.lead_id)
    text = Path(args.message_file).read_text(encoding="utf-8") if args.message_file else args.message
    digest = message_hash(text)
    day, today = send_day(args)
    daily, weekly, _, notes = resolve_limits(args)
    for note in notes:
        print(note, file=sys.stderr)
    with locked(args.log):
        events = read_events(args.log)
        state = current_state(events)
        if key in state:
            ev = state[key]
            print("refused: %s is already in the log (%s %s, sent %s)" % (key, ev["kind"], ev["status"], ev["sent_at"]),
                  file=sys.stderr)
            return EXIT_CONTACTED
        if args.kind == "connection":
            why = cap_reached(usage(events, today, day), daily, weekly)
            if why and not args.allow_over_cap:
                print("refused: %s. Send nothing more of this kind until it clears." % why, file=sys.stderr)
                return EXIT_CAP
        status = "pending" if args.pending else "sent"
        append_event(args.log, {"lead_id": key, "kind": args.kind, "status": status, "sent_at": day.isoformat(),
                                "status_at": day.isoformat(), "touches": 0 if args.pending else 1,
                                "message_hash": digest, "note": args.note or ""})
    if args.pending:
        print("logged: %s %s PENDING %s (message %s): send it now, verify it, then run "
              "`status --lead-id %s --status sent`" % (key, args.kind, day.isoformat(), digest, key))
    else:
        print("logged: %s %s sent %s (message %s)" % (key, args.kind, day.isoformat(), digest))
    return EXIT_OK


def cmd_status(args):
    key = lead_key(args.lead_id)
    day = parse_day(args.date) if args.date else date.today()
    with locked(args.log):
        state = current_state(read_events(args.log))
        if key not in state:
            raise LogError("%s is not in the log: record the send first" % key)
        cur = state[key]
        if args.status not in TRANSITIONS[cur["status"]]:
            raise LogError("%s is already %s; cannot go to %s" % (key, cur["status"], args.status))
        if day < parse_day(cur["status_at"]):
            raise LogError("%s: date %s is before the last event (%s)" % (key, day, cur["status_at"]))
        confirming = cur["status"] == "pending" and args.status == "sent"
        append_event(args.log, {"lead_id": key, "kind": cur["kind"], "status": args.status,
                                "sent_at": day.isoformat() if confirming else cur["sent_at"],
                                "status_at": day.isoformat(), "touches": 1 if confirming else cur["touches"],
                                "message_hash": cur["message_hash"], "note": args.note or ""})
    print("logged: %s %s -> %s on %s" % (key, cur["status"], args.status, day.isoformat()))
    return EXIT_OK


def cmd_followup(args):
    key = lead_key(args.lead_id)
    text = Path(args.message_file).read_text(encoding="utf-8") if args.message_file else args.message
    digest = message_hash(text)
    day, today = send_day(args)
    _, _, followup_cap, notes = resolve_limits(args)
    max_touches, more = resolve_max_touches(args)
    for note in notes + more:
        print(note, file=sys.stderr)
    with locked(args.log):
        events = read_events(args.log)
        state = current_state(events)
        if key not in state:
            raise LogError("%s is not in the log: record the send first" % key)
        cur = state[key]
        if cur["status"] != "accepted":
            raise LogError("%s is %s: a follow-up is only logged for someone who accepted and has not replied"
                           % (key, cur["status"]))
        if int(cur["touches"]) >= max_touches:
            raise LogError("%s already had %s touches (maximum %d): no more follow-ups"
                           % (key, cur["touches"], max_touches))
        if day < parse_day(cur["status_at"]):
            raise LogError("%s: date %s is before the last event (%s)" % (key, day, cur["status_at"]))
        done = usage(events, today, day)["followups_day"]
        if done >= followup_cap and not args.allow_over_cap:
            print("refused: daily follow-up cap reached (%d / %d on %s). Send nothing more of this kind "
                  "until it clears." % (done, followup_cap, day), file=sys.stderr)
            return EXIT_CAP
        append_event(args.log, {"lead_id": key, "kind": cur["kind"], "status": "accepted",
                                "sent_at": cur["sent_at"], "status_at": day.isoformat(),
                                "touches": int(cur["touches"]) + 1, "message_hash": digest,
                                "note": args.note or ""})
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
    daily, weekly, followup_cap, notes = resolve_limits(args)
    used = usage(read_events(args.log), today)
    day_n, week_n, followups_today = used["day_n"], used["week_n"], used["followups_day"]
    d_status, w_status = classify(day_n, daily), classify(week_n, weekly)
    f_status = classify(followups_today, followup_cap)
    print("Connection requests (%s)" % today.isoformat())
    print("  today      %3d / %-3d  %s" % (day_n, daily, d_status))
    print("  last %d d   %3d / %-3d  %s" % (WEEK_DAYS, week_n, weekly, w_status))
    print("  can still send today: %d" % max(0, min(daily - day_n, weekly - week_n)))
    print("Follow-up messages")
    print("  today      %3d / %-3d  %s" % (followups_today, followup_cap, f_status))
    print("InMails sent: %d today, %d in the last %d days (not capped here: use the credits left)"
          % (used["inmail_day"], used["inmail_week"], WEEK_DAYS))
    for note in notes:
        print(note)
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
    pending = sorted(k for k, e in state.items() if e["status"] == "pending")
    if pending:
        print("pending (send intended, not confirmed: check the lead for an invitation/thread first): %d" % len(pending))
        for key in pending:
            print("  %s (intended %s)" % (key, state[key]["sent_at"]))
    if args.stale_days is not None:
        max_touches, notes = resolve_max_touches(args)
        for note in notes:
            print(note, file=sys.stderr)
        today = parse_day(args.today) if args.today else date.today()
        cutoff = today - timedelta(days=args.stale_days)
        due = sorted(k for k, e in state.items()
                     if e["status"] == "accepted" and parse_day(e["status_at"]) <= cutoff
                     and int(e["touches"]) < max_touches)
        print("accepted, no reply, last touch %d+ days ago, touches left: %d" % (args.stale_days, len(due)))
        for key in due:
            print("  %s (last touch %s, touches %s)" % (key, state[key]["status_at"], state[key]["touches"]))
    return EXIT_OK


# ----------------------------------------------------------------------------- command line

def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--log", default=DEFAULT_LOG, metavar="FILE", help="ledger CSV (default %(default)s)")
    over = argparse.ArgumentParser(add_help=False)
    over.add_argument("--allow-over-cap", action="store_true",
                      help="ONLY on the user's explicit go: allow a send past a reached cap and limits above the defaults")
    limits = argparse.ArgumentParser(add_help=False)
    limits.add_argument("--daily", type=int, metavar="N",
                        help="daily connection limit (default %d; lower is fine)" % DAILY_CONNECTION_CAP)
    limits.add_argument("--weekly", type=int, metavar="N",
                        help="7-day connection limit (default %d; lower is fine)" % WEEKLY_CONNECTION_CAP)
    limits.add_argument("--followup-daily", type=int, metavar="N",
                        help="follow-up messages per day (default %d; lower is fine)" % DAILY_FOLLOWUP_CAP)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    chk = sub.add_parser("check", parents=[common], help="exit 3 if anyone was already contacted")
    chk.add_argument("--lead-id", action="append", default=[], metavar="ID")
    chk.add_argument("--ids-file", metavar="FILE", help="one lead id / URL per line (# comments allowed)")

    add = sub.add_parser("add", parents=[common, limits, over],
                         help="record a send (or, with --pending, the intent to send)")
    add.add_argument("--lead-id", required=True, metavar="ID")
    add.add_argument("--kind", required=True, choices=KINDS)
    group = add.add_mutually_exclusive_group(required=True)
    group.add_argument("--message", help="the exact text that is sent (only its hash is stored)")
    group.add_argument("--message-file", metavar="FILE")
    add.add_argument("--pending", action="store_true",
                     help="record the intent BEFORE clicking send; confirm afterwards with `status --status sent`")
    add.add_argument("--date", metavar="YYYY-MM-DD", help="send date (default today; at most 2 days ago)")
    add.add_argument("--today", metavar="YYYY-MM-DD", help=argparse.SUPPRESS)
    add.add_argument("--note", default="", help="short free text, no personal details")

    st = sub.add_parser("status", parents=[common],
                        help="record sent (confirms a pending row) / accepted / replied / withdrawn")
    st.add_argument("--lead-id", required=True, metavar="ID")
    st.add_argument("--status", required=True, choices=STATUS_CHOICES)
    st.add_argument("--date", metavar="YYYY-MM-DD", help="when it happened (default today)")
    st.add_argument("--note", default="")

    fu = sub.add_parser("followup", parents=[common, limits, over],
                        help="record a follow-up message to someone who accepted")
    fu.add_argument("--lead-id", required=True, metavar="ID")
    fgroup = fu.add_mutually_exclusive_group(required=True)
    fgroup.add_argument("--message", help="the exact text that was sent (only its hash is stored)")
    fgroup.add_argument("--message-file", metavar="FILE")
    fu.add_argument("--date", metavar="YYYY-MM-DD", help="send date (default today; at most 2 days ago)")
    fu.add_argument("--today", metavar="YYYY-MM-DD", help=argparse.SUPPRESS)
    fu.add_argument("--max-touches", type=int, default=MAX_TOUCHES, metavar="N",
                    help="stop after this many messages to one person (default %(default)s; lower is fine)")
    fu.add_argument("--note", default="")

    caps = sub.add_parser("caps", parents=[common, limits, over],
                          help="today / last 7 days vs the connection-request caps")
    caps.add_argument("--date", metavar="YYYY-MM-DD", help="treat this as today")
    caps.add_argument("--for", dest="scope", choices=["connection", "followup", "all"], default="all",
                      help="which caps decide the exit code: the kind of batch about to be sent (default %(default)s)")

    summ = sub.add_parser("summary", parents=[common, over],
                          help="counts per status; pending rows; follow-up candidates")
    summ.add_argument("--stale-days", type=int, metavar="N", help="list people accepted >= N days ago, no reply")
    summ.add_argument("--max-touches", type=int, default=MAX_TOUCHES, metavar="N",
                      help="leave out people who already had this many messages (default %(default)s; lower is fine)")
    summ.add_argument("--today", metavar="YYYY-MM-DD", help=argparse.SUPPRESS)
    return ap


COMMANDS = {"check": cmd_check, "add": cmd_add, "status": cmd_status, "followup": cmd_followup,
            "caps": cmd_caps, "summary": cmd_summary}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return COMMANDS[args.command](args)
    except (LogError, OSError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_BAD


if __name__ == "__main__":
    sys.exit(main())
