import "./_isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway, parseSse, readSnapshotFile } from "../src/gateway.js";

// Safety net: no test may touch the real ~/.grokbot snapshot.
const tmpSnapDir = mkdtempSync(join(tmpdir(), "grokbot-snap-"));
process.env.GROKBOT_SECTIONS_SYNC_FILE = join(tmpSnapDir, "default.json");

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
  const snapshotPath = join(mkdtempSync(join(tmpdir(), "grokbot-snap-")), "sync.json");
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime, snapshotPath });
  const next = [{ id: "__agents__", name: "Unassigned", agentIds: [] }, { id: "s1", name: "Renamed", agentIds: ["a"] }];
  const saved = await gw.setSections(next);
  assert.deepEqual(saved, next);
  const set = runtime.calls.find((c) => c[0] === "set");
  assert.deepEqual(set[1], next);
  assert.deepEqual(set[2], prev);
  assert.equal(calls.at(-1).url, "https://host/api/setHostSettings");
  assert.deepEqual(calls.at(-1).body, { sidebarSections: next }, "the host patch carries no snapshot key");
  assert.equal(typeof readSnapshotFile(snapshotPath).key, "string", "a mirror records the sync snapshot file so --auto sync sees no false conflict");
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
  assert.match(gw.lastSectionsMirror.reason, /differ/);
});

test("getSections warns on stderr when the server list is empty but host settings hold a layout", async () => {
  const { fetchImpl } = fakeFetch((url) => (url.endsWith("/api/getHostSettings") ? { status: 200, body: { sidebarSections: [{ id: "h", name: "Host", agentIds: ["a"] }] } } : null));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakeRuntime([{ id: "__agents__", name: "Unassigned" }]) });
  const cap = captureStderr();
  let got;
  try {
    got = await gw.getSections();
  } finally {
    cap.restore();
  }
  assert.deepEqual(got.filter((x) => x.id !== "__agents__"), [], "still reports the server list");
  assert.equal(cap.lines.length, 1);
  assert.match(cap.lines[0], /^grokbot: warning: server sections are empty while host settings hold 1; /);
});

test("host mirror skip warns, and stays skipped on the next command (guard is not one-shot)", async () => {
  const hostLayout = [{ id: "h1", name: "H1", agentIds: ["a"] }, { id: "h2", name: "H2", agentIds: ["b"] }];
  const { fetchImpl, calls } = fakeFetch((url, init) => {
    if (url.endsWith("/api/getHostSettings")) return { status: 200, body: { sidebarSections: hostLayout } };
    return { status: 200, body: JSON.parse(init.body) };
  });
  const runtime = fakeRuntime([]);
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  const cap = captureStderr();
  try {
    await gw.getSections();
    await gw.setSections([{ id: "s1", name: "Foo", agentIds: [] }]);
    await gw.getSections(); // server now holds [Foo]
    await gw.setSections([{ id: "s1", name: "Foo", agentIds: [] }, { id: "s2", name: "Bar", agentIds: [] }]);
  } finally {
    cap.restore();
  }
  assert.equal(calls.filter((c) => c.url.endsWith("/api/setHostSettings")).length, 0, "host layout never overwritten");
  assert.equal(gw.lastSectionsMirror.skipped, true);
  const skips = cap.lines.filter((l) => /host mirror skipped/.test(l));
  assert.equal(skips.length, 2, "each skipped mirror warns");
});

test("setSections mirrors when the host layout matches the server base", async () => {
  const layout = [{ id: "s1", name: "One", agentIds: ["a"] }];
  const { fetchImpl, calls } = fakeFetch((url, init) => (url.endsWith("/api/getHostSettings") ? { status: 200, body: { sidebarSections: layout } } : { status: 200, body: JSON.parse(init.body) }));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakeRuntime(layout) });
  await gw.getSections();
  const next = [{ id: "s1", name: "Renamed", agentIds: ["a"] }];
  await gw.setSections(next);
  assert.deepEqual(calls.filter((c) => c.url.endsWith("/api/setHostSettings")).map((c) => c.body.sidebarSections), [next]);
  assert.deepEqual(gw.lastSectionsMirror, { ok: true });
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

