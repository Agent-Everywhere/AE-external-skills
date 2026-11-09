import "./_isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorClient } from "../src/cursor.js";
import { deleteRoutine, resumeGuard, setRoutineSlackWorkspace } from "../src/routines.js";
import { enumName, installBaseline, mapLimit, parseAllowlist, summarizeSlackOutcome, waitForSlackWorkspace } from "../src/slack.js";
import { DENIED_FOR_AGENTS, enforce, isDenied, commandPath } from "../src/policy.js";
import { buildProgram, setCursorForTests, setSlackPollMsForTests } from "../src/cli.js";
import { captureIo } from "./_io.js";

const A1 = "11111111-1111-1111-1111-111111111111";
const A2 = "22222222-2222-2222-2222-222222222222";
const rec = (o) => JSON.stringify({ id: o.name, isEnabled: true, runs: [], ...o });

/** Stateful mocked control plane: handlers see (body); every call is recorded. No network, no real account. */
function fakePlane({ routines, workspaces = [], slackConnections = [], overrides = {} } = {}) {
  const calls = [];
  const state = { routines: structuredClone(routines ?? []), workspaces: structuredClone(workspaces) };
  const rows = (agentId) => state.routines.filter((r) => r.agentId === agentId).map((r) => ({ automationId: r.automationId, recordJson: rec(r.rec) }));
  const handlers = {
    ListGrokBotAgents: () => ({ agents: [{ id: "1", agentId: A1, name: "Alpha" }, { id: "2", agentId: A2, name: "Beta" }], slackConnections }),
    ListGrokBotAccountAutomations: (b) => ({ agents: b.agentIds.map((agentId) => ({ agentId, automations: rows(agentId) })) }),
    SetGrokBotAgentAutomationEnabled: (b) => {
      const r = state.routines.find((x) => x.agentId === b.agentId && x.automationId === b.automationId);
      r.rec.isEnabled = b.isEnabled;
      return { automations: rows(b.agentId) };
    },
    DeleteGrokBotAgentAutomation: (b) => {
      state.routines = state.routines.filter((x) => !(x.agentId === b.agentId && x.automationId === b.automationId));
      return { automations: rows(b.agentId) };
    },
    ListSlackLinkedWorkspaces: () => ({ workspaces: state.workspaces, canLinkAnotherWorkspace: true }),
    SetSandAutomationSlackWorkspace: (b) => {
      state.workspaces = state.workspaces.map((w) => (w.slackTeamId === b.slackTeamId ? { ...w, sandAutomationCount: (w.sandAutomationCount ?? 0) + 1 } : w));
      return { workspaces: state.workspaces };
    },
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const service = url.split("/").at(-2);
    const body = JSON.parse(init.body);
    calls.push({ method, service, body });
    const h = handlers[method];
    if (!h) return { ok: false, status: 404, statusText: "nf", text: async () => JSON.stringify({ code: "not_found", message: "no " + method }) };
    const r = h(body);
    return r instanceof Error ? { ok: false, status: 500, statusText: "x", text: async () => JSON.stringify({ message: r.message }) } : { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  const client = new CursorClient({ accessToken: "t" }, { fetchImpl, baseUrl: "https://x.test" });
  const writes = () => calls.filter((c) => !/^(List|Get)/.test(c.method));
  return { client, calls, state, writes };
}
const R = (agentId, automationId, name, isEnabled = true) => ({ agentId, automationId, rec: { name, prompt: "p-" + name, isEnabled, trigger: { type: "cron", schedule: "0 1 * * *" } } });

test("enumName strips the proto prefix; a missing (default) value is UNSPECIFIED", () => {
  assert.equal(enumName("GROK_BOT_SLACK_INSTALL_OUTCOME_PENDING_ADMIN_APPROVAL"), "PENDING_ADMIN_APPROVAL");
  assert.equal(enumName("GROK_BOT_SLACK_INSTALL_STATUS_NOT_CONNECTED"), "NOT_CONNECTED");
  assert.equal(enumName("GROK_BOT_SLACK_CONNECT_CLAIM_OUTCOME_CLAIMED"), "CLAIMED");
  assert.equal(enumName(undefined), "UNSPECIFIED");
});

test("summarizeSlackOutcome: done=0, human step=4, refused/failed=1, each with its hint and details", () => {
  const P = "GROK_BOT_SLACK_INSTALL_OUTCOME_";
  const ok = summarizeSlackOutcome("install", { outcome: P + "INSTALLED", workspaceName: "Acme", slackTeamId: "T1" });
  assert.deepEqual([ok.ok, ok.exitCode, ok.outcome], [true, 0, "INSTALLED"]);
  assert.match(ok.message, /^install: INSTALLED \(Acme\)$/);
  assert.equal(ok.details.slackTeamId, "T1");

  const pending = summarizeSlackOutcome("install", { outcome: P + "PENDING_ADMIN_APPROVAL", approvalRequestFiled: true, oauthAuthorizeUrl: "https://slack.com/oauth/x" });
  assert.deepEqual([pending.ok, pending.needsHuman, pending.exitCode], [false, true, 4]);
  assert.match(pending.message, /admin must approve/);
  assert.match(pending.message, /open: https:\/\/slack\.com\/oauth\/x/);
  assert.equal(pending.details.approvalRequestFiled, true);

  const wr = summarizeSlackOutcome("install", { outcome: P + "WORKSPACE_REQUIRED", workspaces: [{ slackTeamId: "T1", slackTeamName: "One" }, { slackTeamId: "T2" }] });
  assert.equal(wr.exitCode, 4);
  assert.match(wr.message, /--workspace <teamId>/);
  assert.match(wr.message, /workspaces: T1 \(One\), T2$/m);

  for (const name of ["NOT_PUBLISHED", "UNSUPPORTED_HARNESS", "SLACK_REJECTED", "RATELIMITED", "INSTALL_CONFLICT", "WORKSPACE_NOT_ALLOWED"]) {
    const v = summarizeSlackOutcome("install", { outcome: P + name, slackError: "boom", retryAfterSeconds: 30 });
    assert.deepEqual([v.ok, v.needsHuman, v.exitCode], [false, false, 1], name);
  }
  assert.match(summarizeSlackOutcome("install", { outcome: P + "INSTALL_CONFLICT" }).message, /--replace/);
  assert.match(summarizeSlackOutcome("install", { outcome: P + "RATELIMITED", retryAfterSeconds: 30 }).message, /retry after 30s/);
  // reinstall / uninstall / connect / claim vocabularies
  assert.equal(summarizeSlackOutcome("reinstall", { outcome: "GROK_BOT_SLACK_REINSTALL_OUTCOME_UP_TO_DATE" }).exitCode, 0);
  assert.equal(summarizeSlackOutcome("reinstall", { outcome: "GROK_BOT_SLACK_REINSTALL_OUTCOME_RECREATE_REQUIRED" }).exitCode, 4);
  assert.equal(summarizeSlackOutcome("uninstall", { outcome: "GROK_BOT_SLACK_UNINSTALL_OUTCOME_REMOVED", forgotten: true }).details.forgotten, true);
  assert.equal(summarizeSlackOutcome("connect", { outcome: "GROK_BOT_SLACK_CONNECT_OUTCOME_STARTED", url: "https://slack.com/o" }).url, "https://slack.com/o");
  assert.equal(summarizeSlackOutcome("connect", { outcome: "GROK_BOT_SLACK_CONNECT_OUTCOME_NOT_PUBLISHED" }).exitCode, 1);
  assert.equal(summarizeSlackOutcome("claim", { outcome: "GROK_BOT_SLACK_CONNECT_CLAIM_OUTCOME_INVALID" }).exitCode, 1);
  assert.equal(summarizeSlackOutcome("claim", { outcome: "GROK_BOT_SLACK_CONNECT_CLAIM_OUTCOME_WRONG_CURSOR_ACCOUNT" }).exitCode, 4);
  // an empty / unknown outcome is a failure, never a silent success
  assert.equal(summarizeSlackOutcome("install", {}).exitCode, 1);
  assert.match(summarizeSlackOutcome("install", {}).message, /no outcome/);
  assert.equal(summarizeSlackOutcome("install", { outcome: P + "BRAND_NEW" }).exitCode, 1);
});

test("parseAllowlist: agent|routine lines, bare ids, comments, blanks; malformed lines throw", () => {
  const e = parseAllowlist("# header\n\nAlpha | Daily disk clean (Mac + box)  # why\n  9c15cbfe-06fc  \nBeta|nightly\n");
  assert.deepEqual(e, [
    { line: 3, agent: "Alpha", routine: "Daily disk clean (Mac + box)" },
    { line: 4, agent: null, routine: "9c15cbfe-06fc" },
    { line: 5, agent: "Beta", routine: "nightly" },
  ]);
  assert.throws(() => parseAllowlist("Alpha |"), /line 1/);
  assert.throws(() => parseAllowlist("| x"), /line 1/);
});

test("CursorClient Slack calls hit the right service/method with the right bodies", async () => {
  const p = fakePlane({
    overrides: {
      GetGrokBotSlackInstallState: () => ({ status: "GROK_BOT_SLACK_INSTALL_STATUS_NOT_CONNECTED" }),
      GetSlackUserSettings: () => ({ hasSlackAuth: true }),
      GetSlackInstallUrl: () => ({ url: "https://slack.com/oauth/v2/authorize?x=1", attemptId: "att" }),
      StartGrokBotSlackConnect: () => ({ url: "u", outcome: "GROK_BOT_SLACK_CONNECT_OUTCOME_STARTED" }),
      ClaimGrokBotSlackConnect: () => ({ outcome: "GROK_BOT_SLACK_CONNECT_CLAIM_OUTCOME_CLAIMED" }),
      InstallGrokBotSlackApp: () => ({}),
      ReinstallGrokBotSlackApp: () => ({}),
      UninstallGrokBotSlackApp: () => ({}),
      UnlinkSlackAccess: () => ({ success: true }),
    },
  });
  const c = p.client;
  await c.getSlackInstallState(A1);
  await c.getSlackUserSettings();
  await c.getSlackInstallUrl();
  await c.getSlackInstallUrl({ reconnectSlackTeamId: "T9" });
  await c.startSlackConnect(A1);
  await c.claimSlackConnect("claim-1");
  await c.installSlackApp(A1);
  await c.installSlackApp(A1, { slackTeamId: "T1", replaceExistingApp: true });
  await c.reinstallSlackApp(A1);
  await c.uninstallSlackApp(A1);
  await c.uninstallSlackApp(A1, { forgetIfUnreachable: true });
  await c.unlinkSlackAccess("T1");
  await c.setAutomationSlackWorkspace("auto1", "T1");
  await c.deleteAutomation(A1, "auto1", "America/Los_Angeles");
  await c.deleteAutomation(A1, "auto2");
  const DASH = "aiserver.v1.DashboardService";
  const G = "aiserver.v1.GrokBotService";
  assert.deepEqual(
    p.calls.map((x) => [x.service, x.method, x.body]),
    [
      [G, "GetGrokBotSlackInstallState", { agentId: A1 }],
      [DASH, "GetSlackUserSettings", {}],
      [DASH, "GetSlackInstallUrl", {}],
      [DASH, "GetSlackInstallUrl", { reconnectSlackTeamId: "T9" }],
      [G, "StartGrokBotSlackConnect", { agentId: A1 }],
      [G, "ClaimGrokBotSlackConnect", { claim: "claim-1" }],
      [G, "InstallGrokBotSlackApp", { agentId: A1 }],
      [G, "InstallGrokBotSlackApp", { agentId: A1, slackTeamId: "T1", replaceExistingApp: true }],
      [G, "ReinstallGrokBotSlackApp", { agentId: A1 }],
      [G, "UninstallGrokBotSlackApp", { agentId: A1 }],
      [G, "UninstallGrokBotSlackApp", { agentId: A1, forgetIfUnreachable: true }],
      [DASH, "UnlinkSlackAccess", { slackTeamId: "T1" }],
      [DASH, "SetSandAutomationSlackWorkspace", { automationId: "auto1", slackTeamId: "T1" }],
      [G, "DeleteGrokBotAgentAutomation", { agentId: A1, automationId: "auto1", timeZone: "America/Los_Angeles" }],
      [G, "DeleteGrokBotAgentAutomation", { agentId: A1, automationId: "auto2" }],
    ],
  );
});

test("deleteRoutine: without --yes it names the target and sends nothing; with --yes it deletes and confirms by re-read", async () => {
  const p = fakePlane({ routines: [R(A1, "a1", "nightly"), R(A1, "a2", "morning")] });
  await assert.rejects(deleteRoutine(p.client, "Alpha", "nightly"), (e) => /DELETE Alpha \/ nightly \(a1\), prompt 9 chars/.test(e.message) && /--yes/.test(e.message) && e.exitCode === 64);
  assert.equal(p.writes().length, 0);
  const r = await deleteRoutine(p.client, "Alpha", "nightly", { yes: true, timeZone: "UTC" });
  assert.deepEqual([r.deleted, r.confirmed, r.automationId], [true, true, "a1"]);
  assert.deepEqual(p.writes().map((w) => [w.method, w.body]), [["DeleteGrokBotAgentAutomation", { agentId: A1, automationId: "a1", timeZone: "UTC" }]]);
  assert.deepEqual(p.state.routines.map((x) => x.automationId), ["a2"], "only the named routine went");
  await assert.rejects(deleteRoutine(p.client, "Alpha", "nope", { yes: true }), /No routine "nope"/);
});

test("deleteRoutine fails loudly when the write is accepted but the routine is still listed", async () => {
  const p = fakePlane({ routines: [R(A1, "a1", "nightly")], overrides: { DeleteGrokBotAgentAutomation: () => ({ automations: [] }) } });
  await assert.rejects(deleteRoutine(p.client, "Alpha", "nightly", { yes: true }), (e) => e.exitCode === 1 && /still listed/.test(e.message));
});

test("setRoutineSlackWorkspace checks the team is linked before any write, and needs --yes", async () => {
  const p = fakePlane({ routines: [R(A1, "a1", "nightly")], workspaces: [{ slackTeamId: "T1", displayName: "Acme", sandAutomationCount: 2 }] });
  await assert.rejects(setRoutineSlackWorkspace(p.client, "Alpha", "nightly", "T404", { yes: true }), /not linked.*T1 \(Acme\)/);
  await assert.rejects(setRoutineSlackWorkspace(p.client, "Alpha", "nightly", "T1"), /Alpha \/ nightly \(a1\) -> Slack workspace T1 \(Acme\)\nRe-run with --yes/);
  assert.equal(p.writes().length, 0);
  const r = await setRoutineSlackWorkspace(p.client, "Alpha", "nightly", "T1", { yes: true });
  assert.deepEqual(p.writes().map((w) => [w.method, w.body]), [["SetSandAutomationSlackWorkspace", { automationId: "a1", slackTeamId: "T1" }]]);
  assert.deepEqual(r.workspace, { slackTeamId: "T1", displayName: "Acme", sandAutomationCount: 3 });
});

test("resumeGuard re-enables only allowlisted disabled routines, confirms by re-read, and reports the rest", async () => {
  const p = fakePlane({
    routines: [R(A1, "a1", "nightly", false), R(A1, "a2", "morning", true), R(A2, "b1", "weekly", false), R(A2, "b2", "other", false)],
  });
  const entries = parseAllowlist("Alpha | nightly\nAlpha | morning\nBeta | weekly\nBeta | nightly\nb2\nAlpha | nightly\n");
  const r = await resumeGuard(p.client, entries);
  assert.deepEqual(r.results.map((x) => x.status), ["resumed", "enabled", "resumed", "not-found", "resumed", "duplicate"]);
  assert.equal(r.resumed, 3);
  assert.equal(r.errors, 1, "an allowlist entry that matches nothing is an error");
  assert.deepEqual(p.writes().map((w) => [w.method, w.body.agentId, w.body.automationId, w.body.isEnabled]), [
    ["SetGrokBotAgentAutomationEnabled", A1, "a1", true],
    ["SetGrokBotAgentAutomationEnabled", A2, "b1", true],
    ["SetGrokBotAgentAutomationEnabled", A2, "b2", true],
  ]);
  assert.ok(p.state.routines.every((x) => x.rec.isEnabled === true));
  // second pass: nothing disabled, nothing written
  const before = p.writes().length;
  const again = await resumeGuard(p.client, entries.slice(0, 2));
  assert.deepEqual([again.resumed, again.errors, p.writes().length - before], [0, 0, 0]);
});

test("resumeGuard never touches unlisted routines, and --dry-run writes nothing", async () => {
  const p = fakePlane({ routines: [R(A1, "a1", "nightly", false), R(A1, "a2", "unlisted", false)] });
  const dry = await resumeGuard(p.client, parseAllowlist("Alpha | nightly"), { dryRun: true });
  assert.deepEqual(dry.results.map((x) => x.status), ["would-resume"]);
  assert.equal(p.writes().length, 0);
  await resumeGuard(p.client, parseAllowlist("Alpha | nightly"));
  assert.equal(p.state.routines.find((x) => x.automationId === "a2").rec.isEnabled, false);
});

test("resumeGuard: ambiguous refs are errors; a failing write does not stop the others; an unconfirmed write is a failure", async () => {
  const p = fakePlane({ routines: [R(A1, "a1", "dup", false), R(A1, "a2", "dup", false), R(A1, "a3", "good", false), R(A2, "b1", "bad", false)] });
  const failing = fakePlane({
    routines: [R(A1, "a3", "good", false), R(A2, "b1", "bad", false)],
    overrides: { SetGrokBotAgentAutomationEnabled: (b) => (b.automationId === "b1" ? new Error("nope") : (failing.state.routines.find((x) => x.automationId === b.automationId).rec.isEnabled = true, { automations: [] })) },
  });
  const amb = await resumeGuard(p.client, parseAllowlist("Alpha | dup\nAlpha | good"));
  assert.deepEqual(amb.results.map((x) => x.status), ["ambiguous", "resumed"]);
  assert.equal(amb.errors, 1);
  const f = await resumeGuard(failing.client, parseAllowlist("Beta | bad\nAlpha | good"));
  assert.deepEqual(f.results.map((x) => x.status), ["failed", "resumed"]);
  assert.match(f.results[0].error, /nope/);
  assert.equal(failing.writes().length, 2, "the failure did not stop the second write");
  // write "succeeds" but the routine stays disabled on re-read
  const stuck = fakePlane({ routines: [R(A1, "a1", "x", false)], overrides: { SetGrokBotAgentAutomationEnabled: () => ({ automations: [] }) } });
  const s = await resumeGuard(stuck.client, parseAllowlist("Alpha | x"));
  assert.deepEqual([s.results[0].status, s.errors], ["failed", 1]);
  assert.match(s.results[0].error, /still disabled/);
});

test("policy: the whole slack family and the new automations writes are denied under the agent policy", () => {
  assert.ok(DENIED_FOR_AGENTS.includes("slack"));
  const p = buildProgram();
  const sub = (...path) => path.reduce((c, name) => c.commands.find((x) => x.name() === name), p);
  const dir = mkdtempSync(join(tmpdir(), "grokbot-pol-"));
  const env = { GROKBOT_POLICY: "agent", GROKBOT_AUDIT_LOG: join(dir, "a.jsonl") };
  for (const path of [["slack", "status"], ["slack", "workspaces"], ["slack", "link-url"], ["slack", "connect"], ["slack", "claim"], ["slack", "install"], ["slack", "reinstall"], ["slack", "uninstall"], ["slack", "unlink"], ["automations", "delete"], ["automations", "slack-workspace"], ["automations", "resume-guard"]]) {
    const c = sub(...path);
    assert.equal(isDenied(commandPath(c), "agent"), true, path.join(" "));
    assert.throws(() => enforce(c, path, env), (e) => e.exitCode === 77, path.join(" "));
  }
});

test("CLI: slack writes without --yes refuse (exit 3) before any write; resume-guard refuses an empty allowlist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-slack-cli-"));
  const empty = join(dir, "empty.txt");
  writeFileSync(empty, "# nothing\n");
  const io = captureIo();
  const run = (...args) => buildProgram().parseAsync(args, { from: "user" });
  try {
    // No Cursor account exists in the isolated app-support dir, so reaching a write would fail differently (UsageError about sign-in).
    for (const args of [["slack", "claim", "c1"], ["slack", "unlink", "T1"]]) {
      await assert.rejects(run(...args), (e) => (args[1] === "claim" ? e.exitCode === 3 && /Re-run with --yes/.test(e.message) : /No Cursor account/.test(e.message)), args.join(" "));
    }
    await assert.rejects(run("automations", "resume-guard", "--allow", empty), /no entries/);
  } finally {
    io.restore();
  }
  assert.equal(readFileSync(empty, "utf8"), "# nothing\n");
});

