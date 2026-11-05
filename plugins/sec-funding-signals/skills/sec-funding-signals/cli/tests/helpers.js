import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const tmpDir = () => mkdtempSync(join(tmpdir(), "sec-funding-test-"));
export const fixture = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");

/** Fake clock: sleep advances time instantly. */
export function fakeClock(start = 1_000_000) {
  const c = { t: start, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}

export function res(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    async json() { return typeof body === "string" ? JSON.parse(body) : body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

/** Mock fetch driven by handler(url, init, n) -> response. Records calls. */
export function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); };
  f.calls = calls;
  return f;
}

/** An EDGAR full-text search hit. */
export const hit = (accession, cik, name, { form = "D", date = "2026-10-20", state = "TX" } = {}) => ({
  _id: `${accession}:primary_doc.xml`,
  _source: { ciks: [String(cik).padStart(10, "0")], display_names: [`${name}  (CIK ${String(cik).padStart(10, "0")})`], file_date: date, form, adsh: accession, biz_states: [state], biz_locations: [`City, ${state}`] },
});
export const searchPage = (hits, total = hits.length) => ({ hits: { total: { value: total, relation: "eq" }, hits } });
