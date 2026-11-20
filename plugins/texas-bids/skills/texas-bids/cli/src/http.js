// Polite HTTP for the ESBD data service: a plain User-Agent, at most about 1 request per 750 ms, a timeout on every
// request, and retries with backoff on 429/5xx, timeouts and network errors. Anything else non-200 is a clear error.

export const VERSION = "0.1.0";
export const USER_AGENT = `texas-bids-cli/${VERSION} (read-only public bid board check; +https://github.com/Agent-Everywhere/AE-external-skills)`;

export class HttpError extends Error {
  constructor(message, status, url) { super(message); this.name = "HttpError"; this.status = status; this.url = url; }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHttp({
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => Date.now(),
  minIntervalMs = 750,
  timeoutMs = 45000,
  maxRetries = 2,
  backoffMs = 2000,
} = {}) {
  let last = -Infinity;
  let chain = Promise.resolve();
  const stats = { requests: 0, retries: 0 };

  /** Reserve the next request slot (serialised, so concurrent callers still obey the pacing). */
  function slot() {
    const p = chain.then(async () => {
      const wait = last + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    chain = p.catch(() => {});
    return p;
  }

  /** POST a JSON body, return the parsed JSON. Redirects are not followed. */
  async function postJson(url, body) {
    let attempt = 0;
    for (;;) {
      await slot();
      stats.requests++;
      let res = null;
      let err = null;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "user-agent": USER_AGENT, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) { err = e; }
      const retryable = err || res.status === 429 || res.status >= 500;
      if (retryable) {
        if (attempt >= maxRetries) {
          if (err) {
            const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
            throw new HttpError(timedOut ? `no answer from the Texas bid board after ${Math.round(timeoutMs / 1000)}s (${attempt + 1} attempts)` : `network error after ${attempt + 1} attempts: ${err.message}`, 0, url);
          }
          throw new HttpError(`the Texas bid board answered HTTP ${res.status} after ${attempt + 1} attempts`, res.status, url);
        }
        attempt++;
        stats.retries++;
        let delay = backoffMs * 2 ** (attempt - 1);
        const ra = res && res.headers && res.headers.get && res.headers.get("retry-after");
        if (ra && Number.isFinite(Number(ra))) delay = Math.max(delay, Number(ra) * 1000);
        await sleep(delay);
        continue;
      }
      if (res.status >= 300 && res.status < 400) throw new HttpError(`unexpected redirect (HTTP ${res.status}); the bid board may have moved`, res.status, url);
      if (!res.ok) throw new HttpError(`the Texas bid board answered HTTP ${res.status}`, res.status, url);
      const text = await res.text();
      try { return JSON.parse(text); } catch {
        // The service sometimes answers 200 with an empty body when it is overloaded: treat it like a timeout and retry.
        if (attempt >= maxRetries) throw new HttpError(`the Texas bid board sent a reply that is not JSON (${text.length} bytes)${text.length === 0 ? ": it is probably overloaded, try again in a few minutes" : ""}`, res.status, url);
        attempt++;
        stats.retries++;
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
  }

  return { postJson, stats };
}
