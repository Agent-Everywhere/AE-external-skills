import test from "node:test";
import assert from "node:assert/strict";
import { createHttp, HttpError, userAgent } from "../src/http.js";
import { AllowlistError } from "../src/allowlist.js";
import { fakeClock, mockFetch, res, tmpDir } from "./helpers.js";

const URL1 = "https://efts.sec.gov/LATEST/search-index?q=x&forms=D";
const DOC = "https://www.sec.gov/Archives/edgar/data/1/000123456726000001/primary_doc.xml";

test("User-Agent is '<app> <contact email>' and is sent on every request", async () => {
  const clock = fakeClock();
  const f = mockFetch(() => res({}));
  const http = createHttp({ email: "rep@sales.test", fetchImpl: f, sleep: clock.sleep, now: clock.now });
  await http.getJson(URL1);
  assert.equal(f.calls[0].init.headers["user-agent"], "sec-funding-signals rep@sales.test");
  assert.equal(userAgent("a@b.co"), "sec-funding-signals a@b.co");
});

test("no email, no client", () => {
  assert.throws(() => createHttp({ fetchImpl: async () => res({}) }), /contact email/);
});

test("requests are spaced at least 250 ms apart (at most 4 per second) even when issued concurrently", async () => {
  const clock = fakeClock();
  const times = [];
  const f = mockFetch(() => { times.push(clock.now()); return res({}); });
  const http = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now });
  await Promise.all([1, 2, 3, 4, 5].map(() => http.getJson(URL1)));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 250, `gap ${times[i] - times[i - 1]}`);
});

test("429 and 5xx are retried with backoff; Retry-After is honoured; gives up after maxRetries", async () => {
  const clock = fakeClock();
  let n = 0;
  const f = mockFetch(() => (++n === 1 ? res({}, { status: 429, headers: { "retry-after": "3" } }) : n === 2 ? res({}, { status: 503 }) : res({ ok: 1 })));
  const http = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(await http.getJson(URL1), { ok: 1 });
  assert.equal(http.stats.retries, 2);
  assert.ok(clock.sleeps.includes(3000));
  const bad = createHttp({ email: "a@b.co", fetchImpl: mockFetch(() => res({}, { status: 500 })), sleep: clock.sleep, now: clock.now, maxRetries: 1 });
  await assert.rejects(() => bad.getJson(URL1), HttpError);
});

test("a 404 is not retried", async () => {
  const clock = fakeClock();
  const f = mockFetch(() => res("", { status: 404 }));
  const http = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now });
  await assert.rejects(() => http.getText(DOC), (e) => e.status === 404);
  assert.equal(f.calls.length, 1);
});

test("a redirect is followed only to an allowed URL", async () => {
  const clock = fakeClock();
  const f = mockFetch((u) => (u === DOC ? res("", { status: 302, headers: { location: "https://evil.example.com/x" } }) : res("<x/>")));
  const http = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now });
  await assert.rejects(() => http.getText(DOC), AllowlistError);
  assert.equal(f.calls.length, 1);
});

test("a non-allowlisted URL never reaches fetch", async () => {
  const f = mockFetch(() => res({}));
  const http = createHttp({ email: "a@b.co", fetchImpl: f });
  await assert.rejects(() => http.getJson("https://www.sec.gov/cgi-bin/browse-edgar"), AllowlistError);
  assert.equal(f.calls.length, 0);
});

test("filings are cached on disk forever; --no-cache refetches", async () => {
  const clock = fakeClock();
  const dir = tmpDir();
  const f = mockFetch(() => res("<edgarSubmission/>"));
  const a = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: dir });
  await a.cachedText(DOC, () => a.getText(DOC));
  const b = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: dir });
  assert.equal(await b.cachedText(DOC, () => b.getText(DOC)), "<edgarSubmission/>");
  assert.equal(f.calls.length, 1);
  assert.equal(b.stats.cacheHits, 1);
  const c = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: dir, noCache: true });
  await c.cachedText(DOC, () => c.getText(DOC));
  assert.equal(f.calls.length, 2);
});
