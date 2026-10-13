"""Tests for skills/claude-desktop/scripts/desktop.py. No Peekaboo or Claude Desktop needed."""
import hashlib
import importlib.util
import json
import os
import struct
import tempfile
import threading
import time
import unittest
import zlib
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("desktop", ROOT / "skills" / "claude-desktop" / "scripts" / "desktop.py")
desktop = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(desktop)


class UrlBuilding(unittest.TestCase):
    def test_mode_to_url_mapping(self):
        self.assertTrue(desktop.build_url("cowork", "hi").startswith("claude://cowork/new?q="))
        self.assertTrue(desktop.build_url("chat", "hi").startswith("claude://claude.ai/new?q="))
        self.assertTrue(desktop.build_url("code", "hi").startswith("claude://code/new?q="))

    def test_prompt_is_fully_percent_encoded_and_round_trips(self):
        prompt = "Run /my-skill & show a=b?c#d\nsecond line, 100% é \"quoted\""
        url = desktop.build_url("cowork", prompt)
        self.assertNotIn(" ", url)
        self.assertNotIn("\n", url)
        self.assertNotIn("&", urlsplit(url).query)
        self.assertEqual(parse_qs(urlsplit(url).query)["q"], [prompt])

    def test_folder_only_for_code_and_is_encoded(self):
        url = desktop.build_url("code", "hi", folder="/Users/me/My Project")
        qs = parse_qs(urlsplit(url).query)
        self.assertEqual(qs["folder"], ["/Users/me/My Project"])
        self.assertNotIn(" ", url)
        with self.assertRaises(desktop.DesktopError):
            desktop.build_url("chat", "hi", folder="/tmp")

    def test_rejects_bad_input(self):
        with self.assertRaises(desktop.DesktopError):
            desktop.build_url("browser", "hi")
        with self.assertRaises(desktop.DesktopError):
            desktop.build_url("chat", "   ")
        with self.assertRaises(desktop.DesktopError):
            desktop.build_url("chat", "x" * (desktop.MAX_PROMPT_CHARS + 1))
        desktop.build_url("chat", "x" * desktop.MAX_PROMPT_CHARS)


class ArgParsing(unittest.TestCase):
    def test_open_dry_run_from_prompt_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = os.path.join(tmp, "p.txt")
            Path(f).write_text("hello world\n", encoding="utf-8")
            args = desktop.make_parser().parse_args(["open", "--mode", "cowork", "--prompt-file", f, "--dry-run"])
            self.assertEqual(args.mode, "cowork")
            self.assertTrue(args.dry_run)
            self.assertEqual(desktop.read_prompt(args), "hello world")
            self.assertEqual(desktop.main(["open", "--mode", "cowork", "--prompt-file", f, "--dry-run"]), 0)

    def test_mode_is_required_and_validated(self):
        with self.assertRaises(SystemExit):
            desktop.make_parser().parse_args(["open", "--prompt", "x"])
        with self.assertRaises(SystemExit):
            desktop.make_parser().parse_args(["open", "--mode", "nope", "--prompt", "x"])

    def test_prompt_source_rules(self):
        parse = desktop.make_parser().parse_args
        with self.assertRaises(desktop.DesktopError):
            desktop.read_prompt(parse(["open", "--mode", "chat"]))
        with self.assertRaises(desktop.DesktopError):
            desktop.read_prompt(parse(["open", "--mode", "chat", "--prompt", "a", "--prompt-file", "b"]))
        with self.assertRaises(desktop.DesktopError):
            desktop.read_prompt(parse(["open", "--mode", "chat", "--prompt-file", "/no/such/file"]))

    def test_coordinates(self):
        self.assertEqual(desktop.parse_coord("120"), 120)
        self.assertEqual(desktop.parse_coord("120.7"), 120)
        for bad in ("abc", "-5", ""):
            with self.assertRaises(desktop.DesktopError):
                desktop.parse_coord(bad)

    def test_wait_idle_args_and_defaults(self):
        args = desktop.make_parser().parse_args(["wait-idle", "--timeout", "30"])
        self.assertEqual((args.timeout, args.interval, args.stable), (30.0, 6.0, 2))
        self.assertEqual((args.tolerance, args.ignore_bottom), (0.002, 140))
        args = desktop.make_parser().parse_args(["wait-idle", "--tolerance", "0.05", "--ignore-bottom", "0"])
        self.assertEqual((args.tolerance, args.ignore_bottom), (0.05, 0))


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class WaitIdle(unittest.TestCase):
    def run_with(self, frames, **kw):
        clock = FakeClock()
        it = iter(frames)
        last = []

        def capture():
            try:
                last.append(next(it))
            except StopIteration:
                pass
            return last[-1]

        return desktop.wait_idle(capture, clock=clock.clock, sleeper=clock.sleep, **kw)

    def test_returns_when_two_consecutive_captures_match(self):
        status, n, data = self.run_with([b"a", b"b", b"c", b"c"], timeout=100, interval=5)
        self.assertEqual((status, n, data), ("idle", 4, b"c"))

    def test_already_still_window_needs_two_captures(self):
        self.assertEqual(self.run_with([b"x", b"x"], timeout=100, interval=5)[:2], ("idle", 2))

    def test_non_consecutive_repeats_do_not_count(self):
        status, n, _ = self.run_with([b"a", b"b"] * 30, timeout=100, interval=5)
        self.assertEqual(status, "timeout")

    def test_times_out_when_always_changing(self):
        frames = [bytes([i]) for i in range(50)]
        status, n, _ = self.run_with(frames, timeout=20, interval=5)
        self.assertEqual(status, "timeout")
        self.assertLessEqual(n, 5)

    def test_stable_three_requires_three_identical(self):
        status, n, _ = self.run_with([b"a", b"a", b"b", b"b", b"b"], timeout=100, interval=5, stable=3)
        self.assertEqual((status, n), ("idle", 5))

    def test_stable_below_two_is_rejected(self):
        with self.assertRaises(desktop.DesktopError):
            self.run_with([b"a"], stable=1)


def _chunk(kind, body):
    crc = zlib.crc32(kind + body) & 0xFFFFFFFF
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)


