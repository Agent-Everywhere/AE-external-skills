// Pure model operations for sidebar sections. Sections live in Cursor's per-user runtime settings
// (GrokBotService Get/UpdateGrokBotUserRuntimeSettings -> settings.sidebarSections.sections). Shape:
//   [{ id: "section-<base36>-<n>", name: "Agent Swarm", agentIds: ["<uuid>", ...], isCollapsed?: bool }, ...]
// The server list includes the pseudo-section { id: "__agents__", name: "Unassigned" }; keep it in place.
// An agent belongs to at most one section; the app derives sectionIdByAgent from this list, first wins.
import { UsageError } from "./output.js";

export function normalizeSections(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.name !== "string") continue;
    const agentIds = [];
    for (const id of Array.isArray(s.agentIds) ? s.agentIds : []) {
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        agentIds.push(id);
      }
    }
    // Spread first so fields we do not model survive a read-modify-write round trip.
    const section = { ...s, id: s.id, name: s.name, agentIds };
    if (typeof s.isCollapsed !== "boolean") delete section.isCollapsed;
    out.push(section);
  }
  return out;
}

export function newSectionId(now = Date.now(), n = Math.floor(Math.random() * 90) + 10) {
  return `section-${now.toString(36)}-${n}`;
}

export function findSection(sections, ref) {
  if (!ref) return null;
  const exact = sections.find((s) => s.id === ref);
  if (exact) return exact;
  const byName = sections.filter((s) => s.name.toLowerCase() === String(ref).toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new UsageError(`Section name "${ref}" is ambiguous (${byName.map((s) => s.id).join(", ")}); use the id.`);
  const partial = sections.filter((s) => s.name.toLowerCase().includes(String(ref).toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new UsageError(`Section "${ref}" matches ${partial.length} sections: ${partial.map((s) => s.name).join(", ")}`);
  return null;
}

export function requireSection(sections, ref) {
  const s = findSection(sections, ref);
  if (!s) throw new UsageError(`No section matches "${ref}". Known: ${sections.map((s) => s.name).join(", ") || "(none)"}`);
  return s;
}

export function createSection(sections, name, agentIds = [], { id = newSectionId(), position = null } = {}) {
  const clean = String(name).trim();
  if (!clean) throw new UsageError("Section name cannot be blank.");
  if (sections.some((s) => s.name.toLowerCase() === clean.toLowerCase())) throw new UsageError(`Section "${clean}" already exists.`);
  const next = assignAgents(sections, null, agentIds); // detach the agents from any other section first
  const section = { id, name: clean, agentIds: [...new Set(agentIds)] };
  if (position == null || position >= next.length) next.push(section);
  else next.splice(Math.max(0, position), 0, section);
  return { sections: next, section };
}

export function renameSection(sections, ref, name) {
  const target = requireSection(sections, ref);
  if (BUILTIN_SECTION_IDS.has(target.id)) throw new UsageError(`"${target.name}" is the app's built-in bucket and cannot be renamed.`);
  const clean = String(name).trim();
  if (!clean) throw new UsageError("Section name cannot be blank.");
  if (sections.some((s) => s.id !== target.id && s.name.toLowerCase() === clean.toLowerCase())) throw new UsageError(`Section "${clean}" already exists.`);
  return { sections: sections.map((s) => (s.id === target.id ? { ...s, name: clean } : s)), section: { ...target, name: clean } };
}

export const BUILTIN_SECTION_IDS = new Set(["__agents__"]); // the app's "Unassigned" bucket

export function deleteSection(sections, ref) {
  const target = requireSection(sections, ref);
  if (BUILTIN_SECTION_IDS.has(target.id)) throw new UsageError(`"${target.name}" is the app's built-in bucket and cannot be deleted.`);
  return { sections: sections.filter((s) => s.id !== target.id), section: target, released: target.agentIds };
}

/** Put agentIds into section `ref` (null = unassign), removing them from every other section. */
export function assignAgents(sections, ref, agentIds) {
  const target = ref == null ? null : requireSection(sections, ref);
  const ids = new Set(agentIds);
  return sections.map((s) => {
    const kept = s.agentIds.filter((id) => !ids.has(id));
    if (target && s.id === target.id) return { ...s, agentIds: [...kept, ...agentIds.filter((id, i, arr) => arr.indexOf(id) === i)] };
    return { ...s, agentIds: kept };
  });
}

export function moveSection(sections, ref, position) {
  const target = requireSection(sections, ref);
  const rest = sections.filter((s) => s.id !== target.id);
  const idx = Math.min(Math.max(0, position), rest.length);
  rest.splice(idx, 0, target);
  return rest;
}

export function sortSections(sections, { by = "name" } = {}) {
  const copy = [...sections];
  if (by === "name") copy.sort((a, b) => a.name.localeCompare(b.name));
  else if (by === "size") copy.sort((a, b) => b.agentIds.length - a.agentIds.length);
  return copy;
}

/** Drop agent ids that no longer exist in the roster; optionally drop empty sections. */
export function pruneSections(sections, liveAgentIds, { dropEmpty = false } = {}) {
  const live = new Set(liveAgentIds);
  let removed = 0;
  let next = sections.map((s) => {
    const agentIds = s.agentIds.filter((id) => live.has(id));
    removed += s.agentIds.length - agentIds.length;
    return { ...s, agentIds };
  });
  let droppedSections = [];
  if (dropEmpty) {
    droppedSections = next.filter((s) => s.agentIds.length === 0 && !BUILTIN_SECTION_IDS.has(s.id));
    next = next.filter((s) => s.agentIds.length > 0 || BUILTIN_SECTION_IDS.has(s.id));
  }
  return { sections: next, removed, droppedSections };
}

export function sectionIdByAgent(sections) {
  const map = new Map();
  for (const s of sections) for (const id of s.agentIds) if (!map.has(id)) map.set(id, s.id);
  return map;
}

export function sectionsDiff(before, after) {
  const b = new Map(before.map((s) => [s.id, s]));
  const a = new Map(after.map((s) => [s.id, s]));
  const changes = [];
  for (const s of after) {
    const prev = b.get(s.id);
    if (!prev) changes.push(`+ section "${s.name}" (${s.agentIds.length} agents)`);
    else {
      if (prev.name !== s.name) changes.push(`~ rename "${prev.name}" → "${s.name}"`);
      const added = s.agentIds.filter((id) => !prev.agentIds.includes(id)).length;
      const removed = prev.agentIds.filter((id) => !s.agentIds.includes(id)).length;
      if (added || removed) changes.push(`~ "${s.name}": +${added} −${removed} agents`);
    }
  }
  for (const s of before) if (!a.has(s.id)) changes.push(`− section "${s.name}" (${s.agentIds.length} agents released)`);
  return changes;
}