// ---------------------------------------------------------------- review fixes

test("resumeGuard matches exactly (case-insensitive): prefixes and substrings are not-found and never written; hints only in --dry-run", async () => {
  const p = fakePlane({ routines: [R(A1, "a1b2c3d4-0000", "nightly", false), R(A2, "b1", "weekly", false)] });
  const entries = parseAllowlist("Alph | nightly\nAlpha | night\nAlpha | a1b2c3d4\n11111111 | nightly\nBeta | WEEKLY\nALPHA | NIGHTLY\n");
  const r = await resumeGuard(p.client, entries);
  assert.deepEqual(r.results.map((x) => x.status), ["not-found", "not-found", "not-found", "not-found", "resumed", "resumed"]);
  assert.ok(r.results.slice(0, 4).every((x) => !/did you mean/.test(x.error)), "no hints outside --dry-run");
  assert.deepEqual(p.writes().map((w) => w.body.automationId), ["b1", "a1b2c3d4-0000"], "only the two exact (case-insensitive) matches were written");
  // by exact agent id and exact routine id
  const q = fakePlane({ routines: [R(A1, "a1", "nightly", false)] });
  assert.equal((await resumeGuard(q.client, parseAllowlist(`${A1} | a1`))).results[0].status, "resumed");
  // dry-run: still not-found, but with candidates to help fix the allowlist
  const d = fakePlane({ routines: [R(A1, "a1b2c3d4-0000", "nightly", false)] });
  const dry = await resumeGuard(d.client, parseAllowlist("Alph | night"), { dryRun: true });
  assert.equal(dry.results[0].status, "not-found");
  assert.match(dry.results[0].error, /did you mean "Alpha \| nightly" \(a1b2c3d4-0000\)\?/);
  assert.equal(d.writes().length, 0);
});

