// The search pipeline, the single-filing lookup, and the judgment merge. Pure functions over an injected `http`.
import { fetchFiling, parseFilingRef, parseSince, searchFilings } from "./edgar.js";
import { excludeReason, reasonKind, vehicleNameReason, fundReason } from "./filters.js";

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const byLatest = (a, b) => (b.filing_date || "").localeCompare(a.filing_date || "") || b.accession.localeCompare(a.accession);

const AMOUNT_FIELDS = ["raise_amount", "raise_amount_basis", "total_offering_amount", "total_offering_text", "total_amount_sold", "total_amount_sold_text", "total_remaining_text"];

/**
 * One row per CIK: the latest filing wins; counts, accessions, keywords and related persons are carried over. A later
 * amendment that reports no amount (or no first-sale date, or website) does not erase what an earlier filing disclosed:
 * those fields are filled from the newest filing that has them (`amount_from` names the accession).
 */
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
    if (latest.raise_amount === null || latest.raise_amount === undefined) {
      const donor = group.find((g) => g.raise_amount !== null && g.raise_amount !== undefined);
      if (donor) { for (const k of AMOUNT_FIELDS) latest[k] = donor[k]; latest.amount_from = donor.accession; }
    }
    if (!latest.date_of_first_sale) {
      const donor = group.find((g) => g.date_of_first_sale);
      if (donor) { latest.date_of_first_sale = donor.date_of_first_sale; latest.first_sale_yet_to_occur = false; }
    }
    if (!latest.website) latest.website = group.map((g) => g.website).find(Boolean) || "";
    const seen = new Set();
    latest.related_persons = group.flatMap((g) => g.related_persons || []).filter((p) => {
      const k = `${p.first_name} ${p.last_name}`.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    out.push(latest);
  }
  return out.sort(byLatest);
}

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
const MAX_CONSECUTIVE_BLOCKS = 3;

/**
 * keywords -> EDGAR search (date range split when a keyword exceeds the cap) -> cheap name filters -> fetch each filing ->
 * classify -> dedupe by CIK -> state / amount / freshness filters. Returns { rows, meta }. `meta.complete` is false when any
 * filing could not be fetched or a keyword's results were still capped after splitting.
 */
