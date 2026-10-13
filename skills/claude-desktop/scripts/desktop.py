#!/usr/bin/env python3
"""Small helper for driving the Claude Desktop app on macOS with Peekaboo.

Python 3 standard library only. It shells out to `peekaboo`, `open`, `sw_vers`
and `pgrep`; it makes no network calls of its own.

Subcommands:
  open       open a claude:// deep link that prefills a new Chat / Cowork / Code task
  activate   bring Claude to the front (any Space, un-minimize) and confirm it is frontmost
  frontmost-check  print the frontmost app and Claude's window count; exit 1 if Claude is not in front
  shot       capture a screenshot of the Claude window (activates first, recovers from "minimized")
  click      click at window-relative coordinates (refuses unless Claude is frontmost)
  type       type text into the focused field of the Claude window
  press      press a key or chord in the Claude window
  scroll     scroll the conversation or a list
  config-mcp list | add | remove local MCP servers in claude_desktop_config.json (backup + validation)
  wait-idle  poll screenshots until the window stops changing (pixel compare, tolerant of a blinking caret)
  approvals-log  add | show: append-only JSONL record of every approval prompt answered (count + warning)
  doctor     check macOS version, Peekaboo, permissions, and whether Claude runs
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zlib
from datetime import datetime
from urllib.parse import quote

APP = "Claude"

# Official documented deep links: https://support.claude.com/en/articles/14729294
MODE_URLS = {
    "cowork": "claude://cowork/new",
    "chat": "claude://claude.ai/new",
    "code": "claude://code/new",
}
MAX_PROMPT_CHARS = 14000  # documented limit is about 14k characters
MIN_MACOS_MAJOR = 15

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_TIMEOUT = 2

# wait-idle comparison: decode PNGs, average BLOCK x BLOCK pixel blocks, and call two captures equal
# when the fraction of blocks whose mean colour moved by more than BLOCK_DELTA (0-255, per channel)
# is at most the tolerance. A blinking text caret touches a handful of blocks out of tens of thousands.
BLOCK = 8
BLOCK_DELTA = 12
DEFAULT_TOLERANCE = 0.002
DEFAULT_IGNORE_BOTTOM = 140  # capture pixels; excludes the message-box strip with its caret


INDETERMINATE = "indeterminate"


class DesktopError(Exception):
    """A problem the user can act on; printed without a traceback."""


def build_url(mode, prompt, folder=None):
    """Return the deep link for `mode` that prefills `prompt` (and `folder` for code)."""
    if mode not in MODE_URLS:
        raise DesktopError("unknown mode %r (use one of: %s)" % (mode, ", ".join(sorted(MODE_URLS))))
    if not prompt or not prompt.strip():
        raise DesktopError("the prompt is empty")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise DesktopError("prompt is %d characters; deep links accept about %d. Shorten it, or "
                           "prefill a short prompt that points at a file." % (len(prompt), MAX_PROMPT_CHARS))
    if folder and mode != "code":
        raise DesktopError("--folder only applies to --mode code")
    url = "%s?q=%s" % (MODE_URLS[mode], quote(prompt, safe=""))
    if folder:
        url += "&folder=%s" % quote(folder, safe="")
    return url


def run(cmd, timeout=60):
    """Run a command, returning (returncode, combined output). Never raises on non-zero exit."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise DesktopError("command not found: %s" % cmd[0])
    except subprocess.TimeoutExpired:
        raise DesktopError("timed out after %ss: %s" % (timeout, " ".join(cmd)))
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def parse_coord(value):
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        raise DesktopError("coordinates must be numbers, got %r" % (value,))
    if n < 0:
        raise DesktopError("coordinates are window-relative and cannot be negative: %d" % n)
    return n


def _remove_stale(path):
    """Delete a leftover file at `path` so a stale image can never pass for the new capture."""
    if os.path.isdir(path):
        raise DesktopError("%s is a directory; give a file path for the screenshot" % path)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise DesktopError("cannot clear old screenshot %s: %s" % (path, exc))


def shot(path, runner=run, sleeper=time.sleep):
    """Capture the Claude window to `path`. If the window is minimized, bring the app up and retry.

    Any existing file at `path` is deleted before every capture attempt, so a file that is present
    afterwards was written by this call (wait-idle relies on this to never compare a stale frame).
    """
    cmd = ["peekaboo", "see", "--app", APP, "--no-elements", "--path", path]
    _remove_stale(path)
    code, out = runner(cmd)
    if code != 0 and "target changed during capture" in out.lower():
        # Transient: the window moved/redrew mid-capture. One automatic retry (seen to succeed live).
        sleeper(0.5)
        _remove_stale(path)
        code, out = runner(cmd)
    if code != 0 and "minimized" in out.lower():
        runner(["open", "-a", APP])
        sleeper(1.5)
        _remove_stale(path)
        code, out = runner(cmd)
    if code != 0:
        raise DesktopError("screenshot failed: %s" % out.strip()[:500])
    if not os.path.isfile(path):
        raise DesktopError("peekaboo reported success but %s was not written" % path)
    return path


