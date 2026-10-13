// Regression tests for the grokbot bug-fix pass (create --section, strict delete resolution, section refetch,
// nudgeRenderer policy gate, and timeouts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cdp, CdpError } from "../src/cdp.js";
import { Gateway } from "../src/gateway.js";
import { resolveAgent, resolveMany } from "../src/agents.js";
import { WAIT_TRANSCRIPT_WINDOW, entriesSince, nudgeDeps, run, setGatewayForTests } from "../src/cli.js";

// ---------------------------------------------------------------- helpers
const A1 = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "abcd2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A3 = "33333333-cccc-4ccc-8ccc-cccccccccccc";

function mockGateway({ roster = [], sections = [], createResult = { id: "new-agent" }, transcript = [] } = {}) {
  const calls = [];
  let secs = sections;
  const gw = {
    calls,
    async listAgents() { return roster; },
    async getSections() { calls.push(["getSections"]); return typeof secs === "function" ? secs() : secs; },
    async setSections(next) { calls.push(["setSections", next]); return next; },
    async createAgent(p) { calls.push(["createAgent", p]); return createResult; },
    async deleteAgents(ids) { calls.push(["deleteAgents", ids]); return { ok: true }; },
    async sendPrompt(id, prompt) { calls.push(["sendPrompt", id, prompt]); return { accepted: true, clientNonce: "n", sentAt: Date.now() }; },
    async transcriptTail(id, limit) { calls.push(["transcriptTail", id, limit]); return transcript; },
    async health() { return { ok: true }; },
  };
  return gw;
}

async function runCli(gw, ...args) {
  setGatewayForTests(gw);
  const buf = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => (buf.push(String(s)), true);
  process.stderr.write = () => true;
  try {
    await run(["node", "grokbot", "--json", ...args]);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    setGatewayForTests(null);
  }
  // The test runner's own reporter may write to stdout while it is patched; keep only our JSON payloads.
  return buf.filter((c) => /^[\[{]/.test(c)).join("");
}

// ---------------------------------------------------------------- fix 1: agents create --section
test("create --section validates the section BEFORE createAgent", async () => {
  const gw = mockGateway({ sections: [{ id: "s1", name: "Swarm", agentIds: [] }] });
  await assert.rejects(runCli(gw, "agents", "create", "Bot", "--section", "Nope"), /No section matches/);
  assert.ok(!gw.calls.some((c) => c[0] === "createAgent"), "no agent may be created for a bad section");
});

test("create --section assigns the new agent and reports the resolved section", async () => {
  const gw = mockGateway({ sections: [{ id: "s1", name: "Swarm", agentIds: [] }] });
  await runCli(gw, "agents", "create", "Bot", "--section", "swarm");
  const set = gw.calls.find((c) => c[0] === "setSections");
  assert.deepEqual(set[1].find((s) => s.id === "s1").agentIds, ["new-agent"]);
});

test("create --section errors (does not claim success) when the create response has no id", async () => {
  const gw = mockGateway({ sections: [{ id: "s1", name: "Swarm", agentIds: [] }], createResult: {} });
  await assert.rejects(runCli(gw, "agents", "create", "Bot", "--section", "Swarm"), /NOT placed in section "Swarm"/);
  assert.ok(!gw.calls.some((c) => c[0] === "setSections"));
});

// ---------------------------------------------------------------- fix 2: resolveAgent precedence + strict
const roster = [
  { id: A1, name: "Researcher" },
  { id: A2, name: "Writer" },
  { id: A3, name: "abcd" }, // name collides with A2's id prefix
];

test("exact name beats id-prefix match; full id beats everything", () => {
  assert.equal(resolveAgent(roster, "abcd").id, A3, "exact name wins over id prefix");
  assert.equal(resolveAgent(roster, A2).id, A2);
  assert.equal(resolveAgent(roster, "abcd2222").id, A2, "non-colliding prefix still works in loose mode");
});

test("strict mode: full id or exact name only", () => {
  assert.equal(resolveAgent(roster, A1, { strict: true }).id, A1);
  assert.equal(resolveAgent(roster, "writer", { strict: true }).id, A2);
  assert.throws(() => resolveAgent(roster, "1111", { strict: true }), /exact id or name/);
  assert.throws(() => resolveAgent(roster, "abcd2222", { strict: true }), /exact id or name/);
  assert.throws(() => resolveAgent(roster, "Writ", { strict: true }), /exact id or name/);
  assert.throws(() => resolveMany(roster, [A1, "1111"], { strict: true }), /exact id or name/);
});

test("agents delete refuses an id prefix and deletes nothing", async () => {
  const gw = mockGateway({ roster });
  await assert.rejects(runCli(gw, "agents", "delete", "1111", "--yes"), /exact id or name/);
  assert.ok(!gw.calls.some((c) => c[0] === "deleteAgents"));
});

test("agents delete --ids-file refuses prefixes too", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = join(mkdtempSync(join(tmpdir(), "grokbot-")), "ids.txt");
  writeFileSync(f, `${A1}\n3333\n`);
  const gw = mockGateway({ roster });
  await assert.rejects(runCli(gw, "agents", "delete", "--ids-file", f, "--yes", "--confirm-count", "2"), /exact id or name/);
  assert.ok(!gw.calls.some((c) => c[0] === "deleteAgents"));
});

test("agents delete accepts full id and exact name", async () => {
  const gw = mockGateway({ roster });
  await runCli(gw, "agents", "delete", A1, "Writer", "--yes", "--confirm-count", "2");
  assert.deepEqual(gw.calls.find((c) => c[0] === "deleteAgents")[1], [A1, A2]);
});

// ---------------------------------------------------------------- fix 3: refetch sections before cleanup write
test("agents delete refetches sections right before the cleanup write", async () => {
  let n = 0;
  const stale = [{ id: "s1", name: "S", agentIds: [A1] }];
  const fresh = [{ id: "s1", name: "S", agentIds: [A1] }, { id: "s2", name: "Added meanwhile", agentIds: [A3] }];
  const gw = mockGateway({ roster, sections: () => (++n === 1 ? stale : fresh) });
  await runCli(gw, "agents", "delete", A1, "--yes", "--section", "S");
  const write = gw.calls.find((c) => c[0] === "setSections");
  assert.ok(write, "cleanup write happened");
  const idx = (name) => gw.calls.findIndex((c) => c[0] === name);
  assert.ok(gw.calls.findLastIndex((c) => c[0] === "getSections") > idx("deleteAgents"), "getSections called after deleteAgents");
  assert.deepEqual(write[1].map((s) => s.id), ["s1", "s2"], "concurrently-added section survives the write");
  assert.deepEqual(write[1].find((s) => s.id === "s1").agentIds, []);
  assert.deepEqual(write[1].find((s) => s.id === "s2").agentIds, [A3]);
});

// ---------------------------------------------------------------- fix 4: nudgeRenderer policy gate
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
}

