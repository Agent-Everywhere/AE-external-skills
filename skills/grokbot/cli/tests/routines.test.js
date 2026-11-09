import "./_isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorClient } from "../src/cursor.js";
import { exportRoutines, flattenTrigger, listRoutines, matchAgents, normalizeRoutine, renderAgentMarkdown } from "../src/routines.js";
import { isDenied } from "../src/policy.js";

const AM = "9781022e-e90a-4635-bbc8-34a9abfd77dd";
const OTHER = "24fea2e8-d157-49b5-821b-e91543d51f9a";
const rec = (o) => JSON.stringify({ id: o.name, isEnabled: true, runs: [], ...o });
const cron = (schedule) => ({ type: "cron", schedule, firesAt: schedule + "!", timing: "flexible", window: { earlyMinutes: 15, lateMinutes: 0 } });

function mockClient(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    calls.push({ method, body: JSON.parse(init.body) });
    const h = handlers[method];
    if (!h) return { ok: false, status: 404, statusText: "nf", text: async () => JSON.stringify({ code: "not_found", message: "no " + method }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(h(JSON.parse(init.body))) };
  };
  return { client: new CursorClient({ accessToken: "t" }, { fetchImpl, baseUrl: "https://x.test" }), calls };
}

const agentsReply = { agents: [{ id: "1", agentId: AM, name: "Acme AM" }, { id: "2", agentId: OTHER, name: "Client AM" }, { id: "3", name: "no box id" }] };
const amRows = [
  { automationId: "a1", recordJson: rec({ name: "morning", prompt: "Do ```fenced``` thing\nline2", trigger: cron("CRON_TZ=UTC 0 7 * * *"), schedule: "CRON_TZ=UTC 0 7 * * *", createdAt: 1793057785000, runs: [{ status: "ok" }] }) },
  { automationId: "a2", recordJson: rec({ name: "recap", isEnabled: false, prompt: "p2", trigger: { type: "group", listeners: [cron("0 8 * * *"), { type: "webhook", secretToken: "SHHH" }] } }) },
];

test("flattenTrigger flattens groups and keeps only allowlisted leaf fields", () => {
  const t = flattenTrigger({ type: "group", listeners: [cron("0 8 * * *"), { type: "webhook", secretToken: "SHHH", url: "https://h/x", window: { earlyMinutes: 1, evil: "x" }, nested: { a: 1 } }] });
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { type: "cron", schedule: "0 8 * * *", timing: "flexible", window: { earlyMinutes: 15, lateMinutes: 0 } });
  assert.deepEqual(t[1], { type: "webhook", window: { earlyMinutes: 1 } });
  assert.ok(!JSON.stringify(t).includes("SHHH"));
});

test("prompts are verbatim: nothing in the prompt is redacted", () => {
  const prompt = 'Use {"api_key":"abc"} and Bearer abcdefghijkl1234 as shown';
  const r = normalizeRoutine({ agentId: AM }, { automationId: "x", recordJson: rec({ name: "n", prompt, trigger: cron("0 1 * * *") }) });
  assert.equal(r.prompt, prompt);
});

test("normalizeRoutine keeps the prompt verbatim and maps fields", () => {
  const r = normalizeRoutine({ agentId: AM, name: "Acme AM" }, amRows[0]);
  assert.equal(r.prompt, "Do ```fenced``` thing\nline2");
  assert.deepEqual([r.agentId, r.agentName, r.automationId, r.name, r.enabled, r.trigger, r.lastRunStatus], [AM, "Acme AM", "a1", "morning", true, "cron", "ok"]);
  assert.equal(r.createdAt, "2026-10-26T23:36:25.000Z");
  assert.equal(normalizeRoutine({ agentId: AM }, amRows[1]).enabled, false);
});

test("matchAgents: uuid prefix, name substring, none", () => {
  const a = agentsReply.agents.filter((x) => x.agentId);
  assert.equal(matchAgents(a, "9781").length, 1);
  assert.equal(matchAgents(a, "am").length, 2);
  assert.equal(matchAgents(a, "Acme AM").length, 1);
  assert.throws(() => matchAgents(a, "zzz"), /No agent matches/);
});

test("listRoutines uses read-only RPCs, skips agents without a box id, dedupes agents", async () => {
  const dup = { agents: [...agentsReply.agents, { id: "9", agentId: AM, name: "Acme AM dup" }] };
  const { client, calls } = mockClient({
    ListGrokBotAgents: () => dup,
    ListGrokBotAccountAutomations: () => ({ agents: [{ agentId: AM, automations: amRows }, { agentId: OTHER }] }),
  });
  const { routines, agents, errors } = await listRoutines(client);
  assert.deepEqual(agents.map((a) => a.count), [2, 0]);
  assert.equal(routines.length, 2);
  assert.equal(errors.length, 0);
  assert.deepEqual(calls.filter((c) => c.method === "ListGrokBotAccountAutomations").map((c) => c.body), [{ agentIds: [AM, OTHER] }]);
  assert.ok(calls.every((c) => /^List/.test(c.method)), "only read RPCs");
  const one = mockClient({ ListGrokBotAgents: () => agentsReply, ListGrokBotAccountAutomations: () => ({ agents: [{ agentId: AM, automations: amRows }] }) });
  assert.equal((await listRoutines(one.client, { agent: "9781" })).routines.length, 2);
});