test("setSections mirrors the server-stored list, so a server amendment does not disable later mirrors", async () => {
  let host = [];
  const { fetchImpl, calls } = fakeFetch((url, init) => {
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
  const cap = captureStderr();
  try {
    await gw.getSections();
    await gw.setSections([{ id: "s1", name: "One ", agentIds: [] }]);
    assert.deepEqual(host, stored, "host mirror holds the server-stored list, not the request");
    await gw.setSections([{ id: "s1", name: "Renamed ", agentIds: [] }]);
    assert.deepEqual(gw.lastSectionsMirror, { ok: true }, "second edit still mirrors");
    assert.deepEqual(host, stored);
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.filter((l) => /host mirror skipped/.test(l)).length, 0);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/setHostSettings")).length, 2);
});

// ---------------------------------------------------------------- two stores: host mirror vs app store
function hostWorld(initial) {
  const host = { ...initial };
  const { fetchImpl, calls } = fakeFetch((url, init) => {
    if (url.endsWith("/api/getHostSettings")) return { status: 200, body: host };
    if (url.endsWith("/api/setHostSettings")) {
      Object.assign(host, JSON.parse(init.body));
      return { status: 200, body: host };
    }
    return { status: 200, body: {} };
  });
  return { host, fetchImpl, calls };
}
const mk = (runtime, hostInit, snapshot) => {
  const w = hostWorld(hostInit);
  const snapshotPath = join(mkdtempSync(join(tmpdir(), "grokbot-snap-")), "sync.json");
  if (snapshot) writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const snap = () => readSnapshotFile(snapshotPath);
  return { ...w, snapshotPath, snap, gw: new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl: w.fetchImpl, runtime, snapshotPath }) };
};
const A = { id: "s1", name: "One", agentIds: ["a"] };
const B = { id: "s2", name: "Two", agentIds: ["b"] };
const bucket = { id: "__agents__", name: "Unassigned", agentIds: [] };
const keyOf = (l) => JSON.stringify(l.map((x) => [x.id, x.name, x.agentIds]));

test("setSections without a runtime writes the host mirror and flags hostOnly", async () => {
  const { gw, host } = mk(null, {});
  assert.equal(gw.hostOnly, false);
  await gw.setSections([A]);
  assert.equal(gw.hostOnly, true);
  assert.deepEqual(host.sidebarSections, [A]);
});

test("sectionStores: drift false/true, and null without a runtime", async () => {
  let r = await mk(fakeRuntime([bucket, A]), { sidebarSections: [A] }).gw.sectionStores();
  assert.equal(r.drift, false, "__agents__ is ignored in the comparison");
  assert.equal(r.snapshot, null);
  r = await mk(fakeRuntime([bucket, A]), { sidebarSections: [A, B] }).gw.sectionStores();
  assert.equal(r.drift, true);
  r = await mk(fakeRuntime([A, B]), { sidebarSections: [B, A] }).gw.sectionStores();
  assert.equal(r.drift, true, "order matters");
  const snap = { at: "2026-11-01T00:00:00.000Z", key: "k" };
  r = await mk(null, { sidebarSections: [A] }, snap).gw.sectionStores();
  assert.equal(r.runtime, null);
  assert.equal(r.drift, null);
  assert.deepEqual(r.snapshot, snap);
  assert.deepEqual(r.host, [A]);
});

test("syncHostToRuntime pushes the host sections with the runtime as CAS base and writes the snapshot", async () => {
  const prev = [A, bucket];
  const runtime = fakeRuntime(prev);
  const { gw, host, snap, snapshotPath } = mk(runtime, { sidebarSections: [A, B] }, { at: "t", key: keyOf([A]) });
  const r = await gw.syncHostToRuntime();
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.snapshotWritten, true);
  const set = runtime.calls.find((c) => c[0] === "set");
  assert.deepEqual(set[1], [A, bucket, B], "the runtime bucket keeps its existing index");
  assert.deepEqual(set[2], prev, "CAS base is the raw runtime list read just before");
  assert.equal(snap().key, keyOf([A, B]), "snapshot persisted to the Mac-local file");
  assert.ok(!Number.isNaN(Date.parse(snap().at)));
  assert.equal(statSync(snapshotPath).mode & 0o777, 0o600);
  assert.equal("grokbotSectionsSync" in host, false, "nothing is written to the host settings key");
  assert.equal(keyOf(r.before.filter((x) => x.id !== "__agents__")), keyOf([A]));
});