def click(x, y, runner=run):
    code, out = runner(["peekaboo", "click", "--app", APP, "--foreground", "--at", "%d,%d" % (x, y)])
    if code != 0:
        raise DesktopError("click failed: %s" % out.strip()[:500])
    return out


def type_text(text, runner=run):
    cmd = ["peekaboo", "type", "--app", APP, "--foreground"]
    # Text that starts with '-' would be parsed as an option ("Unknown option -h"). Peekaboo 4.9.2
    # honours the `--` end-of-options separator (checked against `peekaboo type --help`/arg parsing).
    if text.startswith("-"):
        cmd.append("--")
    cmd.append(text)
    code, out = runner(cmd)
    # Peekaboo 4.9.2 often exits non-zero with "Action outcome is indeterminate" although the text
    # was typed. That is not a failure to retry blindly (a retry would type it twice): report it
    # and let the caller confirm with a screenshot.
    if code != 0 and "indeterminate" not in out.lower():
        raise DesktopError("type failed: %s" % out.strip()[:500])
    return out if code == 0 else INDETERMINATE


def press(chord, runner=run):
    code, out = runner(["peekaboo", "press", chord, "--app", APP, "--foreground"])
    if code != 0:
        raise DesktopError("press failed: %s" % out.strip()[:500])
    return out


# --- focus / window recovery -------------------------------------------------------------------
# Claude Desktop's window only exists for Peekaboo and System Events while Claude is the frontmost
# app on its Space. If anything else is in front (or the window sits on another Space, or is
# minimized) `peekaboo see` fails with "window minimized / target not found" even though the app is
# running. `open -a` and `tell application "Claude" to activate` did not fix it on the tested Mac;
# asking System Events to set the process frontmost does.
_SE = 'tell application "System Events" to '
_FRONT_APP = _SE + 'get name of first process whose frontmost is true'
_CLAUDE_STATE = _SE + 'tell process "%s" to get {frontmost, count of windows}' % APP
_SET_FRONT = _SE + 'tell process "%s" to set frontmost to true' % APP
_UNMINIMIZE = (_SE + 'tell process "%s" to if (count of windows) > 0 then '
               'set value of attribute "AXMinimized" of window 1 to false' % APP)


def automation_denied(out):
    """True when osascript output says macOS Automation permission for System Events is missing."""
    low = (out or "").lower()
    return "-1743" in low or "not authorized to send apple events" in low


AUTOMATION_HINT = ("Automation permission is missing: allow the terminal app that runs Claude Code to "
                   "control System Events (System Settings > Privacy & Security > Automation), then retry")


def frontmost_app(runner=run):
    code, out = runner(["osascript", "-e", _FRONT_APP])
    return out.strip() if code == 0 else ""


def claude_state(runner=run):
    """Return (is_frontmost, window_count); (False, 0) when the process is not running."""
    code, out = runner(["osascript", "-e", _CLAUDE_STATE])
    if code != 0:
        return False, 0
    parts = [p.strip() for p in out.strip().split(",")]
    try:
        return parts[0] == "true", int(parts[1])
    except (IndexError, ValueError):
        return False, 0


def activate(runner=run, sleeper=time.sleep, attempts=4):
    """Bring Claude to the front and wait until it is frontmost with a window. Returns the window count.

    Order per attempt: launch if not running, set frontmost via System Events (this also switches to
    the Space holding the window), un-minimize window 1, then re-check. Raises DesktopError when it
    cannot get there, so callers never send input to the wrong app.
    """
    for _ in range(attempts):
        front, windows = claude_state(runner)
        if not front or windows == 0:
            code, _out = runner(["pgrep", "-x", APP])
            if code != 0:
                runner(["open", "-a", APP])
                sleeper(3)
            runner(["osascript", "-e", _SET_FRONT])
            runner(["osascript", "-e", _UNMINIMIZE])
            sleeper(1.0)
            front, windows = claude_state(runner)
            if windows == 0:
                runner(["open", "-a", APP])  # asks the app to reopen a closed main window
                runner(["osascript", "-e", _SET_FRONT])
                sleeper(1.5)
                front, windows = claude_state(runner)
        if front and windows > 0:
            return windows
        sleeper(1.0)
    code, out = runner(["osascript", "-e", _FRONT_APP])
    if automation_denied(out):
        raise DesktopError("could not bring Claude to the front: System Events refused (-1743). %s. "
                           "Ask the user, do not send input." % AUTOMATION_HINT)
    raise DesktopError("could not bring Claude to the front (frontmost app is %r). Is it signed in and "
                       "not blocked by a system dialog? Ask the user, do not send input."
                       % (out.strip() if code == 0 else ""))


def require_front(runner=run, sleeper=time.sleep):
    """Activate, then refuse to continue unless Claude is frontmost right now. Call before any input."""
    activate(runner, sleeper)
    app = frontmost_app(runner)
    if app != APP:
        raise DesktopError("%r is frontmost, not Claude; refusing to send input" % app)