test("per-agent fallback when the account group is missing, unavailable, or readIndividually", async () => {
  const third = "33333333-3333-4333-8333-333333333333";
  const { client, calls } = mockClient({
    ListGrokBotAgents: () => ({ agents: [...agentsReply.agents, { id: "4", agentId: third, name: "Third" }] }),
    ListGrokBotAccountAutomations: () => ({ agents: [{ agentId: OTHER, unavailable: true }, { agentId: third, readIndividually: true }] }), // AM group missing entirely
    ListGrokBotAgentAutomations: () => ({ automations: [amRows[0]] }),
  });
  const { routines } = await listRoutines(client);
  assert.deepEqual(calls.filter((c) => c.method === "ListGrokBotAgentAutomations").map((c) => c.body.agentId), [AM, OTHER, third]);
  assert.equal(routines.length, 3);
});

test("agent ids are chunked 50 per account RPC", async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: String(i), agentId: `id-${i}`, name: `a${i}` }));
  const { client, calls } = mockClient({
    ListGrokBotAgents: () => ({ agents: many }),
    ListGrokBotAccountAutomations: (b) => ({ agents: b.agentIds.map((agentId) => ({ agentId })) }),
  });
  await listRoutines(client);
  assert.deepEqual(calls.filter((c) => c.method === "ListGrokBotAccountAutomations").map((c) => c.body.agentIds.length), [50, 50, 20]);
});

test("a malformed recordJson becomes a stub, warns, reports an error, and the rest still lists/exports", async () => {
  const bad = { automationId: "bad1", recordJson: "{not json" };
  const { client } = mockClient({
    ListGrokBotAgents: () => agentsReply,
    ListGrokBotAccountAutomations: () => ({ agents: [{ agentId: AM, automations: [bad, amRows[0]] }, { agentId: OTHER }] }),
  });
  const warnings = [];
  const listing = await listRoutines(client, { warn: (m) => warnings.push(m) });
  assert.equal(listing.routines.length, 2);
  assert.equal(listing.errors.length, 1);
  assert.match(warnings[0], /malformed routine bad1/);
  assert.deepEqual([listing.routines[0].malformed, listing.routines[0].automationId, listing.routines[0].raw], [true, "bad1", bad]);
  const dir = mkdtempSync(join(tmpdir(), "grokbot-routines-"));
  const [f] = exportRoutines(dir, listing);
  const md = readFileSync(f.file, "utf8");
  assert.ok(md.includes("bad1 (UNPARSEABLE)") && md.includes("{not json") && md.includes("## morning"));
});

test("gateway rows (box-hosted agents) are merged and deduped; gateway failure is a note", async () => {
  const BOX = "bbbbbbbb-0000-4000-8000-000000000000";
  const gwRows = [
    { agentId: BOX, automation: { id: "boxjob", name: "Box job", prompt: "box prompt", isEnabled: true, trigger: cron("0 2 * * *") } },
    { agentId: AM, automation: { id: "a1", name: "morning", prompt: "dup" } },
  ];
  const mk = () => mockClient({
    ListGrokBotAgents: () => agentsReply,
    ListGrokBotAccountAutomations: () => ({ agents: [{ agentId: AM, automations: amRows }, { agentId: OTHER }] }),
  }).client;
  const gateway = { listAutomations: async () => gwRows, listAgents: async () => [{ id: BOX, name: "Boxy" }] };
  const { routines, agents } = await listRoutines(mk(), { gateway });
  assert.equal(routines.length, 3);
  assert.equal(routines.find((r) => r.automationId === "boxjob").agentName, "Boxy");
  assert.equal(routines.find((r) => r.automationId === "a1").prompt, "Do ```fenced``` thing\nline2", "control-plane row wins the duplicate");
  assert.equal(agents.find((a) => a.agentId === BOX).count, 1);
  const warnings = [];
  const failing = { listAutomations: async () => { throw new Error("boom"); } };
  const r2 = await listRoutines(mk(), { gateway: failing, warn: (m) => warnings.push(m) });
  assert.equal(r2.routines.length, 2);
  assert.match(warnings[0], /gateway automations unavailable.*boom/);
  assert.equal((await listRoutines(mk(), { gateway, agent: "Boxy" })).routines.length, 1);
});

test("exportRoutines writes one file per agent with verbatim prompt and a safe fence", async () => {
  const { client } = mockClient({
    ListGrokBotAgents: () => agentsReply,
    ListGrokBotAccountAutomations: () => ({ agents: [{ agentId: AM, automations: amRows }, { agentId: OTHER }] }),
  });
  const listing = await listRoutines(client);
  const dir = mkdtempSync(join(tmpdir(), "grokbot-routines-"));
  const files = exportRoutines(dir, listing);
  assert.equal(files.length, 1, "agent with no routines gets no file");
  assert.equal(files[0].count, 2);
  assert.deepEqual(readdirSync(dir), [`acme-am-${AM.slice(0, 8)}.md`]);
  const md = readFileSync(files[0].file, "utf8");
  assert.ok(md.includes("````text\nDo ```fenced``` thing\nline2\n````"), md);
  assert.ok(md.includes("- enabled: false"));
  assert.ok(md.includes("- schedule: CRON_TZ=UTC 0 7 * * *"));
  assert.ok(!md.includes("SHHH"));
  assert.ok(renderAgentMarkdown({ agentId: AM, name: "x" }, []).includes("routines: 0"));
});

test("automations stays operator-only (denied under the agent policy, including export)", () => {
  assert.equal(isDenied("automations", "agent"), true);
  assert.equal(isDenied("automations export", "agent"), true);
  assert.equal(isDenied("automations", "operator"), false);
});