test("syncHostToRuntime refuses an empty host mirror and never touches the app", async () => {
  const runtime = fakeRuntime([A]);
  const { gw } = mk(runtime, { sidebarSections: [bucket] });
  await assert.rejects(gw.syncHostToRuntime({ force: true }), (e) => e.name === "GatewayError" && e.reason === "empty-host");
  assert.equal(runtime.calls.some((c) => c[0] === "set"), false);
});

test("syncHostToRuntime without a runtime throws", async () => {
  await assert.rejects(mk(null, { sidebarSections: [A] }).gw.syncHostToRuntime(), (e) => e.reason === "no-runtime");
});

test("syncHostToRuntime is a noop when equal and refreshes a stale snapshot", async () => {
  const runtime = fakeRuntime([A, bucket]);
  const { gw, snap } = mk(runtime, { sidebarSections: [A] }, { at: "x", key: "old" });
  const r = await gw.syncHostToRuntime();
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(runtime.calls.some((c) => c[0] === "set"), false);
  assert.equal(snap().key, keyOf([A]));
});

test("syncHostToRuntime refuses when both sides moved since the last sync, unless forced", async () => {
  const snap = { at: "2026-11-01T00:00:00.000Z", key: keyOf([A]) };
  const mkConflict = () => mk(fakeRuntime([A, B]), { sidebarSections: [{ ...A, name: "Edited on host" }] }, snap);
  const refused = mkConflict();
  await assert.rejects(refused.gw.syncHostToRuntime(), (e) => e.reason === "conflict" && /--force/.test(e.message));
  assert.equal(refused.gw.runtime.calls.some((c) => c[0] === "set"), false);
  const forced = mkConflict();
  const r = await forced.gw.syncHostToRuntime({ force: true });
  assert.equal(r.changed, true);
  assert.equal(forced.gw.runtime.calls.find((c) => c[0] === "set")[1][0].name, "Edited on host");
});

test("syncHostToRuntime pushes when only the host moved since the last sync", async () => {
  const snap = { at: "t", key: keyOf([A]) };
  const { gw } = mk(fakeRuntime([A]), { sidebarSections: [A, B] }, snap);
  assert.equal((await gw.syncHostToRuntime()).changed, true);
});

test("syncHostToRuntime never overwrites an app-only edit (host == snapshot, runtime != snapshot)", async () => {
  const runtime = fakeRuntime([A, B]);
  const { gw, snap } = mk(runtime, { sidebarSections: [A] }, { at: "t", key: keyOf([A]) });
  const r = await gw.syncHostToRuntime();
  assert.equal(r.changed, false);
  assert.equal(r.reason, "host-unchanged");
  assert.equal(runtime.calls.some((c) => c[0] === "set"), false);
  assert.equal(snap().key, keyOf([A]), "snapshot untouched");
});

test("syncHostToRuntime with no snapshot refuses when stores differ, and pushes with force", async () => {
  for (const snapshot of [undefined, { at: "t" }]) {
    const runtime = fakeRuntime([A]);
    const { gw, snap } = mk(runtime, { sidebarSections: [A, B] }, snapshot);
    await assert.rejects(gw.syncHostToRuntime(), (e) => e.reason === "no-snapshot" && /--force/.test(e.message));
    assert.equal(runtime.calls.some((c) => c[0] === "set"), false);
    const r = await gw.syncHostToRuntime({ force: true });
    assert.equal(r.changed, true);
    assert.equal(snap().key, keyOf([A, B]));
  }
});

