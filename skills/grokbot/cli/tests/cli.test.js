import "./_isolate.js";
import { captureIo } from "./_io.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Gateway, readSnapshotFile } from "../src/gateway.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram, setCursorForTests, setGatewayForTests, runtimeClientFor, sendMessage, confirmDestructive, describeSectionStores, sectionsSyncMode, hasSelectionFlags, selectionFromOpts } from "../src/cli.js";
import { UsageError } from "../src/output.js";

// Safety net: no test may touch the real ~/.grokbot snapshot.
process.env.GROKBOT_SECTIONS_SYNC_FILE = join(mkdtempSync(join(tmpdir(), "grokbot-cli-snap-")), "default.json");

function sub(program, ...path) {
  let c = program;
  for (const name of path) c = c.commands.find((x) => x.name() === name || x.aliases().includes(name));
  return c;
}

test("--groups / --no-groups is a tri-state on selection commands", () => {
  const list = sub(buildProgram(), "agents", "list");
  list.parseOptions(["--no-groups"]);
  assert.equal(list.opts().groups, false);
  const list2 = sub(buildProgram(), "agents", "list");
  list2.parseOptions(["--groups"]);
  assert.equal(list2.opts().groups, true);
  const list3 = sub(buildProgram(), "agents", "list");
  list3.parseOptions([]);
  assert.equal(list3.opts().groups, undefined);
  assert.equal(hasSelectionFlags(list3.opts()), false);
  assert.equal(hasSelectionFlags(list2.opts()), true);
});

test("selectionFromOpts maps flags and resolves --section against sections", () => {
  const f = selectionFromOpts({ name: "x*", hidden: true, idleFor: "2h", section: "Swarm" }, [{ id: "s1", name: "Swarm", agentIds: [] }]);
  assert.equal(f.name, "x*");
  assert.equal(f.hidden, true);
  assert.equal(f.includeHidden, true);
  assert.equal(f.idleFor, 7_200_000);
  assert.equal(f.section, "s1");
  assert.equal(selectionFromOpts({ section: "none" }, []).section, "none");
  assert.throws(() => selectionFromOpts({ section: "nope" }, []), /No section matches/);
});

const jsonCmd = { parent: null, opts: () => ({ json: true }) };
const rows = [{ id: "a", name: "A" }, { id: "b", name: "B" }];

test("confirmDestructive: dry-run, missing --yes, count mismatch, ok", async () => {
  const io = captureIo();
  const outBuf = io.out;
  try {
    assert.equal(await confirmDestructive(jsonCmd, rows, { dryRun: true }, { verb: "delete" }), false);
    await assert.rejects(confirmDestructive(jsonCmd, rows, {}, { verb: "delete" }), (e) => e.exitCode === 3 && /--yes --confirm-count 2/.test(e.message));
    await assert.rejects(confirmDestructive(jsonCmd, rows, { yes: true }, { verb: "delete" }), (e) => e.exitCode === 3 && /confirm-count 2/.test(e.message));
    await assert.rejects(confirmDestructive(jsonCmd, rows, { yes: true, confirmCount: "abc" }, { verb: "delete" }), (e) => e.exitCode === 3);
    await assert.rejects(confirmDestructive(jsonCmd, rows, { yes: true, confirmCount: "3" }, { verb: "delete" }), (e) => e.exitCode === 3);
    assert.equal(await confirmDestructive(jsonCmd, rows, { yes: true, confirmCount: "2" }, { verb: "delete" }), true);
    assert.equal(await confirmDestructive(jsonCmd, [rows[0]], { yes: true }, { verb: "delete" }), true, "single target needs only --yes");
    assert.equal(await confirmDestructive(jsonCmd, rows, { yes: true }, { verb: "move", requireCount: false }), true, "reversible ops skip the count");
  } finally {
    io.restore();
  }
  assert.ok(outBuf.some((s) => s.includes('"dryRun": true')));
});

test("delete/move/unassign expose the gating flags; app restart has --debug", () => {
  const p = buildProgram();
  for (const path of [["agents", "delete"], ["sections", "move"], ["sections", "unassign"]]) {
    const names = sub(p, ...path).options.map((o) => o.long);
    assert.ok(names.includes("--yes") && names.includes("--dry-run"), path.join(" "));
  }
  assert.ok(sub(p, "agents", "delete").options.map((o) => o.long).includes("--confirm-count"));
  assert.ok(sub(p, "app", "restart").options.map((o) => o.long).includes("--debug"));
});

