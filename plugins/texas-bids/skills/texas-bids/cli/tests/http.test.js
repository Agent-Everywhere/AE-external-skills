import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT, createHttp } from "../src/http.js";
import { fakeClock, mockFetch, res } from "./helpers.js";

const mk = (f, extra = {}) => { const c = fakeClock(); return { c, http: createHttp({ fetchImpl: f, sleep: c.sleep, now: c.now, ...extra }) }; };

test("sends a plain user agent, JSON body, no redirects and a timeout signal", async () => {
  const f = mockFetch(() => res({ ok: 1 }));
  const { http } = mk(f);
  assert.deepEqual(await http.postJson("https://example.test/x", { a: 1 }), { ok: 1 });
  const init = f.calls[0].init;
  assert.equal(init.headers["user-agent"], USER_AGENT);
  assert.match(USER_AGENT, /^texas-bids-cli\/\d/);
  assert.doesNotMatch(USER_AGENT, /@/, "no personal contact details in the user agent");
  assert.equal(init.redirect, "manual");
  assert.ok(init.signal);
  assert.equal(init.body, '{"a":1}');
});

test("paces requests at least 750 ms apart", async () => {
  const f = mockFetch(() => res({}));
  const { http, c } = mk(f);
  await http.postJson("https://example.test/x", {});
  const t0 = c.t;
  await http.postJson("https://example.test/x", {});
  assert.ok(c.t - t0 >= 750);
});

test("retries 5xx and 429 with backoff, then succeeds", async () => {
  const f = mockFetch((u, i, n) => (n === 1 ? res("busy", { status: 503 }) : n === 2 ? res("slow", { status: 429, headers: { "retry-after": "5" } }) : res({ ok: true })));
  const { http, c } = mk(f, { maxRetries: 3 });
  assert.deepEqual(await http.postJson("https://example.test/x", {}), { ok: true });
  assert.equal(f.calls.length, 3);
  assert.ok(c.sleeps.some((s) => s >= 5000), "honours Retry-After");
});

test("a non-200 answer is a clear error and is not retried (4xx)", async () => {
  const f = mockFetch(() => res("nope", { status: 403 }));
  const { http } = mk(f);
  await assert.rejects(http.postJson("https://example.test/x", {}), /HTTP 403/);
  assert.equal(f.calls.length, 1);
});

test("persistent 5xx gives up with a clear message", async () => {
  const f = mockFetch(() => res("", { status: 502 }));
  const { http } = mk(f, { maxRetries: 2 });
  await assert.rejects(http.postJson("https://example.test/x", {}), /HTTP 502 after 3 attempts/);
  assert.equal(f.calls.length, 3);
});

test("a timeout is retried and then reported as no answer", async () => {
  const f = mockFetch(() => { const e = new Error("t"); e.name = "TimeoutError"; throw e; });
  const { http } = mk(f, { maxRetries: 1, timeoutMs: 45000 });
  await assert.rejects(http.postJson("https://example.test/x", {}), /no answer from the Texas bid board after 45s/);
  assert.equal(f.calls.length, 2);
});

test("an empty 200 body is retried, then reported as not JSON", async () => {
  const f = mockFetch(() => res("", { status: 200 }));
  const { http } = mk(f, { maxRetries: 1 });
  await assert.rejects(http.postJson("https://example.test/x", {}), /not JSON \(0 bytes\).*overloaded/);
  assert.equal(f.calls.length, 2);
  const f2 = mockFetch((u, i, n) => (n === 1 ? res("", { status: 200 }) : res({ ok: 1 })));
  assert.deepEqual(await mk(f2).http.postJson("https://example.test/x", {}), { ok: 1 });
});

test("a redirect is an error, not followed", async () => {
  const f = mockFetch(() => res("", { status: 302, headers: { location: "https://elsewhere.test/" } }));
  await assert.rejects(mk(f).http.postJson("https://example.test/x", {}), /unexpected redirect/);
});
