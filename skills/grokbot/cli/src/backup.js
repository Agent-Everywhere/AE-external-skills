// Fleet backup + usage helpers (read-only): usage summary, agent profile export, transcript export.
// Nothing here writes to Grok, sends a message, or touches secrets: custom MCP config is never requested,
// and any object key that looks like a credential is scrubbed from everything exported.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { UsageError } from "./output.js";
import { matchAgents } from "./routines.js";

const SECRET_KEY = /token|secret|key|password|credential|authorization|cookie|^env$|^headers$/i;

/** Deep copy with credential-looking keys replaced. Strings (prompts, bodies) are left verbatim. */
export function scrubKeys(value) {
  if (Array.isArray(value)) return value.map(scrubKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "<redacted>" : scrubKeys(v)]));
  return value;
}

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
const agentFile = (a) => `${slug(a.name)}-${a.agentId.slice(0, 8)}`;
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const DIR_MODE = { recursive: true, mode: 0o700 };

// ------------------------------------------------------------------ usage
const PT = "America/Los_Angeles";
const ptTime = (ms) => (ms ? new Intl.DateTimeFormat("en-US", { timeZone: PT, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(Number(ms))) : "?");
const ptDate = (ms) => (ms ? new Intl.DateTimeFormat("en-US", { timeZone: PT, month: "short", day: "numeric", year: "numeric" }).format(new Date(Number(ms))) : "?");
// Spend fields are US cents (limit 40000 = the $400 included on the Ultra plan; individualLimit 500 = a $5 cap).
const isoMs = (v) => (num(v) ? new Date(num(v)).toISOString() : null);
const usd = (cents) => (cents == null ? "?" : `$${(Number(cents) / 100).toFixed(2)}`);

function untilText(ms, now) {
  const d = Number(ms) - now;
  if (!Number.isFinite(d)) return "";
  if (d <= 0) return "now";
  const h = Math.floor(d / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor((d % 3_600_000) / 60_000)}m`;
}

/** Normalize the four Dashboard replies into one summary object (money in cents and dollars). */
// int64 fields can arrive as strings; anything non-finite becomes null so nothing downstream shows NaN/Infinity.
const num = (v) => {
  const n = v === null || v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = (spent, limit) => {
  const s = num(spent);
  const l = num(limit);
  return s !== null && l !== null && l > 0 ? Math.round((s / l) * 1000) / 10 : null;
};

export function summarizeUsage({ status = {}, period = {}, access = {}, cycle = {}, errors = {} }, now = Date.now()) {
  const plan = period.planUsage ?? {};
  const lim = period.spendLimitUsage ?? {};
  const resetMs = num(Date.parse(status.nextResetTimestampUtc ?? ""));
  const startMs = num(Date.parse(status.currentPeriodStart ?? ""));
  return {
    plan: { name: status.cursorPlanName ?? null, label: status.grokPlanLabel ?? null },
    access: { state: access.state ?? null, blockReason: access.blockReason ?? null },
    window: {
      percentUsed: num(status.usagePercent),
      hasAvailableUsage: status.hasAvailableUsage ?? null,
      onDemandEnabled: status.onDemandSettings?.enabled ?? null,
      startsAt: startMs ? new Date(startMs).toISOString() : null,
      resetsAt: resetMs ? new Date(resetMs).toISOString() : null,
      resetsAtPT: resetMs ? ptTime(resetMs) : null,
      resetsIn: resetMs ? untilText(resetMs, now) : null,
    },
    billingCycle: { start: isoMs(cycle.startDateEpochMillis), end: isoMs(cycle.endDateEpochMillis) },
    included: {
      spentCents: num(plan.totalSpend),
      limitCents: num(plan.limit),
      remainingCents: num(plan.remaining),
      percentOfLimit: pct(plan.totalSpend, plan.limit),
      serverMessage: period.displayMessage ?? null,
    },
    personalLimit: { usedCents: num(lim.individualUsed), limitCents: num(lim.individualLimit), remainingCents: num(lim.individualRemaining), type: lim.limitType ?? null },
    units: "cents",
    unavailable: errors,
  };
}

export function formatUsage(u) {
  const w = u.window;
  const lines = [
    `Plan:            ${[u.plan.name, u.plan.label].filter(Boolean).join(" / ") || "?"}   access ${String(u.access.state ?? "?").replace("SAND_ACCESS_STATE_", "")}`,
    `Allowance window: ${w.percentUsed ?? "?"}% used${w.hasAvailableUsage === false ? " (none available)" : w.percentUsed >= 100 ? (w.onDemandEnabled ? " (included allowance exhausted; on-demand enabled)" : " (included allowance exhausted)") : ""}`,
    `Resets:          ${w.resetsAtPT ?? "?"}${w.resetsIn ? ` (in ${w.resetsIn})` : ""}`,
    `Billing cycle:   ${ptDate(Date.parse(u.billingCycle.start ?? ""))} to ${ptDate(Date.parse(u.billingCycle.end ?? ""))}`,
    `Included spend:  ${usd(u.included.spentCents)} of ${usd(u.included.limitCents)}${u.included.percentOfLimit != null ? ` (${u.included.percentOfLimit}%)` : ""}, ${usd(u.included.remainingCents)} left`,
  ];
  if (u.included.serverMessage) lines.push(`                 server says: "${u.included.serverMessage}"`);
  if (u.personalLimit.limitCents !== null && u.personalLimit.limitCents !== undefined) lines.push(`Personal cap:    ${usd(u.personalLimit.usedCents)} of ${usd(u.personalLimit.limitCents)} used, ${usd(u.personalLimit.remainingCents)} left`);
  for (const [method, why] of Object.entries(u.unavailable ?? {})) lines.push(`Unavailable:     ${method} (${why})`);
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------ agents export
const msg = (e) => String(e?.message ?? e).replace(/^grokbot:\s*/, "").slice(0, 160);

/**
 * One <name>-<id8>.json per server-hosted agent: profile (ListGrokBotAgents row), skills, plugins, access,
 * (the gateway's getAgentMemories is gone as of host 00b0aa1, so no memories). Account-level workflows go once to <dir>/workflows/<id>.md (user-authored only; managed and
 * plugin workflows are listed in workflows/INDEX.json). A failing section is skipped and noted in `skipped`.
 */
export async function exportAgents(dir, { cursor, gateway, warn = (m) => process.stderr.write(m + "\n"), now = () => new Date().toISOString() }) {
  mkdirSync(dir, DIR_MODE);
  const { agents } = await cursor.listAgents();
  const seen = new Set();
  const files = [];
  const notes = new Map(); // "section: reason" -> agent names, reported once per distinct failure
  const sections = [
    ["skills", (a) => cursor.listAgentSkills(a.agentId)],
    ["plugins", (a) => cursor.getAgentPlugins(a.agentId)],
    ["access", (a) => cursor.getAgentAccess(a.agentId)],
  ];
  for (const a of agents) {
    if (!a.agentId || seen.has(a.agentId)) continue;
    seen.add(a.agentId);
    const doc = { exportedAt: now(), agentId: a.agentId, profile: scrubKeys(a) };
    const skipped = {};
    for (const [name, fn] of sections) {
      try {
        doc[name] = scrubKeys(await fn(a));
      } catch (e) {
        skipped[name] = msg(e);
      }
    }
    if (Object.keys(skipped).length) {
      doc.skipped = skipped;
      for (const [k, v] of Object.entries(skipped)) {
        const key = `${k}: ${v}`;
        (notes.get(key) ?? notes.set(key, []).get(key)).push(a.name ?? a.agentId);
      }
    }
    const file = join(dir, `${agentFile(a)}.json`);
    writeJson(file, doc);
    files.push({ agentId: a.agentId, name: a.name ?? null, file, skipped: Object.keys(skipped) });
  }
  for (const [key, names] of notes) warn(`grokbot: skipped ${key} (${names.length === 1 ? names[0] : `${names.length} agents`})`);
  const workflows = await exportWorkflows(dir, { gateway, agents: [...seen], warn });
  return { files, workflows };
}

async function exportWorkflows(dir, { gateway, agents, warn }) {
  if (!gateway) {
    warn("grokbot: workflows skipped (no gateway session)");
    return { written: 0, listed: 0, skipped: "no gateway session" };
  }
  let rows = null;
  let lastErr = null;
  for (const id of agents) {
    try {
      rows = await gateway.call("getAgentWorkflows", { id });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!Array.isArray(rows)) {
    warn(`grokbot: workflows skipped (${msg(lastErr ?? "no agents")})`);
    return { written: 0, listed: 0, skipped: msg(lastErr ?? "no agents") };
  }
  const wdir = join(dir, "workflows");
  mkdirSync(wdir, DIR_MODE);
  const index = [];
  let written = 0;
  for (const w of rows) {
    index.push({ id: w.id, name: w.name, source: w.source, pluginId: w.pluginId ?? null, description: w.description ?? null });
    if (w.source !== "workflow") continue;
    const { body = "", ...meta } = scrubKeys(w);
    const front = Object.entries(meta).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    writeFileSync(join(wdir, `${slug(w.id)}-${createHash("sha256").update(String(w.id)).digest("hex").slice(0, 8)}.md`), `---\n${front.join("\n")}\n---\n${w.body ?? ""}\n`, { mode: 0o600 });
    written++;
  }
  writeJson(join(wdir, "INDEX.json"), index);
  return { written, listed: rows.length };
}

// ------------------------------------------------------------------ transcripts export
const MAX_PAGES = 2000;

/** `--since` must be a non-negative integer seq. */
export function parseSince(v) {
  const n = v === undefined || v === null || v === "" ? 0 : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--since must be a non-negative integer seq, got "${v}".`);
  return n;
}