test("auto-review set/append/get speak the structured allow/block rules through host settings", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  let current = { isEnabled: true, allowInstructions: ["old rule"], blockInstructions: ["never this"] };
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      calls.push({ url: req.url, body: parsed });
      if (req.url === "/api/setHostSettings") current = parsed.autoReviewInstructions ?? current;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ sidebarSections: [], autoReviewInstructions: current }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "grokbot-ar-"));
  const auditFile = join(dir, "audit.jsonl");
  const keys = ["GROKBOT_POLICY", "GROKBOT_AUDIT_LOG"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GROKBOT_POLICY = "operator"; // audit records must still be written under operator
  process.env.GROKBOT_AUDIT_LOG = auditFile;
  // No runtime client: this test must never reach the real Cursor account.
  setGatewayForTests(new Gateway({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "T", headers: {} }, { runtime: null }));
  const io = captureIo();
  const outBuf = io.out;
  const errBuf = io.err;
  const runCli = (...args) => buildProgram().parseAsync(args, { from: "user" });
  const sets = () => calls.filter((c) => c.url === "/api/setHostSettings").map((c) => c.body);
  const auditRecords = () => (existsSync(auditFile) ? readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const shaOf = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  try {
    await runCli("auto-review", "set", "x\n\n y ");
    assert.deepEqual(sets(), [{ autoReviewInstructions: { isEnabled: true, allowInstructions: ["x", "y"], blockInstructions: ["never this"] } }], "set replaces only the allow list, one rule per line, other list kept");
    assert.ok(errBuf.join("").includes("previous allow rules: 1"), "previous count goes to stderr");
    assert.ok(errBuf.join("").includes("host auto-review setting only"), "host-only write is announced");
    const rec = auditRecords();
    assert.equal(rec.length, 1);
    assert.equal(rec[0].path, "auto-review set");
    assert.equal(rec[0].list, "allow");
    assert.equal(rec[0].length, JSON.stringify(["x", "y"]).length);
    assert.equal(rec[0].sha256, shaOf(["x", "y"]));
    assert.ok(!JSON.stringify(rec[0]).includes('"x"'), "audit never stores the rules themselves");

    const file = join(dir, "rules.md");
    writeFileSync(file, "from file\n");
    calls.length = 0;
    await runCli("auto-review", "set", "--file", file);
    assert.deepEqual(sets()[0].autoReviewInstructions.allowInstructions, ["from file"]);

    calls.length = 0;
    await runCli("auto-review", "append", "second");
    assert.deepEqual(sets()[0].autoReviewInstructions.allowInstructions, ["from file", "second"]);
    const appendRec = auditRecords().at(-1);
    assert.equal(appendRec.path, "auto-review append");
    assert.equal(appendRec.sha256, shaOf(["from file", "second"]));

    // a rule already in the list is a no-op: no write, no audit record
    calls.length = 0;
    const before = auditRecords().length;
    await runCli("auto-review", "append", "second");
    assert.deepEqual(sets(), [], "appending an existing rule writes nothing");
    assert.equal(auditRecords().length, before);

    calls.length = 0;
    await runCli("auto-review", "append", "--list", "block", "also never");
    assert.deepEqual(sets()[0].autoReviewInstructions.blockInstructions, ["never this", "also never"]);
    assert.deepEqual(sets()[0].autoReviewInstructions.allowInstructions, ["from file", "second"], "the allow list is untouched");

    outBuf.length = 0;
    await runCli("auto-review", "get");
    assert.match(outBuf.join(""), /enabled +yes\nallow \(2\)\n {2}from file\n {2}second\nblock \(2\)\n {2}never this\n {2}also never\n/);

    // empty / whitespace-only values are rejected from every source unless --clear
    calls.length = 0;
    const blank = join(dir, "blank.md");
    writeFileSync(blank, "  \n\t\n");
    await assert.rejects(runCli("auto-review", "set", ""), (e) => e instanceof UsageError && /empty/.test(e.message));
    await assert.rejects(runCli("auto-review", "set", "   "), (e) => e instanceof UsageError && /--clear/.test(e.message));
    await assert.rejects(runCli("auto-review", "set", "--file", blank), (e) => e instanceof UsageError && /--clear/.test(e.message));
    await assert.rejects(runCli("auto-review", "append", "  "), (e) => e instanceof UsageError);
    await assert.rejects(runCli("auto-review", "append", "a\nb"), (e) => e instanceof UsageError);
    await assert.rejects(runCli("auto-review", "set", "--list", "nope", "x"), /--list must be/);
    await assert.rejects(runCli("auto-review", "set"), /exactly one source/);
    await assert.rejects(runCli("auto-review", "set", "x", "--file", file), /exactly one source/);
    await assert.rejects(runCli("auto-review", "set", "x", "--clear"), /--clear takes no/);
    assert.equal(calls.length, 0, "usage errors never reach the gateway");

    // --clear with no source empties the chosen list only
    await runCli("auto-review", "set", "--clear", "--list", "block");
    assert.deepEqual(sets()[0].autoReviewInstructions, { isEnabled: true, allowInstructions: ["from file", "second"], blockInstructions: [] });
    const clearRec = auditRecords().at(-1);
    assert.equal(clearRec.sha256, shaOf([]));
  } finally {
    io.restore();
    setGatewayForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
  }
});

test("describeSectionStores: drift diff, in sync, and the box view against the last sync snapshot", () => {
  const A = { id: "s1", name: "One", agentIds: ["a"] };
  const B = { id: "s2", name: "Two", agentIds: [] };
  const key = (l) => JSON.stringify(l.map((x) => [x.id, x.name, x.agentIds]));
  let d = describeSectionStores({ runtime: [A], host: [A, B], drift: true, snapshot: null });
  assert.equal(d.inSync, false);
  assert.deepEqual(d.diff, ['+ section "Two" (0 agents)']);
  d = describeSectionStores({ runtime: [A], host: [A], drift: false, snapshot: null });
  assert.equal(d.inSync, true);
  d = describeSectionStores({ runtime: null, host: [A], drift: null, snapshot: { at: "t", key: key([A]) } });
  assert.equal(d.inSync, true);
  assert.equal(d.mirrorMatchesSnapshot, true);
  d = describeSectionStores({ runtime: null, host: [A, B], drift: null, snapshot: { at: "t", key: key([A]) } });
  assert.equal(d.inSync, false);
  assert.equal(d.mirrorMatchesSnapshot, false);
  assert.equal(d.state, "pending");
  d = describeSectionStores({ runtime: null, host: [A], drift: null, snapshot: null });
  assert.equal(d.inSync, null, "no runtime and no snapshot (box): unknown, not pending");
  assert.equal(d.mirrorMatchesSnapshot, null);
  assert.equal(d.state, "unknown");
  assert.equal(describeSectionStores({ runtime: [A], host: [A], drift: false, snapshot: null }).state, "in-sync");
});