test("setRoutineSlackWorkspace is confirmed by a re-read: a failed re-read, a missing team, or a reply without the team is exit 1", async () => {
  const ws = [{ slackTeamId: "T1", displayName: "Acme", sandAutomationCount: 0 }];
  const ok = fakePlane({ routines: [R(A1, "a1", "nightly")], workspaces: ws });
  const r = await setRoutineSlackWorkspace(ok.client, "Alpha", "nightly", "T1", { yes: true });
  assert.equal(r.confirmed, true);
  assert.match(r.target, /routine count rose 0 -> 1/);
  assert.equal(ok.calls.filter((c) => c.method === "ListSlackLinkedWorkspaces").length, 2, "one list before the write (validation), one after (confirmation)");

  let lists = 0;
  const flaky = fakePlane({ routines: [R(A1, "a1", "nightly")], workspaces: ws, overrides: { ListSlackLinkedWorkspaces: () => (++lists > 1 ? new Error("down") : { workspaces: ws }) } });
  await assert.rejects(setRoutineSlackWorkspace(flaky.client, "Alpha", "nightly", "T1", { yes: true }), (e) => e.exitCode === 1 && /could not be confirmed: re-read failed/.test(e.message));

  let n = 0;
  const vanished = fakePlane({ routines: [R(A1, "a1", "nightly")], workspaces: ws, overrides: { ListSlackLinkedWorkspaces: () => ({ workspaces: ++n > 1 ? [] : ws }) } });
  await assert.rejects(setRoutineSlackWorkspace(vanished.client, "Alpha", "nightly", "T1", { yes: true }), (e) => e.exitCode === 1 && /not in the linked workspaces on re-read/.test(e.message));

  const noRow = fakePlane({ routines: [R(A1, "a1", "nightly")], workspaces: ws, overrides: { SetSandAutomationSlackWorkspace: () => ({ workspaces: [] }) } });
  await assert.rejects(setRoutineSlackWorkspace(noRow.client, "Alpha", "nightly", "T1", { yes: true }), (e) => e.exitCode === 1 && /reply did not include/.test(e.message));
});

