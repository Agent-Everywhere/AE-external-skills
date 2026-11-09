// Routines (a.k.a. automations): read-only listing + markdown export.
// Routines of server-hosted ("temporal") agents live on the Cursor control plane, not on the box
// gateway (whose listAllAutomations returns [] for them). Reads only; no create/update/run/webhook
// credential calls, and nothing here ever contacts a Grok agent.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./output.js";

const iso = (ms) => (ms && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);
const ACCOUNT_CHUNK = 50;

// Allowlisted trigger leaf fields (real shapes seen: cron {schedule, timing?, window?}, webhook {}).
// Anything else (firesAt, urls, credentials, unknown future fields) is dropped, not copied.
const LEAF_FIELDS = ["type", "schedule", "cron", "timezone", "timing", "event", "eventName"];
const WINDOW_FIELDS = ["earlyMinutes", "lateMinutes"];
const isPrimitive = (v) => ["string", "number", "boolean"].includes(typeof v);

/** Flatten a (possibly nested "group") trigger into allowlisted leaf triggers: [{type, schedule?, timing?, window?}]. */
export function flattenTrigger(trigger) {
  if (!trigger || typeof trigger !== "object") return [];
  if (Array.isArray(trigger.listeners)) return trigger.listeners.flatMap(flattenTrigger);
  const leaf = {};
  for (const k of LEAF_FIELDS) if (isPrimitive(trigger[k])) leaf[k] = trigger[k];
  if (trigger.window && typeof trigger.window === "object") {
    const w = {};
    for (const k of WINDOW_FIELDS) if (typeof trigger.window[k] === "number") w[k] = trigger.window[k];
    if (Object.keys(w).length) leaf.window = w;
  }
  return [leaf];
}

/** Normalize one routine record (the parsed recordJson / box automation object). Prompt is kept verbatim. */
export function normalizeRecord(agent, automationId, rec) {
  const triggers = flattenTrigger(rec.trigger);
  const lastRun = Array.isArray(rec.runs) && rec.runs.length > 0 ? rec.runs[rec.runs.length - 1] : null;
  return {
    agentId: agent.agentId,
    agentName: agent.name ?? null,
    automationId: automationId ?? rec.id ?? null,
    name: rec.name ?? rec.id ?? null,
    enabled: rec.isEnabled !== false,
    trigger: rec.trigger?.type ?? triggers[0]?.type ?? null,
    triggers,
    schedule: typeof rec.schedule === "string" ? rec.schedule : (triggers.find((t) => t.schedule)?.schedule ?? null),
    triggerDescription: typeof rec.triggerDescription === "string" ? rec.triggerDescription : null,
    prompt: typeof rec.prompt === "string" ? rec.prompt : "",
    provenance: rec.provenance ?? null,
    createdAt: iso(rec.createdAt),
    lastRunAt: iso(rec.lastRunAt),
    lastRunStatus: lastRun?.status ?? null,
    nextRunAt: iso(rec.nextRunAt),
  };
}

/** Normalize a control-plane row ({automationId, recordJson}); throws on malformed recordJson. */
export function normalizeRoutine(agent, row) {
  const rec = typeof row.recordJson === "string" ? JSON.parse(row.recordJson) : row.recordJson;
  if (!rec || typeof rec !== "object") throw new Error("recordJson is not an object");
  return normalizeRecord(agent, row.automationId, rec);
}

function stubRoutine(agent, row, err) {
  return { agentId: agent.agentId, agentName: agent.name ?? null, automationId: row?.automationId ?? null, name: null, enabled: null, trigger: null, triggers: [], schedule: null, prompt: "", malformed: true, error: String(err?.message ?? err), raw: row };
}

/** Match --agent <ref>: full/prefix uuid, control-plane id, or case-insensitive name substring. */
export function matchAgents(agents, ref) {
  if (!ref) return agents;
  const r = String(ref).toLowerCase();
  const exact = agents.filter((a) => a.agentId?.toLowerCase() === r || String(a.id) === r || a.name?.toLowerCase() === r);
  if (exact.length) return exact;
  const found = agents.filter((a) => a.agentId?.toLowerCase().startsWith(r) || a.name?.toLowerCase().includes(r));
  if (found.length === 0) throw new UsageError(`No agent matches "${ref}".`);
  return found;
}