def make_png(width, height, pixel, channels=3, filters=(0,), depth=8, interlace=0):
    """Tiny stdlib PNG encoder. `pixel(x, y)` returns an (r, g, b) tuple; row y uses filters[y % len]."""
    color = 2 if channels == 3 else 6
    rows = []
    prev = bytearray(width * channels)
    for y in range(height):
        cur = bytearray()
        for x in range(width):
            cur.extend(pixel(x, y))
            if channels == 4:
                cur.append(255)
        ftype = filters[y % len(filters)]
        out = bytearray()
        for i, v in enumerate(cur):
            a = cur[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            pred = (0, a, b, (a + b) >> 1, _paeth(a, b, c))[ftype]
            out.append((v - pred) & 255)
        rows.append(bytes([ftype]) + bytes(out))
        prev = cur
    ihdr = struct.pack(">IIBBBBB", width, height, depth, color, 0, 0, interlace)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(b"".join(rows))) + _chunk(b"IEND", b""))


W, H = 800, 600


def base_pixel(x, y):
    return (30 + x % 7, 40 + y % 5, 50)  # mild texture, below the block delta everywhere


def with_patch(x0, y0, x1, y1, color=(255, 255, 255)):
    def pixel(x, y):
        return color if x0 <= x < x1 and y0 <= y < y1 else base_pixel(x, y)
    return pixel