test("sections verify/sync commands and --stores flag are registered", () => {
  const p = buildProgram();
  assert.ok(sub(p, "sections", "verify"));
  const sync = sub(p, "sections", "sync");
  sync.parseOptions(["--auto", "--force", "--dry-run", "--yes"]);
  assert.deepEqual(sync.opts(), { auto: true, force: true, dryRun: true, yes: true });
  const list = sub(p, "sections", "list");
  list.parseOptions(["--stores"]);
  assert.equal(list.opts().stores, true);
});

test("sections sync: --dry-run wins over --auto/--yes; bare sync previews; --auto/--yes apply", () => {
  assert.equal(sectionsSyncMode({ auto: true, dryRun: true }), "preview");
  assert.equal(sectionsSyncMode({ yes: true, dryRun: true }), "preview");
  assert.equal(sectionsSyncMode({}), "preview");
  assert.equal(sectionsSyncMode({ auto: true }), "apply");
  assert.equal(sectionsSyncMode({ yes: true }), "apply");
});

// ---- sections sync --auto through the CLI (fake host + fake app store, temp snapshot file)
async function autoSyncWorld({ runtime: runtimeInit, host: hostInit, snapshot }) {
  const A = { id: "s1", name: "One", agentIds: ["a"] };
  const host = { sidebarSections: hostInit(A) };
  let stored = runtimeInit(A);
  const runtime = {
    sets: 0,
    getSidebarSections: async () => stored,
    setSidebarSections: async (sections) => ((runtime.sets += 1), (stored = sections)),
  };
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/api/setHostSettings")) Object.assign(host, JSON.parse(init.body));
    return { ok: true, status: 200, statusText: "ok", text: async () => JSON.stringify(host) };
  };
  const snapshotPath = join(mkdtempSync(join(tmpdir(), "grokbot-cli-snap-")), "sync.json");
  if (snapshot) writeFileSync(snapshotPath, JSON.stringify(snapshot(A)));
  setGatewayForTests(new Gateway({ baseUrl: "https://host", token: "T", headers: {} }, { fetchImpl, runtime, snapshotPath }));
  const run = async () => {
    const err = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    // Only swallow the CLI's own output; the test reporter writes through the same streams, asynchronously.
    process.stderr.write = (x, ...rest) => (/grokbot:/.test(String(x)) ? (err.push(String(x)), true) : origErr(x, ...rest));
    process.stdout.write = (x, ...rest) => (/^synced host mirror/.test(String(x)) ? true : origOut(x, ...rest));
    try {
      await buildProgram().parseAsync(["sections", "sync", "--auto"], { from: "user" });
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    return err.join("");
  };
  return { A, host, runtime, snapshotPath, run, stored: () => stored };
}
const keyOfList = (l) => JSON.stringify(l.map((x) => [x.id, x.name, x.agentIds ?? []]));

test("sections sync --auto pushes a pending host edit and records the snapshot file", async () => {
  const w = await autoSyncWorld({ runtime: (A) => [A], host: (A) => [A, { id: "s2", name: "Two", agentIds: [] }], snapshot: (A) => ({ at: "t", key: keyOfList([A]) }) });
  try {
    assert.equal(await w.run(), "");
    assert.equal(w.runtime.sets, 1);
    assert.equal(w.stored().length, 2);
    assert.equal(readSnapshotFile(w.snapshotPath).key, keyOfList(w.host.sidebarSections));
  } finally {
    setGatewayForTests(null);
  }
});

test("sections sync --auto bootstraps the snapshot file when both stores already agree", async () => {
  const w = await autoSyncWorld({ runtime: (A) => [A], host: (A) => [A] });
  try {
    assert.equal(await w.run(), "");
    assert.equal(w.runtime.sets, 0);
    assert.equal(readSnapshotFile(w.snapshotPath).key, keyOfList([w.A]));
  } finally {
    setGatewayForTests(null);
  }
});

test("sections sync --auto on a conflict keeps the app copy, logs once with a timestamp and diff, then stays silent", async () => {
  const w = await autoSyncWorld({
    runtime: (A) => [A, { id: "s2", name: "App only", agentIds: [] }],
    host: (A) => [{ ...A, name: "Host rename" }],
    snapshot: (A) => ({ at: "t", key: keyOfList([A]) }),
  });
  try {
    const first = await w.run();
    assert.match(first, /^\d{4}-\d\d-\d\dT[\d:.]+Z grokbot: sections sync --auto: conflict, kept the app copy/);
    assert.match(first, /Host rename|App only/, "the diff is in the log line");
    assert.equal(first.trim().split("\n")[0].includes("conflict"), true);
    assert.equal(w.runtime.sets, 0, "app store never written");
    assert.equal(await w.run(), "", "second run with the same conflict is silent");
    assert.equal(w.runtime.sets, 0);
  } finally {
    setGatewayForTests(null);
  }
});

async function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
}
const roster = [{ id: "11111111-1111-1111-1111-111111111111", name: "Alpha" }, { id: "22222222-2222-2222-2222-222222222222", name: "Beta" }];

test("0.79 command surface: todos/tasks/settings/search --agent exist; memories and --notify are gone", () => {
  const p = buildProgram();
  assert.ok(sub(p, "agents", "todos"));
  assert.ok(sub(p, "agents", "tasks").options.map((o) => o.long).includes("--done"));
  assert.ok(sub(p, "agents", "search").options.map((o) => o.long).includes("--agent"));
  assert.ok(sub(p, "cursor", "settings"));
  assert.equal(sub(p, "agents", "memories"), undefined, "getAgentMemories is a 404 on host 00b0aa1");
  assert.match(sub(p, "agents", "update").options.find((o) => o.long === "--notify").description, /removed in app 0\.79/, "--notify stays only to explain its removal");
  assert.ok(sub(p, "agents", "update").options.map((o) => o.long).includes("--notify-updates"));
  assert.ok(sub(p, "auto-review", "set").options.map((o) => o.long).includes("--list"));
});