test("nudgeRenderer is skipped under agent policy, runs under operator policy", async () => {
  const orig = { ...nudgeDeps };
  let probes = 0;
  nudgeDeps.appState = async () => (probes++, { cdpReachable: false });
  try {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const audit = join(mkdtempSync(join(tmpdir(), "grokbot-")), "audit.jsonl");
    const sections = () => [{ id: "s1", name: "S", agentIds: [] }];
    await withEnv({ GROKBOT_POLICY: "agent", GROKBOT_AUDIT_LOG: audit }, () => runCli(mockGateway({ sections }), "sections", "rename", "S", "T"));
    assert.equal(probes, 0, "no CDP probe under agent policy");
    await withEnv({ GROKBOT_POLICY: "operator" }, () => runCli(mockGateway({ sections }), "sections", "rename", "S", "T"));
    assert.equal(probes, 1, "operator policy still nudges");
  } finally {
    Object.assign(nudgeDeps, orig);
  }
});

// ---------------------------------------------------------------- fix 5: timeouts
test("gateway.health times out instead of hanging", async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const gw = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, timeoutMs: 20 });
  await assert.rejects(gw.health(), (e) => e.name === "GatewayError" && /health: timed out after 20ms/.test(e.message));
});

test("gateway.health still returns the parsed body and still surfaces HTTP errors", async () => {
  const ok = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }) });
  assert.deepEqual(await ok.health(), { ok: true });
  const bad = new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl: async () => ({ ok: false, status: 503, text: async () => "down" }) });
  await assert.rejects(bad.health(), (e) => e.status === 503 && /health failed: 503/.test(e.message));
});