class PngCompare(unittest.TestCase):
    def fp(self, pixel, channels=3, ignore_bottom=140, **kw):
        return desktop.fingerprint(make_png(W, H, pixel, channels, **kw), ignore_bottom)

    def test_decoder_round_trips_every_filter_type_rgb_and_rgba(self):
        def grad(x, y):
            return ((x * 3) % 256, (y * 5) % 256, (x + y) % 256)
        ref = desktop.png_block_means(make_png(64, 40, grad), ignore_bottom=0)
        for ch in (3, 4):
            for f in (0, 1, 2, 3, 4, (0, 1, 2, 3, 4)):
                png = make_png(64, 40, grad, channels=ch, filters=f if isinstance(f, tuple) else (f,))
                self.assertEqual(desktop.png_block_means(png, ignore_bottom=0), ref, (ch, f))
        # spot-check a block mean against the raw pixels
        _, _, means = ref
        xs, ys = range(8), range(8)
        self.assertEqual(means[0][0][0], sum(grad(x, y)[0] for x in xs for y in ys) // 64)

    def test_identical_captures_are_equal(self):
        self.assertTrue(desktop.fingerprints_equal(self.fp(base_pixel), self.fp(base_pixel)))

    def test_caret_sized_change_is_equal(self):
        caret = with_patch(300, 200, 302, 218)  # 2x18 px, outside the ignored strip
        a, b = self.fp(base_pixel), self.fp(caret)
        self.assertNotEqual(make_png(W, H, base_pixel), make_png(W, H, caret))
        self.assertTrue(desktop.fingerprints_equal(a, b))

    def test_large_change_is_different(self):
        big = with_patch(100, 100, 500, 300)
        self.assertFalse(desktop.fingerprints_equal(self.fp(base_pixel), self.fp(big)))

    def test_tolerance_zero_flags_even_a_caret(self):
        caret = with_patch(300, 200, 302, 218)
        self.assertFalse(desktop.fingerprints_equal(self.fp(base_pixel), self.fp(caret), tolerance=0))
        self.assertTrue(desktop.fingerprints_equal(self.fp(base_pixel), self.fp(base_pixel), tolerance=0))

    def test_bottom_strip_change_is_ignored_unless_disabled(self):
        strip = with_patch(0, H - 100, W, H)  # inside the bottom 140 px
        self.assertTrue(desktop.fingerprints_equal(self.fp(base_pixel), self.fp(strip)))
        self.assertFalse(desktop.fingerprints_equal(self.fp(base_pixel, ignore_bottom=0),
                                                    self.fp(strip, ignore_bottom=0)))

    def test_different_dimensions_are_different(self):
        small = desktop.fingerprint(make_png(W, H - 8, base_pixel), 0)
        self.assertFalse(desktop.fingerprints_equal(self.fp(base_pixel, ignore_bottom=0), small))

    def test_rgba_matches_rgb(self):
        self.assertTrue(desktop.fingerprints_equal(self.fp(base_pixel, 3), self.fp(base_pixel, 4)))

    def test_unsupported_png_falls_back_to_bytes_with_warning(self):
        warnings = []
        a = desktop.fingerprint(make_png(16, 16, base_pixel, interlace=1), 0, warnings.append)
        b = desktop.fingerprint(make_png(16, 16, base_pixel, interlace=1), 0)
        self.assertEqual(a[0], "raw")
        self.assertEqual(len(warnings), 1)
        self.assertTrue(desktop.fingerprints_equal(a, b))
        self.assertFalse(desktop.fingerprints_equal(a, desktop.fingerprint(b"other", 0)))

    def test_wait_idle_settles_despite_blinking_caret(self):
        frames = [make_png(W, H, with_patch(300, 200, 302, 218) if i % 2 else base_pixel) for i in range(6)]
        clock = FakeClock()
        it = iter(frames)
        status, n, _ = desktop.wait_idle(lambda: next(it), timeout=100, interval=5,
                                         clock=clock.clock, sleeper=clock.sleep)
        self.assertEqual((status, n), ("idle", 2))

    def test_wait_idle_still_times_out_on_real_change(self):
        frames = [make_png(W, H, with_patch(10 * i, 100, 10 * i + 400, 300)) for i in range(6)]
        clock = FakeClock()
        it = iter(frames)
        status, n, _ = desktop.wait_idle(lambda: next(it), timeout=20, interval=5,
                                         clock=clock.clock, sleeper=clock.sleep)
        self.assertEqual(status, "timeout")

    def test_wait_idle_rejects_bad_tolerance_and_ignore_bottom(self):
        for kw in ({"tolerance": -0.1}, {"tolerance": 2}, {"ignore_bottom": -1}):
            with self.assertRaises(desktop.DesktopError):
                desktop.wait_idle(lambda: b"x", **kw)


class Recorder:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def __call__(self, cmd, timeout=60):
        self.calls.append(cmd)
        return self.results.pop(0)


class WritingRecorder(Recorder):
    """Recorder whose successful `peekaboo see` calls write the --path file, like the real tool."""
    def __init__(self, path, results):
        super().__init__(results)
        self.path = path

    def __call__(self, cmd, timeout=60):
        res = super().__call__(cmd, timeout)
        if cmd[:2] == ["peekaboo", "see"] and res[0] == 0:
            Path(self.path).write_bytes(b"png")
        return res


class Shelling(unittest.TestCase):
    def test_shot_command_and_minimized_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            rec = WritingRecorder(path, [(1, "error: window minimized"), (0, ""), (0, "")])
            sleeps = []
            self.assertEqual(desktop.shot(path, runner=rec, sleeper=sleeps.append), path)
            self.assertEqual(rec.calls[0], ["peekaboo", "see", "--app", "Claude", "--no-elements", "--path", path])
            self.assertEqual(rec.calls[1], ["open", "-a", "Claude"])
            self.assertEqual(rec.calls[2], rec.calls[0])
            self.assertEqual(len(sleeps), 1)

    def test_shot_other_failure_is_not_retried(self):
        rec = Recorder([(1, "permission denied")])
        with self.assertRaises(desktop.DesktopError):
            desktop.shot("/nonexistent/never.png", runner=rec, sleeper=lambda s: None)
        self.assertEqual(len(rec.calls), 1)

    def test_click_type_press_commands(self):
        rec = Recorder([(0, ""), (0, ""), (0, "")])
        desktop.click(400, 300, runner=rec)
        desktop.type_text("hello", runner=rec)
        desktop.press("return", runner=rec)
        self.assertEqual(rec.calls[0], ["peekaboo", "click", "--app", "Claude", "--foreground", "--at", "400,300"])
        self.assertEqual(rec.calls[1], ["peekaboo", "type", "--app", "Claude", "--foreground", "hello"])
        self.assertEqual(rec.calls[2], ["peekaboo", "press", "return", "--app", "Claude", "--foreground"])

    def test_doctor_all_good(self):
        perms = ("Source: Peekaboo Bridge\nScreen Recording (Required): Granted\n"
                 "Accessibility (Required): Granted\nEvent Synthesizing (Optional): Granted\n")
        rec = Recorder([(0, "15.7\n"), (0, "Peekaboo 4.9.2\n"), (0, perms), (0, "Terminal\n"), (0, "123\n")])
        ok, lines = desktop.doctor(runner=rec)
        self.assertTrue(ok, lines)

    def test_doctor_flags_old_macos_missing_permission_and_app(self):
        perms = "Screen Recording (Required): Granted\nAccessibility (Required): Not Granted\n"
        rec = Recorder([(0, "14.6\n"), (0, "Peekaboo 4.9.2\n"), (0, perms), (0, "Terminal\n"), (1, "")])
        ok, lines = desktop.doctor(runner=rec)
        text = "\n".join(lines)
        self.assertFalse(ok)
        self.assertIn("needs macOS 15", text)
        self.assertIn("must both be granted", text)
        self.assertIn("not running", text)

    def test_doctor_missing_peekaboo(self):
        def runner(cmd, timeout=60):
            if cmd[0] == "peekaboo":
                raise desktop.DesktopError("command not found: peekaboo")
            return (0, "15.7\n")
        ok, lines = desktop.doctor(runner=runner)
        self.assertFalse(ok)
        self.assertIn("brew install", "\n".join(lines))


class Focus(unittest.TestCase):
    def test_activate_noop_when_already_frontmost(self):
        rec = Recorder([(0, "true, 1\n")])
        self.assertEqual(desktop.activate(runner=rec, sleeper=lambda s: None), 1)
        self.assertEqual(len(rec.calls), 1)

    def test_activate_sets_frontmost_and_unminimizes(self):
        rec = Recorder([(0, "false, 0\n"), (0, "123\n"), (0, ""), (0, ""), (0, "true, 1\n")])
        self.assertEqual(desktop.activate(runner=rec, sleeper=lambda s: None), 1)
        joined = [" ".join(c) for c in rec.calls]
        self.assertTrue(any("set frontmost to true" in j for j in joined))
        self.assertTrue(any("AXMinimized" in j for j in joined))

    def test_activate_launches_when_not_running(self):
        rec = Recorder([(1, ""), (1, ""), (0, ""), (0, ""), (0, ""), (0, "true, 1\n")])
        desktop.activate(runner=rec, sleeper=lambda s: None)
        self.assertIn(["open", "-a", "Claude"], rec.calls)

    def test_activate_gives_up_with_error(self):
        def runner(cmd, timeout=60):
            if "get {frontmost" in " ".join(cmd):
                return (0, "false, 0\n")
            if cmd[0] == "pgrep":
                return (0, "1\n")
            return (0, "Other\n")
        with self.assertRaises(desktop.DesktopError):
            desktop.activate(runner=runner, sleeper=lambda s: None, attempts=2)

    def test_require_front_refuses_when_other_app_in_front(self):
        def runner(cmd, timeout=60):
            if "get {frontmost" in " ".join(cmd):
                return (0, "true, 1\n")
            return (0, "Mail\n")
        with self.assertRaises(desktop.DesktopError):
            desktop.require_front(runner=runner, sleeper=lambda s: None)

    def test_shot_recovering_retries_after_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            state = {"n": 0}

            def runner(cmd, timeout=60):
                if cmd[0] == "peekaboo":
                    state["n"] += 1
                    if state["n"] == 1:
                        return (1, "target was not found")
                    Path(path).write_bytes(b"png")
                    return (0, "")
                return (0, "true, 1\n")
            self.assertEqual(desktop.shot_recovering(path, runner=runner, sleeper=lambda s: None), path)
            self.assertEqual(state["n"], 2)

    def test_type_indeterminate_is_not_a_failure(self):
        rec = Recorder([(1, "Action outcome is indeterminate; observe the target")])
        self.assertEqual(desktop.type_text("x", runner=rec), desktop.INDETERMINATE)
        with self.assertRaises(desktop.DesktopError):
            desktop.type_text("x", runner=Recorder([(1, "permission denied")]))

    def test_scroll_clicks_then_scrolls_foreground(self):
        rec = Recorder([(0, ""), (0, "")])
        desktop.scroll("down", 7, (10, 20), runner=rec)
        self.assertEqual(rec.calls[0], ["peekaboo", "click", "--app", "Claude", "--foreground", "--at", "10,20"])
        self.assertEqual(rec.calls[1], ["peekaboo", "scroll", "--app", "Claude", "--direction", "down",
                                        "--amount", "7", "--foreground"])
        with self.assertRaises(desktop.DesktopError):
            desktop.scroll("sideways")


class McpConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "claude_desktop_config.json")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, data):
        with open(self.path, "w") as fh:
            json.dump(data, fh)

    def read(self):
        with open(self.path) as fh:
            return json.load(fh)

    def test_add_preserves_keys_and_backs_up(self):
        orig = {"preferences": {"a": 1}, "other": [1, 2]}
        self.write(orig)
        backup = desktop.mcp_add(self.path, "zz-x", "/usr/bin/false", ["--a"], ["K=V"])
        data = self.read()
        self.assertEqual(data["preferences"], orig["preferences"])
        self.assertEqual(data["other"], orig["other"])
        self.assertEqual(data["mcpServers"]["zz-x"], {"command": "/usr/bin/false", "args": ["--a"], "env": {"K": "V"}})
        with open(backup) as fh:
            self.assertEqual(json.load(fh), orig)

    def test_remove_only_named_entry(self):
        self.write({"mcpServers": {"keep": {"command": "a"}, "zz-x": {"command": "b"}}})
        desktop.mcp_remove(self.path, "zz-x")
        self.assertEqual(self.read()["mcpServers"], {"keep": {"command": "a"}})
        with self.assertRaises(desktop.DesktopError):
            desktop.mcp_remove(self.path, "missing")

    def test_refuses_invalid_json_and_duplicates_and_bad_names(self):
        with open(self.path, "w") as fh:
            fh.write("{not json")
        with self.assertRaises(desktop.DesktopError):
            desktop.mcp_add(self.path, "zz-x", "c")
        with open(self.path) as fh:
            self.assertEqual(fh.read(), "{not json")
        self.write({"mcpServers": {"zz-x": {"command": "a"}}})
        with self.assertRaises(desktop.DesktopError):
            desktop.mcp_add(self.path, "zz-x", "c")
        desktop.mcp_add(self.path, "zz-x", "c", replace=True)
        self.assertEqual(self.read()["mcpServers"]["zz-x"], {"command": "c"})
        with self.assertRaises(desktop.DesktopError):
            desktop.mcp_add(self.path, "bad name!", "c")

    def test_list_hides_env_values(self):
        self.write({"mcpServers": {"s": {"command": "c", "args": ["a"], "env": {"TOKEN": "supersecret"}}}})
        rows = "\n".join(desktop.mcp_list(self.path))
        self.assertIn("TOKEN", rows)
        self.assertNotIn("supersecret", rows)

    def test_missing_file_is_created_by_add(self):
        desktop.mcp_add(self.path, "zz-x", "c")
        self.assertEqual(self.read(), {"mcpServers": {"zz-x": {"command": "c"}}})


