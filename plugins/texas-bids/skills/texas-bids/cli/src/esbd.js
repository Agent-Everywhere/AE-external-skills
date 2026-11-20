// The Texas ESBD (Electronic State Business Daily) list service. The public site's search page is a SuiteCommerce app
// that POSTs a JSON filter to this service and renders the reply; this module makes the same call. Read-only.

export const BASE = "https://www.txsmartbuy.gov";
export const SERVICE_URL = `${BASE}/app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Service.ss`;
export const PER_PAGE = 24;          // fixed by the service
export const MAX_PAGES = 40;         // per keyword and status: 960 rows is far more than any keyword should match

// Server-side status codes. "1" returns both Posted and Addendum Posted, which is what "open" means here.
export const STATUS_CODES = { open: "1", awarded: "2", cancelled: "3", closed: "5", "no-award": "11" };
export const STATUS_NAMES = Object.keys(STATUS_CODES);

export class EsbdError extends Error {}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** "11/7/2026" -> "2026-11-07" ("" when it is not a date). */
export function usDateToIso(s) {
  const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "2026-11-07" -> "11/07/2026" (the format the service wants). */
export function isoToUsDate(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new EsbdError("date must look like YYYY-MM-DD");
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** The service puts the member number after the agency name ("Department Of Public Safety - 405"): drop it. */
function agencyLabel(name, number) {
  const n = clean(name);
  const suffix = ` - ${clean(number)}`;
  return number && n.endsWith(suffix) ? n.slice(0, -suffix.length) : n;
}

/** encodeURIComponent leaves ! ' ( ) * alone; encode them too so a markdown link around the URL cannot break. */
const encodePath = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export function normalizeLine(l) {
  const id = clean(l.solicitationId);
  return {
    id,
    internal_id: clean(l.internalid),
    title: clean(l.title),
    agency: agencyLabel(l.agencyName, l.agencyNumber),
    agency_number: clean(l.agencyNumber),
    status: clean(l.statusName),
    posted: usDateToIso(l.postingDate),
    due: usDateToIso(l.responseDue),
    due_time: clean(l.responseTime),
    updated: clean(l.lastModified),
    class_codes: String(l.nigpCodes ?? "").split(";").map(clean).filter(Boolean),
    attachment_url: clean(l.url),
    url: `${BASE}/esbd/${encodePath(id)}`,
  };
}

/** Validate one reply from the list service and return its rows plus paging info. */
export function parseListResponse(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new EsbdError("unexpected reply from the Texas bid board (not an object)");
  if (json.errorCode) throw new EsbdError(`the Texas bid board refused the request: ${json.errorCode}${json.errorMessage ? ` (${json.errorMessage})` : ""}`);
  if (!Array.isArray(json.lines)) throw new EsbdError("unexpected reply from the Texas bid board (no result list): the site layout may have changed");
  const total = Number(json.totalRecordsFound);
  return {
    rows: json.lines.map(normalizeLine),
    page: Number(json.page) || 1,
    perPage: Number(json.recordsPerPage) || PER_PAGE,
    total: Number.isFinite(total) ? total : json.lines.length,
  };
}

/** Every page of one keyword + status (+ optional posting-date window). */
export async function fetchAll({ http, keyword, status = "open", since }) {
  const code = STATUS_CODES[status];
  if (!code) throw new EsbdError(`unknown status; use ${STATUS_NAMES.join(", ")} or all`);
  const rows = [];
  let total = 0;
  let truncated = false;
  for (let page = 1; ; page++) {
    const body = { keyword, status: code, page };
    if (since) body.startDate = isoToUsDate(since);
    const r = parseListResponse(await http.postJson(SERVICE_URL, body));
    total = r.total;
    rows.push(...r.rows);
    if (!r.rows.length || page * r.perPage >= r.total) break;
    if (page >= MAX_PAGES) { truncated = true; break; }
  }
  // A page that comes back empty (or short) before the reported total is reached means the check may be missing bids.
  return { rows, total, truncated, incomplete: !truncated && rows.length < total };
}

export function warningsFor(meta) {
  const w = [];
  if (meta.truncated.length) w.push(`WARNING: too many matches, the list was cut off at ${MAX_PAGES * PER_PAGE} for: ${meta.truncated.join(", ")}. Some bids are missing; use more specific keywords.`);
  if (meta.incomplete.length) w.push(`WARNING: the bid board stopped returning rows before its reported total for: ${meta.incomplete.join("; ")}. This check may be incomplete; run it again later.`);
  return w;
}

const words = (s) => String(s || "").split(",").map(clean).filter(Boolean);
export const splitList = words;

/** Whole-word-ish, case-insensitive containment (used for --exclude and --agency filters). */
const has = (text, term) => clean(text).toLowerCase().includes(term.toLowerCase());

/**
 * Search the bid board. Each keyword is one server-side search (a keyword that is several words is matched as typed);
 * the results are merged (OR) and de-duplicated, and `matched` lists the keywords that found each row.
 */
export async function search({ http, keywords, status = "open", since, limit, exclude = [], agencies = [], excludeAgencies = [] }) {
  const kws = [...new Set(keywords.map(clean).filter(Boolean))];
  if (!kws.length) throw new EsbdError('give at least one keyword, for example --keywords "janitorial,HVAC,fuel"');
  if (since) isoToUsDate(since);
  const statuses = status === "all" ? STATUS_NAMES : [status];
  const merged = new Map();
  const meta = { truncated: [], incomplete: [], per_keyword: {} };
  for (const kw of kws) {
    meta.per_keyword[kw] = 0;
    for (const st of statuses) {
      const r = await fetchAll({ http, keyword: kw, status: st, since });
      if (r.truncated) meta.truncated.push(`${kw} (${st})`);
      if (r.incomplete) meta.incomplete.push(`${kw} (${st}): got ${r.rows.length} of ${r.total}`);
      meta.per_keyword[kw] += r.rows.length;
      for (const row of r.rows) {
        const key = row.internal_id || row.id;
        const prev = merged.get(key);
        if (prev) { if (!prev.matched.includes(kw)) prev.matched.push(kw); } else merged.set(key, { ...row, matched: [kw] });
      }
    }
  }
  let rows = [...merged.values()];
  if (since) rows = rows.filter((r) => !r.posted || r.posted >= since);
  if (exclude.length) rows = rows.filter((r) => !exclude.some((t) => has(r.title, t)));
  if (agencies.length) rows = rows.filter((r) => agencies.some((t) => has(r.agency, t) || has(r.agency_number, t)));
  if (excludeAgencies.length) rows = rows.filter((r) => !excludeAgencies.some((t) => has(r.agency, t) || has(r.agency_number, t)));
  rows.sort((a, b) => b.posted.localeCompare(a.posted) || a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
  const total = rows.length;
  if (limit && rows.length > limit) rows = rows.slice(0, limit);
  return { rows, total, meta: { ...meta, warnings: warningsFor(meta) } };
}
