import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildProgram, confirmDestructive, hasSelectionFlags, selectionFromOpts } from "../src/cli.js";
import { UsageError } from "../src/output.js";

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
  const outBuf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => (outBuf.push(String(s)), true);
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
    process.stdout.write = orig;
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

test("auto-review set/append/get write only {autoReviewInstructions} through the gateway", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  // (existsSync/readFileSync/createHash are imported statically above)
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  let current = "old rule";
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
  const keys = ["GROKBOT_GATEWAY_URL", "GROKBOT_GATEWAY_TOKEN", "GROKBOT_POLICY", "GROKBOT_AUDIT_LOG"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GROKBOT_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GROKBOT_GATEWAY_TOKEN = "T";
  process.env.GROKBOT_POLICY = "operator"; // audit records must still be written under operator
  process.env.GROKBOT_AUDIT_LOG = auditFile;
  const outBuf = [];
  const errBuf = [];
  const orig = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => (outBuf.push(String(s)), true);
  process.stderr.write = (s) => (errBuf.push(String(s)), true);
  const runCli = (...args) => buildProgram().parseAsync(args, { from: "user" });
  const sets = () => calls.filter((c) => c.url === "/api/setHostSettings").map((c) => c.body);
  const auditRecords = () => (existsSync(auditFile) ? readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  try {
    await runCli("auto-review", "set", "x");
    assert.deepEqual(sets(), [{ autoReviewInstructions: "x" }], "set writes exactly one key");
    assert.ok(errBuf.join("").includes("previous auto-review instructions length: 8"), "previous length goes to stderr");
    const rec = auditRecords();
    assert.equal(rec.length, 1);
    assert.equal(rec[0].path, "auto-review set");
    assert.equal(rec[0].length, 1);
    assert.equal(rec[0].sha256, createHash("sha256").update("x").digest("hex"));
    assert.ok(!JSON.stringify(rec[0]).includes('"x"'), "audit never stores the value itself");

    const file = join(dir, "rules.md");
    writeFileSync(file, "from file\n");
    calls.length = 0;
    await runCli("auto-review", "set", "--file", file);
    assert.deepEqual(sets(), [{ autoReviewInstructions: "from file\n" }]);

    calls.length = 0;
    await runCli("auto-review", "append", "second");
    assert.deepEqual(sets(), [{ autoReviewInstructions: "from file\nsecond" }]);
    const appendRec = auditRecords().at(-1);
    assert.equal(appendRec.path, "auto-review append");
    assert.equal(appendRec.length, "from file\nsecond".length);
    assert.equal(appendRec.sha256, createHash("sha256").update("from file\nsecond").digest("hex"));

    // duplicate last line is a no-op: no write, no audit record
    calls.length = 0;
    const before = auditRecords().length;
    await runCli("auto-review", "append", "second");
    assert.deepEqual(sets(), [], "appending the existing last line writes nothing");
    assert.equal(auditRecords().length, before);

    outBuf.length = 0;
    await runCli("auto-review", "get");
    assert.equal(outBuf.join(""), "from file\nsecond\n");

    // empty / whitespace-only values are rejected from every source unless --clear
    calls.length = 0;
    const blank = join(dir, "blank.md");
    writeFileSync(blank, "  \n\t\n");
    await assert.rejects(runCli("auto-review", "set", ""), (e) => e instanceof UsageError && /empty/.test(e.message));
    await assert.rejects(runCli("auto-review", "set", "   "), (e) => e instanceof UsageError && /--clear/.test(e.message));
    await assert.rejects(runCli("auto-review", "set", "--file", blank), (e) => e instanceof UsageError && /--clear/.test(e.message));
    await assert.rejects(runCli("auto-review", "append", "  "), (e) => e instanceof UsageError);
    await assert.rejects(runCli("auto-review", "set"), /exactly one source/);
    await assert.rejects(runCli("auto-review", "set", "x", "--file", file), /exactly one source/);
    await assert.rejects(runCli("auto-review", "set", "x", "--clear"), /--clear takes no/);
    assert.equal(calls.length, 0, "usage errors never reach the gateway");

    // --clear with no source sets ""
    await runCli("auto-review", "set", "--clear");
    assert.deepEqual(sets(), [{ autoReviewInstructions: "" }]);
    const clearRec = auditRecords().at(-1);
    assert.equal(clearRec.length, 0);
    assert.equal(clearRec.sha256, createHash("sha256").update("").digest("hex"));
  } finally {
    process.stdout.write = orig;
    process.stderr.write = origErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
  }
});