class ShotFreshness(unittest.TestCase):
    def test_stale_file_is_deleted_before_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            Path(path).write_bytes(b"STALE")
            seen = {}

            def runner(cmd, timeout=60):
                seen["existed_at_capture"] = os.path.exists(path)
                Path(path).write_bytes(b"FRESH")
                return (0, "")
            desktop.shot(path, runner=runner, sleeper=lambda s: None)
            self.assertFalse(seen["existed_at_capture"])
            self.assertEqual(Path(path).read_bytes(), b"FRESH")

    def test_success_without_new_file_is_an_error_not_the_stale_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            Path(path).write_bytes(b"STALE")
            with self.assertRaises(desktop.DesktopError):
                desktop.shot(path, runner=Recorder([(0, "")]), sleeper=lambda s: None)
            self.assertFalse(os.path.exists(path))

    def test_stale_file_cleared_again_before_minimized_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            Path(path).write_bytes(b"STALE")
            calls = []

            def runner(cmd, timeout=60):
                if cmd[0] == "peekaboo":
                    calls.append(os.path.exists(path))
                    if len(calls) == 1:
                        Path(path).write_bytes(b"PARTIAL")
                        return (1, "window minimized")
                    Path(path).write_bytes(b"FRESH")
                return (0, "")
            desktop.shot(path, runner=runner, sleeper=lambda s: None)
            self.assertEqual(calls, [False, False])

    def test_wait_idle_capture_never_reuses_stale_frame(self):
        # same shape as the wait-idle capture closure in main(): shot_recovering + read the file
        with tempfile.TemporaryDirectory() as tmp:
            frame = os.path.join(tmp, "frame.png")
            Path(frame).write_bytes(b"STALE")

            def runner(cmd, timeout=60):
                # osascript state probe says Claude is frontmost; peekaboo "succeeds" but writes nothing
                return (0, "true, 1\n") if cmd[0] == "osascript" else (0, "")
            with self.assertRaises(desktop.DesktopError):
                desktop.shot_recovering(frame, runner=runner, sleeper=lambda s: None)

    def test_directory_target_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(desktop.DesktopError):
                desktop.shot(tmp, runner=Recorder([]), sleeper=lambda s: None)


class AutomationPermission(unittest.TestCase):
    DENIED = "execution error: Not authorized to send Apple events to System Events. (-1743)"
    PERMS = "Screen Recording (Required): Granted\nAccessibility (Required): Granted\n"

    def test_doctor_reports_automation_denied_explicitly(self):
        rec = Recorder([(0, "15.7\n"), (0, "Peekaboo 4.9.2\n"), (0, self.PERMS), (1, self.DENIED), (0, "1\n")])
        ok, lines = desktop.doctor(runner=rec)
        text = "\n".join(lines)
        self.assertFalse(ok)
        self.assertIn("Automation permission denied (-1743)", text)
        self.assertIn("System Events", text)
        self.assertTrue(any(c[0] == "osascript" and "System Events" in c[2] for c in rec.calls))

    def test_doctor_reports_other_system_events_failure(self):
        rec = Recorder([(0, "15.7\n"), (0, "Peekaboo 4.9.2\n"), (0, self.PERMS), (1, "weird failure"), (0, "1\n")])
        ok, lines = desktop.doctor(runner=rec)
        self.assertFalse(ok)
        self.assertIn("System Events check failed: weird failure", "\n".join(lines))

    def test_activate_error_names_automation_permission_when_that_is_the_cause(self):
        def runner(cmd, timeout=60):
            if cmd[0] == "osascript":
                return (1, self.DENIED)
            return (0, "1\n")
        with self.assertRaises(desktop.DesktopError) as cm:
            desktop.activate(runner=runner, sleeper=lambda s: None, attempts=2)
        self.assertIn("Automation", str(cm.exception))
        self.assertIn("-1743", str(cm.exception))

    def test_activate_error_without_denial_does_not_blame_automation(self):
        def runner(cmd, timeout=60):
            if "get {frontmost" in " ".join(cmd):
                return (0, "false, 0\n")
            return (0, "Other\n")
        with self.assertRaises(desktop.DesktopError) as cm:
            desktop.activate(runner=runner, sleeper=lambda s: None, attempts=1)
        self.assertNotIn("Automation", str(cm.exception))


