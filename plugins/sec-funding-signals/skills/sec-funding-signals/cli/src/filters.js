// Operating-company filters. Form D is also filed by investment funds and special-purpose vehicles; a rep prospecting
// companies wants the operating business, so these are dropped by default (`--include-funds` keeps them).
// Heuristics only: documented in SKILL.md, and every drop records a `filtered_reason`.

/** industryGroupType values that are investment vehicles, not operating companies (compared case-insensitively). */
export const FUND_INDUSTRIES = ["pooled investment fund", "investing"];

/** Issuer-name patterns that mark an SPV, series entity, feeder or co-invest vehicle. [label, regex] */
export const NAME_PATTERNS = [
  ["SPV", /\bSPV\b/i],
  ["Fund", /\bFunds?\b/i],
  ["Partners Fund", /\bPartners\s+Fund\b/i],
  ["a series of", /\ba\s+series\s+of\b/i],
  ["Series LLC", /\bSeries\s+LLC\b|\bLLC,?\s+Series\b/i],
  ["Holdings I/II/III", /\bHoldings,?\s+(?:[IVX]{1,5}|\d{1,2})\b/i],
  ["Co-Invest", /\bco-?invest(?:ment)?\b/i],
  ["Feeder", /\bfeeder\b/i],
  ["Syndicate", /\bsyndicate\b/i],
];

/** The reason this issuer looks like a non-operating vehicle by name alone, or null. */
export function vehicleNameReason(name) {
  for (const [label, re] of NAME_PATTERNS) if (re.test(name || "")) return `vehicle-name: matches "${label}"`;
  return null;
}

/** Fund/SPV reason using the filing's industry fields and the issuer name, or null for an operating company. */
export function fundReason({ name, industry_group, investment_fund_type }) {
  const ind = String(industry_group || "").trim().toLowerCase();
  if (FUND_INDUSTRIES.includes(ind)) return `fund: industry group "${industry_group}"`;
  if (investment_fund_type) return `fund: investment fund type "${investment_fund_type}"`;
  return vehicleNameReason(name);
}

const SUFFIX = /\b(?:inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|lp|llp|plc)\b\.?/g;
export const normalizeName = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(SUFFIX, " ").replace(/[^a-z0-9]+/g, " ").trim();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive containment ("bus" does not match "business"). */
export function containsTerm(text, term) {
  const t = String(term || "").trim();
  if (!t) return false;
  return new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])`, "i").test(text || "");
}

/** User exclusions from the profile: terms (whole-word match in the issuer name) and companies (normalised name contains it). */
export function excludeReason(name, excludes) {
  const ex = excludes || {};
  for (const t of ex.terms || []) if (containsTerm(name, t)) return `excluded: term "${t}"`;
  const n = ` ${normalizeName(name)} `;
  for (const c of ex.companies || []) {
    const cn = normalizeName(c);
    if (cn && n.includes(` ${cn} `)) return `excluded: company "${c}"`;
  }
  return null;
}

export const reasonKind = (reason) => (!reason ? null : reason.startsWith("excluded:") ? "excluded" : "vehicle");