const dedupeAgents = (agents) => [...new Map(agents.filter((a) => a.agentId).map((a) => [a.agentId, a])).values()];
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * List routines for every (or the matched) agent. `cursor` is a CursorClient (server-hosted agents);
 * optional `gateway` is a Gateway (box-hosted agents), merged in and deduped by agentId+automationId.
 * Malformed rows become stub entries ({malformed, error, raw}) and are reported via `errors`.
 * Returns {routines, agents:[{agentId, name, count}], errors:[string]}.
 */
export async function listRoutines(cursor, { agent, gateway, warn = (m) => process.stderr.write(m + "\n") } = {}) {
  const universe = dedupeAgents((await cursor.listAgents()).agents);
  const serverIds = new Set(universe.map((a) => a.agentId));

  let gwRows = [];
  if (gateway) {
    try {
      const r = await gateway.listAutomations();
      gwRows = Array.isArray(r) ? r.filter((x) => x?.agentId && x.automation && typeof x.automation === "object") : [];
      if (gwRows.some((x) => !serverIds.has(x.agentId))) {
        const names = new Map();
        try {
          for (const a of await gateway.listAgents()) names.set(a.id, a.name);
        } catch {
          // names are cosmetic
        }
        for (const id of new Set(gwRows.map((x) => x.agentId))) if (!serverIds.has(id)) universe.push({ agentId: id, name: names.get(id) ?? null });
      }
    } catch (e) {
      warn(`grokbot: gateway automations unavailable, using control plane only: ${e.message}`);
    }
  }

  const agents = matchAgents(universe, agent);
  const errors = [];
  const routines = [];
  const perAgent = [];
  const seen = new Set();
  const push = (a, row, make) => {
    let entry;
    try {
      entry = make();
    } catch (e) {
      entry = stubRoutine(a, row, e);
      const msg = `malformed routine ${row?.automationId ?? "(no id)"} for agent ${a.name ?? a.agentId}: ${entry.error}`;
      errors.push(msg);
      warn(`grokbot: ${msg}`);
    }
    const key = `${a.agentId}:${entry.automationId ?? JSON.stringify(row)}`;
    if (seen.has(key)) return 0;
    seen.add(key);
    routines.push(entry);
    return 1;
  };

  const groups = new Map();
  const cpAgents = agents.filter((a) => serverIds.has(a.agentId));
  for (const ids of chunk(cpAgents.map((a) => a.agentId), ACCOUNT_CHUNK)) {
    for (const g of await cursor.listAccountAutomations(ids)) groups.set(g.agentId, g);
  }

  for (const a of agents) {
    let count = 0;
    if (serverIds.has(a.agentId)) {
      const g = groups.get(a.agentId);
      const rows = !g || g.unavailable || g.readIndividually ? await cursor.listAgentAutomations(a.agentId) : (g.automations ?? []);
      for (const row of rows) count += push(a, row, () => normalizeRoutine(a, row));
    }
    for (const x of gwRows) if (x.agentId === a.agentId) count += push(a, x, () => normalizeRecord(a, x.automation.id ?? x.automationId, x.automation));
    perAgent.push({ agentId: a.agentId, name: a.name ?? null, count });
  }
  return { routines, agents: perAgent, errors };
}

/** Resolve exactly one control-plane routine from an agent ref and an automation id or name. */
export async function resolveRoutine(cursor, agentRef, ref) {
  const { routines } = await listRoutines(cursor, { agent: agentRef });
  const live = routines.filter((r) => !r.malformed);
  const agentIds = new Set(live.map((r) => r.agentId));
  if (agentIds.size > 1) throw new UsageError(`"${agentRef}" matches ${agentIds.size} agents with routines; use a more specific agent ref.`);
  const q = String(ref).toLowerCase();
  let hit = live.filter((r) => r.automationId?.toLowerCase() === q || r.name?.toLowerCase() === q);
  if (hit.length === 0) hit = live.filter((r) => r.automationId?.toLowerCase().startsWith(q));
  if (hit.length !== 1) throw new UsageError(hit.length === 0 ? `No routine "${ref}" on agent "${agentRef}".` : `"${ref}" matches ${hit.length} routines; use the automation id.`);
  return hit[0];
}