class TypeArgs(unittest.TestCase):
    def test_plain_text_has_no_separator(self):
        rec = Recorder([(0, "")])
        desktop.type_text("hello -x", runner=rec)
        self.assertEqual(rec.calls[0], ["peekaboo", "type", "--app", "Claude", "--foreground", "hello -x"])

    def test_leading_dash_text_gets_double_dash_separator(self):
        for text in ("-h", "--help", "- bullet", "-1"):
            rec = Recorder([(0, "")])
            desktop.type_text(text, runner=rec)
            self.assertEqual(rec.calls[0], ["peekaboo", "type", "--app", "Claude", "--foreground", "--", text])

    def test_cli_accepts_leading_dash_text_after_separator(self):
        args = desktop.make_parser().parse_args(["type", "--", "-foo"])
        self.assertEqual(args.text, "-foo")


class ConfigSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "claude_desktop_config.json")
        with open(self.path, "w") as fh:
            json.dump({"mcpServers": {"keep": {"command": "a"}}}, fh)

    def tearDown(self):
        self.tmp.cleanup()

    def read(self):
        with open(self.path) as fh:
            return json.load(fh)

    # 1. --restart ordering
    def edit(self, prepare, restart, events, quit_exc=None, launch_exc=None):
        def quit_():
            events.append("quit")
            if quit_exc:
                raise quit_exc

        def launch():
            events.append("launch")
            if launch_exc:
                raise launch_exc
        return desktop.edit_mcp(self.path, prepare, restart=restart, quit=quit_, launch=launch)

    def test_invalid_input_never_quits_the_app(self):
        events = []
        with self.assertRaises(desktop.DesktopError):
            self.edit(lambda: desktop.prepare_mcp_add(self.path, "bad name!", "c"), True, events)
        with self.assertRaises(desktop.DesktopError):
            self.edit(lambda: desktop.prepare_mcp_add(self.path, "keep", "c"), True, events)  # exists
        with self.assertRaises(desktop.DesktopError):
            self.edit(lambda: desktop.prepare_mcp_remove(self.path, "missing"), True, events)
        with self.assertRaises(desktop.DesktopError):
            self.edit(lambda: desktop.prepare_mcp_add(self.path, "ok", ""), True, events)
        self.assertEqual(events, [])
        self.assertEqual(self.read(), {"mcpServers": {"keep": {"command": "a"}}})

    def test_main_invalid_input_never_quits_the_app(self):
        calls = []
        orig_quit, orig_launch = desktop.quit_app, desktop.launch_app
        desktop.quit_app = lambda *a, **k: calls.append("quit")
        desktop.launch_app = lambda *a, **k: calls.append("launch")
        try:
            rc = desktop.main(["config-mcp", "add", "bad name!", "--command", "c", "--restart",
                               "--config", self.path])
        finally:
            desktop.quit_app, desktop.launch_app = orig_quit, orig_launch
        self.assertEqual(rc, desktop.EXIT_ERROR)
        self.assertEqual(calls, [])

    def test_restart_flow_validates_then_quits_then_rereads_then_commits_then_launches(self):
        events = []

        def prepare():
            events.append("prepare")
            return desktop.prepare_mcp_add(self.path, "new", "c")
        backup, relaunched = self.edit(prepare, True, events)
        self.assertEqual(events, ["prepare", "quit", "prepare", "launch"])
        self.assertTrue(relaunched)
        self.assertIn("new", self.read()["mcpServers"])
        self.assertTrue(os.path.exists(backup))

    def test_config_rewritten_by_app_on_quit_is_preserved(self):
        def quit_():
            with open(self.path, "w") as fh:
                json.dump({"mcpServers": {"keep": {"command": "a"}}, "appWroteThis": 1}, fh)
        desktop.edit_mcp(self.path, lambda: desktop.prepare_mcp_add(self.path, "new", "c"), restart=True,
                         quit=quit_, launch=lambda: None)
        data = self.read()
        self.assertEqual(data["appWroteThis"], 1)
        self.assertIn("new", data["mcpServers"])

    def test_failure_after_quit_relaunches_and_launch_failure_cannot_mask_it(self):
        events = []
        with self.assertRaises(desktop.DesktopError) as cm:
            self.edit(lambda: desktop.prepare_mcp_add(self.path, "x", "c"), True, events,
                      quit_exc=desktop.DesktopError("original quit problem"),
                      launch_exc=desktop.DesktopError("launch also broke"))
        self.assertIn("original quit problem", str(cm.exception))
        self.assertEqual(events, ["quit", "launch"])

    def test_prepare_failing_after_quit_relaunches(self):
        events = []
        state = {"n": 0}

        def prepare():
            state["n"] += 1
            if state["n"] == 2:
                raise desktop.DesktopError("changed under us")
            return desktop.prepare_mcp_add(self.path, "x", "c")
        with self.assertRaises(desktop.DesktopError) as cm:
            self.edit(prepare, True, events, launch_exc=RuntimeError("boom"))
        self.assertIn("changed under us", str(cm.exception))
        self.assertEqual(events, ["quit", "launch"])
        self.assertNotIn("x", self.read()["mcpServers"])

    def test_no_restart_does_not_touch_the_app(self):
        events = []
        backup, relaunched = self.edit(lambda: desktop.prepare_mcp_add(self.path, "x", "c"), False, events)
        self.assertEqual(events, [])
        self.assertFalse(relaunched)

    def test_prepare_does_not_write_or_back_up(self):
        before = sorted(os.listdir(self.tmp.name))
        desktop.prepare_mcp_add(self.path, "x", "c")
        desktop.prepare_mcp_remove(self.path, "keep")
        self.assertEqual(sorted(os.listdir(self.tmp.name)), before)
        self.assertEqual(self.read(), {"mcpServers": {"keep": {"command": "a"}}})

    # 2. backups
    def test_backup_never_overwrites_existing_bak(self):
        from datetime import datetime
        now = datetime(2026, 1, 2, 3, 4, 5, 678901)
        first = desktop.backup_config(self.path, now)
        Path(first).write_text("PRECIOUS")
        second = desktop.backup_config(self.path, now)
        third = desktop.backup_config(self.path, now)
        self.assertEqual(len({first, second, third}), 3)
        self.assertEqual(Path(first).read_text(), "PRECIOUS")
        self.assertIn("678901", first)
        self.assertEqual(json.loads(Path(second).read_text()), self.read())

    def test_backup_none_when_no_file(self):
        self.assertIsNone(desktop.backup_config(os.path.join(self.tmp.name, "nope.json")))

    # 3. write_config
    def test_write_preserves_mode_and_leaves_no_temp(self):
        os.chmod(self.path, 0o640)
        desktop.write_config(self.path, {"a": 1})
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o640)
        self.assertEqual(self.read(), {"a": 1})
        self.assertEqual(sorted(os.listdir(self.tmp.name)), ["claude_desktop_config.json"])

    def test_write_new_file_is_private_and_uses_unique_temp(self):
        new = os.path.join(self.tmp.name, "sub", "c.json")
        desktop.write_config(new, {"a": 1})
        self.assertEqual(os.stat(new).st_mode & 0o777, 0o600)
        # a leftover fixed-name temp from an older run is neither used nor clobbered
        Path(self.path + ".tmp-desktop-skill").write_text("other")
        desktop.write_config(self.path, {"b": 2})
        self.assertEqual(Path(self.path + ".tmp-desktop-skill").read_text(), "other")

    def test_write_failure_cleans_temp_and_keeps_original(self):
        with self.assertRaises(TypeError):
            desktop.write_config(self.path, {"a": object()})
        self.assertEqual(self.read(), {"mcpServers": {"keep": {"command": "a"}}})
        self.assertEqual(sorted(os.listdir(self.tmp.name)), ["claude_desktop_config.json"])

    # 4. mcp_list redaction
    def list_rows(self, spec):
        with open(self.path, "w") as fh:
            json.dump({"mcpServers": {"s": spec}}, fh)
        return "\n".join(desktop.mcp_list(self.path))

    def test_list_redacts_secret_looking_args(self):
        rows = self.list_rows({"command": "npx", "args": [
            "-y", "@modelcontextprotocol/server-filesystem", "/Users/me/docs",
            "API_KEY=abc123secret", "--token=tok_value_1", "--password", "hunter2hunter2", "--verbose",
            "--api-key", "sk-live-0123456789abcdef", "https://u:pw0rd@example.com/x?access_token=zzz&a=1",
            "Authorization: Bearer abcdef", "A1b2C3d4E5f6G7h8I9j0K1l2M3"]})
        for leaked in ("abc123secret", "tok_value_1", "hunter2", "sk-live", "pw0rd", "zzz", "abcdef", "A1b2C3d4E5"):
            self.assertNotIn(leaked, rows)
        for kept in ("npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/me/docs", "--verbose",
                     "API_KEY=<redacted>", "--token=<redacted>", "a=1", "example.com"):
            self.assertIn(kept, rows)

    def test_list_flag_secret_does_not_eat_following_flag(self):
        rows = self.list_rows({"command": "c", "args": ["--token", "--verbose", "plain"]})
        self.assertIn("--verbose", rows)
        self.assertIn("plain", rows)

    def test_list_shows_env_names_only(self):
        rows = self.list_rows({"command": "c", "env": {"TOKEN": "supersecret", "B": "x"}})
        self.assertIn("B,TOKEN", rows)
        self.assertNotIn("supersecret", rows)

    def test_list_tolerates_bad_shapes(self):
        for spec in ("a string", ["list"], 5, None, {"command": 5, "args": "oops", "env": ["x"]},
                     {"command": "c", "args": [1, None, {"k": "v"}, ["n"]], "env": "SECRET=1"},
                     {"command": "c", "args": ["ok"], "env": {1: "v"}}):
            rows = self.list_rows(spec)  # must not raise
            self.assertNotIn("SECRET=1", rows)
        with open(self.path, "w") as fh:
            json.dump({"mcpServers": ["not", "a", "dict"]}, fh)
        self.assertIn("not an object", "\n".join(desktop.mcp_list(self.path)))