test("Slack outcomes are verb-aware: uninstall of something not connected is success; install/reinstall NOT_CONNECTED still needs a human", () => {
  const u = summarizeSlackOutcome("uninstall", { outcome: "GROK_BOT_SLACK_UNINSTALL_OUTCOME_NOT_CONNECTED" });
  assert.deepEqual([u.ok, u.needsHuman, u.exitCode, u.outcome], [true, false, 0, "NOT_CONNECTED"]);
  assert.match(u.message, /nothing was installed or connected/);
  assert.equal(summarizeSlackOutcome("install", { outcome: "GROK_BOT_SLACK_INSTALL_OUTCOME_NOT_CONNECTED" }).exitCode, 4);
  assert.equal(summarizeSlackOutcome("reinstall", { outcome: "GROK_BOT_SLACK_REINSTALL_OUTCOME_NOT_CONNECTED" }).exitCode, 4);
  assert.equal(summarizeSlackOutcome("uninstall", { outcome: "GROK_BOT_SLACK_UNINSTALL_OUTCOME_MANAGER_REAUTH_REQUIRED" }).exitCode, 4);
  assert.equal(summarizeSlackOutcome("uninstall", { outcome: "GROK_BOT_SLACK_UNINSTALL_OUTCOME_SLACK_REJECTED" }).exitCode, 1);
});

