// Agent reference resolution and roster filtering.
import { UsageError } from "./output.js";
import { sectionIdByAgent } from "./sections.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve one ref: full id, unique id prefix (>=4), exact name (ci), or unique name substring. */
export function resolveAgent(roster, ref) {
  const r = String(ref ?? "").trim();
  if (!r) throw new UsageError("Empty agent reference.");
  const byId = roster.find((a) => a.id === r);
  if (byId) return byId;
  if (r.length >= 4 && /^[0-9a-f-]+$/i.test(r)) {
    const pref = roster.filter((a) => a.id.toLowerCase().startsWith(r.toLowerCase()));
    if (pref.length === 1) return pref[0];
    if (pref.length > 1) throw new UsageError(`Id prefix "${r}" matches ${pref.length} agents; use more characters.`);
    if (UUID_RE.test(r)) throw new UsageError(`No agent with id ${r}.`);
  }
  const exact = roster.filter((a) => (a.name ?? "").toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new UsageError(`Name "${r}" matches ${exact.length} agents (${exact.map((a) => a.id.slice(0, 8)).join(", ")}); use an id.`);
  const partial = roster.filter((a) => (a.name ?? "").toLowerCase().includes(r.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new UsageError(`"${r}" matches ${partial.length} agents: ${partial.map((a) => `${a.name} (${a.id.slice(0, 8)})`).join(", ")}`);
  throw new UsageError(`No agent matches "${r}".`);
}

export function resolveMany(roster, refs) {
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const a = resolveAgent(roster, ref);
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

export function parseDuration(text) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i);
  if (!m) throw new UsageError(`Bad duration "${text}" (use e.g. 30m, 12h, 7d, 2w).`);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/**
 * Filter roster rows. opts:
 *  name (glob, ci) | match (substring, ci) | regex | hidden (true/false) | groups (true/false)
 *  running | unread | awaiting | idleFor (ms) | createdBefore (ms) | createdAfter (ms)
 *  section (section ref or "none") | ids (array) | includeHidden
 */
export function filterAgents(roster, opts = {}, sections = []) {
  let rows = roster;
  if (!opts.includeHidden && opts.hidden !== true) rows = rows.filter((a) => !a.isHiddenFromSidebar);
  if (opts.hidden === true) rows = rows.filter((a) => a.isHiddenFromSidebar);
  if (opts.hidden === false) rows = rows.filter((a) => !a.isHiddenFromSidebar);
  if (opts.groups === true) rows = rows.filter((a) => a.isGroup);
  if (opts.groups === false) rows = rows.filter((a) => !a.isGroup);
  if (opts.name) {
    const re = globToRegExp(opts.name);
    rows = rows.filter((a) => re.test(a.name ?? ""));
  }
  if (opts.match) {
    const q = opts.match.toLowerCase();
    rows = rows.filter((a) => `${a.name ?? ""} ${a.description ?? ""} ${a.title ?? ""}`.toLowerCase().includes(q));
  }
  if (opts.regex) {
    const re = new RegExp(opts.regex, "i");
    rows = rows.filter((a) => re.test(a.name ?? ""));
  }
  if (opts.running) rows = rows.filter((a) => a.isRunning || a.isRunningTurn);
  if (opts.idle) rows = rows.filter((a) => !(a.isRunning || a.isRunningTurn));
  if (opts.unread) rows = rows.filter((a) => a.hasUnread || (a.unreadCount ?? 0) > 0);
  if (opts.awaiting) rows = rows.filter((a) => a.awaitingUserResponse);
  const now = Date.now();
  if (opts.idleFor) rows = rows.filter((a) => (a.lastActivityAt ?? a.updatedAt ?? a.createdAt ?? 0) < now - opts.idleFor);
  if (opts.createdBefore) rows = rows.filter((a) => (a.createdAt ?? 0) < now - opts.createdBefore);
  if (opts.createdAfter) rows = rows.filter((a) => (a.createdAt ?? 0) >= now - opts.createdAfter);
  if (opts.ids) {
    const set = new Set(opts.ids);
    rows = rows.filter((a) => set.has(a.id));
  }
  if (opts.section !== undefined) {
    const map = sectionIdByAgent(sections);
    if (opts.section === "none" || opts.section === null) rows = rows.filter((a) => !map.has(a.id));
    else rows = rows.filter((a) => map.get(a.id) === opts.section);
  }
  return rows;
}

export function sortAgents(rows, by = "activity") {
  const copy = [...rows];
  const key = {
    activity: (a) => -(a.lastActivityAt ?? a.updatedAt ?? 0),
    created: (a) => -(a.createdAt ?? 0),
    name: (a) => (a.name ?? "").toLowerCase(),
    unread: (a) => -(a.unreadCount ?? 0),
  }[by];
  if (!key) throw new UsageError(`Unknown sort "${by}" (activity|created|name|unread).`);
  copy.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return copy;
}

export function agentState(a) {
  if (a.isRunningTurn) return "running";
  if (a.isComposingMessage) return "composing";
  if (a.awaitingUserResponse) return "awaiting";
  if (a.isRunning) return "active";
  return "idle";
}