class ShotTransientRetry(unittest.TestCase):
    def test_target_changed_during_capture_retries_once_then_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            rec = WritingRecorder(path, [(1, "Error: target changed during capture"), (0, "")])
            self.assertEqual(desktop.shot(path, runner=rec, sleeper=lambda s: None), path)
            self.assertEqual(len(rec.calls), 2)
            self.assertEqual(rec.calls[0], rec.calls[1])

    def test_target_changed_twice_fails_after_exactly_one_retry(self):
        rec = Recorder([(1, "target changed during capture"), (1, "target changed during capture")])
        with self.assertRaises(desktop.DesktopError):
            desktop.shot("/nonexistent/never.png", runner=rec, sleeper=lambda s: None)
        self.assertEqual(len(rec.calls), 2)


class ShotRetryOrdering(unittest.TestCase):
    def test_transient_retry_still_happens_after_minimized_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            rec = WritingRecorder(path, [(1, "window minimized"), (0, ""), (1, "target changed during capture"),
                                         (0, "")])
            self.assertEqual(desktop.shot(path, runner=rec, sleeper=lambda s: None), path)
            self.assertEqual([c[0] for c in rec.calls], ["peekaboo", "open", "peekaboo", "peekaboo"])

    def test_first_error_is_kept_when_the_retry_fails_differently(self):
        rec = Recorder([(1, "target changed during capture"), (1, "permission denied")])
        with self.assertRaises(desktop.DesktopError) as cm:
            desktop.shot("/nonexistent/never.png", runner=rec, sleeper=lambda s: None)
        text = str(cm.exception)
        self.assertIn("permission denied", text)
        self.assertIn("first error was: target changed during capture", text)
        self.assertEqual(cm.exception.output, "permission denied")

    def test_same_error_twice_is_not_duplicated(self):
        rec = Recorder([(1, "target changed during capture"), (1, "target changed during capture")])
        with self.assertRaises(desktop.DesktopError) as cm:
            desktop.shot("/nonexistent/never.png", runner=rec, sleeper=lambda s: None)
        self.assertNotIn("first error", str(cm.exception))

    def test_recovering_wrapper_decides_from_the_last_error_only(self):
        # first error mentions "minimized" but the final one is a hard failure: no extra recovery rounds
        calls = {"see": 0}

        def runner(cmd, timeout=60):
            if cmd[0] == "peekaboo":
                calls["see"] += 1
                return (1, "window minimized") if calls["see"] == 1 else (1, "permission denied")
            return (0, "true, 1\n")
        with self.assertRaises(desktop.DesktopError):
            desktop.shot_recovering("/nonexistent/never.png", runner=runner, sleeper=lambda s: None)
        self.assertEqual(calls["see"], 2)