/**
 * Enable/disable one routine. WRITE: throws (after naming the target) unless `yes`; nothing is sent without it.
 * After the write the routine is re-read from the server; if its state is not the requested one this throws
 * (exitCode 1) instead of reporting success. A routine already in the requested state is left alone.
 */
export async function toggleRoutine(cursor, agentRef, ref, enabled, { yes = false } = {}) {
  const r = await resolveRoutine(cursor, agentRef, ref);
  const word = (on) => (on ? "enabled" : "disabled");
  const target = `${r.agentName ?? r.agentId} / ${r.name} (${r.automationId}): ${word(r.enabled)} -> ${word(enabled)}`;
  const base = { agentId: r.agentId, automationId: r.automationId, name: r.name, enabled };
  if (r.enabled === enabled) return { ...base, changed: false, confirmed: true, target: `${target} (already ${word(enabled)}, nothing sent)` };
  if (!yes) throw new UsageError(`${target}\nRe-run with --yes to apply.`);
  await cursor.setAutomationEnabled(r.agentId, r.automationId, enabled);
  const after = await resolveRoutine(cursor, r.agentId, r.automationId);
  if (after.enabled !== enabled) {
    const err = new Error(`${target}\nWrite accepted but the routine is still ${word(after.enabled)}.`);
    err.exitCode = 1;
    throw err;
  }
  return { ...base, changed: true, confirmed: true, target: `${target} (confirmed by re-read)` };
}

/**
 * Delete one control-plane routine. WRITE and irreversible: names the target (with its prompt size, so `automations export`
 * can be run first) and throws unless `yes`. After the write the agent's routines are re-read; if the routine is still
 * there this throws (exitCode 1) instead of reporting success.
 */
export async function deleteRoutine(cursor, agentRef, ref, { yes = false, timeZone } = {}) {
  const r = await resolveRoutine(cursor, agentRef, ref);
  const target = `${r.agentName ?? r.agentId} / ${r.name} (${r.automationId}), prompt ${r.prompt.length} chars`;
  const base = { agentId: r.agentId, automationId: r.automationId, name: r.name };
  if (!yes) throw new UsageError(`DELETE ${target}\nThis cannot be undone (back up with \`grokbot automations export <dir>\`). Re-run with --yes to apply.`);
  await cursor.deleteAutomation(r.agentId, r.automationId, timeZone);
  let routines;
  try {
    ({ routines } = await listRoutines(cursor, { agent: r.agentId }));
  } catch (e) {
    // The delete itself was accepted: do not report an error for a flaky re-read (a retry would hit "no such routine").
    return { ...base, deleted: true, confirmed: false, target: `deleted ${target} (unconfirmed: the re-read failed: ${String(e?.message ?? e).slice(0, 160)})` };
  }
  if (routines.some((x) => x.automationId === r.automationId)) {
    const err = new Error(`DELETE ${target}\nWrite accepted but the routine is still listed.`);
    err.exitCode = 1;
    throw err;
  }
  return { ...base, deleted: true, confirmed: true, target: `deleted ${target} (confirmed by re-read)` };
}

/**
 * Point one routine at a linked Slack workspace. WRITE: needs `yes`. The team id must be one of the account's linked
 * workspaces (checked first, so a typo never reaches the write). Returns the workspace row the server reports back.
 */
