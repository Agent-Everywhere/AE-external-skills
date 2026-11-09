import "./_isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorClient } from "../src/cursor.js";
import { exportAgents, exportTranscripts, fetchTranscript, formatUsage, parseSince, scrubKeys, summarizeUsage } from "../src/backup.js";
import { UsageError } from "../src/output.js";
import { resolveRoutine, toggleRoutine } from "../src/routines.js";
import { isDenied } from "../src/policy.js";
import { buildProgram } from "../src/cli.js";

const AM = "9781022e-e90a-4635-bbc8-34a9abfd77dd";
const OTHER = "24fea2e8-d157-49b5-821b-e91543d51f9a";

function mockClient(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const [service, method] = url.split("/").slice(-2);
    const body = JSON.parse(init.body);
    calls.push({ service, method, body });
    const h = handlers[method];
    if (!h) return { ok: false, status: 404, statusText: "nf", text: async () => JSON.stringify({ code: "not_found", message: "no " + method }) };
    const r = h(body);
    if (r instanceof Error) return { ok: false, status: 400, statusText: "bad", text: async () => JSON.stringify({ code: "failed_precondition", message: r.message }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  return { client: new CursorClient({ accessToken: "t" }, { fetchImpl, baseUrl: "https://x.test" }), calls };
}
const agentsReply = { agents: [{ id: "1", agentId: AM, name: "Acme AM", description: "Be helpful", apiKeyHint: "zzz" }, { id: "2", agentId: OTHER, name: "Client AM" }] };

test("scrubKeys redacts credential-looking keys, env and headers but keeps strings verbatim", () => {
  const out = scrubKeys({ name: "x", apiKey: "k", nested: { accessToken: "t", env: { A: "b" }, headers: { a: 1 }, list: [{ clientSecret: "s", ok: "Bearer text stays" }] }, body: "token: in prose" });
  assert.equal(out.apiKey, "<redacted>");
  assert.equal(out.nested.accessToken, "<redacted>");
  assert.equal(out.nested.env, "<redacted>");
  assert.equal(out.nested.headers, "<redacted>");
  assert.equal(out.nested.list[0].clientSecret, "<redacted>");
  assert.equal(out.nested.list[0].ok, "Bearer text stays");
  assert.equal(out.body, "token: in prose");
});

const usageReply = {
  GetSandUsageStatus: () => ({ usagePercent: 100, hasAvailableUsage: true, nextResetTimestampUtc: "2026-10-30T08:03:18.463Z", currentPeriodStart: "2026-10-23T08:03:18.463Z", cursorPlanName: "Ultra", grokPlanLabel: "Grok Bot Plan", onDemandSettings: { enabled: true } }),
  GetCurrentPeriodUsage: () => ({ planUsage: { totalSpend: 3574, limit: 40000, remaining: 36426 }, spendLimitUsage: { individualUsed: 425, individualLimit: 500, individualRemaining: 75, limitType: "user" }, displayMessage: "You've used 10% of your included usage" }),
  GetSandAccessStatus: () => ({ state: "SAND_ACCESS_STATE_GRANTED" }),
  GetMonthlyBillingCycle: () => ({ startDateEpochMillis: "1791705792000", endDateEpochMillis: "1794384192000" }),
};

test("usage calls the four Dashboard reads and formats percent, PT reset, dollars", async () => {
  const { client, calls } = mockClient(usageReply);
  const u = summarizeUsage(await client.usage(), Date.parse("2026-10-29T21:00:00Z"));
  assert.ok(calls.every((c) => c.service === "aiserver.v1.DashboardService" && /^Get/.test(c.method)));
  assert.equal(calls.length, 4);
  assert.equal(u.window.percentUsed, 100);
  assert.equal(u.window.resetsAtPT, "Oct 30, 1:03 AM PDT");
  assert.equal(u.window.resetsIn, "11h 3m");
  assert.deepEqual([u.included.spentCents, u.included.percentOfLimit, u.personalLimit.remainingCents], [3574, 8.9, 75]);
  const text = formatUsage(u);
  assert.match(text, /100% used/);
  assert.match(text, /\$35\.74 of \$400\.00 \(8\.9%\), \$364\.26 left/);
  assert.match(text, /\$4\.25 of \$5\.00 used, \$0\.75 left/);
  assert.match(text, /Oct 30, 1:03 AM PDT/);
});

test("agents export: profile/skills/access per agent, failures skipped and aggregated, no custom MCP, scrubbed", async () => {
  const { client, calls } = mockClient({
    ListGrokBotAgents: () => agentsReply,
    ListGrokBotAgentSkills: () => ({ skills: [{ id: "s", name: "s", body: "b" }] }),
    GetGrokBotAgentPlugins: (b) => (b.agentId === OTHER ? new Error("Share the bot with your team") : { serviceAccountsEnabled: false, mcpToken: "SHHH" }),
    GetGrokBotAgentAccess: () => ({ state: { expectedStateToken: "SHHH2", teamRowOn: true } }),
  });
  const gwCalls = [];
  const gateway = {
    call: async (cmd, body) => {
      gwCalls.push([cmd, body]);
      return cmd === "getAgentWorkflows" ? [{ id: "mine", name: "mine", source: "workflow", body: "do it\n```x```", helperScripts: [], secretKey: "SHHH3" }, { id: "built", name: "Built", source: "managed", body: "vendor" }, { id: "p", name: "P", source: "plugin", pluginId: "1" }] : [];
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "grokbot-agents-"));
  const warnings = [];
  const r = await exportAgents(dir, { cursor: client, gateway, warn: (m) => warnings.push(m), now: () => "T" });
  assert.equal(r.files.length, 2);
  assert.deepEqual(readdirSync(dir).sort(), ["acme-am-9781022e.json", "client-am-24fea2e8.json", "workflows"]);
  const am = JSON.parse(readFileSync(join(dir, "acme-am-9781022e.json"), "utf8"));
  assert.equal(am.profile.description, "Be helpful");
  assert.equal(am.profile.apiKeyHint, "<redacted>");
  assert.equal(am.skills[0].body, "b");
  assert.equal(am.plugins.mcpToken, "<redacted>");
  assert.equal(am.access.state.expectedStateToken, "<redacted>");
  assert.equal(am.skipped, undefined);
  const other = JSON.parse(readFileSync(join(dir, "client-am-24fea2e8.json"), "utf8"));
  assert.deepEqual(Object.keys(other.skipped), ["plugins"]);
  assert.equal(warnings.length, 1, "one note per distinct failure, not per agent");
  assert.ok(warnings.some((w) => /plugins.*Share the bot/.test(w)));
  assert.equal(gwCalls.filter(([c]) => c === "getAgentMemories").length, 0, "the host dropped getAgentMemories (404 on 00b0aa1); it is no longer requested");
  assert.ok(calls.every((c) => c.method !== "GetGrokBotAgentCustomMcp"));
  assert.ok(calls.filter((c) => c.method === "GetGrokBotAgentPlugins").every((c) => c.body.includeMcpConfig === false));
  assert.deepEqual(readdirSync(join(dir, "workflows")).sort(), ["INDEX.json", "mine.md"]);
  const wf = readFileSync(join(dir, "workflows", "mine.md"), "utf8");
  assert.ok(wf.endsWith("---\ndo it\n```x```\n"));
  assert.ok(!wf.includes("SHHH3"));
  assert.equal(JSON.parse(readFileSync(join(dir, "workflows", "INDEX.json"), "utf8")).length, 3);
  assert.deepEqual(r.workflows, { written: 1, listed: 3 });
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) assert.ok(!readFileSync(join(dir, f), "utf8").includes("SHHH"));
});

test("agents export survives a missing gateway (workflows noted, profiles still written)", async () => {
  const { client } = mockClient({ ListGrokBotAgents: () => agentsReply, ListGrokBotAgentSkills: () => ({}), GetGrokBotAgentPlugins: () => ({}), GetGrokBotAgentAccess: () => ({}) });
  const dir = mkdtempSync(join(tmpdir(), "grokbot-agents-"));
  const warnings = [];
  const r = await exportAgents(dir, { cursor: client, gateway: null, warn: (m) => warnings.push(m) });
  assert.equal(r.files.length, 2);
  assert.equal(r.workflows.skipped, "no gateway session");
  assert.ok(!existsSync(join(dir, "workflows")));
});

function transcriptHandler(total, gaps = new Set()) {
  const seqs = Array.from({ length: total }, (_, i) => i + 1).filter((s) => !gaps.has(s));
  return (b) => {
    const before = b.beforeSeq === undefined ? Infinity : Number(b.beforeSeq);
    const page = seqs.filter((s) => s < before).slice(-Math.min(b.limit, 200)).reverse();
    return { entries: page.map((s) => ({ seq: String(s), entryKind: "send-message", body: Buffer.from(JSON.stringify({ n: s })).toString("base64") })) };
  };
}

test("fetchTranscript pages backwards via beforeSeq, dedupes, handles gaps, and honours --since", async () => {
  const { client, calls } = mockClient({ ListGrokBotTranscriptEntries: transcriptHandler(450, new Set([7, 8, 300])) });
  const all = await fetchTranscript(client, AM, { limit: 200 });
  assert.equal(all.length, 447);
  assert.deepEqual([all[0].seq, all.at(-1).seq], ["1", "450"]);
  assert.deepEqual(all.map((e) => Number(e.seq)), [...all.map((e) => Number(e.seq))].sort((a, b) => a - b));
  const beforeSeqs = calls.map((c) => c.body.beforeSeq);
  assert.deepEqual(beforeSeqs.slice(0, 3), [undefined, "250", "50"]);
  const since = await fetchTranscript(client, AM, { since: 400 });
  assert.deepEqual([since.length, since[0].seq], [50, "401"]);
});

test("transcripts export: one jsonl per agent with raw and decoded body; a failing agent is skipped", async () => {
  const { client } = mockClient({
    ListGrokBotAgents: () => agentsReply,
    ListGrokBotTranscriptEntries: (b) => (b.agentId === OTHER ? new Error("nope") : transcriptHandler(3)(b)),
  });
  const dir = mkdtempSync(join(tmpdir(), "grokbot-tx-"));
  const warnings = [];
  const files = await exportTranscripts(dir, { cursor: client, warn: (m) => warnings.push(m) });
  assert.equal(files.length, 1);
  assert.match(warnings[0], /Client AM: transcript skipped \(.*nope/);
  const lines = readFileSync(files[0].file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.seq), ["1", "2", "3"]);
  assert.deepEqual(lines[1].bodyJson, { n: 2 });
  assert.equal(typeof lines[1].body, "string");
  const one = await exportTranscripts(mkdtempSync(join(tmpdir(), "grokbot-tx-")), { cursor: client, agent: "9781", since: 1 });
  assert.equal(one[0].entries, 2);
});

test("resolveRoutine picks exactly one routine by id or name; toggle sends only SetGrokBotAgentAutomationEnabled", async () => {
  const row = (id, name, on = true) => ({ automationId: id, recordJson: JSON.stringify({ id: name, name, isEnabled: on, prompt: "p", trigger: { type: "cron", schedule: "0 1 * * *" } }) });
  const { client, calls } = mockClient({
    ListGrokBotAgents: () => agentsReply,
    ListGrokBotAccountAutomations: () => ({ agents: [{ agentId: AM, automations: [row("uuid-1", "morning"), row("uuid-2", "evening", false)] }, { agentId: OTHER, automations: [row("uuid-3", "morning")] }] }),
    SetGrokBotAgentAutomationEnabled: (b) => ({ automations: [row(b.automationId, "morning", b.isEnabled)] }),
  });
  assert.equal((await resolveRoutine(client, "9781", "morning")).automationId, "uuid-1");
  assert.equal((await resolveRoutine(client, "Acme AM", "uuid-2")).name, "evening");
  await assert.rejects(resolveRoutine(client, "am", "morning"), /matches 2 agents/);
  await assert.rejects(resolveRoutine(client, "9781", "nope"), /No routine/);
  assert.ok(calls.every((c) => c.method !== "SetGrokBotAgentAutomationEnabled"), "resolving never writes");
  const rows = await client.setAutomationEnabled(AM, "uuid-1", false);
  assert.deepEqual(calls.at(-1).body, { agentId: AM, automationId: "uuid-1", isEnabled: false });
  assert.equal(rows.length, 1);
});

function toggleFixture({ applyWrite = true } = {}) {
  let on = true;
  const row = () => ({ automationId: "uuid-1", recordJson: JSON.stringify({ id: "morning", name: "morning", isEnabled: on, prompt: "p", trigger: { type: "cron", schedule: "0 1 * * *" } }) });
  return mockClient({
    ListGrokBotAgents: () => agentsReply,
    ListGrokBotAccountAutomations: () => ({ agents: [{ agentId: AM, automations: [row()] }, { agentId: OTHER, automations: [] }] }),
    SetGrokBotAgentAutomationEnabled: (b) => {
      if (applyWrite) on = b.isEnabled;
      return { automations: [row()] };
    },
  });
}
const writesOf = (calls) => calls.filter((c) => c.method === "SetGrokBotAgentAutomationEnabled");

test("toggleRoutine without --yes names the target and sends nothing; with --yes it writes once and confirms by re-read", async () => {
  const { client, calls } = toggleFixture();
  await assert.rejects(toggleRoutine(client, "9781", "morning", false), /Acme AM \/ morning \(uuid-1\): enabled -> disabled\nRe-run with --yes/);
  assert.equal(writesOf(calls).length, 0);
  const r = await toggleRoutine(client, "9781", "morning", false, { yes: true });
  assert.deepEqual([r.enabled, r.confirmed, r.changed], [false, true, true]);
  assert.deepEqual(writesOf(calls).map((c) => c.body), [{ agentId: AM, automationId: "uuid-1", isEnabled: false }]);
  assert.ok(calls.findLastIndex((c) => c.method === "ListGrokBotAccountAutomations") > calls.findIndex((c) => c.method === "SetGrokBotAgentAutomationEnabled"), "re-read after the write");
  const again = await toggleRoutine(client, "9781", "morning", false, { yes: true });
  assert.equal(again.changed, false, "already in the requested state");
  assert.equal(writesOf(calls).length, 1, "no second write");
  const autos = buildProgram().commands.find((c) => c.name() === "automations");
  for (const verb of ["enable", "disable"]) assert.ok(autos.commands.find((c) => c.name() === verb)?.options.some((o) => o.long === "--yes"));
});

test("toggleRoutine fails (exitCode 1) when the write is accepted but the state did not change", async () => {
  const { client } = toggleFixture({ applyWrite: false });
  await assert.rejects(toggleRoutine(client, "9781", "morning", false, { yes: true }), (e) => e.exitCode === 1 && /still enabled/.test(e.message));
});

test("usage: one failing read still prints the rest; all failing throws; zero/string limits never give Infinity/NaN", async () => {
  const { client } = mockClient({ ...usageReply, GetCurrentPeriodUsage: () => new Error("boom") });
  const raw = await client.usage();
  assert.deepEqual(Object.keys(raw.errors), ["GetCurrentPeriodUsage"]);
  const u = summarizeUsage(raw, Date.parse("2026-10-29T21:00:00Z"));
  const text = formatUsage(u);
  assert.match(text, /100% used/);
  assert.match(text, /Unavailable:\s+GetCurrentPeriodUsage \(.*boom/);
  assert.equal(u.included.percentOfLimit, null);
  assert.ok(!/NaN|Infinity/.test(text), text);
  await assert.rejects(mockClient({}).client.usage(), /usage unavailable/);
  const odd = summarizeUsage({ period: { planUsage: { totalSpend: "3574", limit: "0", remaining: "x" }, spendLimitUsage: { individualUsed: "425", individualLimit: "500", individualRemaining: "75" } }, status: { usagePercent: "100" } });
  assert.equal(odd.included.percentOfLimit, null);
  assert.equal(odd.included.remainingCents, null);
  assert.equal(odd.window.percentUsed, 100);
  assert.equal(odd.personalLimit.remainingCents, 75);
  assert.ok(!/NaN|Infinity/.test(formatUsage(odd)));
  assert.equal(summarizeUsage({ period: { planUsage: { totalSpend: "3574", limit: "40000" } } }).included.percentOfLimit, 8.9);
});

test("parseSince accepts non-negative integers and rejects the rest", () => {
  assert.equal(parseSince(undefined), 0);
  assert.equal(parseSince("200"), 200);
  for (const bad of ["abc", "-1", "1.5", "NaN", "Infinity"]) assert.throws(() => parseSince(bad), UsageError, bad);
});

test("fetchTranscript stops on pages without a usable seq and refuses to loop forever", async () => {
  const noSeq = mockClient({ ListGrokBotTranscriptEntries: () => ({ entries: [{ entryKind: "x" }, { seq: "abc" }] }) });
  assert.deepEqual(await fetchTranscript(noSeq.client, AM), []);
  assert.equal(noSeq.calls.length, 1);
  const endless = mockClient({ ListGrokBotTranscriptEntries: (b) => ({ entries: [{ seq: String((b.beforeSeq ?? 1e9) - 1) }] }) });
  await assert.rejects(fetchTranscript(endless.client, AM, { maxPages: 5 }), /exceeded 5 pages/);
  assert.equal(endless.calls.length, 5);
});

test("transcripts export: --since appends, a full export replaces atomically, zero entries never touch the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-tx-"));
  const file = join(dir, `acme-am-${AM.slice(0, 8)}.jsonl`);
  const handlers = (total) => ({ ListGrokBotAgents: () => agentsReply, ListGrokBotTranscriptEntries: (b) => (b.agentId === OTHER ? { entries: [] } : transcriptHandler(total)(b)) });
  const seqsIn = () => readFileSync(file, "utf8").trim().split("\n").map((l) => Number(JSON.parse(l).seq));
  await exportTranscripts(dir, { cursor: mockClient(handlers(3)).client, agent: "9781" });
  assert.deepEqual(seqsIn(), [1, 2, 3]);
  const inc = await exportTranscripts(dir, { cursor: mockClient(handlers(5)).client, agent: "9781", since: 3 });
  assert.deepEqual(seqsIn(), [1, 2, 3, 4, 5], "appended, not replaced");
  assert.equal(inc[0].entries, 2);
  const none = await exportTranscripts(dir, { cursor: mockClient(handlers(5)).client, agent: "9781", since: 5 });
  assert.deepEqual([none[0].entries, none[0].file], [0, null]);
  assert.deepEqual(seqsIn(), [1, 2, 3, 4, 5], "nothing new: file untouched");
  const empty = await exportTranscripts(dir, { cursor: mockClient(handlers(0)).client, agent: "9781" });
  assert.equal(empty[0].entries, 0);
  assert.deepEqual(seqsIn(), [1, 2, 3, 4, 5], "an empty full export never clobbers a good file");
  await exportTranscripts(dir, { cursor: mockClient(handlers(2)).client, agent: "9781" });
  assert.deepEqual(seqsIn(), [1, 2], "a non-empty full export replaces it");
  assert.ok(readdirSync(dir).every((f) => !f.includes(".tmp-")), "no temp file left behind");
  await assert.rejects(exportTranscripts(dir, { cursor: mockClient(handlers(1)).client, since: "-3" }), UsageError);
  await assert.rejects(exportTranscripts(dir, { cursor: mockClient(handlers(1)).client, since: "abc" }), /--since/);
});

test("policy: usage is allowed for agents; enable/disable, agents export and transcripts are operator-only", () => {
  assert.equal(isDenied("usage", "agent"), false);
  for (const p of ["automations enable", "automations disable", "agents export", "transcripts export"]) assert.equal(isDenied(p, "agent"), true, p);
  assert.equal(isDenied("agents list", "agent"), false);
  assert.equal(isDenied("agents export", "operator"), false);
});