class ApprovalsLog(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.log = os.path.join(self._tmp.name, "sub", "approvals.jsonl")
        self.n = 0

    def png(self):
        """A fresh, distinct PNG file (new content each call)."""
        self.n += 1
        path = os.path.join(self._tmp.name, "shot%d.png" % self.n)
        shade = self.n
        Path(path).write_bytes(make_png(16, 16, lambda x, y: (shade % 256, shade // 256, 7)))
        return path

    def add(self, button="Allow once", prompt="Allow Claude to fetch pages from example.com?", shot=None, **kw):
        return desktop.add_approval(self.log, prompt, button, shot or self.png(), **kw)

    def lines(self):
        return [json.loads(x) for x in Path(self.log).read_text(encoding="utf-8").splitlines()]

    def test_add_appends_jsonl_with_fields_tz_timestamp_and_sha(self):
        shot = self.png()
        entry, count, warnings = self.add(shot=shot)
        self.assertEqual((count, warnings), (1, []))
        _, count, _ = self.add(button="Deny")
        self.assertEqual(count, 1)  # a Deny is logged but is not a routine approval
        first, second = self.lines()
        self.assertEqual(set(first), {"type", "time", "run", "prompt", "button", "shot", "shot_sha256", "broad"})
        self.assertEqual((first["button"], first["broad"]), ("Allow once", False))
        self.assertEqual(first["shot_sha256"], hashlib.sha256(Path(shot).read_bytes()).hexdigest())
        self.assertEqual(second["button"], "Deny")
        self.assertIsNotNone(datetime.fromisoformat(first["time"]).tzinfo)

    def test_requires_prompt_button_and_shot(self):
        for kw in ({"prompt": ""}, {"button": " "}):
            with self.assertRaises(desktop.DesktopError):
                self.add(**kw)
        with self.assertRaises(desktop.DesktopError):
            desktop.add_approval(self.log, "p", "Allow once", None)
        self.assertFalse(os.path.exists(self.log))

    # --- counter: per run, refuses the 6th routine approval ---------------------------------------
    def test_start_rotates_old_log_to_prev_and_writes_header(self):
        self.add()
        run_id, prev = desktop.start_run(self.log)
        self.assertEqual(prev, self.log + ".prev")
        self.assertEqual(len(json.loads(Path(prev).read_text().splitlines()[0]).keys() & {"button"}), 1)
        (header,) = self.lines()
        self.assertEqual((header["type"], header["run"]), ("header", run_id))
        self.assertNotIn("user_ok", header)
        # starting again over a header-only log must not clobber the real .prev
        desktop.start_run(self.log)
        self.assertIn("Allow once", Path(prev).read_text())

    def test_count_is_per_run_not_per_file(self):
        for _ in range(5):
            self.add()
        desktop.start_run(self.log)
        _, count, warnings = self.add()
        self.assertEqual((count, warnings), (1, []))

    def test_sixth_routine_approval_is_refused_without_user_ok_and_declines_do_not_count(self):
        desktop.start_run(self.log)
        for i in range(5):
            _, count, warnings = self.add()
            self.add(button="Not now")
            self.assertEqual(count, i + 1)
            self.assertEqual(len(warnings), 1 if i == 4 else 0, i)
        self.assertIn("refused", warnings[0])
        before = Path(self.log).read_text()
        with self.assertRaises(desktop.DesktopError) as cm:
            self.add()
        self.assertIn("--user-ok", str(cm.exception))
        self.assertEqual(Path(self.log).read_text(), before)  # nothing written
        entry, count, _ = self.add(user_ok="yes, approve them all")
        self.assertEqual((count, entry["user_ok"]), (6, "yes, approve them all"))
        self.assertEqual(desktop.main(["approvals-log", "add", "--log", self.log, "--prompt", "p",
                                       "--button", "Allow once", "--shot", self.png()]), 1)

    def test_start_user_ok_lifts_the_limits_for_the_run(self):
        desktop.start_run(self.log, user_ok="Auto mode is fine for this run")
        self.assertEqual(self.lines()[0]["user_ok"], "Auto mode is fine for this run")
        for _ in range(7):
            self.add()
        entry, _, warnings = self.add(button="Allow all for this website")
        self.assertIs(entry["broad"], True)
        self.assertTrue(any("standing grant" in w for w in warnings))

    # --- broad detection: fail closed ------------------------------------------------------------
    def test_scope_classification_fails_closed(self):
        for label in ("Allow once", "Deny", "Cancel", "Block", "Not now", "Don't allow", "Don’t allow", "allow once."):
            self.assertEqual(desktop.approval_scope(label), "limited", label)
        for label in ("Allow all for this website", "Always allow", "Allow for this task", "Allow all",
                      "Allow for all sites", "Allow for this conversation", "Allow on this domain",
                      "Allow every time", "Trust this site", "Allow for all chats", "Remember my choice",
                      "Don't ask again", "Skip all", "Auto"):
            self.assertEqual(desktop.approval_scope(label), "broad", label)
            self.assertTrue(desktop.is_broad_approval(label), label)
        for label in ("Allow", "Okay", "Proceed", "Yes"):
            self.assertEqual(desktop.approval_scope(label), "unverified", label)

    def test_broad_and_unverified_need_a_user_ok(self):
        for label in ("Allow all for this website", "Allow", "Remember my choice"):
            with self.assertRaises(desktop.DesktopError, msg=label):
                self.add(button=label)
        self.assertFalse(os.path.exists(self.log))
        entry, _, warnings = self.add(button="Allow", user_ok="the user said click Allow")
        self.assertEqual(entry["broad"], "unverified")
        self.assertTrue(any("unverified" in w for w in warnings))

    def test_show_recomputes_broad_instead_of_trusting_the_stored_flag(self):
        os.makedirs(os.path.dirname(self.log))
        old = {"time": "t", "prompt": "p", "button": "Allow all for this website", "shot": "s", "broad": False}
        missing_key = {"time": "t", "prompt": "p", "button": "Always allow", "shot": "s"}
        Path(self.log).write_text(json.dumps(old) + "\n" + json.dumps(missing_key) + "\n", encoding="utf-8")
        text = "\n".join(desktop.format_approvals(*desktop.read_log(self.log)))
        self.assertEqual(text.count("[BROAD GRANT]"), 2)
        self.assertIn("2 approval(s) logged; 2 broad grant(s)", text)

    def test_show_lists_entries_headers_count_and_warning(self):
        desktop.start_run(self.log, user_ok="ok to go past five")
        for _ in range(5):
            self.add()
        self.add(button="Allow all for this website")
        text = "\n".join(desktop.format_approvals(*desktop.read_log(self.log)))
        self.assertIn("6 approval(s) logged; 1 broad grant(s)", text)
        self.assertIn("[BROAD GRANT]", text)
        self.assertIn("user OK: ok to go past five", text)
        self.assertIn("WARNING", text)
        self.assertEqual(desktop.read_approvals(os.path.join(self._tmp.name, "none.jsonl")), [])

    # --- screenshot evidence ---------------------------------------------------------------------
    def test_shot_must_exist_be_png_fresh_and_new(self):
        missing = os.path.join(self._tmp.name, "nope.png")
        notpng = os.path.join(self._tmp.name, "x.png")
        Path(notpng).write_bytes(b"not a png")
        stale = self.png()
        os.utime(stale, (time.time() - 600, time.time() - 600))
        for bad in (missing, notpng, stale):
            with self.assertRaises(desktop.DesktopError, msg=bad):
                self.add(shot=bad)
        self.assertFalse(os.path.exists(self.log))
        first = self.png()
        self.add(shot=first)
        with self.assertRaises(desktop.DesktopError):  # same path as the previous entry
            self.add(shot=first)
        copy = os.path.join(self._tmp.name, "copy.png")
        Path(copy).write_bytes(Path(first).read_bytes())
        with self.assertRaises(desktop.DesktopError):  # different path, same bytes
            self.add(shot=copy)
        self.assertEqual(len(self.lines()), 1)
        self.add()  # a genuinely new screenshot is fine

    # --- corrupt log -----------------------------------------------------------------------------
    def test_corrupt_log_is_tolerated_by_show_and_add(self):
        os.makedirs(os.path.dirname(self.log))
        good = {"type": "approval", "time": "t", "prompt": "p", "button": "Allow once", "shot": "s", "broad": False}
        with open(self.log, "wb") as fh:
            fh.write(json.dumps(good).encode() + b"\nnot json\n\xff\xfe bad bytes\n[1, 2]\n" + json.dumps(good).encode())
        records, corrupt = desktop.read_log(self.log)  # no trailing newline on the last line
        self.assertEqual((len(records), [n for n, _ in corrupt]), (2, [2, 3, 4]))
        self.assertEqual(desktop.main(["approvals-log", "show", "--log", self.log]), 1)
        text = "\n".join(desktop.format_approvals(records, corrupt))
        self.assertIn("CORRUPT line 2", text)
        self.assertIn("CORRUPT line 4", text)
        entry, count, warnings = self.add()
        self.assertEqual(count, 3)
        self.assertTrue(any("corrupt" in w for w in warnings))
        self.assertTrue(any("newline" in w for w in warnings))
        records, corrupt = desktop.read_log(self.log)
        self.assertEqual((len(records), len(corrupt)), (3, 3))  # new entry sits on its own line
        self.assertEqual(records[-1]["button"], "Allow once")

    def test_clean_show_exits_zero_and_add_does_not_warn_about_newline(self):
        self.add()
        self.assertEqual(desktop.main(["approvals-log", "show", "--log", self.log]), 0)
        _, _, warnings = self.add()
        self.assertEqual(warnings, [])

    def test_unencodable_text_is_a_desktop_error_not_a_traceback(self):
        with self.assertRaises(desktop.DesktopError):
            self.add(prompt="bad \udcff surrogate")
        self.assertFalse(os.path.exists(self.log))
        self.assertEqual(desktop.main(["approvals-log", "add", "--log", self.log, "--prompt", "bad \udcff",
                                       "--button", "Allow once", "--shot", self.png()]), 1)

    # --- concurrency -----------------------------------------------------------------------------
    def test_add_waits_for_the_lock(self):
        done = threading.Event()
        shot = self.png()

        def worker():
            self.add(shot=shot)
            done.set()
        with desktop._approvals_lock(self.log):
            t = threading.Thread(target=worker)
            t.start()
            self.assertFalse(done.wait(0.4))
        self.assertTrue(done.wait(5))
        t.join()

    def test_concurrent_adds_get_distinct_counts_and_all_land(self):
        shots = [self.png() for _ in range(5)]
        counts = []

        def worker(shot):
            counts.append(self.add(shot=shot)[1])
        threads = [threading.Thread(target=worker, args=(s,)) for s in shots]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(counts), [1, 2, 3, 4, 5])
        self.assertEqual(len(self.lines()), 5)

    def test_cli_start_add_show_and_default_path(self):
        args = desktop.make_parser().parse_args(["approvals-log", "show"])
        self.assertEqual(args.log, "desktop-approvals.jsonl")
        self.assertEqual(desktop.main(["approvals-log", "start", "--log", self.log, "--user-ok", "go"]), 0)
        self.assertEqual(desktop.main(["approvals-log", "add", "--log", self.log, "--prompt", "p",
                                       "--button", "Allow once", "--shot", self.png()]), 0)
        self.assertEqual(desktop.main(["approvals-log", "add", "--log", self.log, "--prompt", "p"]), 1)
        self.assertEqual(desktop.main(["approvals-log", "show", "--log", self.log]), 0)
        self.assertEqual(len(desktop.read_approvals(self.log)), 1)


class WaitIdleReminder(unittest.TestCase):
    def test_wait_idle_prints_blocked_on_prompt_reminder(self):
        import contextlib
        import io
        real_shot, real_wait = desktop.shot_recovering, desktop.wait_idle
        desktop.shot_recovering = lambda path, **kw: Path(path).write_bytes(b"x")
        desktop.wait_idle = lambda *a, **kw: ("idle", 2, b"x")
        buf = io.StringIO()
        try:
            with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(buf):
                code = desktop.main(["wait-idle", "--out", os.path.join(tmp, "o.png")])
        finally:
            desktop.shot_recovering, desktop.wait_idle = real_shot, real_wait
        self.assertEqual(code, 0)
        self.assertIn("idle after 2 captures", buf.getvalue())
        self.assertIn("blocked on an approval prompt", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
