import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DENIED_FOR_AGENTS, audit, auditPath, commandPath, enforce, isDenied, resolvePolicy } from "../src/policy.js";
import { boxGatewaySession } from "../src/session.js";
import { buildProgram } from "../src/cli.js";

/** Write a fake host gateway.json and return an env that makes isInsideBox(env)/boxGatewaySession(env) find it. */
function fakeBoxEnv(dir) {
  const p = join(dir, "gateway.json");
  writeFileSync(p, JSON.stringify({ scheme: "http", host: "0.0.0.0", port: 1340, token: "T", pid: 1, startedAt: 1 }));
  return { path: p, env: { GROKBOT_BOX_GATEWAY_JSON: p } };
}

function sub(program, ...path) {
  let c = program;
  for (const name of path) c = c.commands.find((x) => x.name() === name || x.aliases().includes(name));
  return c;
}

test("resolvePolicy: explicit env wins, otherwise operator off-box", () => {
  assert.equal(resolvePolicy({ GROKBOT_POLICY: "agent" }), "agent");
  assert.equal(resolvePolicy({ GROKBOT_POLICY: "OPERATOR" }), "operator");
  assert.equal(resolvePolicy({}), boxGatewaySession() ? "agent" : "operator");
});

test("isDenied matches whole command families under agent policy only", () => {
  assert.equal(isDenied("agents delete", "agent"), false, "agents delete is allowed for box agents");
  assert.equal(isDenied("agents interrupt", "agent"), true);
  assert.equal(isDenied("agents interruption-log", "agent"), false, "prefix must be a whole word");
  assert.equal(isDenied("cursor rpc", "agent"), true);
  assert.equal(isDenied("sections move", "agent"), false);
  assert.equal(isDenied("sections delete", "agent"), false, "sections delete is allowed for box agents");
  assert.equal(isDenied("agents interrupt", "operator"), false);
  for (const d of DENIED_FOR_AGENTS) assert.ok(d.length > 1);
});

test("commandPath + enforce deny with exit 77 and audit both outcomes", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-policy-"));
  const env = { GROKBOT_POLICY: "agent", GROKBOT_AUDIT_LOG: join(dir, "audit.jsonl") };
  const p = buildProgram();
  const intr = sub(p, "agents", "interrupt");
  assert.equal(commandPath(intr), "agents interrupt");
  assert.throws(() => enforce(intr, ["agents", "interrupt", "x"], env), (e) => e.exitCode === 77 && /agent policy/.test(e.message));
  const del = sub(p, "agents", "delete");
  assert.equal(commandPath(del), "agents delete");
  assert.equal(enforce(del, ["agents", "delete", "x", "--yes"], env), "agent", "agents delete allowed under agent");
  const move = sub(p, "sections", "move");
  assert.equal(enforce(move, ["sections", "move", "S", "a"], env), "agent");
  const lines = readFileSync(env.GROKBOT_AUDIT_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.path, l.decision]), [["agents interrupt", "denied"], ["agents delete", "allowed"], ["sections move", "allowed"]]);
  assert.equal(enforce(intr, [], { GROKBOT_POLICY: "operator", GROKBOT_AUDIT_LOG: join(dir, "op.jsonl") }), "operator");
  assert.equal(existsSync(join(dir, "op.jsonl")), false, "operator runs are not audited");
  assert.equal(auditPath({ GROKBOT_AUDIT_LOG: "/x/y.jsonl" }), "/x/y.jsonl");
});

test("auto-review is allowed under agent policy while raw settings set stays denied", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-policy-"));
  const env = { GROKBOT_POLICY: "agent", GROKBOT_AUDIT_LOG: join(dir, "audit.jsonl") };
  const p = buildProgram();
  for (const name of ["get", "set", "append"]) {
    const c = sub(p, "auto-review", name);
    assert.equal(commandPath(c), `auto-review ${name}`);
    assert.equal(isDenied(commandPath(c), "agent"), false);
    assert.equal(enforce(c, ["auto-review", name], env), "agent");
  }
  assert.equal(isDenied("settings set", "agent"), true);
  assert.throws(() => enforce(sub(p, "settings", "set"), ["settings", "set", "k", "1"], env), (e) => e.exitCode === 77);
  const lines = readFileSync(env.GROKBOT_AUDIT_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.path, l.decision]), [["auto-review get", "allowed"], ["auto-review set", "allowed"], ["auto-review append", "allowed"], ["settings set", "denied"]]);
});

test("boxGatewaySession reads the host's gateway.json and talks to loopback", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-box-"));
  const p = join(dir, "gateway.json");
  writeFileSync(p, JSON.stringify({ scheme: "http", host: "0.0.0.0", port: 1340, token: "T", pid: 1, startedAt: 1 }));
  const s = boxGatewaySession({ GROKBOT_BOX_GATEWAY_JSON: p });
  assert.equal(s.source, "box");
  assert.equal(s.baseUrl, "http://127.0.0.1:1340");
  assert.equal(s.token, "T");
  assert.equal(s.path, p);
});

test("resolvePolicy: a real box cannot be downgraded to operator via env", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-box-"));
  const { env: boxEnv } = fakeBoxEnv(dir);
  // Off-box, the explicit env is honored either way.
  assert.equal(resolvePolicy({ GROKBOT_POLICY: "operator" }), "operator");
  // Inside a real box, GROKBOT_POLICY=operator is a pure self-declaration and must not win.
  assert.equal(resolvePolicy({ ...boxEnv, GROKBOT_POLICY: "operator" }), "agent");
  assert.equal(resolvePolicy(boxEnv), "agent");
});

test("auditPath: inside a real box the log is pinned next to gateway.json, ignoring GROKBOT_AUDIT_LOG", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-box-"));
  const { path: gatewayPath, env: boxEnv } = fakeBoxEnv(dir);
  const attackerPath = join(mkdtempSync(join(tmpdir(), "grokbot-attacker-")), "audit.jsonl");
  assert.equal(auditPath({ ...boxEnv, GROKBOT_AUDIT_LOG: attackerPath }), join(dir, "grokbot-audit.jsonl"));
  assert.notEqual(auditPath({ ...boxEnv, GROKBOT_AUDIT_LOG: attackerPath }), attackerPath);
  assert.ok(gatewayPath.startsWith(dir));
});

test("audit: redacts secret-shaped values before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-policy-"));
  const env = { GROKBOT_AUDIT_LOG: join(dir, "audit.jsonl") };
  audit({ policy: "agent", path: "agents send", argv: ["agents", "send", "x", "Bearer sk-secret-abc123"], decision: "allowed" }, env);
  const raw = readFileSync(env.GROKBOT_AUDIT_LOG, "utf8");
  assert.ok(!raw.includes("sk-secret-abc123"), "raw bearer token must not appear in the audit log");
  assert.ok(raw.includes("<redacted>"));
});