test("deleteRoutine: a post-delete re-read that throws reports deleted (unconfirmed), not an error", async () => {
  let lists = 0;
  const p = fakePlane({
    routines: [R(A1, "a1", "nightly")],
    overrides: { ListGrokBotAccountAutomations: (b) => (++lists > 1 ? new Error("flaky") : { agents: b.agentIds.map((agentId) => ({ agentId, automations: p.state.routines.filter((r) => r.agentId === agentId).map((r) => ({ automationId: r.automationId, recordJson: rec(r.rec) })) })) }) },
  });
  const r = await deleteRoutine(p.client, "Alpha", "nightly", { yes: true });
  assert.deepEqual([r.deleted, r.confirmed], [true, false]);
  assert.match(r.target, /deleted .* \(unconfirmed: the re-read failed: .*flaky/);
  assert.equal(p.writes().length, 1);
});

test("audit: the slack claim token never reaches the audit log (denied under the agent policy)", async () => {
  const { redactArgv } = await import("../src/policy.js");
  assert.deepEqual(redactArgv("slack claim", ["slack", "claim", "SECRET-CLAIM", "--yes"]), ["slack", "claim", "<redacted>", "--yes"]);
  assert.deepEqual(redactArgv("slack claim", ["slack", "claim", "--yes", "SECRET-CLAIM"]), ["slack", "claim", "--yes", "<redacted>"]);
  assert.deepEqual(redactArgv("slack status", ["slack", "status"]), ["slack", "status"]);
  const dir = mkdtempSync(join(tmpdir(), "grokbot-claim-aud-"));
  const env = { GROKBOT_POLICY: "agent", GROKBOT_AUDIT_LOG: join(dir, "a.jsonl") };
  const claim = buildProgram().commands.find((c) => c.name() === "slack").commands.find((c) => c.name() === "claim");
  assert.throws(() => enforce(claim, ["slack", "claim", "SECRET-CLAIM", "--yes"], env), (e) => e.exitCode === 77);
  const log = readFileSync(env.GROKBOT_AUDIT_LOG, "utf8");
  assert.ok(!log.includes("SECRET-CLAIM"), "token must not be logged");
  assert.match(log, /"decision":"denied"/);
});

test("launchd render-plist.sh escapes $HOME for sed and XML (spaces, &, |, \\, <, >) and yields a valid plist", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "grokbot-render-"));
  const tpl = new URL("../launchd/com.grokbot.resume-guard.plist", import.meta.url).pathname;
  const home = "/Users/a b&c|d\\e<f>g";
  const rendered = execFileSync("sh", [new URL("../launchd/render-plist.sh", import.meta.url).pathname, tpl, home], { encoding: "utf8" });
  assert.ok(!rendered.includes("__HOME__"));
  assert.ok(rendered.includes("/Users/a b&amp;c|d\\e&lt;f&gt;g/Library/Logs/grokbot-resume-guard.log"));
  assert.ok(rendered.includes('--allow "$HOME/.grokbot/resume-allow.txt"'), "the shell command quotes $HOME itself instead of templating it");
  const out = join(dir, "t.plist");
  writeFileSync(out, rendered);
  try {
    execFileSync("plutil", ["-lint", out], { stdio: "pipe" });
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // no plutil off macOS
  }
});

test("agents export help no longer mentions memories", () => {
  const exp = buildProgram().commands.find((c) => c.name() === "agents").commands.find((c) => c.name() === "export");
  assert.ok(!/memor/i.test(exp.description()));
});

// ---------------------------------------------------------------- workspaces (both links) and connect --wait/--install

const ST = "GROK_BOT_SLACK_INSTALL_STATUS_";
const OC = "GROK_BOT_SLACK_INSTALL_OUTCOME_";
const ws = (id, name, ms) => ({ slackTeamId: id, slackTeamName: name, managerAuthUpdatedAtMs: String(ms) });

/** Run a CLI command against a mocked plane; returns { stdout, stderr, exitCode }. */
async function runCli(plane, ...args) {
  const io = captureIo();
  const prev = process.exitCode;
  process.exitCode = 0;
  setCursorForTests(plane.client);
  setSlackPollMsForTests(5);
  try {
    await buildProgram().parseAsync(args, { from: "user" });
    return { stdout: io.out.join(""), stderr: io.err.join(""), exitCode: process.exitCode ?? 0 };
  } catch (e) {
    return { stdout: io.out.join(""), stderr: io.err.join(""), exitCode: e.exitCode ?? 1, error: e };
  } finally {
    io.restore();
    setCursorForTests(null);
    setSlackPollMsForTests(null);
    process.exitCode = prev;
  }
}

