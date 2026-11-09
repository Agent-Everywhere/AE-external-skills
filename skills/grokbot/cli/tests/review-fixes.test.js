import "./_isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorClient } from "../src/cursor.js";
import { exportAgents, exportTranscripts } from "../src/backup.js";
import { deleteRoutine, exportRoutines, setRoutineSlackWorkspace, toggleRoutine } from "../src/routines.js";
import { DENIED_FOR_AGENTS, enforce } from "../src/policy.js";
import { buildProgram } from "../src/cli.js";

const A1 = "11111111-1111-1111-1111-111111111111";
const A2 = "22222222-2222-2222-2222-222222222222";
const mode = (p) => statSync(p).mode & 0o777;

function plane({ workspaces = [], setHandler } = {}) {
  const calls = [];
  let ws = structuredClone(workspaces);
  const rec = (name, on = true) => JSON.stringify({ id: name, name, isEnabled: on, prompt: "p", trigger: { type: "cron", schedule: "0 1 * * *" } });
  const handlers = {
    ListGrokBotAgents: () => ({ agents: [{ id: "1", agentId: A1, name: "Alpha" }, { id: "2", agentId: A2, name: "Beta" }] }),
    ListGrokBotAccountAutomations: (b) => ({ agents: b.agentIds.map((agentId) => ({ agentId, automations: agentId === A1 ? [{ automationId: "abcd-1234", recordJson: rec("nightly report") }] : [] })) }),
    SetGrokBotAgentAutomationEnabled: () => ({ automations: [] }),
    DeleteGrokBotAgentAutomation: () => ({ automations: [] }),
    ListSlackLinkedWorkspaces: () => ({ workspaces: ws }),
    SetSandAutomationSlackWorkspace: (b) => (setHandler ? setHandler(b, (n) => (ws = n), ws) : { workspaces: ws }),
  };
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    calls.push({ method, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify(handlers[method](JSON.parse(init.body))) };
  };
  return { client: new CursorClient({ accessToken: "t" }, { fetchImpl, baseUrl: "https://x.test" }), writes: () => calls.filter((c) => !/^(List|Get)/.test(c.method)) };
}

test("toggle/delete match agent and routine exactly: no prefix or substring fallback, nothing is written", async () => {
  const p = plane();
  const bad = [
    ["1111", "abcd-1234"], // agent id prefix
    ["alph", "abcd-1234"], // agent name substring
    ["Alpha", "abcd"], // automation id prefix
    ["Alpha", "nightly"], // routine name substring
  ];
  for (const [agent, ref] of bad) {
    await assert.rejects(toggleRoutine(p.client, agent, ref, false, { yes: true }), /No routine/, `toggle ${agent} ${ref}`);
    await assert.rejects(deleteRoutine(p.client, agent, ref, { yes: true }), /No routine/, `delete ${agent} ${ref}`);
  }
  assert.deepEqual(p.writes(), []);
  // exact id or exact name (case-insensitive) still resolves
  await toggleRoutine(p.client, A1, "abcd-1234", false).catch((e) => assert.match(e.message, /Re-run with --yes/));
  await assert.rejects(deleteRoutine(p.client, "ALPHA", "Nightly Report"), /DELETE Alpha \/ nightly report \(abcd-1234\)/);
});

test("slack-workspace: confirmed only when the workspace's routine count rose from the pre-write state", async () => {
  const ws = [{ slackTeamId: "T1", displayName: "Acme", sandAutomationCount: 2 }];
  const up = plane({ workspaces: ws, setHandler: (b, set, cur) => (set(cur.map((w) => ({ ...w, sandAutomationCount: Number(w.sandAutomationCount) + 1 }))), { workspaces: [{ slackTeamId: "T1" }] }) });
  const r1 = await setRoutineSlackWorkspace(up.client, "Alpha", "abcd-1234", "T1", { yes: true });
  assert.equal(r1.confirmed, true);

  // the server says OK but the count did not move (e.g. the routine was already on T1, or the write was dropped)
  const same = plane({ workspaces: ws, setHandler: () => ({ workspaces: [{ slackTeamId: "T1" }] }) });
  const r2 = await setRoutineSlackWorkspace(same.client, "Alpha", "abcd-1234", "T1", { yes: true });
  assert.equal(r2.confirmed, false);
  assert.match(r2.target, /NOT confirmed/);
  assert.doesNotMatch(r2.target, /confirmed by re-read/);

  // an unavailable count cannot prove anything either
  const noCount = plane({ workspaces: [{ slackTeamId: "T1", displayName: "Acme" }], setHandler: () => ({ workspaces: [{ slackTeamId: "T1" }] }) });
  assert.equal((await setRoutineSlackWorkspace(noCount.client, "Alpha", "abcd-1234", "T1", { yes: true })).confirmed, false);
});