def shot_recovering(path, runner=run, sleeper=time.sleep, attempts=3):
    """Like shot(), but activates Claude first and re-activates on window-not-found errors."""
    last = None
    for _ in range(attempts):
        activate(runner, sleeper)
        try:
            return shot(path, runner=runner, sleeper=sleeper)
        except DesktopError as exc:
            last = exc
            text = str(exc).lower()
            if "minimized" not in text and "not found" not in text:
                raise
            sleeper(1.0)
    raise last


def png_size(path):
    """(width, height) of a PNG file, or None."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
    except OSError:
        return None
    if head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def scroll(direction, amount=5, at=None, runner=run):
    """Foreground scroll. Peekaboo 4.9.2 rejects --foreground with --at and wants a snapshot id for a
    background coordinate scroll, so `at` is handled by clicking that point first (pick an inert spot
    in the pane, such as blank space in the conversation) and scrolling where the pointer sits."""
    if direction not in ("up", "down", "left", "right"):
        raise DesktopError("direction must be up, down, left or right")
    if at:
        click(at[0], at[1], runner=runner)
    code, out = runner(["peekaboo", "scroll", "--app", APP, "--direction", direction,
                        "--amount", str(int(amount)), "--foreground"])
    if code != 0:
        raise DesktopError("scroll failed: %s" % out.strip()[:500])
    return out


# --- local MCP servers (claude_desktop_config.json) --------------------------------------------
CONFIG_PATH = os.path.expanduser("~/Library/Application Support/Claude/claude_desktop_config.json")
SERVER_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


def load_config(path):
    """Return the parsed config dict ({} if the file is absent). Raises DesktopError on invalid JSON."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        raise DesktopError("%s is not valid JSON, refusing to touch it: %s" % (path, exc))
    if not isinstance(data, dict):
        raise DesktopError("%s must hold a JSON object" % path)
    return data


def backup_config(path, now=None):
    """Copy the config next to itself with a unique timestamp. Returns the backup path (None if no file).

    The name carries microseconds plus a counter on collision, and the file is created exclusively,
    so an existing .bak-* is never overwritten.
    """
    if not os.path.exists(path):
        return None
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S-%f")
    for counter in range(1000):
        dest = "%s.bak-%s%s" % (path, stamp, "" if counter == 0 else "-%d" % counter)
        try:
            out = open(dest, "xb")
        except FileExistsError:
            continue
        try:
            with out, open(path, "rb") as src:
                shutil.copyfileobj(src, out)
            shutil.copystat(path, dest)
        except BaseException:
            try:
                os.unlink(dest)
            except OSError:
                pass
            raise
        return dest
    raise DesktopError("could not find an unused backup name next to %s" % path)


def write_config(path, data):
    """Validate by round-tripping, then replace atomically via a unique temp file in the same directory.

    The temp file gets the original file's permission bits (0600 for a new file) before os.replace.
    """
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    json.loads(text)
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except FileNotFoundError:
        mode = 0o600
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# --- mcp list: never show secrets ---------------------------------------------------------------
_SECRET_WORDS = r"(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|key|auth|credential|bearer|cookie|session)"
_KV_SECRET_RE = re.compile(r"((?<![\w.-])[\w.-]*" + _SECRET_WORDS + r"[\w.-]*=)([^&\s]*)", re.I)
_SECRET_FLAG_RE = re.compile(r"^-{1,2}[\w.-]*" + _SECRET_WORDS + r"[\w.-]*$", re.I)
_URL_USERINFO_RE = re.compile(r"(://[^/\s:@]*:)([^/\s@]+)(@)")
_HEADER_RE = re.compile(r"^((?:authorization|x-api-key|proxy-authorization)\s*:\s*).+$", re.I)
_KNOWN_TOKEN_RE = re.compile(r"(?:sk-|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|AKIA|eyJ|glpat-|npm_)[A-Za-z0-9_\-.]{8,}")
_RANDOM_RE = re.compile(r"^[A-Za-z0-9_+=-]{20,}$")
REDACTED = "<redacted>"


def _looks_random(value):
    """A long unbroken run of token characters mixing letters and digits (paths and words don't)."""
    return bool(_RANDOM_RE.match(value)) and any(c.isdigit() for c in value) and any(c.isalpha() for c in value)


def redact_args(args):
    """Return display strings for an args list with secret-looking values replaced. Never raises."""
    if not isinstance(args, list):
        return ["<args not a list>"]
    out = []
    hide_next = False
    for arg in args:
        if not isinstance(arg, str):
            out.append("<non-string arg>")
            hide_next = False
            continue
        if hide_next and not arg.startswith("-"):
            out.append(REDACTED)
            hide_next = False
            continue
        hide_next = False
        text = _KV_SECRET_RE.sub(lambda m: m.group(1) + REDACTED, arg)
        text = _URL_USERINFO_RE.sub(lambda m: m.group(1) + REDACTED + m.group(3), text)
        text = _HEADER_RE.sub(lambda m: m.group(1) + REDACTED, text)
        text = _KNOWN_TOKEN_RE.sub(REDACTED, text)
        if text == arg and _looks_random(arg):
            text = REDACTED
        if text == arg and _SECRET_FLAG_RE.match(arg):
            hide_next = True
        out.append(text)
    return out


