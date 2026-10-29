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

function fakeRuntime(initial) {
  const calls = [];
  let stored = initial;
  return {
    calls,
    async getSidebarSections() {
      calls.push(["get"]);
      return stored;
    },
    async setSidebarSections(sections, base) {
      calls.push(["set", sections, base]);
      stored = sections;
      return sections;
    },
  };
}

test("getSections prefers the Cursor runtime over host settings", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { sidebarSections: [{ id: "host", name: "Host", agentIds: [] }] } }));
  const runtime = fakeRuntime([{ id: "__agents__", name: "Unassigned" }, { id: "s1", name: "One", agentIds: ["a"], isCollapsed: true }]);
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  const got = await gw.getSections();
  assert.deepEqual(got, [{ id: "__agents__", name: "Unassigned", agentIds: [] }, { id: "s1", name: "One", agentIds: ["a"], isCollapsed: true }]);
  assert.equal(calls.length, 0, "host settings untouched on read");
});

test("setSections sends the previous runtime sections as base and mirrors host settings", async () => {
  const { fetchImpl, calls } = fakeFetch((url, init) => ({ status: 200, body: JSON.parse(init.body) }));
  const prev = [{ id: "__agents__", name: "Unassigned" }, { id: "s1", name: "One", agentIds: ["a"] }];
  const runtime = fakeRuntime(prev);
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  const next = [{ id: "__agents__", name: "Unassigned", agentIds: [] }, { id: "s1", name: "Renamed", agentIds: ["a"] }];
  const saved = await gw.setSections(next);
  assert.deepEqual(saved, next);
  const set = runtime.calls.find((c) => c[0] === "set");
  assert.deepEqual(set[1], next);
  assert.deepEqual(set[2], prev);
  assert.equal(calls.at(-1).url, "https://host/api/setHostSettings");
  assert.deepEqual(calls.at(-1).body, { sidebarSections: next });
});

test("host mirror failure does not fail setSections", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 500, body: { message: "boom" } }));
  const runtime = fakeRuntime([]);
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  const next = [{ id: "s1", name: "One", agentIds: [] }];
  assert.deepEqual(await gw.setSections(next), next);
});

test("CursorClient get/setSidebarSections speak the runtime-settings RPC", async () => {
  const { CursorClient, CursorRpcError } = await import("../src/cursor.js");
  const { fetchImpl, calls } = fakeFetch((url, init) => {
    if (url.endsWith("/GetGrokBotUserRuntimeSettings")) return { status: 200, body: { settings: { sidebarSections: { sections: [{ id: "__agents__", name: "Unassigned" }] } } } };
    if (url.endsWith("/UpdateGrokBotUserRuntimeSettings")) {
      const b = JSON.parse(init.body);
      return { status: 200, body: b.sidebarSections.sections.length ? { settings: { sidebarSections: b.sidebarSections } } : { settings: {} } };
    }
    return { status: 404, body: {} };
  });
  const c = new CursorClient({ accessToken: "tok" }, { fetchImpl });
  const base = await c.getSidebarSections();
  assert.deepEqual(base, [{ id: "__agents__", name: "Unassigned" }]);
  const next = [{ id: "__agents__", name: "Unassigned" }, { id: "s", name: "S", agentIds: ["a"] }];
  assert.deepEqual(await c.setSidebarSections(next, base), next);
  assert.deepEqual(calls.at(-1).body, { sidebarSections: { sections: next }, sidebarSectionsBase: { sections: base } });
  await c.setSidebarSections(next);
  assert.equal("sidebarSectionsBase" in calls.at(-1).body, false);
  await assert.rejects(c.setSidebarSections([]), (e) => e instanceof CursorRpcError);
});

function captureStderr() {
  const orig = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return { lines, restore: () => (process.stderr.write = orig) };
}

test("setSections skips the host mirror when server sections are empty but host sections are not", async () => {
  const hostLayout = [{ id: "h", name: "Host", agentIds: ["a"] }];
  const { fetchImpl, calls } = fakeFetch((url, init) => {
    if (url.endsWith("/api/getHostSettings")) return { status: 200, body: { sidebarSections: hostLayout } };
    return { status: 200, body: JSON.parse(init.body) };
  });
  const runtime = fakeRuntime([]);
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  await gw.getSections();
  const next = [{ id: "s1", name: "One", agentIds: [] }];
  assert.deepEqual(await gw.setSections(next), next);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/setHostSettings")).length, 0);
  assert.equal(gw.lastSectionsMirror.ok, false);
  assert.equal(gw.lastSectionsMirror.skipped, true);
  assert.match(gw.lastSectionsMirror.reason, /empty/);
});

