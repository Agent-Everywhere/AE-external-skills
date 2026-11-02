#!/usr/bin/env python3
"""li_common.py: helpers shared by find_people.py, outreach.py and replies.py (Python 3 stdlib only, no network).

Not a command. It holds the pieces every ledger needs: UTC timestamps and rolling windows, the vanity whitelist,
atomic multi-file writes, a lock file, spreadsheet-formula and control-character guards, and the CLI wrapper.
"""
import contextlib
import csv
import datetime
import io
import json
import os
import re
import secrets
import sys
import tempfile
import time
from urllib.parse import quote, unquote

TS = "%Y-%m-%dT%H:%M:%SZ"
DAY = datetime.timedelta(hours=24)
WEEK = datetime.timedelta(days=7)
LOCK = ".lock"


class Fail(Exception):
    """A user-facing error: printed as `error: ...`, exit code 2."""


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


def in_window(at, now, window=DAY):
    return now - window < parse_ts(at) <= now


# ---- vanity -----------------------------------------------------------------------------------------------

BAD_DECODED = re.compile(r"[\x00-\x20\x7f\"'`$\\/<>;|&(){}\[\]*?!#]")


def decoded_ok(dec):
    return bool(dec) and bool(dec.strip(".")) and not BAD_DECODED.search(dec)


def parse_vanity(url):
    """(vanity, reason): the /in/<vanity> segment, URL-decoded; reason explains an empty vanity."""
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


def safe_vanity(v):
    """A vanity coming from a results file: decoded, whitelisted, or ''."""
    v = v.strip() if isinstance(v, str) else ""
    return v if decoded_ok(v) and len(v) <= 100 else ""


def profile_url(vanity):
    return "https://www.linkedin.com/in/%s/" % quote(vanity, safe="-_.~")


# ---- text -------------------------------------------------------------------------------------------------

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]")


def clean_text(s, limit=300):
    """One line of untrusted text: control and bidi characters become spaces, whitespace collapses, length is cut."""
    s = "" if s is None else str(s)
    return re.sub(r"\s+", " ", _CONTROL.sub(" ", s)).strip()[:limit]


def defuse(s):
    """Spreadsheet formula guard: a leading = + - @ tab or CR gets a single quote in front."""
    s = "" if s is None else str(s)
    return "'" + s if s and s[0] in "=+-@\t\r" else s


def undefuse(s):
    """Undo defuse(): a single leading quote in front of = + - @ tab or CR is the guard, not part of the value."""
    s = "" if s is None else str(s)
    return s[1:] if len(s) > 1 and s[0] == "'" and s[1] in "=+-@\t\r" else s


def text_arg(inline, file_path=None, use_stdin=False, what="value"):
    """A user-supplied value from exactly one source: the inline flag, a file, or stdin. Files and stdin keep the
    value out of the shell command line, where quotes, $ and backticks in it would be interpreted."""
    given = [x for x in (inline is not None, file_path is not None, bool(use_stdin)) if x]
    if len(given) != 1:
        raise Fail("give the %s exactly one way: inline, from a file, or on stdin" % what)
    if file_path is not None:
        try:
            with open(file_path, encoding="utf-8-sig") as f:
                return f.read().strip()
        except OSError as e:
            raise Fail("cannot read %s file %s: %s" % (what, file_path, e))
    if use_stdin:
        return sys.stdin.read().strip()
    return inline


def norm_key(name):
    return re.sub(r"[^a-z0-9]+", "_", (name or "").strip().lower()).strip("_")


def find_col(header, names):
    low = {h.strip().lower(): h for h in header}
    for n in names:
        if n in low:
            return low[n]
    return None


def compile_where(items, columns):
    """--where column=regex (repeatable). `columns` are the names it may refer to; matching is case-insensitive."""
    out = []
    low = {c.lower(): c for c in columns}
    for item in items or []:
        col, sep, pat = item.partition("=")
        if not sep or not col.strip():
            raise Fail("--where expects column=regex, got %r" % item)
        real = low.get(col.strip().lower())
        if not real:
            raise Fail("--where column %r not found; columns: %s" % (col, ", ".join(columns)))
        try:
            out.append((real, re.compile(pat, re.I)))
        except re.error as e:
            raise Fail("bad regex in --where %r: %s" % (item, e))
    return out


# ---- files ------------------------------------------------------------------------------------------------

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


STALE_LOCK_SECONDS = 120


@contextlib.contextmanager
def locked(d, tool="the script"):
    """Lock file (O_EXCL) so two runs never write the same working dir together.

    The file holds a random token. A lock older than STALE_LOCK_SECONDS (a crashed run) is taken over by renaming it
    away first, which only one contender can win; and a lock is unlinked on exit only if it still holds our token,
    so a run that outlived its lock never deletes the lock of the run that replaced it."""
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, LOCK)
    token = "%d:%s" % (os.getpid(), secrets.token_hex(8))

    def create():
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, token.encode())
        os.close(fd)

    try:
        create()
    except FileExistsError:
        try:
            stale = time.time() - os.path.getmtime(path) > STALE_LOCK_SECONDS
        except OSError:
            stale = False
        if not stale:
            raise Fail("another run of %s is using %s (lock file %s); wait a moment and retry" % (tool, d, path))
        grave = "%s.stale-%s" % (path, token.split(":")[1])
        try:
            os.rename(path, grave)   # atomic: exactly one contender wins the takeover
        except OSError:
            grave = None
        if grave:
            try:
                if time.time() - os.path.getmtime(grave) <= STALE_LOCK_SECONDS:   # we moved a live, fresh lock
                    os.rename(grave, path)
                    raise Fail("another run of %s is using %s (lock file %s); wait a moment and retry" % (tool, d, path))
                os.unlink(grave)
            except OSError:
                pass
        try:
            create()
        except FileExistsError:
            raise Fail("another run of %s took over %s (lock file %s); wait a moment and retry" % (tool, d, path))
    try:
        yield
    finally:
        try:
            with open(path, encoding="utf-8") as f:
                mine = f.read() == token
            if mine:
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


def read_dict_csv(path):
    rows = read_csv(path)
    if not rows:
        return [], []
    header = rows[0]
    return header, [dict(zip(header, (r + [""] * len(header))[: len(header)])) for r in rows[1:]
                    if any(c.strip() for c in r)]


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump_json(obj):
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def emit(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def load_results_file(path, what):
    """A page-snippet result saved to a file: a JSON object, or a JSON string holding one (console output)."""
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.loads(f.read().strip())
        if isinstance(data, str):
            data = json.loads(data)
    except (OSError, json.JSONDecodeError) as e:
        raise Fail("%s is not readable JSON (%s); save the exact output of %s" % (path, e, what))
    if not isinstance(data, dict):
        raise Fail("%s must be the output object of %s" % (path, what))
    return data


def run_main(build_parser, argv=None):
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