/** Plane whose install state for agent A1 follows `states` (one per poll; the last repeats). */
function connectPlane({ states, install = { outcome: OC + "INSTALLED", workspaceName: "Acme" }, workspaces = [], overrides = {} }) {
  let i = 0;
  return fakePlane({
    workspaces,
    slackConnections: [{ agentId: A1 }, { agentId: A2 }],
    overrides: {
      GetGrokBotSlackInstallState: (b) => (b.agentId === A1 ? states[Math.min(i++, states.length - 1)] : { status: ST + "NOT_CONNECTED", workspaces: states.at(-1).workspaces }),
      StartGrokBotSlackConnect: () => ({ outcome: "GROK_BOT_SLACK_CONNECT_OUTCOME_STARTED", url: "https://slack.com/oauth/v2/authorize?x=1" }),
      InstallGrokBotSlackApp: () => install,
      ...overrides,
    },
  });
}

test("slack workspaces shows both sections: app workspaces (union across agents) and the routine-trigger link", async () => {
  const p = fakePlane({
    workspaces: [],
    slackConnections: [{ agentId: A1 }, { agentId: A2 }],
    overrides: {
      GetGrokBotSlackInstallState: (b) => ({ status: ST + "NOT_CONNECTED", workspaces: b.agentId === A1 ? [ws("T1", "Acme", 1000)] : [ws("T1", "Acme", 2000), ws("T2", "Beta Co", 500)] }),
      GetSlackUserSettings: () => ({ hasSlackAuth: false }),
    },
  });
  const r = await runCli(p, "slack", "workspaces");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Grok Bot app workspaces[\s\S]*T1\s+Acme[\s\S]*T2\s+Beta Co/);
  assert.match(r.stdout, /Routine-trigger link \(DashboardService[\s\S]*\(none\)/);
  assert.ok(r.stdout.indexOf("Grok Bot app workspaces") < r.stdout.indexOf("Routine-trigger link"));
  assert.equal((r.stdout.match(/T1/g) ?? []).length, 1, "T1 is de-duplicated across agents");
  const j = await runCli(p, "--json", "slack", "workspaces");
  const body = JSON.parse(j.stdout);
  assert.deepEqual(body.appWorkspaces.map((w) => w.slackTeamId).sort(), ["T1", "T2"]);
  assert.deepEqual(body.workspaces, []);
  // --agent narrows the app-workspace section to that agent's own list
  const one = JSON.parse((await runCli(p, "--json", "slack", "workspaces", "--agent", "Beta")).stdout);
  assert.equal(one.appWorkspaces.length, 2);
  const a = JSON.parse((await runCli(p, "--json", "slack", "workspaces", "--agent", "Alpha")).stdout);
  assert.deepEqual(a.appWorkspaces.map((w) => w.slackTeamId), ["T1"]);
  assert.equal(p.writes().length, 0, "read-only");
});

test("slack workspaces lists a routine-trigger workspace under its own heading too", async () => {
  const p = fakePlane({ workspaces: [{ slackTeamId: "T9", displayName: "Routines Co", status: "SLACK_LINK_STATUS_ACTIVE", sandAutomationCount: 2 }], slackConnections: [{ agentId: A1 }], overrides: { GetGrokBotSlackInstallState: () => ({ status: ST + "CONNECTED", workspaces: [ws("T1", "Acme", 1)] }), GetSlackUserSettings: () => ({}) } });
  const r = await runCli(p, "slack", "workspaces");
  assert.match(r.stdout, /Grok Bot app workspaces[\s\S]*T1\s+Acme[\s\S]*Routine-trigger link[\s\S]*T9\s+Routines Co/);
});

test("slack connect (no --wait) prints the URL plus the browser note and polls nothing", async () => {
  const p = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }] });
  const r = await runCli(p, "slack", "connect", "Alpha");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /open: https:\/\/slack\.com\/oauth\/v2\/authorize\?x=1/);
  assert.match(r.stdout, /signed in to both Slack and cursor\.com/);
  assert.equal(p.calls.filter((c) => c.method === "GetGrokBotSlackInstallState").length, 0);
});

test("slack connect --wait succeeds when a workspace with a newer managerAuthUpdatedAtMs appears", async () => {
  const before = { status: ST + "NOT_CONNECTED", workspaces: [ws("T0OLD001", "Old", 1000)] };
  const p = connectPlane({ states: [before, before, { status: ST + "NOT_CONNECTED", workspaces: [ws("T0OLD001", "Old", 1000), ws("T0NEW001", "Agent Everywhere", 5000)] }] });
  const r = await runCli(p, "slack", "connect", "Alpha", "--wait", "5");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /workspace recorded: T0NEW001 \(Agent Everywhere\)/);
  assert.equal(p.writes().filter((w) => w.method === "InstallGrokBotSlackApp").length, 0, "no install without --install");
  // a re-authorized existing workspace (newer ms, same id) also counts
  const re = connectPlane({ states: [before, { status: ST + "NOT_CONNECTED", workspaces: [ws("T0OLD001", "Old", 9000)] }] });
  assert.match((await runCli(re, "slack", "connect", "Alpha", "--wait", "5")).stdout, /workspace recorded: T0OLD001/);
  // status turning CONNECTED (server completed the install) also ends the wait
  const conn = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }, { status: ST + "CONNECTED", slackTeamId: "T7", workspaceName: "Seven", workspaces: [ws("T7", "Seven", 1)] }] });
  assert.match((await runCli(conn, "slack", "connect", "Alpha", "--wait", "5")).stdout, /status: CONNECTED/);
});

test("slack connect --wait times out with exit 4 when nothing new is recorded", async () => {
  const same = { status: ST + "NOT_CONNECTED", workspaces: [ws("T0OLD001", "Old", 1000)] };
  const p = connectPlane({ states: [same] });
  const r = await runCli(p, "slack", "connect", "Alpha", "--wait", "0.05");
  assert.equal(r.exitCode, 4);
  assert.match(r.stdout, /timed out after/);
  assert.match(r.stdout, /open: https:\/\/slack\.com/);
  assert.ok(p.calls.filter((c) => c.method === "GetGrokBotSlackInstallState").length >= 2, "polled more than once");
  const bad = await runCli(p, "slack", "connect", "Alpha", "--wait", "abc");
  assert.equal(bad.exitCode, 64);
  assert.match(bad.error.message, /--wait expects a positive number/);
});