def mcp_list(path):
    servers = load_config(path).get("mcpServers") or {}
    if not isinstance(servers, dict):
        return ["mcpServers is not an object (%s)" % type(servers).__name__]
    rows = []
    for name, spec in sorted(servers.items(), key=lambda kv: str(kv[0])):
        if not isinstance(spec, dict):
            rows.append("%s: <entry is not an object>" % name)
            continue
        command = spec.get("command")
        command = redact_args([command])[0] if isinstance(command, str) else "?"
        env = spec.get("env")
        if env is None or env == {}:
            env_note = ""
        elif isinstance(env, dict):
            env_note = "  [env names: %s; values hidden]" % ",".join(sorted(str(k) for k in env))
        else:
            env_note = "  [env: invalid shape, values hidden]"
        rows.append("%s: %s %s%s" % (name, command, " ".join(redact_args(spec.get("args") or [])), env_note))
    return rows


def prepare_mcp_add(path, name, command, args=(), env=(), replace=False):
    """Validate everything and return the new config dict. Writes nothing."""
    if not SERVER_NAME_RE.match(name or ""):
        raise DesktopError("server name must be letters, digits, . _ - (got %r)" % (name,))
    if not command:
        raise DesktopError("--command is required")
    env_map = {}
    for item in env:
        if "=" not in item:
            raise DesktopError("--env must be KEY=VALUE, got %r" % item)
        k, v = item.split("=", 1)
        env_map[k] = v
    data = load_config(path)
    servers = data.get("mcpServers")
    if servers is None:
        servers = {}
    if not isinstance(servers, dict):
        raise DesktopError("mcpServers in %s is not an object; refusing to touch it" % path)
    if name in servers and not replace:
        raise DesktopError("server %r already exists; pass --replace to overwrite just that entry" % name)
    entry = {"command": command}
    if args:
        entry["args"] = list(args)
    if env_map:
        entry["env"] = env_map
    servers[name] = entry
    data["mcpServers"] = servers
    return data


def prepare_mcp_remove(path, name):
    """Validate and return the new config dict with only `name` removed. Writes nothing."""
    data = load_config(path)
    servers = data.get("mcpServers")
    if not isinstance(servers, dict) or name not in servers:
        raise DesktopError("no server named %r in %s" % (name, path))
    del servers[name]
    return data


def commit_config(path, data, now=None):
    """Back up the current file, then write `data`. Returns the backup path."""
    backup = backup_config(path, now)
    write_config(path, data)
    return backup


def mcp_add(path, name, command, args=(), env=(), replace=False, now=None):
    """Add one stdio server under mcpServers. Never touches other keys. Returns the backup path."""
    return commit_config(path, prepare_mcp_add(path, name, command, args, env, replace), now)


def mcp_remove(path, name, now=None):
    """Remove one named server only. Returns the backup path."""
    return commit_config(path, prepare_mcp_remove(path, name), now)


def edit_mcp(path, prepare, restart=False, quit=None, launch=None, now=None):
    """Run `prepare()` (all validation, returns the new config; no writes), then commit it.

    With restart, validation runs BEFORE the app is quit, so invalid input never quits Claude. After
    the quit the config is re-read and re-prepared (the app rewrites it while exiting) and then
    committed. If anything fails after the quit, relaunch is attempted but can never mask the
    original error. Returns (backup_path, relaunched).
    """
    quit = quit or quit_app
    launch = launch or launch_app
    data = prepare()  # raises before any side effect
    if not restart:
        return commit_config(path, data, now), False
    try:
        quit()
        backup = commit_config(path, prepare(), now)
    except BaseException:
        try:
            launch()  # do not leave the app quit because the edit was refused
        except Exception as exc:
            print("warning: could not relaunch Claude Desktop: %s" % exc, file=sys.stderr)
        raise
    launch()
    return backup, True


def quit_app(runner=run, sleeper=time.sleep):
    """Quit Claude Desktop (stops any running task) and wait for the process to exit."""
    runner(["osascript", "-e", 'tell application "%s" to quit' % APP])
    for _ in range(20):
        code, _out = runner(["pgrep", "-x", APP])
        if code != 0:
            return
        sleeper(1)
    raise DesktopError("Claude did not quit within 20s (a dialog may be asking to confirm); ask the user")


def launch_app(runner=run, sleeper=time.sleep):
    runner(["open", "-a", APP])
    sleeper(4)
    activate(runner, sleeper)


class PngUnsupported(Exception):
    """The bytes are not a PNG this module can decode (not 8-bit RGB/RGBA non-interlaced)."""


