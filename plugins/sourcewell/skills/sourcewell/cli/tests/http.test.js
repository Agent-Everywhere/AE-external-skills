import test from "node:test";
import assert from "node:assert/strict";
import { createHttp, HttpError } from "../src/http.js";
import { fakeClock, jsonRes, mockFetch, tmpDir } from "./helpers.js";

test("rate limiter: request starts are at least 500ms apart (max 2 per second)", async () => {
  const clock = fakeClock();
  const starts = [];
  const f = mockFetch(() => { starts.push(clock.now()); return jsonRes({}); });
  const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, noCache: true, cacheDir: tmpDir() });
  await Promise.all(Array.from({ length: 7 }, (_, i) => http.request(`https://x.test/${i}`)));
  assert.equal(starts.length, 7);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 500, `gap ${i}`);
  for (let i = 2; i < starts.length; i++) assert.ok(starts[i] - starts[i - 2] >= 1000, `window ${i}`);
});

test("retries 429 then 503 with exponential backoff, then succeeds", async () => {
  const clock = fakeClock();
  const seq = [429, 503, 200];
  const f = mockFetch(() => jsonRes({ ok: 1 }, { status: seq.shift() }));
  const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, noCache: true, cacheDir: tmpDir(), backoffMs: 1000 });
  const res = await http.request("https://x.test/");
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 3);
  assert.ok(clock.sleeps.includes(1000));
  assert.ok(clock.sleeps.includes(2000));
  assert.equal(http.stats.retries, 2);
});

test("honours Retry-After", async () => {
  const clock = fakeClock();
  const seq = [jsonRes({}, { status: 429, headers: { "retry-after": "7" } }), jsonRes({})];
  const http = createHttp({ fetchImpl: mockFetch(() => seq.shift()), sleep: clock.sleep, now: clock.now, noCache: true, cacheDir: tmpDir() });
  await http.request("https://x.test/");
  assert.ok(clock.sleeps.includes(7000));
});

test("does not retry a 404, and gives up on persistent 5xx", async () => {
  const clock = fakeClock();
  const f404 = mockFetch(() => jsonRes({}, { status: 404 }));
  const h1 = createHttp({ fetchImpl: f404, sleep: clock.sleep, now: clock.now, noCache: true, cacheDir: tmpDir() });
  assert.equal((await h1.request("https://x.test/")).status, 404);
  assert.equal(f404.calls.length, 1);
  const f500 = mockFetch(() => jsonRes({}, { status: 500 }));
  const h2 = createHttp({ fetchImpl: f500, sleep: clock.sleep, now: clock.now, noCache: true, cacheDir: tmpDir(), maxRetries: 2 });
  await assert.rejects(() => h2.request("https://x.test/"), (e) => e instanceof HttpError && e.status === 500);
  assert.equal(f500.calls.length, 3);
});

test("retries network errors", async () => {
  const clock = fakeClock();
  let n = 0;
  const f = mockFetch(() => { if (n++ === 0) throw new Error("ECONNRESET"); return jsonRes({}); });
  const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, noCache: true, cacheDir: tmpDir() });
  assert.equal((await http.request("https://x.test/")).status, 200);
});

test("cache: hit within 24h, miss after TTL, bypassed with noCache", async () => {
  const dir = tmpDir();
  const clock = fakeClock();
  let produced = 0;
  const mk = (noCache) => createHttp({ fetchImpl: mockFetch(() => jsonRes({})), sleep: clock.sleep, now: clock.now, cacheDir: dir, noCache });
  const produce = async () => ({ n: ++produced });
  const h = mk(false);
  assert.deepEqual(await h.cached("k", produce), { n: 1 });
  assert.deepEqual(await h.cached("k", produce), { n: 1 });
  assert.equal(h.stats.cacheHits, 1);
  clock.t += 23 * 3600 * 1000;
  assert.deepEqual(await mk(false).cached("k", produce), { n: 1 });
  clock.t += 2 * 3600 * 1000;
  assert.deepEqual(await mk(false).cached("k", produce), { n: 2 });
  assert.deepEqual(await mk(true).cached("k", produce), { n: 3 });
});