test("syncHostToRuntime warns and reports snapshotWritten:false when the snapshot write fails after the app write", async () => {
  const runtime = fakeRuntime([A]);
  const w = hostWorld({ sidebarSections: [A, B] });
  // Seeded snapshot in a read-only dir: reads work, the post-push write fails.
  const dir = mkdtempSync(join(tmpdir(), "grokbot-snap-"));
  const snapshotPath = join(dir, "sync.json");
  writeFileSync(snapshotPath, JSON.stringify({ at: "t", key: keyOf([A]) }));
  chmodSync(dir, 0o500);
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl: w.fetchImpl, runtime, snapshotPath });
  const cap = captureStderr();
  let r;
  try {
    r = await gw.syncHostToRuntime();
  } finally {
    cap.restore();
    chmodSync(dir, 0o700);
  }
  assert.equal(r.changed, true);
  assert.equal(r.snapshotWritten, false);
  assert.equal(runtime.calls.some((c) => c[0] === "set"), true);
  assert.match(cap.lines.join(""), /could not record the sync snapshot/);
});

test("host dropping unknown settings keys no longer matters: the snapshot lives in the Mac-local file", async () => {
  // A host that silently discards every key except sidebarSections (the live host's behavior).
  const stored = { sidebarSections: [A] };
  const { fetchImpl } = fakeFetch((url, init) => {
    if (url.endsWith("/api/getHostSettings")) return { status: 200, body: stored };
    if (url.endsWith("/api/setHostSettings")) {
      const b = JSON.parse(init.body);
      if (b.sidebarSections) stored.sidebarSections = b.sidebarSections;
      return { status: 200, body: stored };
    }
    return { status: 200, body: {} };
  });
  const snapshotPath = join(mkdtempSync(join(tmpdir(), "grokbot-snap-")), "sync.json");
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakeRuntime([A, bucket]), snapshotPath });
  assert.equal((await gw.syncHostToRuntime({ auto: true })).changed, false, "equal stores: bootstrap, no write");
  assert.equal(readSnapshotFile(snapshotPath).key, keyOf([A]), "bootstrap snapshot written to the file");
  stored.sidebarSections = [A, B]; // a box agent edits the mirror
  const r = await gw.syncHostToRuntime({ auto: true });
  assert.equal(r.changed, true, "--auto pushes the pending host edit");
  assert.equal(r.snapshotWritten, true);
  assert.equal(readSnapshotFile(snapshotPath).key, keyOf([A, B]));
  assert.equal((await gw.syncHostToRuntime({ auto: true })).changed, false);
});

test("sync with auto: only the host moved pushes; no snapshot and differing stores still refuses", async () => {
  const { gw, snap } = mk(fakeRuntime([A, bucket]), { sidebarSections: [A, B] }, { at: "t", key: keyOf([A]) });
  const r = await gw.syncHostToRuntime({ auto: true });
  assert.equal(r.changed, true);
  assert.equal(snap().key, keyOf([A, B]));
  const none = mk(fakeRuntime([A]), { sidebarSections: [A, B] });
  await assert.rejects(none.gw.syncHostToRuntime({ auto: true }), (e) => e.reason === "no-snapshot");
  assert.equal(existsSync(none.snapshotPath), false);
});

test("sync with auto on a real conflict keeps the app copy, writes nothing, and reports it as new only once", async () => {
  const snap0 = { at: "t", key: keyOf([A]) };
  const runtime = fakeRuntime([A, B]);
  const { gw, snap } = mk(runtime, { sidebarSections: [{ ...A, name: "Edited on host" }] }, snap0);
  const r1 = await gw.syncHostToRuntime({ auto: true });
  assert.deepEqual([r1.changed, r1.reason, r1.newConflict], [false, "conflict", true]);
  assert.equal(keyOf(r1.runtime), keyOf([A, B]));
  assert.equal(keyOf(r1.host), keyOf([{ ...A, name: "Edited on host" }]));
  assert.equal(runtime.calls.some((c) => c[0] === "set"), false, "app untouched");
  assert.equal(snap().key, snap0.key, "snapshot key unchanged");
  assert.ok(snap().conflictKey);
  const r2 = await gw.syncHostToRuntime({ auto: true });
  assert.deepEqual([r2.reason, r2.newConflict], ["conflict", false], "same conflict: silent");
  // Without auto the conflict still throws.
  await assert.rejects(gw.syncHostToRuntime(), (e) => e.reason === "conflict");
});

