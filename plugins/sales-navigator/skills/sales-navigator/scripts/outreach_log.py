#!/usr/bin/env python3
"""Outreach ledger for a Sales Navigator seat: who was contacted, when, and what happened since.

A CSV file (<workspace>/outreach_log.csv), append-only. One person is one Sales Nav lead id; each
line is an event and the LATEST line for a lead id is that person's current state. The message
text is never stored, only a short hash (so a repeat of the same text can be spotted). Every
command that writes holds a file lock (a hidden .<log>.lock beside the log) while it reads and
appends, so two runs cannot both log the same person or both slip under a cap.

  outreach_log.py check   --lead-id ID [--lead-id ID ...] [--ids-file FILE]
        exit 3 if ANY of them is already in the log (any status, pending included), else 0. Run
        this before drafting or sending to anyone. IDs may be a Sales Nav lead URL or an entityUrn.
  outreach_log.py add     --lead-id ID --kind connection|inmail --message TEXT [--pending] [--date YYYY-MM-DD]
        record a send. Refuses (exit 3) a person who is already in the log, and (exit 2) a
        connection request when the daily or 7-day cap is already reached, or an InMail / Open
        Profile message when the daily InMail cap is already reached. With --pending it
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
  outreach_log.py caps    [--for connection|followup|inmail|all] [--date YYYY-MM-DD] [--daily N] [--weekly N]
        connection requests sent today and in the last 7 days, follow-up messages sent today, and
        InMail / Open Profile messages sent today, against the limits. Exit 2 when a cap in scope is
        reached (do not send), else 0. InMail credits are a separate limit the user watches.
  outreach_log.py summary [--stale-days N] [--max-touches N]
        counts per status and kind; the pending rows (intent recorded, send not confirmed); with
        --stale-days, the people who accepted at least N days ago, have not replied and still have
        touches left (the follow-up candidates).

Status: pending -> sent -> accepted -> replied; withdrawn can follow any of pending, sent and
accepted. `replied` and `withdrawn` are final. `touches` counts messages we sent a person: the
first one plus follow-ups (0 while only pending). Dates are local calendar dates, written
YYYY-MM-DD; for add and followup --date may not be in the future or more than 2 days in the past
(log a send when it happens).

Limits come from reference.md ("Outreach caps and stop rules"; execution-action quotas: references/salesnav-kb/05-rate-caps-and-pacing.md). --daily, --weekly, --followup-daily and
--inmail-daily can lower a limit; a value above the default is ignored (with a note) unless --allow-over-cap is
given, and --allow-over-cap is only for the user's explicit go. Likewise --max-touches is clamped
to the default maximum, and add / followup stop at a reached cap, unless --allow-over-cap.

Where the ledger lives: the workspace folder (workspace.py): --workspace DIR, else the `workspace:` field of
the profile (--profile FILE), else $SALESNAV_WORKSPACE, else ~/Claude/sales-navigator when it exists. With none
of those the workspace is NOT located (the current folder is only a fallback that cannot persist). --log FILE
overrides the path and is trusted as located.

A missing ledger is never read as "nobody was contacted": every command REFUSES (exit 4, ask the user) when
the ledger is not found, and ALWAYS (even if a stray outreach_log.csv sits in the current folder, and even
with --first-send) when the workspace could not be located. Only the very first send
ever (the profile's `Outreach started` is blank) may start a new ledger: pass --first-send to add / check
/ caps / summary, and tell the user a new ledger is being created. status and followup never create one.

Exit codes: 0 fine, 1 bad input, 2 a cap is reached (caps, add, followup), 3 already contacted
(check, add), 4 ledger missing or workspace not located (do not send: ask the user).
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace  # noqa: E402

try:
    import fcntl
except ImportError:  # Windows: no advisory locks; the ledger is then only safe for one run at a time
    fcntl = None

# Source of truth: reference.md ("Outreach caps and stop rules"; see also references/salesnav-kb/05-rate-caps-and-pacing.md). A test fails if these drift.
DAILY_CONNECTION_CAP = 20
WEEKLY_CONNECTION_CAP = 100
DAILY_FOLLOWUP_CAP = 20
DAILY_INMAIL_CAP = 20
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

EXIT_OK, EXIT_BAD, EXIT_CAP, EXIT_CONTACTED, EXIT_NO_LEDGER = 0, 1, 2, 3, 4


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
    with open(p, newline="", encoding="utf-8-sig") as fh:  # utf-8-sig: Excel re-saves add a BOM
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
    """(daily, weekly, followup_daily, inmail_daily, notes). Lowering is free; raising needs --allow-over-cap."""
    notes = []
    out = []
    for value, default, label in ((args.daily, DAILY_CONNECTION_CAP, "daily"),
                                  (args.weekly, WEEKLY_CONNECTION_CAP, "weekly"),
                                  (args.followup_daily, DAILY_FOLLOWUP_CAP, "follow-up daily"),
                                  (args.inmail_daily, DAILY_INMAIL_CAP, "inmail daily")):
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
    return out[0], out[1], out[2], out[3], notes


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


def inmail_cap_reached(used, inmail_daily):
    """The daily InMail / Open Profile cap, as text, when a new message would exceed it."""
    if used["inmail_day"] >= inmail_daily:
        return "daily inmail cap reached (%d / %d today)" % (used["inmail_day"], inmail_daily)
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
    daily, weekly, _, inmail_cap, notes = resolve_limits(args)
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
        if args.kind in ("connection", "inmail"):
            used = usage(events, today, day)
            why = (cap_reached(used, daily, weekly) if args.kind == "connection"
                   else inmail_cap_reached(used, inmail_cap))
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
    _, _, followup_cap, _, notes = resolve_limits(args)
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
    daily, weekly, followup_cap, inmail_cap, notes = resolve_limits(args)
    used = usage(read_events(args.log), today)
    day_n, week_n, followups_today = used["day_n"], used["week_n"], used["followups_day"]
    d_status, w_status = classify(day_n, daily), classify(week_n, weekly)
    f_status = classify(followups_today, followup_cap)
    i_status = classify(used["inmail_day"], inmail_cap)
    print("Connection requests (%s)" % today.isoformat())
    print("  today      %3d / %-3d  %s" % (day_n, daily, d_status))
    print("  last %d d   %3d / %-3d  %s" % (WEEK_DAYS, week_n, weekly, w_status))
    print("  can still send today: %d" % max(0, min(daily - day_n, weekly - week_n)))
    print("Follow-up messages")
    print("  today      %3d / %-3d  %s" % (followups_today, followup_cap, f_status))
    print("InMail / Open Profile messages")
    print("  today      %3d / %-3d  %s" % (used["inmail_day"], inmail_cap, i_status))
    print("InMails sent: %d today, %d in the last %d days" % (used["inmail_day"], used["inmail_week"], WEEK_DAYS))
    for note in notes:
        print(note)
    if (daily > DAILY_CONNECTION_CAP or weekly > WEEKLY_CONNECTION_CAP
            or followup_cap > DAILY_FOLLOWUP_CAP or inmail_cap > DAILY_INMAIL_CAP):
        print("A limit is above its default (%d/day, %d/7 days, %d follow-ups/day, %d inmails/day): only with "
              "the user's explicit go." % (DAILY_CONNECTION_CAP, WEEKLY_CONNECTION_CAP, DAILY_FOLLOWUP_CAP,
                                           DAILY_INMAIL_CAP))
    scope = {"connection": (d_status, w_status), "followup": (f_status,),
             "inmail": (i_status,), "all": (d_status, w_status, f_status, i_status)}[args.scope]
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
    common.add_argument("--log", metavar="FILE", help="ledger CSV, overriding <workspace>/%s" % DEFAULT_LOG)
    common.add_argument("--workspace", metavar="DIR",
                        help="workspace folder (default: the profile's workspace:, else $SALESNAV_WORKSPACE, else "
                             "~/Claude/sales-navigator if it exists; none of them = not located, refused)")
    common.add_argument("--profile", metavar="FILE",
                        help="company-profile.md: its `workspace:` field locates the workspace when --workspace is absent")
    first = argparse.ArgumentParser(add_help=False)
    first.add_argument("--first-send", action="store_true",
                       help="ONLY for the very first send ever (profile `Outreach started` blank), with the user "
                            "told: allow a missing ledger and create it. Without it a missing ledger is refused")
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
    limits.add_argument("--inmail-daily", type=int, metavar="N",
                        help="InMail / Open Profile messages per day (default %d; lower is fine)" % DAILY_INMAIL_CAP)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    chk = sub.add_parser("check", parents=[common, first], help="exit 3 if anyone was already contacted")
    chk.add_argument("--lead-id", action="append", default=[], metavar="ID")
    chk.add_argument("--ids-file", metavar="FILE", help="one lead id / URL per line (# comments allowed)")

    add = sub.add_parser("add", parents=[common, limits, over, first],
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

    caps = sub.add_parser("caps", parents=[common, limits, over, first],
                          help="today / last 7 days vs the connection-request, follow-up and InMail caps")
    caps.add_argument("--date", metavar="YYYY-MM-DD", help="treat this as today")
    caps.add_argument("--for", dest="scope", choices=["connection", "followup", "inmail", "all"], default="all",
                      help="which caps decide the exit code: the kind of batch about to be sent (default %(default)s)")

    summ = sub.add_parser("summary", parents=[common, over, first],
                          help="counts per status; pending rows; follow-up candidates")
    summ.add_argument("--stale-days", type=int, metavar="N", help="list people accepted >= N days ago, no reply")
    summ.add_argument("--max-touches", type=int, default=MAX_TOUCHES, metavar="N",
                      help="leave out people who already had this many messages (default %(default)s; lower is fine)")
    summ.add_argument("--today", metavar="YYYY-MM-DD", help=argparse.SUPPRESS)
    return ap


COMMANDS = {"check": cmd_check, "add": cmd_add, "status": cmd_status, "followup": cmd_followup,
            "caps": cmd_caps, "summary": cmd_summary}


def ledger_present(path):
    p = Path(path)
    return p.is_file() and p.stat().st_size > 0


def ledger_gate(args, located):
    """None when the command may run, else the reason it must not (exit 4: ask the user).

    A ledger that cannot be found must never read as an empty one: that would clear everyone.
    """
    if not located:
        return ("the workspace could not be located, so there is no way to know who was contacted before. "
                "Do not send. Ask the user where their Cowork folder is (workspace.py init <folder>) and "
                "pass --workspace")
    if ledger_present(args.log):
        return None
    if getattr(args, "first_send", False):
        return None  # the very first send: the ledger is created explicitly (announced in main)
    return ("no outreach ledger at %s. Do not send. If outreach was done before, the ledger is missing "
            "(wrong workspace or lost file): ask the user where it is. Only if this is the very first "
            "send ever, tell the user a new ledger will be created and re-run with --first-send"
            % args.log)


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.log, located = workspace.state_file(DEFAULT_LOG, args.log, args.workspace, profile=args.profile)
        why = ledger_gate(args, located)
        if why:
            print("refused: %s" % why, file=sys.stderr)
            return EXIT_NO_LEDGER
        if not ledger_present(args.log):
            if args.command == "add":
                Path(args.log).parent.mkdir(parents=True, exist_ok=True)
                print("NOTE: first send ever: creating a new outreach ledger at %s (tell the user)" % args.log)
            else:
                print("NOTE: no outreach ledger yet at %s (--first-send): nothing has been sent" % args.log)
        return COMMANDS[args.command](args)
    except (LogError, OSError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_BAD


if __name__ == "__main__":
    sys.exit(main())