test("slack connect --install refuses without --yes before starting anything", async () => {
  const p = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }] });
  const r = await runCli(p, "slack", "connect", "Alpha", "--install");
  assert.equal(r.exitCode, 3);
  assert.match(r.error.message, /Re-run with --yes/);
  assert.equal(p.calls.filter((c) => c.method === "StartGrokBotSlackConnect").length, 0);
});

test("slack connect --install --yes auto-picks the single new workspace and reports the install outcome", async () => {
  const p = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }, { status: ST + "NOT_CONNECTED", workspaces: [ws("T0NEW001", "Acme", 5000)] }] });
  const r = await runCli(p, "slack", "connect", "Alpha", "--install", "--yes");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /workspace recorded: T0NEW001/);
  assert.match(r.stdout, /install: INSTALLED \(Acme\)/);
  const w = p.writes().filter((x) => x.method === "InstallGrokBotSlackApp");
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].body.agentId, w[0].body.slackTeamId], [A1, "T0NEW001"]);
  // an install that needs a human (admin approval) keeps its exit code 4
  const pend = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }, { status: ST + "NOT_CONNECTED", workspaces: [ws("T0NEW001", "Acme", 5000)] }], install: { outcome: OC + "PENDING_ADMIN_APPROVAL" } });
  const pr = await runCli(pend, "slack", "connect", "Alpha", "--install", "--yes");
  assert.equal(pr.exitCode, 4);
  assert.match(pr.stdout, /install: PENDING_ADMIN_APPROVAL/);
});

test("slack connect --install with several new workspaces needs --workspace (exit 4, no write); --workspace picks one", async () => {
  const two = { status: ST + "NOT_CONNECTED", workspaces: [ws("T0000001", "One", 5000), ws("T0000002", "Two", 6000)] };
  const states = [{ status: ST + "NOT_CONNECTED", workspaces: [] }, two];
  const p = connectPlane({ states });
  const r = await runCli(p, "slack", "connect", "Alpha", "--install", "--yes");
  assert.equal(r.exitCode, 4);
  assert.match(r.stdout, /2 new workspaces appeared \(T0000001 \(One\), T0000002 \(Two\)\).*--workspace/);
  assert.equal(p.writes().filter((x) => x.method === "InstallGrokBotSlackApp").length, 0);
  const q = connectPlane({ states });
  const ok = await runCli(q, "slack", "connect", "Alpha", "--install", "--yes", "--workspace", "T0000002");
  assert.equal(ok.exitCode, 0);
  assert.equal(q.writes().find((x) => x.method === "InstallGrokBotSlackApp").body.slackTeamId, "T0000002");
  // a team id that is not recorded yet is not an error: keep polling until it shows up (here: it never does -> exit 4, no install)
  const never = connectPlane({ states });
  const miss = await runCli(never, "slack", "connect", "Alpha", "--install", "--yes", "--workspace", "T0000009", "--wait", "0.05");
  assert.equal(miss.exitCode, 4);
  assert.match(miss.stdout, /timed out after/);
  assert.equal(never.writes().filter((x) => x.method === "InstallGrokBotSlackApp").length, 0);
  // the format is validated up front, before any call
  const fmt = connectPlane({ states });
  const bad = await runCli(fmt, "slack", "connect", "Alpha", "--install", "--yes", "--workspace", "acme");
  assert.equal(bad.exitCode, 64);
  assert.match(bad.error.message, /not a Slack team id/);
  assert.equal(fmt.calls.length, 0);
});

// ---------------------------------------------------------------- review fixes

test("connect --wait --json: the URL, note and waiting line go to stderr before polling; stdout is one JSON document", async () => {
  const p = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }, { status: ST + "NOT_CONNECTED", workspaces: [ws("T0NEW001", "Acme", 5000)] }] });
  const r = await runCli(p, "--json", "slack", "connect", "Alpha", "--wait", "5");
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /open: https:\/\/slack\.com\/oauth\/v2\/authorize\?x=1/);
  assert.match(r.stderr, /signed in to both Slack and cursor\.com/);
  assert.match(r.stderr, /waiting up to 5s/);
  const body = JSON.parse(r.stdout);
  assert.equal(body.url, "https://slack.com/oauth/v2/authorize?x=1");
  assert.deepEqual(body.waited.newWorkspaces, [{ slackTeamId: "T0NEW001", name: "Acme" }]);
  // a timeout in JSON mode still ends with exit 4 and a JSON result, the URL having been shown on stderr
  const t = await runCli(connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }] }), "--json", "slack", "connect", "Alpha", "--wait", "0.05");
  assert.equal(t.exitCode, 4);
  assert.match(t.stderr, /open: https:\/\/slack\.com/);
  assert.equal(JSON.parse(t.stdout).waited.timedOut, true);
});

test("connect --wait tolerates transient poll errors and gives up after N consecutive failures (exit 1)", async () => {
  let n = 0;
  const flaky = connectPlane({
    states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }],
    overrides: { GetGrokBotSlackInstallState: () => (++n === 1 ? { status: ST + "NOT_CONNECTED", workspaces: [] } : n <= 3 ? new Error("blip") : { status: ST + "NOT_CONNECTED", workspaces: [ws("T0NEW001", "Acme", 5000)] }) },
  });
  const r = await runCli(flaky, "slack", "connect", "Alpha", "--wait", "5");
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /poll failed \(1\/5\).*blip/);
  assert.match(r.stdout, /workspace recorded: T0NEW001/);

  let m = 0;
  const dead = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }], overrides: { GetGrokBotSlackInstallState: () => (++m === 1 ? { status: ST + "NOT_CONNECTED", workspaces: [] } : new Error("down")) } });
  const d = await runCli(dead, "slack", "connect", "Alpha", "--wait", "30");
  assert.equal(d.exitCode, 1);
  assert.match(d.error.message, /5 consecutive install-state reads failed/);
  assert.match(d.error.message, /slack status --agent/);
});