test("agents todos/tasks under the agent policy read the host gateway only (never the control plane)", async () => {
  const calls = [];
  setGatewayForTests({
    listAgents: async () => roster,
    todos: async (id) => (calls.push(["todos", id]), [{ id: "t1", status: "TODO_STATUS_COMPLETED", content: "do it" }]),
    tasks: async (id) => (calls.push(["tasks", id]), []),
    asyncTasks: async (id) => (calls.push(["async", id]), []),
    subagents: async (id) => (calls.push(["sub", id]), []),
  });
  const io = captureIo();
  try {
    await withEnv({ GROKBOT_POLICY: "agent", GROKBOT_AUDIT_LOG: join(mkdtempSync(join(tmpdir(), "grokbot-aud-")), "a.jsonl") }, async () => {
      await buildProgram().parseAsync(["--json", "agents", "todos", "Alpha"], { from: "user" });
      await buildProgram().parseAsync(["--json", "agents", "tasks", "Beta"], { from: "user" });
    });
  } finally {
    io.restore();
    setGatewayForTests(null);
  }
  const [todos, tasks] = io.out.join("").split(/\n(?=\{)/).map((x) => JSON.parse(x));
  assert.equal(todos.source, "host");
  assert.deepEqual(todos.todos.map((t) => t.id), ["t1"]);
  assert.equal(tasks.source, "host");
  assert.deepEqual(calls, [["todos", roster[0].id], ["tasks", roster[1].id], ["async", roster[1].id], ["sub", roster[1].id]]);
});

test("agents todos as operator falls back to the host (with a note) when the control plane is unreachable", async () => {
  setGatewayForTests({ listAgents: async () => roster, todos: async () => [{ id: "h" }] });
  const io = captureIo();
  try {
    await withEnv({ GROKBOT_POLICY: "operator" }, () => buildProgram().parseAsync(["--json", "agents", "todos", "Alpha"], { from: "user" }));
  } finally {
    io.restore();
    setGatewayForTests(null);
  }
  assert.equal(JSON.parse(io.out.join("")).source, "host");
  assert.match(io.err.join(""), /control-plane read failed .*using the host gateway/);
});

test("pins add/remove/clear go through getPinned/setPinned; a host-only write says the app may not show it", async () => {
  let pins = [roster[0].id];
  const gw = {
    pinsHostOnly: false,
    listAgents: async () => roster,
    getPinned: async () => pins,
    setPinned: async (ids) => ((pins = ids), ids),
  };
  setGatewayForTests(gw);
  const io = captureIo();
  try {
    await buildProgram().parseAsync(["--json", "pins", "add", "Beta", "Alpha"], { from: "user" });
    assert.deepEqual(pins, [roster[0].id, roster[1].id], "already-pinned agents are not duplicated");
    assert.equal(io.err.join(""), "");
    gw.pinsHostOnly = true;
    await buildProgram().parseAsync(["--json", "pins", "remove", "Alpha"], { from: "user" });
    assert.deepEqual(pins, [roster[1].id]);
    assert.match(io.err.join(""), /host pins setting only .*0\.79\+ app reads pins from the Cursor runtime store/);
    assert.match(io.out.join(""), /"appVisible": false/);
    await assert.rejects(buildProgram().parseAsync(["pins", "clear"], { from: "user" }), /--yes/);
    assert.deepEqual(pins, [roster[1].id], "clear without --yes writes nothing");
    await buildProgram().parseAsync(["--json", "pins", "clear", "--yes"], { from: "user" });
    assert.deepEqual(pins, []);
  } finally {
    io.restore();
    setGatewayForTests(null);
  }
});

test("doctor resolves the host from a version-3 descriptor and reports a descriptor/Keychain failure separately from the host", async () => {
  const { createServer } = await import("node:http");
  const { mkdirSync, rmSync } = await import("node:fs");
  const crypto = await import("node:crypto");
  const { encryptSafeStorage } = await import("../src/session.js");
  const { descriptorPath, APP_SUPPORT } = await import("../src/session.js");
  const password = "doctor-test-password";
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ ok: true, pid: 7, isBusy: false, activeAgentId: null, startedAt: 1 }));
    if (req.url === "/api/getHostStatus") return res.end(JSON.stringify({ hostVersion: "00b0aa1", hostUpdateAvailable: false, capabilities: [] }));
    if (req.url === "/api/countAgents") return res.end("15");
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  mkdirSync(APP_SUPPORT, { recursive: true });
  const plain = JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "T", headers: { "x-anyrun-network-token": "n" } });
  const write = (blob) => writeFileSync(descriptorPath(), JSON.stringify({ version: 3, entries: { scope: { savedAtMs: Date.now(), encrypted: blob } } }));
  const run = async () => {
    const io = captureIo();
    try {
      await withEnv({ GROKBOT_SAFE_STORAGE_PASSWORD: password, GROKBOT_POLICY: "operator" }, () => buildProgram().parseAsync(["doctor"], { from: "user" }));
    } finally {
      io.restore();
    }
    return io.out.join("");
  };
  try {
    write(encryptSafeStorage(plain, key));
    const ok = await run();
    assert.match(ok, /^keychain +ok +descriptor v3, 1 entry, saved \d{4}-/m);
    assert.match(ok, new RegExp(`^host +127\\.0\\.0\\.1:${server.address().port} +ok=true busy=false version=00b0aa1 agents=15$`, "m"));
    assert.ok(!ok.includes("undefined"));
    // a descriptor that will not decrypt (wrong Keychain password / corrupted) is a keychain ERROR, not "no descriptor"
    write(encryptSafeStorage(plain, crypto.pbkdf2Sync("other", "saltysalt", 1003, 16, "sha1")));
    const bad = await run();
    assert.match(bad, /^keychain +ERROR /m);
    assert.match(bad, /^host +\S+ +ERROR /m, "the host line stays a labeled line, never 'host undefined'");
    assert.ok(!bad.includes("host       undefined"));
    // no descriptor file at all (the app removes it on some disconnects): not a Keychain error; the host resolves via EnsureSandBox or says why not
    rmSync(descriptorPath(), { force: true });
    const none = await run();
    assert.match(none, /^keychain +n\/a \(no gateway-descriptor\.json/m);
    assert.ok(!/^keychain +ERROR/m.test(none));
  } finally {
    rmSync(descriptorPath(), { force: true });
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------- review fixes (auto-review, runtime client, send, --notify)
async function autoReviewRig(initial) {
  const { createServer } = await import("node:http");
  let current = initial;
  const sets = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/api/setHostSettings") {
        const p = JSON.parse(body);
        sets.push(p);
        current = p.autoReviewInstructions ?? current;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ autoReviewInstructions: current }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setGatewayForTests(new Gateway({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "T", headers: {} }, { runtime: null }));
  const dir = mkdtempSync(join(tmpdir(), "grokbot-arrig-"));
  const auditFile = join(dir, "audit.jsonl");
  const io = captureIo();
  const run = (...args) => withEnv({ GROKBOT_POLICY: "operator", GROKBOT_AUDIT_LOG: auditFile }, () => buildProgram().parseAsync(args, { from: "user" }));
  const audit = () => (existsSync(auditFile) ? readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { run, sets, audit, io, close: async () => (io.restore(), setGatewayForTests(null), new Promise((r) => server.close(r))) };
}

test("auto-review never guesses isEnabled: unknown needs --enable, a stored false is preserved, a legacy string is refused", async () => {
  // unknown (nothing stored)
  let rig = await autoReviewRig({ allowInstructions: ["a"], blockInstructions: [] });
  try {
    await assert.rejects(rig.run("auto-review", "set", "x"), (e) => e instanceof UsageError && /--enable/.test(e.message));
    await assert.rejects(rig.run("auto-review", "append", "x"), (e) => e instanceof UsageError && /--enable/.test(e.message));
    assert.deepEqual(rig.sets, [], "nothing written without --enable");
    await rig.run("auto-review", "append", "--enable", "x");
    assert.deepEqual(rig.sets[0].autoReviewInstructions, { isEnabled: true, allowInstructions: ["a", "x"], blockInstructions: [] });
  } finally {
    await rig.close();
  }
  // stored false is kept, not flipped on
  rig = await autoReviewRig({ isEnabled: false, allowInstructions: ["a"], blockInstructions: ["b"] });
  try {
    await rig.run("auto-review", "set", "y");
    assert.equal(rig.sets[0].autoReviewInstructions.isEnabled, false);
    await rig.run("auto-review", "append", "--list", "block", "z");
    assert.equal(rig.sets[1].autoReviewInstructions.isEnabled, false);
    assert.deepEqual(rig.audit().map((r) => [r.path, r.list]), [["auto-review set", "allow"], ["auto-review append", "block"]], "the audit record names the list");
  } finally {
    await rig.close();
  }
  // legacy string form (pre-0.79 host): refuse to overwrite it, even with --enable
  rig = await autoReviewRig("old free-form rules");
  try {
    await assert.rejects(rig.run("auto-review", "set", "--enable", "x"), (e) => e instanceof UsageError && /legacy string form/.test(e.message));
    await assert.rejects(rig.run("auto-review", "append", "--enable", "x"), (e) => e instanceof UsageError && /legacy string form/.test(e.message));
    await assert.rejects(rig.run("auto-review", "set", "--clear"), /legacy string form/);
    assert.deepEqual(rig.sets, []);
    assert.deepEqual(rig.audit(), []);
  } finally {
    await rig.close();
  }
});

test("runtimeClientFor: an operator with a readable Cursor token gets a runtime client; the agent policy never does", async () => {
  const { APP_SUPPORT } = await import("../src/session.js");
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(APP_SUPPORT, { recursive: true });
  const secrets = join(APP_SUPPORT, "sand-secrets.json");
  const plain = (v) => "plaintext:v1:" + Buffer.from(v).toString("base64");
  writeFileSync(secrets, JSON.stringify({ "cursor-accounts": JSON.stringify({ active: "s1", accounts: { s1: { "cursor-access-token": plain("tok"), "cursor-account-profile": plain("{}") } } }) }));
  try {
    assert.ok(runtimeClientFor({}, { GROKBOT_POLICY: "operator" }), "operator: runtime client present");
    assert.equal(runtimeClientFor({}, { GROKBOT_POLICY: "agent" }), null, "agent policy: no Cursor token used for host-store writes");
  } finally {
    rmSync(secrets, { force: true });
  }
  assert.equal(runtimeClientFor({}, { GROKBOT_POLICY: "operator" }), null, "nobody signed in: null");
});

test("agents update --notify explains it was removed in app 0.79 and writes nothing", async () => {
  const calls = [];
  setGatewayForTests({ listAgents: async () => roster, updateAgent: async () => calls.push("update"), setNotifyOnUpdates: async () => calls.push("notify-updates") });
  const io = captureIo();
  try {
    await assert.rejects(buildProgram().parseAsync(["agents", "update", "Alpha", "--notify", "on"], { from: "user" }), (e) => e instanceof UsageError && /--notify was removed in app 0\.79.*--notify-updates/.test(e.message));
  } finally {
    io.restore();
    setGatewayForTests(null);
  }
  assert.deepEqual(calls, []);
});

test("sendMessage: operator sends through the control plane; no cursor client or agent policy uses the gateway; the host's 502 is explained", async () => {
  const agent = roster[0];
  const sent = [];
  const cursorClient = { sendUserMessage: async (id, text, o) => (sent.push([id, text, o.replyToId, typeof o.sentAtMs]), { dispatched: true, mode: "SEND_MODE_ACCEPTED_TEMPORAL", workflowId: "wf", messageId: "m-1" }) };
  let gwCalls = 0;
  const gw = { sendPrompt: async () => (gwCalls++, { accepted: true, clientNonce: "n", sentAt: 1 }) };
  const r = await withEnv({ GROKBOT_POLICY: "operator" }, () => sendMessage({}, gw, agent, "hi", { replyToId: "e1" }, { cursorClient }));
  assert.deepEqual(sent, [[agent.id, "hi", "e1", "number"]]);
  assert.deepEqual([r.via, r.dispatched, r.mode, r.messageId, gwCalls], ["control-plane", true, "ACCEPTED_TEMPORAL", "m-1", 0]);
  assert.equal(typeof r.sentAt, "number");

  // refusal / not dispatched is an error, never a quiet success
  const refused = { sendUserMessage: async () => ({ dispatched: false, refusal: "SEND_REFUSAL_PAUSED" }) };
  await assert.rejects(withEnv({ GROKBOT_POLICY: "operator" }, () => sendMessage({}, gw, agent, "hi", {}, { cursorClient: refused })), (e) => e.exitCode === 1 && /refused by the control plane/.test(e.message));

  // agent policy: gateway only, even when a control-plane client could be built
  const viaGw = await withEnv({ GROKBOT_POLICY: "agent" }, () => sendMessage({}, gw, agent, "hi", {}));
  assert.deepEqual([viaGw.via, viaGw.accepted, gwCalls], ["gateway", true, 1]);

  // the 0.79 host 502 for a non-box caller becomes a clear explanation
  const { GatewayError } = await import("../src/gateway.js");
  const gw502 = { sendPrompt: async () => { throw new GatewayError("sendPrompt failed: 502 A Sand box session may not make this request on this endpoint", { status: 502 }); } };
  await assert.rejects(withEnv({ GROKBOT_POLICY: "agent" }, () => sendMessage({}, gw502, agent, "hi", {})), (e) => e.exitCode === 1 && /502/.test(e.message) && /only accepts sendPrompt from a session it considers the agent's own/.test(e.message) && /operator can send from the Mac/.test(e.message));
  // other gateway errors pass through untouched
  const gw500 = { sendPrompt: async () => { throw new GatewayError("sendPrompt failed: 500 boom", { status: 500 }); } };
  await assert.rejects(withEnv({ GROKBOT_POLICY: "agent" }, () => sendMessage({}, gw500, agent, "hi", {})), /500 boom$/);
});

test("agents send --wait through the control plane polls the roster and prints the transcript tail", async () => {
  const sent = [];
  setCursorForTests({ sendUserMessage: async (id, text) => (sent.push([id, text]), { dispatched: true, mode: "SEND_MODE_ACCEPTED_TEMPORAL", messageId: "m" }) });
  let polls = 0;
  setGatewayForTests({
    listAgents: async () => (polls++ === 0 ? roster : roster.map((a) => ({ ...a, isRunningTurn: polls === 2 }))),
    transcriptTail: async () => ({ entries: [{ kind: "send-message", message: { type: "text", content: "pong" }, timestampMs: 1 }] }),
    sendPrompt: async () => assert.fail("operator send must not touch sendPrompt"),
  });
  const io = captureIo();
  try {
    await withEnv({ GROKBOT_POLICY: "operator" }, () => buildProgram().parseAsync(["--json", "agents", "send", "Alpha", "hello", "there", "--wait", "--timeout", "30"], { from: "user" }));
  } finally {
    io.restore();
    setGatewayForTests(null);
    setCursorForTests(null);
  }
  assert.deepEqual(sent, [[roster[0].id, "hello there"]]);
  const res = JSON.parse(io.out.join(""));
  assert.equal(res.sent.via, "control-plane");
  assert.equal(res.tail.length, 1);
  assert.ok(polls >= 3, "polled until the agent was seen running and then idle");
});

// ---- agents delete (control-plane DeleteGrokBotAgent + verify) and the stale host roster mark
const AID1 = roster[0].id;
const AID2 = roster[1].id;
/** Mocked control plane + host: no network. `cpAgents` is mutated by deleteAgent unless `keep` lists ids that survive the RPC. */
function deleteHarness({ keep = [], cpFails = false, hostDeleteFails = false, rpcFail = {}, truncated = false, emptyList = false, rosterOverride } = {}) {
  const log = { cursor: [], host: [] };
  const cpAgents = roster.map((a) => ({ id: "n-" + a.name, agentId: a.id, name: a.name }));
  const cursorClient = {
    deleteAgent: async (id) => {
      log.cursor.push(["deleteAgent", id]);
      if (rpcFail[id]) throw Object.assign(new Error(`DeleteGrokBotAgent failed: ${rpcFail[id]}`), { status: rpcFail[id] });
      if (!keep.includes(id)) cpAgents.splice(cpAgents.findIndex((a) => a.agentId === id), 1);
      return {};
    },
    listAgents: async (a) => {
      log.cursor.push(["listAgents"]);
      if (cpFails) throw new Error("boom");
      log.cursor.push(["listArgs", Boolean(a?.signal)]);
      return { agents: emptyList ? [] : [...cpAgents], slackConnections: [], truncated };
    },
  };
  const sections = [{ id: "s1", name: "Swarm", agentIds: [AID1] }];
  const gw = {
    listAgents: async () => rosterOverride ?? roster,
    getSections: async () => sections,
    setSections: async (s) => log.host.push(["setSections", s]),
    deleteAgents: async (ids) => {
      log.host.push(["deleteAgents", ids]);
      if (hostDeleteFails) throw new Error("host 502");
    },
  };
  return { log, cursorClient, gw };
}
async function runCli(env, argv) {
  const io = captureIo();
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  let exit;
  let error;
  try {
    await withEnv({ GROKBOT_AUDIT_LOG: join(mkdtempSync(join(tmpdir(), "grokbot-aud-")), "a.jsonl"), ...env }, () => buildProgram().parseAsync(argv, { from: "user" }));
  } catch (e) {
    error = e;
  } finally {
    exit = process.exitCode;
    process.exitCode = prevExit;
    io.restore();
    setGatewayForTests(null);
    setCursorForTests(null);
  }
  return { out: io.out.join(""), err: io.err.join(""), exit, error };
}

test("agents delete (operator): DeleteGrokBotAgent per target, re-reads ListGrokBotAgents, reports deleted only when gone, then mirrors on the host", async () => {
  const h = deleteHarness();
  setGatewayForTests(h.gw);
  setCursorForTests(h.cursorClient);
  const r = await runCli({ GROKBOT_POLICY: "operator" }, ["--json", "agents", "delete", "Alpha", "--yes"]);
  assert.equal(r.error, undefined);
  assert.equal(r.exit, undefined, "exit stays 0");
  assert.deepEqual(h.log.cursor.filter((x) => x[0] !== "listArgs"), [["deleteAgent", AID1], ["listAgents"]], "RPC first, verification read after");
  const res = JSON.parse(r.out);
  assert.equal(res.ok, true);
  assert.deepEqual(res.deleted, [AID1]);
  assert.deepEqual(res.stillPresent, []);
  assert.equal(res.hostMirror.removed, true);
  assert.deepEqual(h.log.host.map((x) => x[0]), ["deleteAgents", "setSections"], "host mirror removal + section membership dropped");
  assert.deepEqual(h.log.host[0][1], [AID1]);
});

test("agents delete (operator): an agent still listed after the RPC is 'still present' and exits 1; the host mirror is left alone", async () => {
  const h = deleteHarness({ keep: [AID2] });
  setGatewayForTests(h.gw);
  setCursorForTests(h.cursorClient);
  const r = await runCli({ GROKBOT_POLICY: "operator" }, ["agents", "delete", "Alpha", "Beta", "--yes", "--confirm-count", "2", "--allow-empty"]);
  assert.equal(r.exit, 1);
  assert.match(r.out, /deleted 1\/2/);
  assert.match(r.out, /still present: Beta/);
  assert.deepEqual(h.log.host.find((x) => x[0] === "deleteAgents")[1], [AID1], "only the verified-gone id is mirrored");

  // a failed verification read is an error, not a success
  const h2 = deleteHarness({ cpFails: true });
  setGatewayForTests(h2.gw);
  setCursorForTests(h2.cursorClient);
  const r2 = await runCli({ GROKBOT_POLICY: "operator" }, ["agents", "delete", "Alpha", "--yes"]);
  assert.equal(r2.error?.exitCode, 1);
  assert.match(r2.error.message, /could not verify/);
  assert.deepEqual(h2.log.host, [], "nothing mirrored when unverified");

  // a failing host mirror is a note, never a failed delete
  const h3 = deleteHarness({ hostDeleteFails: true });
  setGatewayForTests(h3.gw);
  setCursorForTests(h3.cursorClient);
  const r3 = await runCli({ GROKBOT_POLICY: "operator" }, ["agents", "delete", "Alpha", "--yes"]);
  assert.equal(r3.exit, undefined);
  assert.match(r3.out, /deleted 1\/1/);
  assert.match(r3.out, /host mirror: not removed \(host 502\)/);
});

test("agents delete: the --yes gate and target printing still come first, and nothing is sent without them", async () => {
  const h = deleteHarness();
  setGatewayForTests(h.gw);
  setCursorForTests(h.cursorClient);
  const r = await runCli({ GROKBOT_POLICY: "operator" }, ["agents", "delete", "Alpha"]);
  assert.equal(r.error?.exitCode, 3);
  assert.match(r.out, /Alpha/, "targets printed");
  assert.deepEqual(h.log.cursor, []);
});

test("agents delete under the agent policy refuses (needs the owner's Cursor sign-in) and sends nothing, even with a Cursor client around", async () => {
  const h = deleteHarness();
  setGatewayForTests(h.gw);
  setCursorForTests(h.cursorClient);
  const r = await runCli({ GROKBOT_POLICY: "agent" }, ["agents", "delete", "Alpha", "--yes"]);
  assert.equal(r.error?.exitCode, 77);
  assert.match(r.error.message, /owner's Cursor sign-in/);
  assert.deepEqual(h.log.cursor, []);
  assert.deepEqual(h.log.host, [], "no host deleteAgents either (it silently does nothing)");
});

test("agents list marks host-roster agents the control plane no longer lists as (deleted?); agent policy and an empty read mark nothing", async () => {
  const cp = (agentIds) => ({ listAgents: async () => ({ agents: agentIds.map((agentId) => ({ agentId })), slackConnections: [] }) });
  const gw = { listAgents: async () => roster, getSections: async () => [] };

  setGatewayForTests(gw);
  setCursorForTests(cp([AID2]));
  const r = await runCli({ GROKBOT_POLICY: "operator" }, ["--json", "agents", "list"]);
  const rows = JSON.parse(r.out);
  assert.deepEqual(Object.fromEntries(rows.map((a) => [a.name, Boolean(a.deletedOnControlPlane)])), { Alpha: true, Beta: false });
  setGatewayForTests(gw);
  setCursorForTests(cp([AID2]));
  const human = await runCli({ GROKBOT_POLICY: "operator" }, ["agents", "list"]);
  assert.match(human.out, /Alpha.*\(deleted\?\)/);
  assert.doesNotMatch(human.out, /Beta.*\(deleted\?\)/);

  for (const [env, client] of [[{ GROKBOT_POLICY: "agent" }, cp([AID2])], [{ GROKBOT_POLICY: "operator" }, cp([])]]) {
    setGatewayForTests(gw);
    setCursorForTests(client);
    const x = await runCli(env, ["--json", "agents", "list"]);
    assert.ok(JSON.parse(x.out).every((a) => !a.deletedOnControlPlane), JSON.stringify(env));
  }
});

test("agents delete: an empty or truncated control-plane read is unverified (exit 1, nothing mirrored); an RPC failure is never counted as deleted", async () => {
  for (const [label, opts, re] of [["empty", { emptyList: true }, /returned no agents/], ["truncated", { truncated: true }, /truncated/]]) {
    const h = deleteHarness(opts);
    setGatewayForTests(h.gw);
    setCursorForTests(h.cursorClient);
    const r = await runCli({ GROKBOT_POLICY: "operator" }, ["agents", "delete", "Alpha", "--yes"]);
    assert.equal(r.error?.exitCode, 1, label);
    assert.match(r.error.message, re, label);
    assert.deepEqual(h.log.host, [], `${label}: no host mirror or section change`);
  }

  // Alpha's RPC fails but Beta stays listed (a live, non-empty read): Alpha is absent from the list yet must not count as deleted.
  const h = deleteHarness();
  h.cursorClient.deleteAgent = async () => { throw Object.assign(new Error("DeleteGrokBotAgent failed: 500"), { status: 500 }); };
  h.cursorClient.listAgents = async () => ({ agents: [{ agentId: AID2 }], slackConnections: [], truncated: false });
  setGatewayForTests(h.gw);
  setCursorForTests(h.cursorClient);
  const r = await runCli({ GROKBOT_POLICY: "operator" }, ["--json", "agents", "delete", "Alpha", "--yes"]);
  assert.equal(r.exit, 1);
  const res = JSON.parse(r.out);
  assert.deepEqual(res.deleted, []);
  assert.equal(res.failed[0].id, AID1);
  assert.deepEqual(h.log.host, [], "a failed RPC is not mirrored or removed from sections");
});

test("agents delete stops the loop on 401/403/429 and counts the rest as not attempted", async () => {
  const h = deleteHarness({ rpcFail: { [AID1]: 429 } });
  setGatewayForTests(h.gw);
  setCursorForTests(h.cursorClient);
  const r = await runCli({ GROKBOT_POLICY: "operator" }, ["--json", "agents", "delete", "Alpha", "Beta", "--yes", "--confirm-count", "2", "--allow-empty"]);
  assert.deepEqual(h.log.cursor.filter((x) => x[0] === "deleteAgent"), [["deleteAgent", AID1]], "Beta was never attempted");
  assert.equal(r.exit, 1);
  const res = JSON.parse(r.out);
  assert.deepEqual(res.deleted, []);
  assert.match(res.stillPresent.find((f) => f.id === AID2).error, /not attempted/);
});

test("agents delete needs --allow-empty when it would remove every roster agent, and sends nothing without it", async () => {
  const h = deleteHarness();
  setGatewayForTests(h.gw);
  setCursorForTests(h.cursorClient);
  const r = await runCli({ GROKBOT_POLICY: "operator" }, ["agents", "delete", "Alpha", "Beta", "--yes", "--confirm-count", "2"]);
  assert.equal(r.error?.exitCode, 3);
  assert.match(r.error.message, /--allow-empty/);
  assert.deepEqual(h.log.cursor, []);
});

test("agents list marks only from a complete, non-empty control-plane read, and the read carries an abort signal", async () => {
  const gw = { listAgents: async () => roster, getSections: async () => [] };
  const seen = [];
  const cp = (o) => ({ listAgents: async (a) => (seen.push(Boolean(a?.signal)), { agents: [{ agentId: AID2 }], slackConnections: [], ...o }) });
  setGatewayForTests(gw);
  setCursorForTests(cp({}));
  const ok = JSON.parse((await runCli({ GROKBOT_POLICY: "operator" }, ["--json", "agents", "list"])).out);
  assert.ok(ok.find((a) => a.name === "Alpha").deletedOnControlPlane);
  assert.deepEqual(seen, [true], "agents list passes an AbortSignal timeout");
  setGatewayForTests(gw);
  setCursorForTests(cp({ truncated: true }));
  const trunc = JSON.parse((await runCli({ GROKBOT_POLICY: "operator" }, ["--json", "agents", "list"])).out);
  assert.ok(trunc.every((a) => !a.deletedOnControlPlane), "truncated read: no marks");
});