test("a mirror write that fails on the host does not write the snapshot file", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 500, body: { message: "boom" } }));
  const snapshotPath = join(mkdtempSync(join(tmpdir(), "grokbot-snap-")), "sync.json");
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakeRuntime([]), snapshotPath });
  const cap = captureStderr();
  try {
    await gw.setSections([A]);
  } finally {
    cap.restore();
  }
  assert.equal(existsSync(snapshotPath), false);
});

function fakePrefsRuntime({ pins = null, autoReview = null } = {}) {
  const calls = [];
  return {
    calls,
    async getPinnedAgents() {
      calls.push(["getPins"]);
      return pins;
    },
    async setPinnedAgents(ids) {
      calls.push(["setPins", ids]);
      pins = ids;
      return ids;
    },
    async getAutoReview() {
      calls.push(["getAR"]);
      return autoReview;
    },
    async setAutoReview(v) {
      calls.push(["setAR", v]);
      autoReview = { ...v, approvalMode: "server-derived" };
      return autoReview;
    },
  };
}

test("pins: the Cursor runtime store wins; host pinnedAgentIds is only the fallback when the server holds none", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { pinnedAgentIds: ["stale-host"] } }));
  const withPins = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakePrefsRuntime({ pins: ["a", "b"] }) });
  assert.deepEqual(await withPins.getPinned(), ["a", "b"]);
  assert.equal(calls.length, 0, "host untouched when the runtime has pins");
  const none = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakePrefsRuntime({ pins: null }) });
  assert.deepEqual(await none.getPinned(), ["stale-host"]);
});

test("setPinned writes the runtime store, then mirrors host settings best-effort", async () => {
  const { fetchImpl, calls } = fakeFetch((url, init) => ({ status: 200, body: JSON.parse(init.body) }));
  const runtime = fakePrefsRuntime({ pins: ["a"] });
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  assert.deepEqual(await gw.setPinned(["a", "c"]), ["a", "c"]);
  assert.deepEqual(runtime.calls.at(-1), ["setPins", ["a", "c"]]);
  assert.deepEqual(calls.at(-1).body, { pinnedAgentIds: ["a", "c"] });
  assert.equal(gw.pinsHostOnly, false);
  // a failing mirror warns but never fails the app-visible write
  const bad = fakeFetch(() => ({ status: 500, body: { message: "boom" } }));
  const err = captureStderr();
  try {
    const gw2 = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl: bad.fetchImpl, runtime: fakePrefsRuntime() });
    assert.deepEqual(await gw2.setPinned(["z"]), ["z"]);
  } finally {
    err.restore();
  }
  assert.match(err.lines.join(""), /host pins mirror failed/);
});

test("setPinned without a runtime (box) writes only host settings and flags pinsHostOnly", async () => {
  const { fetchImpl, calls } = fakeFetch((url, init) => ({ status: 200, body: JSON.parse(init.body) }));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl });
  assert.deepEqual(await gw.setPinned(["a"]), ["a"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { pinnedAgentIds: ["a"] });
  assert.equal(gw.pinsHostOnly, true);
});

test("normalizeAutoReview reads the structured value, a legacy string, and nothing", async () => {
  const { normalizeAutoReview } = await import("../src/gateway.js");
  assert.deepEqual(normalizeAutoReview({ isEnabled: false, allowInstructions: ["a", "", 3], blockInstructions: ["b"], approvalMode: "x" }), { isEnabled: false, allowInstructions: ["a"], blockInstructions: ["b"] });
  assert.deepEqual(normalizeAutoReview("one\n\n two \n"), { isEnabled: true, allowInstructions: ["one", "two"], blockInstructions: [], legacy: true });
  assert.deepEqual(normalizeAutoReview(""), { isEnabled: null, allowInstructions: [], blockInstructions: [], legacy: true });
  assert.deepEqual(normalizeAutoReview(undefined), { isEnabled: null, allowInstructions: [], blockInstructions: [] });
});

