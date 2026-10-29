// Polite HTTP: at most 2 requests/second, retry with backoff on 429/5xx, 24h local cache.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";
export const USER_AGENT = `sourcewell-cli/${VERSION} (read-only research; +https://github.com/Agent-Everywhere/AE-external-skills)`;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultCacheDir() {
  return process.env.SOURCEWELL_CACHE_DIR || join(homedir(), ".cache", "sourcewell");
}

export class HttpError extends Error {
  constructor(message, status, url) { super(message); this.name = "HttpError"; this.status = status; this.url = url; }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHttp({
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => Date.now(),
  minIntervalMs = 500, // 2 requests per second
  maxRetries = 4,
  backoffMs = 1000,
  cacheDir = defaultCacheDir(),
  ttlMs = DAY_MS,
  noCache = false,
} = {}) {
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

  /** Network request through the rate limiter, with retry on 429/5xx and network errors. Returns the Response. */
  async function request(url, init = {}) {
    let attempt = 0;
    for (;;) {
      await slot();
      stats.requests++;
      let res = null;
      let err = null;
      try {
        res = await fetchImpl(url, { ...init, headers: { "user-agent": USER_AGENT, accept: "application/json, text/html;q=0.9", ...(init.headers || {}) } });
      } catch (e) { err = e; }
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

  const keyFile = (key) => join(cacheDir, createHash("sha256").update(key).digest("hex") + ".json");

  /** Return a cached JSON value for `key` if fresh, else run `produce()` and cache its (JSON-serialisable) result. */
  async function cached(key, produce, { ttl = ttlMs } = {}) {
    if (!noCache) {
      try {
        const { t, value } = JSON.parse(await readFile(keyFile(key), "utf8"));
        if (now() - t < ttl) { stats.cacheHits++; return value; }
      } catch { /* miss */ }
    }
    const value = await produce();
    if (!noCache) {
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(keyFile(key), JSON.stringify({ t: now(), key, value }));
      } catch { /* cache is best effort */ }
    }
    return value;
  }

  /**
   * GET JSON through limiter + retry. Redirects are never followed blindly: with `onRedirect(absoluteUrl)` (which must
   * return the URL to follow, or throw) up to 3 hops are followed and each Location is re-validated; without it a
   * redirect is an error.
   */
  async function getJson(url, { onRedirect } = {}) {
    let u = url;
    for (let hop = 0; hop < 4; hop++) {
      const res = await request(u, { method: "GET", redirect: "manual" });
      const loc = res.status >= 300 && res.status < 400 && res.headers && res.headers.get && res.headers.get("location");
      if (loc) {
        if (!onRedirect) throw new HttpError(`unexpected redirect (HTTP ${res.status}) from ${u}: not followed`, res.status, u);
        u = onRedirect(new URL(loc, u).toString());
        continue;
      }
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${u}`, res.status, u);
      return res.json();
    }
    throw new HttpError(`too many redirects from ${url}`, 0, url);
  }

  return { request, cached, getJson, stats, cacheDir };
}