export async function setRoutineSlackWorkspace(cursor, agentRef, ref, teamId, { yes = false } = {}) {
  const r = await resolveRoutine(cursor, agentRef, ref);
  const { workspaces } = await cursor.listSlackWorkspaces();
  const known = workspaces.find((w) => w.slackTeamId === teamId);
  if (!known) throw new UsageError(`Slack workspace "${teamId}" is not linked to this account. Linked: ${workspaces.map((w) => `${w.slackTeamId}${w.displayName ? ` (${w.displayName})` : ""}`).join(", ") || "(none)"}.`);
  const target = `${r.agentName ?? r.agentId} / ${r.name} (${r.automationId}) -> Slack workspace ${teamId}${known.displayName ? ` (${known.displayName})` : ""}`;
  const base = { agentId: r.agentId, automationId: r.automationId, name: r.name, slackTeamId: teamId };
  if (!yes) throw new UsageError(`${target}\nRe-run with --yes to apply.`);
  const fail = (why) => {
    const err = new Error(`${target}\n${why}`);
    err.exitCode = 1;
    return err;
  };
  const after = await cursor.setAutomationSlackWorkspace(r.automationId, teamId);
  // The write's own reply is not proof: re-read the linked workspaces and require the team's row. A failed re-read, or a
  // row that vanished, is an error (exit 1), never a quiet success.
  let reread;
  try {
    reread = (await cursor.listSlackWorkspaces()).workspaces;
  } catch (e) {
    throw fail(`Write accepted but could not be confirmed: re-read failed (${String(e?.message ?? e)}).`);
  }
  const row = reread.find((w) => w.slackTeamId === teamId);
  if (!row) throw fail(`Write accepted but Slack workspace ${teamId} is not in the linked workspaces on re-read.`);
  const replied = after.find((w) => w.slackTeamId === teamId);
  if (!replied) throw fail(`The server's reply did not include Slack workspace ${teamId}; not confirmed.`);
  return { ...base, changed: true, confirmed: true, workspace: { slackTeamId: row.slackTeamId, displayName: row.displayName ?? null, sandAutomationCount: row.sandAutomationCount ?? null }, target: `set ${target} (confirmed by re-read)` };
}

/**
 * Re-enable allowlisted routines that are disabled. `entries` come from parseAllowlist; each matches exactly (case-insensitive). Only enabled===false rows that an
 * entry names are ever written; everything else (unlisted routines, malformed rows) is left alone. A failing write does not
 * stop the rest. The routines are re-read once afterwards and any that did not come back on are reported as failed.
 * Result: { results:[{entry, status, agentId?, automationId?, name?, error?}], resumed, errors } where status is one of
 * enabled | resumed | would-resume | duplicate | not-found | ambiguous | failed.
 */
export async function resumeGuard(cursor, entries, { dryRun = false } = {}) {
  const { routines } = await listRoutines(cursor, {});
  const live = routines.filter((r) => !r.malformed);
  const results = [];
  const writes = [];
  const seen = new Set();
  // An allowlist entry is consent to write, so matching is exact and case-insensitive (agent id or name; routine id or
  // name). Prefix/substring candidates are only offered as a hint in --dry-run, never acted on.
  const hintFor = (entry) => {
    const q = entry.routine.toLowerCase();
    const a = entry.agent?.toLowerCase();
    const near = live.filter(
      (r) => (!a || r.agentId?.toLowerCase().startsWith(a) || r.agentName?.toLowerCase().includes(a)) && (r.automationId?.toLowerCase().startsWith(q) || r.name?.toLowerCase().includes(q)),
    );
    return near.length ? `; did you mean ${near.slice(0, 3).map((r) => `"${r.agentName ?? r.agentId} | ${r.name}" (${r.automationId})`).join(", ")}?` : "";
  };
  for (const entry of entries) {
    const q = entry.routine.toLowerCase();
    let pool = live;
    if (entry.agent) {
      const a = entry.agent.toLowerCase();
      pool = live.filter((r) => r.agentId?.toLowerCase() === a || r.agentName?.toLowerCase() === a);
    }
    const hit = pool.filter((r) => r.automationId?.toLowerCase() === q || r.name?.toLowerCase() === q);
    if (hit.length === 0) {
      results.push({ entry, status: "not-found", error: `no routine matches "${entry.routine}"${entry.agent ? ` on agent "${entry.agent}"` : ""} exactly${dryRun ? hintFor(entry) : ""}` });
      continue;
    }
    if (hit.length > 1) {
      results.push({ entry, status: "ambiguous", error: `"${entry.routine}"${entry.agent ? ` on "${entry.agent}"` : ""} matches ${hit.length} routines; use the automation id` });
      continue;
    }
    const r = hit[0];
    const row = { entry, agentId: r.agentId, agentName: r.agentName, automationId: r.automationId, name: r.name };
    const key = `${r.agentId}:${r.automationId}`;
    if (seen.has(key)) {
      results.push({ ...row, status: "duplicate" }); // named twice in the allowlist: handled once, by the first entry
      continue;
    }
    seen.add(key);
    if (r.enabled !== false) {
      results.push({ ...row, status: "enabled" });
      continue;
    }
    if (dryRun) {
      results.push({ ...row, status: "would-resume" });
      continue;
    }
    const res = { ...row, status: "resumed" };
    results.push(res);
    writes.push(res);
  }
  for (const res of writes) {
    try {
      await cursor.setAutomationEnabled(res.agentId, res.automationId, true);
    } catch (e) {
      res.status = "failed";
      res.error = String(e?.message ?? e);
    }
  }
  if (writes.some((w) => w.status === "resumed")) {
    const after = (await listRoutines(cursor, {})).routines;
    for (const res of writes) {
      if (res.status !== "resumed") continue;
      const now = after.find((x) => x.agentId === res.agentId && x.automationId === res.automationId);
      if (!now || now.enabled !== true) {
        res.status = "failed";
        res.error = now ? "write accepted but the routine is still disabled" : "routine vanished after the write";
      }
    }
  }
  const resumed = results.filter((r) => r.status === "resumed").length;
  const errors = results.filter((r) => ["not-found", "ambiguous", "failed"].includes(r.status)).length;
  return { results, resumed, errors };
}

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

