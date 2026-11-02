import test from "node:test";
import assert from "node:assert/strict";
import { resolveWsUrl } from "../src/cdp.js";
import { redact, stats } from "../src/output.js";

test("resolveWsUrl passes ws urls and reads /json/version", async () => {
  assert.equal(await resolveWsUrl("ws://a/b"), "ws://a/b");
  assert.equal(await resolveWsUrl("http://h:9", async (u) => { assert.equal(u, "http://h:9/json/version"); return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://h/x" }) }; }), "ws://h/x");
});

test("redact and stats", () => {
  assert.equal(redact("at wss://secret/host intuit_apikey=abc,"), "at <cdp-url> intuit_apikey=<redacted>,");
  assert.deepEqual(stats([5, 1, 3, 2, 4]), { n: 5, median: 3, p95: 5, min: 1, max: 5 });
});