def png_block_means(data, block=BLOCK, ignore_bottom=0):
    """Decode an 8-bit RGB/RGBA non-interlaced PNG into per-block mean colours.

    Returns (width, height, means) where `means` is a list of block rows, each a list of (r, g, b)
    tuples. The bottom `ignore_bottom` pixel rows are neither unfiltered nor compared (the option is
    ignored when it would remove the whole image). Raises PngUnsupported for anything else.
    """
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise PngUnsupported("not a PNG")
    pos = 8
    ihdr = None
    idat = []
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], "big")
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            raise PngUnsupported("truncated PNG")
        pos += 12 + length
        if ctype == b"IHDR":
            ihdr = body
        elif ctype == b"IDAT":
            idat.append(body)
        elif ctype == b"IEND":
            break
    if ihdr is None or len(ihdr) != 13 or not idat:
        raise PngUnsupported("missing IHDR/IDAT")
    width = int.from_bytes(ihdr[0:4], "big")
    height = int.from_bytes(ihdr[4:8], "big")
    depth, color, interlace = ihdr[8], ihdr[9], ihdr[12]
    if depth != 8 or color not in (2, 6) or interlace != 0:
        raise PngUnsupported("bit depth %d, colour type %d, interlace %d" % (depth, color, interlace))
    if width == 0 or height == 0:
        raise PngUnsupported("empty image")
    bpp = 3 if color == 2 else 4
    stride = width * bpp
    try:
        raw = zlib.decompress(b"".join(idat))
    except zlib.error as exc:
        raise PngUnsupported("bad zlib stream: %s" % exc)
    if len(raw) < height * (stride + 1):
        raise PngUnsupported("short pixel data")

    rows_needed = height - ignore_bottom if 0 < ignore_bottom < height else height
    means = []
    prev = bytearray(stride)
    acc = None  # per channel, running sums per block column
    acc_rows = 0
    ncols = (width + block - 1) // block

    def flush():
        out = []
        for i in range(ncols):
            n = min(block, width - i * block) * acc_rows
            out.append(tuple(acc[ch][i] // n for ch in range(3)))
        means.append(out)

    for y in range(rows_needed):
        off = y * (stride + 1)
        ftype = raw[off]
        cur = bytearray(raw[off + 1:off + 1 + stride])
        if ftype == 1:
            for i in range(bpp, stride):
                cur[i] = (cur[i] + cur[i - bpp]) & 255
        elif ftype == 2:
            cur = bytearray((a + b) & 255 for a, b in zip(cur, prev))
        elif ftype == 3:
            for i in range(stride):
                left = cur[i - bpp] if i >= bpp else 0
                cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 255
        elif ftype == 4:
            for i in range(stride):
                a = cur[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cur[i] = (cur[i] + pred) & 255
        elif ftype != 0:
            raise PngUnsupported("bad filter type %d" % ftype)
        prev = cur
        if acc is None:
            acc = [[0] * ncols for _ in range(3)]
            acc_rows = 0
        for ch in range(3):
            vals = cur[ch::bpp]
            sums = [sum(vals[i:i + block]) for i in range(0, width, block)]
            acc[ch] = [p + q for p, q in zip(acc[ch], sums)]
        acc_rows += 1
        if acc_rows == block:
            flush()
            acc = None
    if acc is not None:
        flush()
    return width, rows_needed, means


def fingerprint(data, ignore_bottom=DEFAULT_IGNORE_BOTTOM, warn=None):
    """Comparable fingerprint of a capture: decoded blocks for a readable PNG, else a byte hash."""
    try:
        return ("png",) + png_block_means(data, ignore_bottom=ignore_bottom)
    except PngUnsupported as exc:
        if warn:
            warn("warning: cannot decode screenshot (%s); comparing raw bytes" % exc)
        return ("raw", hashlib.sha256(data).hexdigest())


def fingerprints_equal(a, b, tolerance=DEFAULT_TOLERANCE):
    """True when two fingerprints match: same bytes, or same size with changed-block fraction <= tolerance."""
    if a[0] != b[0]:
        return False
    if a[0] == "raw":
        return a[1] == b[1]
    if a[1:3] != b[1:3]:
        return False
    changed = total = 0
    for row_a, row_b in zip(a[3], b[3]):
        for pa, pb in zip(row_a, row_b):
            total += 1
            if sum(abs(x - y) for x, y in zip(pa, pb)) > 3 * BLOCK_DELTA:
                changed += 1
    return total > 0 and changed / total <= tolerance


def _warn_stderr(msg):
    print(msg, file=sys.stderr)


def wait_idle(capture, timeout=120.0, interval=6.0, stable=2, clock=time.monotonic, sleeper=time.sleep,
              tolerance=DEFAULT_TOLERANCE, ignore_bottom=DEFAULT_IGNORE_BOTTOM, warn=_warn_stderr):
    """Poll `capture()` (returns PNG bytes) until `stable` consecutive captures look the same.

    Captures are compared by decoded pixels (`fingerprints_equal`) with the bottom `ignore_bottom`
    pixel rows excluded, so a blinking caret does not keep the window "busy". Anything that is not an
    8-bit RGB/RGBA non-interlaced PNG falls back to a byte compare, with one warning.

    Returns (status, captures, last_bytes) where status is "idle" or "timeout".
    The first capture is always taken, so a window that is already still returns
    after `stable` captures, one `interval` apart.
    """
    if stable < 2:
        raise DesktopError("--stable must be at least 2")
    if not 0 <= tolerance <= 1:
        raise DesktopError("--tolerance must be between 0 and 1")
    if ignore_bottom < 0:
        raise DesktopError("--ignore-bottom cannot be negative")
    deadline = clock() + timeout
    run_length = 0
    prev = None
    captures = 0
    data = b""
    warned = []

    def warn_once(msg):
        if warn and not warned:
            warned.append(msg)
            warn(msg)

    while True:
        data = capture()
        captures += 1
        fp = fingerprint(data, ignore_bottom, warn_once)
        run_length = run_length + 1 if prev is not None and fingerprints_equal(prev, fp, tolerance) else 1
        prev = fp
        if run_length >= stable:
            return "idle", captures, data
        if clock() + interval > deadline:
            return "timeout", captures, data
        sleeper(interval)


# --- approvals log -------------------------------------------------------------------------------
# Every approval prompt answered in Claude Desktop is recorded here so the run can later prove which
# button was clicked (for example that no "Allow all for this website" was granted). Append-only JSONL.
DEFAULT_APPROVALS_LOG = "desktop-approvals.jsonl"
APPROVAL_WARN_AT = 5
_BROAD_RE = re.compile(r"allow\s+all|always|for\s+this\s+(?:task|website|site|chat|session)|don'?t\s+ask\s+again|"
                       r"skip\s+all", re.I)


def is_broad_approval(button, prompt=""):
    """True when the clicked button looks like a standing grant ("Allow all", "Always allow", ...)."""
    return bool(_BROAD_RE.search(button or ""))


def read_approvals(path):
    """Return the list of approval entries in the JSONL log (empty if the file is absent)."""
    if not os.path.exists(path):
        return []
    entries = []
    try:
        with open(path, encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                except ValueError:
                    raise DesktopError("%s line %d is not valid JSON; refusing to guess" % (path, n))
                if not isinstance(item, dict):
                    raise DesktopError("%s line %d is not a JSON object" % (path, n))
                entries.append(item)
    except OSError as exc:
        raise DesktopError("cannot read approvals log %s: %s" % (path, exc))
    return entries


def add_approval(path, prompt, button, shot_path, now=None):
    """Append one approval record. Returns (entry, count, warnings). All three fields are required."""
    for name, value in (("--prompt", prompt), ("--button", button), ("--shot", shot_path)):
        if not value or not value.strip():
            raise DesktopError("%s is required: log the exact prompt text, the button you clicked, and the "
                               "screenshot path that shows the whole prompt" % name)
    entry = {
        "time": (now or datetime.now()).isoformat(timespec="seconds"),
        "prompt": prompt.strip(),
        "button": button.strip(),
        "shot": shot_path.strip(),
        "broad": is_broad_approval(button),
    }
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    count = len(read_approvals(path)) + 1
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
    except OSError as exc:
        raise DesktopError("cannot write approvals log %s: %s" % (path, exc))
    warnings = []
    if entry["broad"]:
        warnings.append("WARNING: %r looks like a standing grant (Allow all / Always / for this task). That "
                        "needs the user's explicit OK for that exact scope; tell the user now." % entry["button"])
    if count >= APPROVAL_WARN_AT:
        warnings.append("WARNING: %d approvals logged in this run. STOP clicking approvals and ask the user "
                        "whether they would rather allow these themselves." % count)
    return entry, count, warnings


def format_approvals(entries):
    """Human-readable lines for `approvals-log show`, ending with the count and any warnings."""
    lines = []
    for i, e in enumerate(entries, 1):
        lines.append("%d. %s  button=%r%s\n   prompt: %s\n   shot: %s" % (
            i, e.get("time", "?"), e.get("button", "?"), "  [BROAD GRANT]" if e.get("broad") else "",
            e.get("prompt", "?"), e.get("shot", "?")))
    lines.append("%d approval(s) logged; %d broad grant(s)" % (len(entries), sum(1 for e in entries if e.get("broad"))))
    if len(entries) >= APPROVAL_WARN_AT:
        lines.append("WARNING: %d or more approvals; ask the user before clicking more." % APPROVAL_WARN_AT)
    return lines


def macos_major(version):
    try:
        return int(version.strip().split(".")[0])
    except (ValueError, IndexError):
        return None


def doctor(runner=run):
    """Return (ok, lines). Checks are advisory; permissions are the common failure."""
    ok = True
    lines = []
    code, out = runner(["sw_vers", "-productVersion"])
    major = macos_major(out) if code == 0 else None
    if major is None:
        ok = False
        lines.append("FAIL macOS version: could not read (is this a Mac?)")
    elif major < MIN_MACOS_MAJOR:
        ok = False
        lines.append("FAIL macOS %s: Peekaboo needs macOS %d or newer" % (out.strip(), MIN_MACOS_MAJOR))
    else:
        lines.append("ok   macOS %s" % out.strip())
    try:
        code, out = runner(["peekaboo", "--version"])
    except DesktopError:
        code, out = 127, ""
    if code != 0:
        ok = False
        lines.append("FAIL peekaboo not found: brew install openclaw/tap/peekaboo (or use npx -y @steipete/peekaboo)")
    else:
        lines.append("ok   %s" % out.strip().splitlines()[0])
        code, out = runner(["peekaboo", "permissions", "status"])
        for line in out.strip().splitlines():
            lines.append("     " + line)
        if code != 0 or out.count("(Required): Granted") < 2:
            ok = False
            lines.append("FAIL Screen Recording and Accessibility must both be granted to the terminal "
                         "app that runs Claude Code (System Settings > Privacy & Security)")
    try:
        code, out = runner(["osascript", "-e", _FRONT_APP])
    except DesktopError as exc:
        code, out = 1, str(exc)
    if code == 0:
        lines.append("ok   Automation: System Events accepts Apple events (needed to focus Claude)")
    elif automation_denied(out):
        ok = False
        lines.append("FAIL Automation permission denied (-1743) for System Events. " + AUTOMATION_HINT)
    else:
        ok = False
        lines.append("FAIL System Events check failed: %s" % out.strip()[:300])
    code, _ = runner(["pgrep", "-x", APP])
    if code != 0:
        ok = False
        lines.append("FAIL Claude Desktop is not running: open -a Claude, then sign in")
    else:
        lines.append("ok   Claude Desktop is running (sign-in is not checked; confirm in a screenshot)")
    return ok, lines


def read_prompt(args):
    if args.prompt_file and args.prompt:
        raise DesktopError("use either --prompt or --prompt-file, not both")
    if args.prompt_file:
        try:
            with open(args.prompt_file, encoding="utf-8") as fh:
                return fh.read().rstrip("\n")
        except OSError as exc:
            raise DesktopError("cannot read prompt file: %s" % exc)
    if args.prompt:
        return args.prompt
    raise DesktopError("give --prompt-file FILE (or --prompt TEXT)")


def make_parser():
    p = argparse.ArgumentParser(prog="desktop.py", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    o = sub.add_parser("open", help="open a deep link that prefills a new task (never submits)")
    o.add_argument("--mode", required=True, choices=sorted(MODE_URLS))
    o.add_argument("--prompt-file")
    o.add_argument("--prompt")
    o.add_argument("--folder", help="code mode only; Claude Desktop asks the user to confirm it")
    o.add_argument("--dry-run", action="store_true", help="print the URL without opening it")

    sub.add_parser("activate", help="bring Claude to the front (any Space, un-minimize) and confirm")
    sub.add_parser("frontmost-check", help="print frontmost app and Claude window count; exit 1 unless Claude is in front")

    s = sub.add_parser("shot", help="screenshot the Claude window (activates first)")
    s.add_argument("path")
    s.add_argument("--no-activate", action="store_true", help="skip the activate step")

    c = sub.add_parser("click", help="click at window-relative X Y")
    c.add_argument("x")
    c.add_argument("y")

    t = sub.add_parser("type", help="type text into the focused field")
    t.add_argument("text")

    k = sub.add_parser("press", help="press a key or chord, e.g. return or cmd+a")
    k.add_argument("chord")

    sc = sub.add_parser("scroll", help="scroll the Claude window")
    sc.add_argument("direction", choices=["up", "down", "left", "right"])
    sc.add_argument("--amount", type=int, default=5)
    sc.add_argument("--at", help="X,Y window-relative point to scroll over")

    m = sub.add_parser("config-mcp", help="list/add/remove local MCP servers in claude_desktop_config.json")
    m.add_argument("action", choices=["list", "add", "remove"])
    m.add_argument("name", nargs="?")
    m.add_argument("--command", help="add: executable to run (stdio server)")
    m.add_argument("--arg", action="append", default=[], help="add: one argument (repeat)")
    m.add_argument("--env", action="append", default=[], help="add: KEY=VALUE (never put secrets here)")
    m.add_argument("--replace", action="store_true", help="add: overwrite an existing entry of that name")
    m.add_argument("--restart", action="store_true", help="quit and relaunch Claude Desktop afterwards (stops running tasks)")
    m.add_argument("--config", default=CONFIG_PATH, help="config file (default: Claude Desktop's)")

    w = sub.add_parser("wait-idle", help="poll screenshots until consecutive captures match (pixel compare)")
    w.add_argument("--timeout", type=float, default=120.0, help="seconds (default 120)")
    w.add_argument("--interval", type=float, default=6.0, help="seconds between captures (default 6)")
    w.add_argument("--stable", type=int, default=2, help="matching consecutive captures required (default 2)")
    w.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE,
                   help="max fraction of 8x8 blocks that may differ and still count as the same "
                        "(default %s)" % DEFAULT_TOLERANCE)
    w.add_argument("--ignore-bottom", type=int, default=DEFAULT_IGNORE_BOTTOM, metavar="N",
                   help="ignore the bottom N capture pixels (message box and its blinking caret; default %d, "
                        "0 compares the whole window)" % DEFAULT_IGNORE_BOTTOM)
    w.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "claude-desktop-last.png"),
                   help="where to leave the final screenshot")

    al = sub.add_parser("approvals-log", help="record or list approval prompts answered (JSONL)")
    al.add_argument("action", choices=["add", "show"])
    al.add_argument("--log", default=DEFAULT_APPROVALS_LOG,
                    help="JSONL file (default ./%s); pick a directory the user can read" % DEFAULT_APPROVALS_LOG)
    al.add_argument("--prompt", help="add: the prompt text as read from the screenshot")
    al.add_argument("--button", help="add: the exact label of the button you clicked")
    al.add_argument("--shot", help="add: path of the screenshot showing the whole prompt")

    sub.add_parser("doctor", help="check macOS, Peekaboo, permissions, and Claude Desktop")
    return p


def main(argv=None):
    args = make_parser().parse_args(argv)
    try:
        if args.cmd == "open":
            url = build_url(args.mode, read_prompt(args), args.folder)
            if args.dry_run:
                print(url)
                return EXIT_OK
            code, out = run(["open", url])
            if code != 0:
                raise DesktopError("open failed: %s" % out.strip()[:500])
            print("opened %s task (prefilled, not submitted); screenshot next" % args.mode)
        elif args.cmd == "activate":
            print("Claude is frontmost with %d window(s)" % activate())
        elif args.cmd == "frontmost-check":
            front, windows = claude_state()
            print("frontmost=%s claude_frontmost=%s claude_windows=%d" % (frontmost_app(), front, windows))
            return EXIT_OK if front and windows else EXIT_ERROR
        elif args.cmd == "shot":
            path = shot(args.path) if args.no_activate else shot_recovering(args.path)
            size = png_size(path)
            print("%s%s" % (path, "  (%dx%d px)" % size if size else ""))
        elif args.cmd == "click":
            x, y = parse_coord(args.x), parse_coord(args.y)
            require_front()
            click(x, y)
            print("clicked %s,%s" % (args.x, args.y))
        elif args.cmd == "type":
            require_front()
            res = type_text(args.text)
            if res == INDETERMINATE:
                print("typed %d characters (peekaboo reported the outcome as indeterminate: screenshot to "
                      "confirm; do NOT retype blindly)" % len(args.text))
            else:
                print("typed %d characters" % len(args.text))
        elif args.cmd == "press":
            require_front()
            press(args.chord)
            print("pressed %s" % args.chord)
        elif args.cmd == "scroll":
            at = None
            if args.at:
                try:
                    ax, ay = args.at.split(",")
                except ValueError:
                    raise DesktopError("--at must be X,Y")
                at = (parse_coord(ax), parse_coord(ay))
            require_front()
            scroll(args.direction, args.amount, at)
            print("scrolled %s %d" % (args.direction, args.amount))
        elif args.cmd == "config-mcp":
            if args.action == "list":
                rows = mcp_list(args.config)
                print("\n".join(rows) if rows else "no mcpServers in %s" % args.config)
            else:
                if not args.name:
                    raise DesktopError("give the server name")
                # Claude Desktop rewrites this file itself, so with --restart validate first, quit,
                # re-read, edit, relaunch (edit_mcp).
                if args.action == "add":
                    def prepare():
                        return prepare_mcp_add(args.config, args.name, args.command, args.arg, args.env,
                                               args.replace)
                else:
                    def prepare():
                        return prepare_mcp_remove(args.config, args.name)
                backup, relaunched = edit_mcp(args.config, prepare, restart=args.restart)
                print("%s %s; backup: %s" % ("added" if args.action == "add" else "removed", args.name, backup))
                if relaunched:
                    print("Claude Desktop relaunched")
                else:
                    print("Claude Desktop must be quit and reopened for this to take effect; it also rewrites "
                          "this file while running, so prefer --restart")
        elif args.cmd == "wait-idle":
            tmp = tempfile.mkdtemp(prefix="claude-desktop-")
            frame = os.path.join(tmp, "frame.png")

            def capture():
                shot_recovering(frame)
                with open(frame, "rb") as fh:
                    return fh.read()

            try:
                status, captures, data = wait_idle(capture, args.timeout, args.interval, args.stable,
                                                  tolerance=args.tolerance, ignore_bottom=args.ignore_bottom)
                with open(args.out, "wb") as fh:
                    fh.write(data)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            print("%s after %d captures; last screenshot: %s" % (status, captures, args.out))
            print("REMINDER: 'idle' only means the screen stopped changing; it can mean Cowork is blocked on "
                  "an approval prompt. Read %s now (and scroll: stacked prompts can push the reply box off "
                  "screen) before assuming the task finished." % args.out)
            return EXIT_OK if status == "idle" else EXIT_TIMEOUT
        elif args.cmd == "approvals-log":
            if args.action == "add":
                entry, count, warnings = add_approval(args.log, args.prompt, args.button, args.shot)
                print("logged approval #%d to %s: %r" % (count, args.log, entry["button"]))
                for w in warnings:
                    print(w, file=sys.stderr)
            else:
                print("\n".join(format_approvals(read_approvals(args.log))))
        elif args.cmd == "doctor":
            ok, lines = doctor()
            print("\n".join(lines))
            return EXIT_OK if ok else EXIT_ERROR
    except DesktopError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_ERROR
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