test("auto-review: runtime read wins, runtime write sends only the three rule fields and mirrors host settings", async () => {
  const { fetchImpl, calls } = fakeFetch((url, init) => ({ status: 200, body: url.endsWith("/getHostSettings") ? { autoReviewInstructions: "legacy string" } : JSON.parse(init.body) }));
  const runtime = fakePrefsRuntime({ autoReview: { isEnabled: true, allowInstructions: ["r1"], blockInstructions: [], approvalMode: "m" } });
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime });
  assert.deepEqual(await gw.getAutoReview(), { isEnabled: true, allowInstructions: ["r1"], blockInstructions: [] });
  assert.equal(calls.length, 0);
  const saved = await gw.setAutoReview({ isEnabled: true, allowInstructions: ["r1", "r2"], blockInstructions: [], approvalMode: "ignored" });
  assert.deepEqual(runtime.calls.at(-1), ["setAR", { isEnabled: true, allowInstructions: ["r1", "r2"], blockInstructions: [] }]);
  assert.deepEqual(saved.allowInstructions, ["r1", "r2"]);
  assert.deepEqual(calls.at(-1).body, { autoReviewInstructions: { isEnabled: true, allowInstructions: ["r1", "r2"], blockInstructions: [] } });
  assert.equal(gw.autoReviewHostOnly, false);
  // no runtime row on the server: fall back to the host copy (here a legacy string)
  const gw2 = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime: fakePrefsRuntime() });
  assert.deepEqual((await gw2.getAutoReview()).allowInstructions, ["legacy string"]);
});

test("new host reads use the argument names the live host validates", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [] }));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl });
  await gw.todos("a");
  await gw.tasks("a");
  await gw.searchConversation("a", "q", 7);
  await gw.subagents("a");
  await gw.asyncTasks("a");
  assert.deepEqual(calls.map((c) => [c.url.split("/api/")[1], c.body]), [
    ["getAgentTodos", { id: "a" }],
    ["getAgentTasks", { agentId: "a" }],
    ["searchConversation", { agentId: "a", query: "q", limit: 7 }],
    ["getSubagents", { id: "a" }],
    ["getAsyncTasks", { id: "a" }],
  ]);
  for (const gone of ["deleteAgent", "setNotifications", "memories"]) assert.equal(typeof gw[gone], "undefined", `${gone} was removed (host 00b0aa1 has no such command)`);
});

test("network failures surface the undici cause instead of a bare 'fetch failed'", async () => {
  const fetchImpl = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  };
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl });
  await assert.rejects(gw.countAgents(), /countAgents: fetch failed \(ECONNRESET\)/);
});

test("CursorClient pins, auto-review, todos and tasks speak the runtime-settings and agent RPCs", async () => {
  const { CursorClient, CursorRpcError } = await import("../src/cursor.js");
  const { fetchImpl, calls } = fakeFetch((url, init) => {
    const b = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith("/GetGrokBotUserRuntimeSettings")) return { status: 200, body: { settings: { pinnedAgents: { agentIds: ["p1"] }, autoReviewInstructions: { isEnabled: true, allowInstructions: ["a"], blockInstructions: [] } } } };
    if (url.endsWith("/UpdateGrokBotUserRuntimeSettings")) return { status: 200, body: { settings: b.pinnedAgents?.agentIds?.length ? { pinnedAgents: b.pinnedAgents } : b.autoReviewInstructions ? { autoReviewInstructions: b.autoReviewInstructions } : {} } };
    if (url.endsWith("/ListGrokBotAgentTodos")) return { status: 200, body: { todos: [{ id: "t" }] } };
    if (url.endsWith("/ListGrokBotAgentTasks")) return { status: 200, body: { tasks: [] } };
    return { status: 404, body: {} };
  });
  const c = new CursorClient({ accessToken: "tok" }, { fetchImpl });
  assert.deepEqual(await c.getPinnedAgents(), ["p1"]);
  assert.deepEqual(await c.setPinnedAgents(["p1", "p2"]), ["p1", "p2"]);
  assert.deepEqual(calls.at(-1).body, { pinnedAgents: { agentIds: ["p1", "p2"] } });
  // proto3 JSON omits an empty repeated field: a successful write of [] echoes `settings: {}` and is NOT an error
  assert.deepEqual(await c.setPinnedAgents([]), []);
  assert.equal((await c.getAutoReview()).isEnabled, true);
  await c.setAutoReview({ isEnabled: false, allowInstructions: ["x"], blockInstructions: ["y"], approvalMode: "dropped" });
  assert.deepEqual(calls.at(-1).body, { autoReviewInstructions: { isEnabled: false, allowInstructions: ["x"], blockInstructions: ["y"] } });
  assert.deepEqual(await c.listAgentTodos("a"), [{ id: "t" }]);
  assert.deepEqual(calls.at(-1).body, { agentId: "a" });
  await c.listAgentTasks("a", { includeRecentlyDone: true });
  assert.deepEqual(calls.at(-1).body, { agentId: "a", includeRecentlyDone: true });
});

