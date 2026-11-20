import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const tmpDir = () => mkdtempSync(join(tmpdir(), "texas-bids-test-"));
export const fixture = (name) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

/** Fake clock: sleep advances time instantly. */
export function fakeClock() {
  const c = { t: Date.parse("2026-11-20T15:00:00Z"), sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}

export function res(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    async text() { return text; },
    async json() { return JSON.parse(text); },
  };
}

/** Mock fetch driven by handler(url, init, n) -> response. Records calls with the parsed JSON body. */
export function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* not json */ }
    calls.push({ url: String(url), init, body });
    return handler(String(url), init, calls.length, body);
  };
  f.calls = calls;
  return f;
}

/** A mock ESBD service answering from a { keyword: fixtureJson } map (status is ignored unless `byStatus`). */
export function esbdFetch(map) {
  return mockFetch((url, init, n, body) => {
    const r = map[body.keyword] ?? { lines: [], page: body.page, recordsPerPage: 24, totalRecordsFound: 0 };
    return res(r);
  });
}

/** An io object for main(). */
export function makeIo(fetchImpl, extra = {}) {
  const clock = fakeClock();
  const out = [];
  const err = [];
  return {
    io: { fetchImpl, now: clock.now, sleep: clock.sleep, stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, ...extra },
    out: () => out.join(""),
    err: () => err.join(""),
    clock,
  };
}
