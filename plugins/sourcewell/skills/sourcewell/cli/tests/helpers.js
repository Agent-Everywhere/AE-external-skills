import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmpDir = () => mkdtempSync(join(tmpdir(), "sourcewell-test-"));

/** Fake clock: sleep advances time instantly. */
export function fakeClock() {
  const c = { t: 1_000_000, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}

export function jsonRes(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null, getSetCookie: () => headers["set-cookie-list"] || [] },
    async json() { return typeof body === "string" ? JSON.parse(body) : body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

/** Mock fetch driven by a handler(url, init) -> response. Records calls. */
export function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => { calls.push({ url: String(url), init, at: undefined }); return handler(String(url), init, calls.length); };
  f.calls = calls;
  return f;
}

/** One JSON:API document of rows. */
export function doc(type, rows, next) {
  return {
    data: rows.map((attributes, i) => ({ type, id: `id-${attributes.title || i}`, attributes })),
    links: { self: { href: "x" }, ...(next ? { next: { href: next } } : {}) },
  };
}
