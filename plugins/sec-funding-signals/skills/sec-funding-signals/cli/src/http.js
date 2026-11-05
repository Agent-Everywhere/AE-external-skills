// Polite HTTP for SEC EDGAR: descriptive User-Agent with a contact email (SEC fair-access policy), at most 4
// requests/second (SEC's ceiling is 10), retry with backoff on 429/5xx, immutable-filing cache on disk.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertAllowed } from "./allowlist.js";

export const VERSION = "0.1.0";
export const APP_NAME = "sec-funding-signals";
export const MIN_INTERVAL_MS = 250; // 4 requests per second, under the 5/s cap

export const userAgent = (email) => `${APP_NAME} ${email}`;

export class HttpError extends Error {
  constructor(message, status, url) { super(message); this.name = "HttpError"; this.status = status; this.url = url; }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHttp({
  email,
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => Date.now(),
  minIntervalMs = MIN_INTERVAL_MS,
  maxRetries = 4,
  backoffMs = 1000,
  cacheDir,
  noCache = false,
} = {}) {
  if (!email) throw new Error("a contact email is required for the SEC User-Agent");
  const ua = userAgent(email);
  let last = -Infinity;
  let chain = Promise.resolve();
  const stats = { requests: 0, retries: 0, cacheHits: 0 };

  /** Reserve the next request slot. Serialised so concurrent callers still obey the rate limit. */
  function slot() {
    const p = chain.then(async () => {
      const wait = last + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    chain = p.catch(() => {});
    return p;
  }

  async function requestOnce(url, accept) {
    let attempt = 0;
    for (;;) {
      await slot();
      stats.requests++;
      let res = null;
      let err = null;
      try { res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { "user-agent": ua, accept } }); }
      catch (e) { err = e; }
      const retryable = err || res.status === 429 || res.status >= 500;
      if (!retryable) return res;
      if (attempt >= maxRetries) {
        if (err) throw new HttpError(`network error after ${attempt + 1} attempts: ${err.message}`, 0, url);
        throw new HttpError(`HTTP ${res.status} after ${attempt + 1} attempts`, res.status, url);
      }
      let delay = backoffMs * 2 ** attempt;
      const ra = res && res.headers && res.headers.get && res.headers.get("retry-after");
      if (ra && Number.isFinite(Number(ra))) delay = Math.max(delay, Number(ra) * 1000);
      attempt++;
      stats.retries++;
      await sleep(delay);
    }
  }

  /** GET through the allowlist (re-checked on every redirect hop), limiter and retry. Returns the final ok Response. */
  async function get(url, accept = "application/json, application/xml;q=0.9, text/xml;q=0.9") {
    let u = url;
    for (let hop = 0; hop < 4; hop++) {
      assertAllowed(u);
      const res = await requestOnce(u, accept);
      const loc = res.status >= 300 && res.status < 400 && res.headers && res.headers.get && res.headers.get("location");
      if (loc) { u = new URL(loc, u).toString(); continue; }
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${u}`, res.status, u);
      return res;
    }
    throw new HttpError(`too many redirects from ${url}`, 0, url);
  }

  const getJson = async (url) => (await get(url)).json();
  const getText = async (url) => (await get(url)).text();

  const keyFile = (key) => join(cacheDir, createHash("sha256").update(key).digest("hex") + ".json");

  /** Filings never change once accepted, so a cached document is valid forever. */
  async function cachedText(key, produce) {
    if (!noCache && cacheDir) {
      try {
        const { value } = JSON.parse(await readFile(keyFile(key), "utf8"));
        if (typeof value === "string") { stats.cacheHits++; return value; }
      } catch { /* miss */ }
    }
    const value = await produce();
    if (!noCache && cacheDir) {
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(keyFile(key), JSON.stringify({ key, value }));
      } catch { /* cache is best effort */ }
    }
    return value;
  }

  return { get, getJson, getText, cachedText, stats, cacheDir, userAgent: ua };
}