test("setSections still mirrors when server and host sections are both empty", async () => {
  const { fetchImpl, calls } = fakeFetch((url, init) => (url.endsWith("/api/getHostSettings") ? { status: 200, body: {} } : { status: 200, body: JSON.parse(init.body) }));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakeRuntime([]) });
  await gw.getSections();
  await gw.setSections([{ id: "s1", name: "One", agentIds: [] }]);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/setHostSettings")).length, 1);
  assert.deepEqual(gw.lastSectionsMirror, { ok: true });
});

test("mirror failure warns on stderr, records lastSectionsMirror, and setSections still resolves", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 500, body: { message: "boom" } }));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakeRuntime([{ id: "x", name: "X", agentIds: ["a"] }]) });
  await gw.getSections();
  const next = [{ id: "s1", name: "One", agentIds: [] }];
  const cap = captureStderr();
  let saved;
  try {
    saved = await gw.setSections(next);
  } finally {
    cap.restore();
  }
  assert.deepEqual(saved, next);
  assert.equal(gw.lastSectionsMirror.ok, false);
  assert.ok(!gw.lastSectionsMirror.skipped);
  assert.ok(gw.lastSectionsMirror.reason.length > 0);
  assert.equal(cap.lines.length, 1);
  assert.match(cap.lines[0], /^grokbot: warning: host sections mirror failed: .+\n$/);
});

test("setSections uses the base getSections read, even if the server changed since", async () => {
  const first = [{ id: "s1", name: "First", agentIds: [] }];
  const second = [{ id: "s1", name: "Changed elsewhere", agentIds: [] }];
  const reads = [first, second];
  const sets = [];
  const runtime = {
    async getSidebarSections() {
      return reads.shift() ?? second;
    },
    async setSidebarSections(sections, base) {
      sets.push({ sections, base });
      return sections;
    },
  };
  const { fetchImpl } = fakeFetch((url, init) => ({ status: 200, body: init?.body ? JSON.parse(init.body) : {} }));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  await gw.getSections();
  await gw.setSections([{ id: "s1", name: "Mine", agentIds: [] }]);
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].base, first);
  assert.equal(reads.length, 1, "exactly one Get call was made");
});

test("setSections falls back to a fresh read when getSections was never called", async () => {
  const prev = [{ id: "s1", name: "One", agentIds: [] }];
  const runtime = fakeRuntime(prev);
  const { fetchImpl } = fakeFetch((url, init) => ({ status: 200, body: init?.body ? JSON.parse(init.body) : {} }));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  await gw.setSections([{ id: "s1", name: "Two", agentIds: [] }]);
  assert.deepEqual(runtime.calls.find((c) => c[0] === "set")[2], prev);
});

test("host-branch getSections and setSections return normalized sections", async () => {
  const { fetchImpl } = fakeFetch((url, init) => {
    if (url.endsWith("/api/getHostSettings")) return { status: 200, body: { sidebarSections: [{ id: "s", name: "S", agentIds: ["a", "a", 3] }, { bogus: true }] } };
    return { status: 200, body: { sidebarSections: [{ id: "t", name: "T", agentIds: ["b", "b"] }, null] } };
  });
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl });
  assert.deepEqual(await gw.getSections(), [{ id: "s", name: "S", agentIds: ["a"] }]);
  assert.deepEqual(await gw.setSections([]), [{ id: "t", name: "T", agentIds: ["b"] }]);
});

test("setSections mirrors the server-stored list, not the request", async () => {
  let host = [];
  const { fetchImpl } = fakeFetch((url, init) => {
    if (url.endsWith("/api/getHostSettings")) return { status: 200, body: { sidebarSections: host } };
    host = JSON.parse(init.body).sidebarSections;
    return { status: 200, body: { sidebarSections: host } };
  });
  // Server amends every write: it keeps the protected Unassigned bucket first and trims section names.
  let stored = [];
  const runtime = {
    async getSidebarSections() {
      return stored;
    },
    async setSidebarSections(sections) {
      stored = [{ id: "__agents__", name: "Unassigned", agentIds: [] }, ...sections.filter((s) => s.id !== "__agents__").map((s) => ({ ...s, name: s.name.trim() }))];
      return stored;
    },
  };
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  await gw.getSections();
  await gw.setSections([{ id: "s1", name: "One ", agentIds: [] }]);
  assert.deepEqual(host, stored, "host mirror holds the server-stored list");
  await gw.setSections([{ id: "s1", name: "Renamed ", agentIds: [] }]);
  assert.deepEqual(gw.lastSectionsMirror, { ok: true });
  assert.deepEqual(host, stored);
});
