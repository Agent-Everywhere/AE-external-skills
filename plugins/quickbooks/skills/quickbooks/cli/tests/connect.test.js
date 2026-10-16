import test from "node:test";
import assert from "node:assert/strict";
import { claimAgentBrowser, startHeartbeat, ConnectError } from "../src/connect.js";
import { resolveWsUrl } from "../src/cdp.js";
import { redact, stats } from "../src/output.js";

const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

test("claim posts to /browser/claim and returns the session", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([url, JSON.parse(init.body)]); return res(200, { cdp_url: "wss://x/y", heartbeat_token: "h", session_id: "s" }); };
  const c = await claimAgentBrowser({ base: "https://b/", claim: "c1", fetchImpl });
  assert.deepEqual(c, { cdpUrl: "wss://x/y", sessionId: "s", heartbeatToken: "h" });
  assert.deepEqual(seen[0], ["https://b/browser/claim", { claim: "c1" }]);
});

test("rejected or incomplete claims fail clearly", async () => {
  await assert.rejects(claimAgentBrowser({ base: "https://b", claim: "c", fetchImpl: async () => res(410, {}) }), /one-use/);
  await assert.rejects(claimAgentBrowser({ base: "https://b", claim: "c", fetchImpl: async () => res(200, { cdp_url: "x" }) }), ConnectError);
  await assert.rejects(claimAgentBrowser({ base: "", claim: "" }), /needs --base/);
});

test("heartbeat posts and stops", async () => {
  const paths = [];
  const hb = startHeartbeat({ base: "https://b", sessionId: "s", heartbeatToken: "h", intervalMs: 100000, fetchImpl: async (u) => { paths.push(new URL(u).pathname); return res(200, {}); } });
  await hb.report(true);
  await hb.stop();
  assert.ok(paths.includes("/browser/heartbeat") && paths.includes("/browser/auth"));
});

test("resolveWsUrl passes ws urls and reads /json/version", async () => {
  assert.equal(await resolveWsUrl("ws://a/b"), "ws://a/b");
  assert.equal(await resolveWsUrl("http://h:9", async (u) => { assert.equal(u, "http://h:9/json/version"); return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://h/x" }) }; }), "ws://h/x");
});

test("redact and stats", () => {
  assert.equal(redact("at wss://secret/host intuit_apikey=abc,"), "at <cdp-url> intuit_apikey=<redacted>,");
  assert.deepEqual(stats([5, 1, 3, 2, 4]), { n: 5, median: 3, p95: 5, min: 1, max: 5 });
});