test("pins: a missing agentIds on a successful reply is [], and only a reply with no settings is an error", async () => {
  const { CursorClient, CursorRpcError } = await import("../src/cursor.js");
  const reply = { current: null };
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: reply.current }));
  const c = new CursorClient({ accessToken: "tok" }, { fetchImpl });
  reply.current = { settings: { pinnedAgents: {} } };
  assert.deepEqual(await c.setPinnedAgents([]), [], "pinnedAgents present without agentIds");
  assert.deepEqual(await c.getPinnedAgents(), [], "the same shape on read is an empty list, not 'no pins stored'");
  reply.current = { settings: { updatedAtMs: "1" } };
  assert.deepEqual(await c.setPinnedAgents([]), [], "pinnedAgents key absent");
  assert.equal(await c.getPinnedAgents(), null, "no pinnedAgents at all on read: the server holds none (the app falls back to host)");
  reply.current = {};
  await assert.rejects(c.setPinnedAgents(["a"]), (e) => e instanceof CursorRpcError && /no settings/.test(e.message));
});

test("setPinned always attempts the host mirror, [] included; a failed mirror after an emptying write is an error", async () => {
  const mk = (hostOk) => {
    const { fetchImpl, calls } = fakeFetch((url, init) => (hostOk ? { status: 200, body: JSON.parse(init.body) } : { status: 500, body: { message: "boom" } }));
    const runtime = fakePrefsRuntime({ pins: ["a"] });
    return { gw: new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime }), calls, runtime };
  };
  const ok = mk(true);
  assert.deepEqual(await ok.gw.setPinned([]), []);
  assert.deepEqual(ok.calls.map((c) => [c.url.split("/api/")[1], c.body]), [["setHostSettings", { pinnedAgentIds: [] }]], "the empty list is mirrored too");
  const bad = mk(false);
  await assert.rejects(bad.gw.setPinned([]), (e) => e.name === "GatewayError" && /cleared in the Cursor store, but mirroring the empty list .* failed/.test(e.message) && e.reason === "pins-mirror-failed");
  assert.deepEqual(bad.runtime.calls.at(-1), ["setPins", []], "the runtime write itself happened");
  const err = captureStderr();
  try {
    const warn = mk(false);
    assert.deepEqual(await warn.gw.setPinned(["z"]), ["z"], "a non-empty write only warns");
  } finally {
    err.restore();
  }
  assert.match(err.lines.join(""), /host pins mirror failed/);
});

test("CursorClient.sendUserMessage posts SendGrokBotUserMessage with agentId, a uuid messageId, sentAtMs and text", async () => {
  const { CursorClient } = await import("../src/cursor.js");
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { dispatched: true, mode: "SEND_MODE_ACCEPTED_TEMPORAL" } }));
  const c = new CursorClient({ accessToken: "tok" }, { fetchImpl });
  const r = await c.sendUserMessage("agent-1", "hi", { sentAtMs: 1700000000000 });
  assert.match(calls[0].url, /\/aiserver\.v1\.GrokBotService\/SendGrokBotUserMessage$/);
  assert.equal(calls[0].body.agentId, "agent-1");
  assert.equal(calls[0].body.text, "hi");
  assert.equal(calls[0].body.sentAtMs, "1700000000000", "int64 goes out as a string");
  assert.match(calls[0].body.messageId, /^[0-9a-f-]{36}$/);
  assert.equal("replyToId" in calls[0].body, false);
  assert.deepEqual([r.dispatched, r.messageId === calls[0].body.messageId], [true, true]);
  await c.sendUserMessage("agent-1", "again", { messageId: "fixed", replyToId: "e9" });
  assert.deepEqual([calls[1].body.messageId, calls[1].body.replyToId], ["fixed", "e9"]);
});