test("waitForSlackWorkspace bounds each read with an AbortSignal timeout and counts the timeout as a failure", async () => {
  const signals = [];
  const hung = { getSlackInstallState: (_id, { signal }) => (signals.push(signal), new Promise(() => {})) };
  const errs = [];
  await assert.rejects(
    waitForSlackWorkspace(hung, A1, installBaseline({}), { intervalMs: 1, timeoutMs: 5000, requestTimeoutMs: 10, maxFailures: 2, onError: (e) => errs.push(e.message) }),
    (e) => e.exitCode === 1 && /2 consecutive/.test(e.message),
  );
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s.aborted), "each hung request was aborted");
  assert.match(errs[0], /timed out after 10ms/);
  // the overall deadline still wins when reads keep failing but the budget runs out first
  const slow = { getSlackInstallState: async () => { throw new Error("blip"); } };
  const r = await waitForSlackWorkspace(slow, A1, installBaseline({}), { intervalMs: 5, timeoutMs: 20, maxFailures: 1000 });
  assert.equal(r.timedOut, true);
});

test("connect --install ignores a bumped managerAuthUpdatedAtMs on a known workspace (only an unseen team id is auto-installed)", async () => {
  const known = (ms) => ({ status: ST + "NOT_CONNECTED", workspaces: [ws("T0OLD001", "Old", ms)] });
  const p = connectPlane({ states: [known(1000), known(9000)] });
  const r = await runCli(p, "slack", "connect", "Alpha", "--install", "--yes", "--wait", "0.05");
  assert.equal(r.exitCode, 4);
  assert.match(r.stdout, /timed out after/);
  assert.equal(p.writes().filter((x) => x.method === "InstallGrokBotSlackApp").length, 0);
  // an unseen team next to a bumped known one installs into the unseen one
  const q = connectPlane({ states: [known(1000), { status: ST + "NOT_CONNECTED", workspaces: [ws("T0OLD001", "Old", 9000), ws("T0NEW001", "New", 5000)] }] });
  const ok = await runCli(q, "slack", "connect", "Alpha", "--install", "--yes", "--wait", "5");
  assert.equal(ok.exitCode, 0);
  assert.equal(q.writes().find((x) => x.method === "InstallGrokBotSlackApp").body.slackTeamId, "T0NEW001");
  // without --install a bumped timestamp still ends the wait (re-authorization is reported)
  const re = connectPlane({ states: [known(1000), known(9000)] });
  assert.match((await runCli(re, "slack", "connect", "Alpha", "--wait", "5")).stdout, /workspace recorded: T0OLD001/);
});

test("connect --install skips the install when the status turned CONNECTED during the wait", async () => {
  const p = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [] }, { status: ST + "CONNECTED", slackTeamId: "T0NEW001", workspaceName: "Acme", workspaces: [ws("T0NEW001", "Acme", 5000)] }] });
  const r = await runCli(p, "slack", "connect", "Alpha", "--install", "--yes", "--wait", "5");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /install: skipped - the agent became CONNECTED/);
  assert.equal(p.writes().filter((x) => x.method === "InstallGrokBotSlackApp").length, 0);
});

test("connect --install --workspace T for an already-recorded workspace skips the connect and the wait (re-run after a timeout)", async () => {
  const p = connectPlane({ states: [{ status: ST + "NOT_CONNECTED", workspaces: [ws("T0NEW001", "Acme", 5000)] }] });
  const r = await runCli(p, "slack", "connect", "Alpha", "--install", "--yes", "--workspace", "T0NEW001");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /already recorded; skipping/);
  assert.match(r.stdout, /install: INSTALLED/);
  assert.equal(p.calls.filter((c) => c.method === "StartGrokBotSlackConnect").length, 0);
  assert.equal(p.writes().find((x) => x.method === "InstallGrokBotSlackApp").body.slackTeamId, "T0NEW001");
});

test("slack workspaces checks every agent (not just slackConnections), fails on a bad --agent, and survives a ListGrokBotAgents failure", async () => {
  const seen = [];
  const mk = (extra = {}) =>
    fakePlane({ workspaces: [{ slackTeamId: "T9", displayName: "Routines Co", status: "SLACK_LINK_STATUS_ACTIVE" }], slackConnections: [], overrides: { GetSlackUserSettings: () => ({}), GetGrokBotSlackInstallState: (b) => (seen.push(b.agentId), { status: ST + "NOT_CONNECTED", workspaces: b.agentId === A2 ? [ws("T0BETA01", "Beta Co", 7)] : [] }), ...extra } });
  const p = mk();
  const r = await runCli(p, "--json", "slack", "workspaces");
  assert.deepEqual(JSON.parse(r.stdout).appWorkspaces.map((w) => w.slackTeamId), ["T0BETA01"], "an agent with no slackConnections row is still checked");
  assert.deepEqual(seen.sort(), [A1, A2]);
  for (const ref of ["nomatch", "a"]) {
    const bad = await runCli(mk(), "slack", "workspaces", "--agent", ref);
    assert.equal(bad.exitCode, 64, ref);
    assert.match(bad.error.message, /No agent matches|matches \d agents/);
  }
  const down = mk({ ListGrokBotAgents: () => new Error("agents down") });
  const d = await runCli(down, "slack", "workspaces");
  assert.equal(d.exitCode, 1);
  assert.match(d.stdout, /ERROR: ListGrokBotAgents failed/);
  assert.match(d.stdout, /Routine-trigger link[\s\S]*T9\s+Routines Co/);
});

test("mapLimit never runs more than `limit` at once and keeps the input order", async () => {
  let live = 0;
  let peak = 0;
  const r = await mapLimit(Array.from({ length: 20 }, (_, i) => i), 6, async (i) => {
    peak = Math.max(peak, ++live);
    await new Promise((res) => setTimeout(res, 2));
    live--;
    return i * 2;
  });
  assert.ok(peak <= 6 && peak > 1, `peak ${peak}`);
  assert.deepEqual(r, Array.from({ length: 20 }, (_, i) => i * 2));
});