/** Page backwards through ListGrokBotTranscriptEntries (beforeSeq) until empty; returns entries ascending by seq. */
export async function fetchTranscript(cursor, agentId, { since = 0, limit = 200, maxPages = MAX_PAGES } = {}) {
  const bySeq = new Map();
  let before;
  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) throw new Error(`transcript paging exceeded ${maxPages} pages; refusing to loop`);
    const page = await cursor.listTranscriptEntries(agentId, { limit, beforeSeq: before });
    if (page.length === 0) break;
    let minSeq = Infinity;
    for (const e of page) {
      const s = Number(e.seq);
      if (!Number.isFinite(s)) continue;
      minSeq = Math.min(minSeq, s);
      if (s > since) bySeq.set(s, e);
    }
    if (!Number.isFinite(minSeq)) break; // no usable seq on the page: cannot page further
    if (minSeq <= since + 1 || minSeq <= 1 || (before !== undefined && minSeq >= before)) break;
    before = minSeq;
  }
  return [...bySeq.entries()].sort((x, y) => x[0] - y[0]).map(([, e]) => e);
}

// Entry bodies are base64 JSON; keep the raw `body` and add a readable `bodyJson` when it decodes.
function withBodyJson(e) {
  if (typeof e.body !== "string" || e.body === "") return e;
  try {
    return { ...e, bodyJson: JSON.parse(Buffer.from(e.body, "base64").toString("utf8")) };
  } catch {
    return e;
  }
}