test("backups: files are 0600, directories 0700, and workflow filenames include a hash so ids can't collide", async () => {
  const root = mkdtempSync(join(tmpdir(), "grokbot-perm-"));
  const dir = join(root, "agents");
  const cursor = {
    listAgents: async () => ({ agents: [{ agentId: A1, name: "Alpha" }] }),
    listAgentSkills: async () => [],
    getAgentPlugins: async () => [],
    getAgentAccess: async () => ({}),
    listTranscriptEntries: async (id, { beforeSeq }) => (beforeSeq ? [] : [{ seq: "1", body: "" }]),
  };
  const gateway = { call: async () => [{ id: "a/b", name: "x", source: "workflow", body: "1" }, { id: "a-b", name: "y", source: "workflow", body: "2" }, { id: "A B", name: "z", source: "workflow", body: "3" }] };
  const r = await exportAgents(dir, { cursor, gateway, warn: () => {} });
  assert.equal(r.workflows.written, 3);
  const wfiles = readdirSync(join(dir, "workflows")).filter((f) => f.endsWith(".md"));
  assert.equal(wfiles.length, 3, "ids that slug identically still get distinct files");
  assert.ok(wfiles.every((f) => /^[a-z0-9-]+-[0-9a-f]{8}\.md$/.test(f)), wfiles.join(","));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, "workflows")), 0o700);
  for (const f of r.files.map((x) => x.file)) assert.equal(mode(f), 0o600);
  for (const f of wfiles) assert.equal(mode(join(dir, "workflows", f)), 0o600);
  assert.equal(mode(join(dir, "workflows", "INDEX.json")), 0o600);

  const tdir = join(root, "tx");
  const t = await exportTranscripts(tdir, { cursor, agent: "Alpha" });
  assert.equal(mode(tdir), 0o700);
  assert.equal(mode(t[0].file), 0o600);
  // --since appends to a new file: created 0600 too
  const t3 = await exportTranscripts(join(root, "tx3"), { cursor: { ...cursor, listTranscriptEntries: async (id, { beforeSeq }) => (beforeSeq ? [] : [{ seq: "5", body: "" }]) }, agent: "Alpha", since: 1 });
  assert.equal(mode(t3[0].file), 0o600);
});

test("routine exports are written 0600 in a 0700 directory", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "grokbot-rx-")), "routines");
  const agent = { agentId: A1, name: "Alpha" };
  const written = exportRoutines(dir, { agents: [agent], routines: [{ agentId: A1, automationId: "x", name: "n", enabled: true, trigger: "cron", triggers: [], prompt: "p" }] });
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(written[0].file), 0o600);
});

test("agent policy text no longer claims agents may delete agents", () => {
  const src = readFileSync(new URL("../src/policy.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /hide\/delete agents|organize and delete agents/, "header/denial text must not advertise agent deletion");
  const gw = buildProgram().commands.find((c) => c.name() === "gw");
  let msg;
  try {
    enforce(gw, ["gw"], { GROKBOT_POLICY: "agent", GROKBOT_AUDIT_LOG: join(mkdtempSync(join(tmpdir(), "grokbot-pol-")), "a.jsonl") });
  } catch (e) {
    msg = e.message;
  }
  assert.match(msg, /not available under the agent policy/);
  assert.doesNotMatch(msg, /organize and delete agents/);
  assert.match(msg, /agents cannot delete agents/);
  assert.ok(Array.isArray(DENIED_FOR_AGENTS));
});
