import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgram, confirmDestructive, hasSelectionFlags, selectionFromOpts } from "../src/cli.js";

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
