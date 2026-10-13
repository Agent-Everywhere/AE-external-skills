"""Tests for skills/claude-desktop/scripts/desktop.py. No Peekaboo or Claude Desktop needed."""
import importlib.util
import json
import os
import struct
import tempfile
import unittest
import zlib
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


class Shelling(unittest.TestCase):
    def test_shot_command_and_minimized_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            Path(path).write_bytes(b"png")
            rec = Recorder([(1, "error: window minimized"), (0, ""), (0, "")])
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
        rec = Recorder([(0, "15.7\n"), (0, "Peekaboo 4.9.2\n"), (0, perms), (0, "123\n")])
        ok, lines = desktop.doctor(runner=rec)
        self.assertTrue(ok, lines)

    def test_doctor_flags_old_macos_missing_permission_and_app(self):
        perms = "Screen Recording (Required): Granted\nAccessibility (Required): Not Granted\n"
        rec = Recorder([(0, "14.6\n"), (0, "Peekaboo 4.9.2\n"), (0, perms), (1, "")])
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
            Path(path).write_bytes(b"png")
            state = {"n": 0}

            def runner(cmd, timeout=60):
                if cmd[0] == "peekaboo":
                    state["n"] += 1
                    return (1, "target was not found") if state["n"] == 1 else (0, "")
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


if __name__ == "__main__":
    unittest.main()
