// The search pipeline, the single-filing lookup, and the judgment merge. Pure functions over an injected `http`.
import { fetchFiling, parseFilingRef, parseSince, searchFilings } from "./edgar.js";
import { excludeReason, reasonKind, vehicleNameReason, fundReason } from "./filters.js";

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const byLatest = (a, b) => (b.filing_date || "").localeCompare(a.filing_date || "") || b.accession.localeCompare(a.accession);

/** One row per CIK: the latest filing wins; counts, accessions, keywords and related persons are carried over. */
export function dedupeByCik(rows) {
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.cik)) groups.set(r.cik, []); groups.get(r.cik).push(r); }
  const out = [];
  for (const group of groups.values()) {
    group.sort(byLatest);
    const latest = { ...group[0] };
    latest.filing_count = group.length;
    latest.accessions = group.map((g) => g.accession);
    latest.first_filing_date = group.map((g) => g.filing_date).filter(Boolean).sort()[0] || latest.filing_date;
    latest.matched_keywords = [...new Set(group.flatMap((g) => g.matched_keywords || []))];
    const seen = new Set();
    latest.related_persons = group.flatMap((g) => g.related_persons || []).filter((p) => {
      const k = `${p.first_name} ${p.last_name}`.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!latest.website) latest.website = group.map((g) => g.website).find(Boolean) || "";
    out.push(latest);
  }
  return out.sort(byLatest);
}

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

/**
 * keywords -> EDGAR search -> (cheap name filters) -> fetch each filing -> classify -> dedupe by CIK -> state/amount filters.
 * Returns { rows, meta }. `meta.complete` is false when any filing could not be fetched.
 */
export async function runSearch({ http, today, keywords, since, until, states = [], minAmount, maxAmount, includeFunds = false, includeUnknownAmount = false,
  excludes = {}, sample, maxPerKeyword = 500, onProgress = () => {} }) {
  const startdt = parseSince(since, today);
  const enddt = until || today;
  if (startdt > enddt) throw new Error(`--since ${startdt} is after the end date ${enddt}`);
  const wantStates = states.map((s) => s.toUpperCase());
  const min = num(minAmount);
  const max = num(maxAmount);

  const { hits, perKeyword } = await searchFilings(http, { keywords, startdt, enddt, maxPerKeyword });
  hits.sort(byLatest);
  const uniqueIssuers = new Set(hits.map((h) => h.cik));
  const filtered = {};
  const examples = new Map(); // cik -> {issuer, reason}
  const drop = (cik, name, reason) => {
    if (!examples.has(cik)) { bump(filtered, reasonKind(reason) === "excluded" ? "excluded" : reason.startsWith("fund") ? "fund" : "vehicle_name"); examples.set(cik, { issuer: name, reason }); }
  };

  const fetched = [];
  const errors = [];
  let n = 0;
  for (const hit of hits) {
    n++;
    const nameReason = excludeReason(hit.name, excludes) || vehicleNameReason(hit.name);
    if (nameReason && (reasonKind(nameReason) === "excluded" || !includeFunds)) { drop(hit.cik, hit.name, nameReason); continue; }
    if (wantStates.length && hit.state && !wantStates.includes(hit.state.toUpperCase())) { if (!examples.has(hit.cik)) bump(filtered, "state"); examples.set(hit.cik, { issuer: hit.name, reason: `state ${hit.state} not in ${wantStates.join(",")}` }); continue; }
    onProgress(`fetching filing ${n}/${hits.length}: ${hit.name}`);
    try {
      const row = await fetchFiling(http, { cik: hit.cik, accession: hit.accession });
      row.filing_date = hit.filing_date;
      row.matched_keywords = hit.matched_keywords;
      row.issuer_name = row.issuer_name || hit.name;
      const reason = excludeReason(row.issuer_name, excludes) || fundReason({ name: row.issuer_name, industry_group: row.industry_group, investment_fund_type: row.investment_fund_type });
      row.filtered_reason = reason;
      if (reason && (reasonKind(reason) === "excluded" || !includeFunds)) { drop(row.cik, row.issuer_name, reason); continue; }
      fetched.push(row);
    } catch (e) {
      errors.push({ accession: hit.accession, issuer: hit.name, error: e.message });
    }
  }

  let rows = dedupeByCik(fetched);
  rows = rows.filter((r) => {
    let why = null;
    if (wantStates.length && r.state && !wantStates.includes(r.state.toUpperCase())) { bump(filtered, "state"); why = `state ${r.state}`; }
    else if (min !== null || max !== null) {
      if (r.raise_amount === null) { if (!includeUnknownAmount) { bump(filtered, "unknown_amount"); why = "amount not disclosed"; } }
      else if (min !== null && r.raise_amount < min) { bump(filtered, "below_min_amount"); why = "below min"; }
      else if (max !== null && r.raise_amount > max) { bump(filtered, "above_max_amount"); why = "above max"; }
    }
    if (why) examples.set(r.cik, { issuer: r.issuer_name, reason: why });
    return !why;
  });
  const kept = rows.length;
  const operating = rows.filter((r) => !r.filtered_reason).length;
  if (sample) rows = rows.slice(0, sample);

  return {
    rows,
    meta: {
      since: startdt, until: enddt, keywords, per_keyword: perKeyword,
      filings_found: hits.length,
      issuers_before_filtering: uniqueIssuers.size,
      issuers_after_fund_filter: uniqueIssuers.size - (filtered.fund || 0) - (filtered.vehicle_name || 0) - (filtered.excluded || 0),
      issuers_after_all_filters: kept,
      operating_company_rows: operating,
      include_funds: includeFunds,
      filtered, filtered_examples: [...examples.values()].slice(0, 25),
      ...(sample ? { sample } : {}),
      complete: errors.length === 0, fetch_errors: errors,
      requests: http.stats.requests, cache_hits: http.stats.cacheHits,
    },
  };
}

