import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, parseSse } from "../src/gateway.js";

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const r = handler(url, init) ?? { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, statusText: "x", text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { fetchImpl, calls };
}

test("call builds /api/<command> with bearer + routing headers and parses JSON", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [{ id: "a" }] }));
  const gw = new Gateway({ baseUrl: "https://host/", token: "T", headers: { "x-anyrun-network-token": "N" } }, { fetchImpl });
  const rows = await gw.listAgents();
  assert.deepEqual(rows, [{ id: "a" }]);
  assert.equal(calls[0].url, "https://host/api/listAgents");
  assert.equal(calls[0].init.headers.authorization, "Bearer T");
  assert.equal(calls[0].init.headers["x-anyrun-network-token"], "N");
  await gw.listAgents();
  assert.equal(calls.length, 1, "roster cached until a mutation");
  await gw.setHidden("a", true);
  assert.deepEqual(calls[1].body, { id: "a", isHidden: true });
  await gw.listAgents();
  assert.equal(calls.length, 3, "mutation invalidates roster cache");
});

test("errors carry status and redact bearer tokens", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 401, body: { message: "bad Bearer abc.def.ghi" } }));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl });
  await assert.rejects(gw.countAgents(), (e) => e.name === "GatewayError" && e.status === 401 && !e.message.includes("abc.def") && e.exitCode === 2);
});

test("sections/pins go through host settings", async () => {
  const { fetchImpl, calls } = fakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/api/getHostSettings")) return { status: 200, body: { sidebarSections: [{ id: "s", name: "S", agentIds: [] }], pinnedAgentIds: ["p"] } };
    if (url.endsWith("/api/setHostSettings")) return { status: 200, body };
    return { status: 200, body: {} };
  });
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl });
  assert.deepEqual(await gw.getSections(), [{ id: "s", name: "S", agentIds: [] }]);
  assert.deepEqual(await gw.getPinned(), ["p"]);
  await gw.setSections([]);
  assert.deepEqual(calls.at(-1).body, { sidebarSections: [] });
  const sent = await gw.sendPrompt("a", "hi");
  assert.ok(sent.clientNonce.length > 10);
  assert.equal(calls.at(-1).body.agentId, "a");
});

test("parseSse", () => {
  const e = parseSse('event: roster\nid: 7\ndata: {"a":1}\ndata: ');
  assert.equal(e.event, "roster");
  assert.equal(e.id, "7");
  assert.equal(e.data, '{"a":1}\n');
  assert.deepEqual(e.json, { a: 1 });
  assert.equal(parseSse(": keepalive"), null);
});