/**
 * One <name>-<id8>.jsonl per agent (entries ascending by seq, raw body kept). A full export is written to a temp
 * file and renamed into place; `--since N` appends only newer entries. Zero entries never touch the file, so an
 * empty or failed read can't clobber a good backup. Failures are skipped with a note.
 */
export async function exportTranscripts(dir, { cursor, agent, since = 0, warn = (m) => process.stderr.write(m + "\n") }) {
  since = parseSince(since);
  mkdirSync(dir, DIR_MODE);
  const all = [...new Map((await cursor.listAgents()).agents.filter((a) => a.agentId).map((a) => [a.agentId, a])).values()];
  const files = [];
  for (const a of matchAgents(all, agent)) {
    try {
      const entries = await fetchTranscript(cursor, a.agentId, { since });
      const file = join(dir, `${agentFile(a)}.jsonl`);
      if (entries.length > 0) {
        const text = entries.map((e) => JSON.stringify(withBodyJson(e))).join("\n") + "\n";
        if (since > 0) appendFileSync(file, text, { mode: 0o600 });
        else {
          const tmp = `${file}.tmp-${process.pid}`;
          writeFileSync(tmp, text, { mode: 0o600 });
          renameSync(tmp, file);
        }
      }
      files.push({ agentId: a.agentId, name: a.name ?? null, entries: entries.length, lastSeq: entries.length ? Number(entries[entries.length - 1].seq) : since, file: entries.length ? file : null });
    } catch (e) {
      warn(`grokbot: ${a.name ?? a.agentId}: transcript skipped (${msg(e)})`);
    }
  }
  return files;
}