/** `show`: one filing, fetched by CIK + accession (or an Archives URL). An accession alone is tried with its filer prefix as the CIK. */
export async function showFiling({ http, ref, cik }) {
  let target = parseFilingRef(ref);
  if (!target) {
    if (!/^\d{10}-\d{2}-\d{6}$/.test(ref)) throw new Error(`not a filing reference: ${ref}. Use <cik>/<accession>, an EDGAR Archives URL, or an accession number (with --cik)`);
    target = { accession: ref, cik: cik || ref.slice(0, 10) };
  } else if (cik) target.cik = String(cik);
  try { return { rows: [await fetchFiling(http, target)] }; }
  catch (e) {
    if (e.status === 404 && !cik) throw new Error(`filing ${target.accession} not found under CIK ${target.cik}: pass the issuer's CIK with --cik`);
    throw e;
  }
}

const FITS = ["strong", "maybe", "no"];

/** Parse a judgments file: an array, or {judgments: [...]}. */
export function normalizeJudgments(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.judgments) ? json.judgments : null;
  if (!list) throw new Error("judgments must be a JSON array (or {\"judgments\": [...]}) of {cik, fit, fit_reason, evidence}");
  return list;
}

/**
 * Merge fit / fit_reason / evidence (and an optional corrected website) into search rows by CIK (or exact issuer name).
 * Nothing is applied if any judgment is invalid. Rows judged "no" stay in the rows; the Apollo CSVs drop them.
 */
export function mergeJudgments(rows, list) {
  const problems = [];
  const stripZeros = (s) => String(s).replace(/^0+/, "");
  const byCik = new Map(rows.map((r) => [stripZeros(r.cik), r]));
  const byName = new Map(rows.map((r) => [r.issuer_name.toLowerCase(), r]));
  const apply = [];
  list.forEach((j, i) => {
    const label = `judgment #${i + 1}${j && (j.cik || j.issuer_name) ? ` (${j.cik || j.issuer_name})` : ""}`;
    if (!j || typeof j !== "object") { problems.push(`${label}: not an object`); return; }
    const fit = String(j.fit || "").trim().toLowerCase();
    if (!FITS.includes(fit)) { problems.push(`${label}: fit must be strong, maybe or no (got ${JSON.stringify(j.fit)})`); return; }
    if (!String(j.fit_reason || "").trim()) { problems.push(`${label}: fit_reason is required (one line)`); return; }
    const row = (j.cik !== undefined && byCik.get(stripZeros(j.cik))) || (j.issuer_name && byName.get(String(j.issuer_name).toLowerCase()));
    if (!row) { problems.push(`${label}: no matching issuer in the search results`); return; }
    apply.push([row, { fit, fit_reason: String(j.fit_reason).trim(), evidence: j.evidence ? String(j.evidence).trim() : "", website: j.website ? String(j.website).trim() : "" }]);
  });
  if (problems.length) { const e = new Error(`judgments not applied:\n- ${problems.join("\n- ")}`); e.problems = problems; throw e; }
  for (const [row, v] of apply) {
    row.fit = v.fit; row.fit_reason = v.fit_reason; row.evidence = v.evidence;
    if (v.website) row.website = v.website;
  }
  const counts = { strong: 0, maybe: 0, no: 0, unjudged: 0 };
  for (const r of rows) counts[r.fit || "unjudged"]++;
  return { rows, counts, applied: apply.length };
}
