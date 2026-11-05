// The reusable search profile: who the user sells to and how to qualify what the search finds. One JSON file in the
// user's working folder; later runs load it and skip the intake conversation.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export class ProfileError extends Error {
  constructor(message) { super(message); this.name = "ProfileError"; }
}

export const PROFILE_KEYS = ["name", "offer", "icp", "keywords", "excludes", "min_amount", "max_amount", "states", "qualify_rules", "buyer_titles"];
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Returns { errors, warnings } for a parsed profile object. */
export function validateProfile(p) {
  const errors = [];
  const warnings = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return { errors: ["profile must be a JSON object"], warnings };
  for (const k of Object.keys(p)) if (!PROFILE_KEYS.includes(k)) warnings.push(`unknown key "${k}" is ignored`);
  if (p.name !== undefined && typeof p.name !== "string") errors.push("name must be a string");
  if (p.offer !== undefined && typeof p.offer !== "string") errors.push("offer must be a string");
  if (typeof p.offer === "string" && /FILL IN/i.test(p.offer)) warnings.push("offer is still the placeholder: ask the user what they sell");
  if (p.offer === undefined || p.offer === "") warnings.push("offer is empty: the opener line needs it");
  if (!isStrArr(p.keywords) || !p.keywords.length) errors.push("keywords must be a non-empty array of strings");
  if (p.icp !== undefined && (typeof p.icp !== "object" || Array.isArray(p.icp) || p.icp === null)) errors.push("icp must be an object");
  if (p.excludes !== undefined) {
    const e = p.excludes;
    if (!e || typeof e !== "object" || Array.isArray(e)) errors.push("excludes must be an object with terms and companies arrays");
    else for (const k of ["terms", "companies"]) if (e[k] !== undefined && !isStrArr(e[k])) errors.push(`excludes.${k} must be an array of strings`);
  }
  for (const k of ["min_amount", "max_amount"]) {
    if (p[k] !== undefined && p[k] !== null && !(typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] >= 0)) errors.push(`${k} must be a non-negative number or null`);
  }
  if (typeof p.min_amount === "number" && typeof p.max_amount === "number" && p.min_amount > p.max_amount) errors.push("min_amount is greater than max_amount");
  if (p.states !== undefined) {
    if (!isStrArr(p.states) || p.states.some((s) => !/^[A-Za-z]{2}$/.test(s))) errors.push("states must be an array of two-letter state codes");
  }
  if (p.qualify_rules !== undefined) {
    const q = p.qualify_rules;
    if (!q || typeof q !== "object" || Array.isArray(q)) errors.push("qualify_rules must be an object with strong, maybe and no arrays");
    else for (const k of ["strong", "maybe", "no"]) if (q[k] !== undefined && !isStrArr(q[k])) errors.push(`qualify_rules.${k} must be an array of strings`);
  }
  if (p.buyer_titles !== undefined && !isStrArr(p.buyer_titles)) errors.push("buyer_titles must be an array of strings");
  return { errors, warnings };
}

export async function loadProfile(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch (e) { throw new ProfileError(`could not read profile ${path}: ${e.code === "ENOENT" ? "file not found" : e.message}`); }
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new ProfileError(`profile ${path} is not valid JSON: ${e.message}`); }
  const { errors, warnings } = validateProfile(p);
  if (errors.length) throw new ProfileError(`profile ${path} is invalid:\n- ${errors.join("\n- ")}`);
  return { profile: p, warnings };
}

/** Writes a validated profile; refuses to overwrite unless `overwrite`. */
export async function saveProfile(path, profile, { overwrite = false } = {}) {
  const { errors } = validateProfile(profile);
  if (errors.length) throw new ProfileError(`profile is invalid:\n- ${errors.join("\n- ")}`);
  if (!overwrite && existsSync(path)) throw new ProfileError(`${path} already exists: not overwriting your profile (pick another path or delete it)`);
  await writeFile(path, JSON.stringify(profile, null, 2) + "\n");
}

/** Keywords from a file (one per line or comma-separated, `#` comments), a preset name, or a comma list. */
export async function resolveKeywords(spec, { presets, readFileImpl = readFile } = {}) {
  const s = String(spec || "").trim();
  if (!s) throw new ProfileError("no keywords given");
  const split = (text) => text.split(/[\r\n,]+/).map((x) => x.replace(/#.*$/, "").trim()).filter(Boolean);
  let list;
  if (existsSync(s)) list = split(await readFileImpl(s, "utf8"));
  else if (presets && presets[s]) list = [...presets[s].keywords];
  else list = split(s);
  const seen = new Set();
  list = list.filter((k) => { const key = k.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  if (!list.length) throw new ProfileError("no keywords found");
  return list;
}