function fakeWs() {
  return { sent: [], send(d) { this.sent.push(JSON.parse(d)); }, close() { this.onclose?.(); } };
}

test("Cdp.send times out", async () => {
  const cdp = new Cdp(fakeWs(), { timeoutMs: 20 });
  await assert.rejects(cdp.send("Runtime.evaluate"), (e) => e instanceof CdpError && /timed out after 20ms/.test(e.message));
  assert.equal(cdp.pending.size, 0);
});

test("Cdp.send rejects pending calls when the socket closes or errors, and refuses new ones", async () => {
  const ws = fakeWs();
  const cdp = new Cdp(ws, { timeoutMs: 5000 });
  const p1 = cdp.send("A");
  const p2 = cdp.send("B");
  ws.onclose();
  await assert.rejects(p1, /websocket closed/);
  await assert.rejects(p2, /websocket closed/);
  await assert.rejects(cdp.send("C"), /closed/);

  const ws2 = fakeWs();
  const cdp2 = new Cdp(ws2, { timeoutMs: 5000 });
  const p3 = cdp2.send("D");
  ws2.onerror({ message: "boom" });
  await assert.rejects(p3, /websocket error: boom/);
});

test("Cdp.send still resolves normal replies and CDP error replies", async () => {
  const ws = fakeWs();
  const cdp = new Cdp(ws);
  const ok = cdp.send("A");
  ws.onmessage({ data: JSON.stringify({ id: 1, result: { v: 1 } }) });
  assert.deepEqual(await ok, { v: 1 });
  const bad = cdp.send("B");
  ws.onmessage({ data: JSON.stringify({ id: 2, error: { message: "nope" } }) });
  await assert.rejects(bad, /B: nope/);
});

test("send --wait rejects a non-positive or non-numeric --timeout before sending", async () => {
  for (const bad of ["0", "-5", "abc", ""]) {
    const gw = mockGateway({ roster });
    await assert.rejects(runCli(gw, "agents", "send", A1, "hi", "--wait", "--timeout", bad), /--timeout must be a positive number/, `timeout=${JSON.stringify(bad)}`);
    assert.ok(!gw.calls.some((c) => c[0] === "sendPrompt"), "must not send when --timeout is invalid");
  }
});

test("send --wait fetches a wide transcript window and keeps entries since the sent message", async () => {
  const now = Date.now();
  const transcript = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `old${i}`, role: "assistant", text: `old ${i}`, createdAt: now - 3_600_000 })),
    { id: "u", role: "user", text: "hi", createdAt: now },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `tool${i}`, role: "tool", text: `tool ${i}`, createdAt: now + i })),
    { id: "reply", role: "assistant", text: "the reply", createdAt: now + 100 },
  ];
  const gw = mockGateway({ roster, transcript });
  // Agent never starts running -> send --wait gives up after 20s unless sentAt is old; use a stubbed sentAt far in the past.
  gw.sendPrompt = async (id, prompt) => ({ accepted: true, clientNonce: "n", sentAt: now - 1000 - 25_000 });
  const output = JSON.parse(await runCli(gw, "agents", "send", A1, "hi", "--wait", "--timeout", "5"));
  const req = gw.calls.find((c) => c[0] === "transcriptTail");
  assert.equal(req[2], WAIT_TRANSCRIPT_WINDOW);
  assert.ok(WAIT_TRANSCRIPT_WINDOW > 6);
  assert.ok(output.tail.some((e) => e.id === "reply"), "reply found even though 12 tool entries sit between");
  assert.ok(!output.tail.some((e) => e.id === "old0"), "pre-send history excluded");
});

test("entriesSince: timestamp filter, fallback without timestamps", () => {
  const e = [{ id: 1, createdAt: 100 }, { id: 2, createdAt: 10_000 }, { id: 3, createdAt: 10_001 }];
  assert.deepEqual(entriesSince(e, 10_000).map((x) => x.id), [2, 3]);
  const noTs = Array.from({ length: 30 }, (_, i) => ({ id: i }));
  assert.equal(entriesSince(noTs, 10_000).length, 20);
  assert.deepEqual(entriesSince([{ id: 1, createdAt: 100 }], 10_000).map((x) => x.id), [1], "nothing newer: fall back rather than return empty");
});