/** Fence longer than any backtick run in the text, so verbatim prompts never break out. */
function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

export function renderAgentMarkdown(agent, routines) {
  const lines = [`# ${agent.name ?? agent.agentId}`, "", `- agentId: ${agent.agentId}`, `- routines: ${routines.length}`, ""];
  for (const r of routines) {
    if (r.malformed) {
      const f = fence(JSON.stringify(r.raw, null, 2));
      lines.push(`## ${r.automationId ?? "(unknown id)"} (UNPARSEABLE)`, "", `- error: ${r.error}`, "", f + "json", JSON.stringify(r.raw, null, 2), f, "");
      continue;
    }
    lines.push(`## ${r.name}`, "");
    lines.push(`- automationId: ${r.automationId}`);
    lines.push(`- enabled: ${r.enabled}`);
    lines.push(`- trigger: ${r.trigger}${r.triggerDescription ? ` (${r.triggerDescription})` : ""}`);
    for (const t of r.triggers) {
      const bits = [t.type, t.schedule, t.timing && `timing=${t.timing}`, t.window && `window=-${t.window.earlyMinutes ?? 0}m/+${t.window.lateMinutes ?? 0}m`];
      lines.push(`  - ${bits.filter(Boolean).join(" ")}`);
    }
    if (r.schedule) lines.push(`- schedule: ${r.schedule}`);
    if (r.lastRunAt) lines.push(`- lastRun: ${r.lastRunAt}${r.lastRunStatus ? ` (${r.lastRunStatus})` : ""}`);
    if (r.nextRunAt) lines.push(`- nextRun: ${r.nextRunAt}`);
    const f = fence(r.prompt);
    lines.push("", "### Prompt", "", f + "text", r.prompt, f, "");
  }
  return lines.join("\n");
}

/** Write one markdown file per agent that has routines. Returns [{agentId, name, count, file}]. */
export function exportRoutines(dir, { routines, agents }) {
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const a of agents) {
    const mine = routines.filter((r) => r.agentId === a.agentId);
    if (mine.length === 0) continue;
    const file = join(dir, `${slug(a.name)}-${a.agentId.slice(0, 8)}.md`);
    writeFileSync(file, renderAgentMarkdown(a, mine));
    written.push({ agentId: a.agentId, name: a.name, count: mine.length, file });
  }
  return written;
}
