// Execution policy. Two modes:
//   operator (default on a Mac)  — everything allowed; destructive commands still need --yes gates.
//   agent    (default inside a box, or GROKBOT_POLICY=agent) — a Grok Bot agent is driving. It may
//            organize (create/rename/hide/delete agents, sections, pins, send, tail, list) but may
//            not reach below the host gateway (gw/cursor/cdp/app). Deletes still need --yes /
//            --confirm-count. Group membership replace is allowed. Audited.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { boxGatewaySession, isInsideBox, redactValue } from "./session.js";
import { UsageError } from "./output.js";

export const DENIED_FOR_AGENTS = [
  // agents/sections delete + groups members are ALLOWED under agent policy (decided 2026-09-15).
  // Deletes still need --yes / --confirm-count. Keep low-level surfaces denied.
  "agents duplicate",
  "agents interrupt",
  "sections import",
  "pins clear",
  "settings set",
  "gw",
  "cursor",
  "cdp",
  "app",
  "automations",
];

export function resolvePolicy(env = process.env) {
  // Inside its own box the agent fully controls its own process environment, so a bare
  // GROKBOT_POLICY=operator env var must never be enough to self-escalate out of the agent
  // policy — that would make the entire denylist and audit trail an opt-out. Forcing the
  // *more* restrictive agent policy from outside a box (e.g. for tests) is still honored;
  // only a downgrade to operator while actually inside a box is refused.
  if (isInsideBox(env)) return "agent";
  const explicit = (env.GROKBOT_POLICY || "").toLowerCase();
  if (explicit === "agent" || explicit === "operator") return explicit;
  return "operator";
}

/** Dotted command path from a commander command, e.g. "agents delete". */
export function commandPath(cmd) {
  const names = [];
  let c = cmd;
  while (c && c.parent) {
    names.unshift(c.name());
    c = c.parent;
  }
  return names.join(" ");
}

export function isDenied(path, policy) {
  if (policy !== "agent") return false;
  return DENIED_FOR_AGENTS.some((d) => path === d || path.startsWith(d + " "));
}

export function auditPath(env = process.env) {
  // When actually inside a box, pin the audit log next to the real gateway.json the host
  // itself wrote — never to a path the agent's own env can redirect. GROKBOT_AUDIT_LOG (and
  // SAND_DATA_ROOT-derived paths) are only honored off-box, where they are a deliberate
  // testing/operator surface rather than a self-tamper vector.
  const box = boxGatewaySession(env);
  if (box) return join(dirname(box.path), "grokbot-audit.jsonl");
  if (env.GROKBOT_AUDIT_LOG) return env.GROKBOT_AUDIT_LOG;
  return join(homedir(), ".grokbot", "grokbot-audit.jsonl");
}

export function audit(record, env = process.env) {
  try {
    const p = auditPath(env);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    // redactValue walks arrays/objects recursively, so this also scrubs Bearer/JWT-shaped
    // strings and secret-looking keys anywhere inside argv, not just at the top level.
    appendFileSync(p, JSON.stringify(redactValue({ ts: new Date().toISOString(), ...record })) + "\n", { mode: 0o600 });
  } catch {
    // auditing must never break the command
  }
}

/** Enforce policy for a command about to run. Throws UsageError when denied. */
export function enforce(cmd, argv, env = process.env) {
  const policy = resolvePolicy(env);
  const path = commandPath(cmd);
  if (isDenied(path, policy)) {
    audit({ policy, path, argv, decision: "denied" }, env);
    const err = new UsageError(
      `"${path}" is not available under the agent policy. Agents may organize and delete agents/sections (with --yes gates) but not reach below the host gateway (gw/cursor/cdp/app). A human runs denied commands from the Mac with GROKBOT_POLICY=operator.`,
    );
    err.exitCode = 77;
    throw err;
  }
  if (policy === "agent") audit({ policy, path, argv, decision: "allowed" }, env);
  return policy;
}