export async function runSearch({ http, today, keywords, since, until, states = [], minAmount, maxAmount, includeFunds = false, includeUnknownAmount = false,
  includeOldOfferings = false, excludes = {}, sample, maxPerKeyword = 500, onProgress = () => {} }) {
  const startdt = parseSince(since, today);
  if (until !== undefined && !isDate(until)) throw new Error(`--until must be a date (YYYY-MM-DD): got "${until}"`);
  const enddt = until || today;
  if (startdt > enddt) throw new Error(`--since ${startdt} is after the end date ${enddt}`);
  const wantStates = states.map((s) => s.toUpperCase());
  const min = num(minAmount);
  const max = num(maxAmount);

  const { hits, perKeyword } = await searchFilings(http, { keywords, startdt, enddt, maxPerKeyword });
  hits.sort(byLatest);
  const uniqueIssuers = new Set(hits.map((h) => h.cik));
  const filtered = {};
  const examples = new Map(); // cik -> {issuer, reason}; the first reason recorded for an issuer is kept
  const note = (cik, issuer, reason) => { if (!examples.has(cik)) examples.set(cik, { issuer, reason }); };
  const drop = (cik, name, reason) => {
    if (!examples.has(cik)) bump(filtered, reasonKind(reason) === "excluded" ? "excluded" : reason.startsWith("fund") ? "fund" : "vehicle_name");
    note(cik, name, reason);
  };

  /** State, amount and freshness filters plus dedupe, over the rows fetched so far. Pure: returns the surviving rows and drop counts. */
  const finalize = (fetchedRows) => {
    const stats = {};
    const why = new Map();
    const rows = dedupeByCik(fetchedRows).filter((r) => {
      let reason = null;
      if (wantStates.length && r.state && !wantStates.includes(r.state.toUpperCase())) { bump(stats, "state"); reason = `state ${r.state} not in ${wantStates.join(",")}`; }
      else if (min !== null || max !== null) {
        if (r.raise_amount === null) { if (!includeUnknownAmount) { bump(stats, "unknown_amount"); reason = "amount not disclosed"; } }
        else if (min !== null && r.raise_amount < min) { bump(stats, "below_min_amount"); reason = "below min amount"; }
        else if (max !== null && r.raise_amount > max) { bump(stats, "above_max_amount"); reason = "above max amount"; }
      }
      if (!reason && !includeOldOfferings && r.is_amendment && r.date_of_first_sale && r.date_of_first_sale < startdt) {
        bump(stats, "old_offering");
        reason = `amendment of an older offering (first sale ${r.date_of_first_sale}, before ${startdt})`;
      }
      if (reason) why.set(r.cik, { issuer: r.issuer_name, reason });
      return !reason;
    });
    for (const r of rows) r.first_sale_age_days = r.date_of_first_sale ? daysBetween(r.date_of_first_sale, today) : null;
    return { rows, stats, why };
  };
  const wanted = (rows) => (includeFunds ? rows.length : rows.filter((r) => !r.filtered_reason).length);

  const fetched = [];
  const errors = [];
  let n = 0;
  let blocks = 0;
  let stoppedEarly = false;
  for (const hit of hits) {
    n++;
    const nameReason = excludeReason(hit.name, excludes) || vehicleNameReason(hit.name);
    if (nameReason && (reasonKind(nameReason) === "excluded" || !includeFunds)) { drop(hit.cik, hit.name, nameReason); continue; }
    onProgress(`fetching filing ${n}/${hits.length}: ${hit.name}`);
    try {
      const row = await fetchFiling(http, { cik: hit.cik, accession: hit.accession });
      blocks = 0;
      row.filing_date = hit.filing_date;
      row.matched_keywords = hit.matched_keywords;
      row.issuer_name = row.issuer_name || hit.name;
      const reason = excludeReason(row.issuer_name, excludes) || fundReason({ name: row.issuer_name, industry_group: row.industry_group, investment_fund_type: row.investment_fund_type });
      row.filtered_reason = reason;
      if (reason && (reasonKind(reason) === "excluded" || !includeFunds)) { drop(row.cik, row.issuer_name, reason); continue; }
      fetched.push(row);
    } catch (e) {
      errors.push({ accession: hit.accession, issuer: hit.name, error: e.message });
      blocks = e.status === 403 || e.status === 429 ? blocks + 1 : 0;
      if (blocks >= MAX_CONSECUTIVE_BLOCKS) {
        throw new Error(`stopping: the SEC refused ${MAX_CONSECUTIVE_BLOCKS} requests in a row (HTTP ${e.status}). Check that the contact email is real and wait a few minutes before trying again; the filings already fetched are cached.`);
      }
      continue;
    }
    if (sample && n < hits.length && wanted(finalize(fetched).rows) >= sample) { stoppedEarly = true; break; }
  }

  const final = finalize(fetched);
  for (const [k, v] of Object.entries(final.stats)) bump(filtered, k, v);
  for (const [cik, v] of final.why) note(cik, v.issuer, v.reason);
  let rows = final.rows;
  const kept = rows.length;
  const operating = rows.filter((r) => !r.filtered_reason).length;
  if (sample) rows = rows.slice(0, sample);
  const capped = perKeyword.filter((k) => k.capped).map((k) => k.keyword);

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
      new_offerings_only: !includeOldOfferings,
      filtered, filtered_examples: [...examples.values()].slice(0, 25),
      ...(sample ? { sample, sample_stopped_early: stoppedEarly } : {}),
      capped,
      complete: errors.length === 0 && capped.length === 0, fetch_errors: errors,
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
  const byCik = new Map(rows.filter((r) => r && r.cik !== undefined).map((r) => [stripZeros(r.cik), r]));
  const byName = new Map(rows.filter((r) => r && typeof r.issuer_name === "string").map((r) => [r.issuer_name.toLowerCase(), r]));
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
