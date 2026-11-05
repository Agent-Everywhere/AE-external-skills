// EDGAR access: full-text search for Form D filings, and a tolerant parser for each filing's primary_doc.xml.
import { SEARCH_PATH } from "./allowlist.js";

export const EFTS = "https://efts.sec.gov" + SEARCH_PATH;
export const PAGE_SIZE = 100; // EDGAR returns at most 100 hits per page

// ---------- dates ----------

const iso = (d) => d.toISOString().slice(0, 10);

/** `--since`: YYYY-MM-DD, or Nd / Nw / Nm (days, weeks, calendar months) back from `today` (YYYY-MM-DD). */
export function parseSince(value, today) {
  const v = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    if (Number.isNaN(Date.parse(v + "T00:00:00Z"))) throw new Error(`invalid date: ${v}`);
    return v;
  }
  const m = /^(\d{1,4})([dwm])$/i.exec(v);
  if (!m) throw new Error(`--since must be a date (YYYY-MM-DD) or a span like 30d, 12w, 6m: got "${v}"`);
  const n = Number(m[1]);
  const d = new Date(today + "T00:00:00Z");
  const unit = m[2].toLowerCase();
  if (unit === "d") d.setUTCDate(d.getUTCDate() - n);
  else if (unit === "w") d.setUTCDate(d.getUTCDate() - 7 * n);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return iso(d);
}

// ---------- keywords ----------

/** One EDGAR query string per keyword: multi-word phrases are quoted; single words (and `robot*` wildcards) are not. */
export function keywordQuery(kw) {
  const k = String(kw).trim();
  if (/^".*"$/.test(k)) return k;
  return /\s/.test(k) ? `"${k}"` : k;
}

// ---------- search ----------

export function buildSearchUrl({ q, startdt, enddt, from = 0 }) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  p.set("forms", "D");
  p.set("dateRange", "custom");
  p.set("startdt", startdt);
  p.set("enddt", enddt);
  if (from) p.set("from", String(from));
  return `${EFTS}?${p.toString()}`;
}

const stripCik = (s) => String(s || "").replace(/\s*\(CIK[^)]*\)\s*$/i, "").replace(/\s+/g, " ").trim();
const dropZeros = (s) => String(s).replace(/^0+/, "") || "0";

export function parseHit(h) {
  const s = h._source || {};
  const accession = String(h._id || "").split(":")[0] || s.adsh;
  if (!accession) return null;
  return {
    accession,
    cik: dropZeros((s.ciks && s.ciks[0]) || ""),
    name: stripCik(s.display_names && s.display_names[0]),
    form: s.form || s.file_type || "D",
    filing_date: s.file_date || "",
    state: (s.biz_states && s.biz_states[0]) || "",
    location: (s.biz_locations && s.biz_locations[0]) || "",
  };
}

const dayMs = 86400000;
const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * dayMs).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / dayMs);

/**
 * Search each keyword separately (so every hit records which keywords found it), page through the results, and union the
 * hits by accession number. When a keyword has more results than `maxPerKeyword` the date range is split in half and
 * each half searched again (down to single days), so a cap never silently drops filings. Returns
 * { hits, perKeyword: [{keyword, total, fetched, windows, capped}] }; `capped` is true only if a single day still
 * exceeded the cap.
 */
export async function searchFilings(http, { keywords, startdt, enddt, maxPerKeyword = 500 }) {
  const byAcc = new Map();
  const perKeyword = [];
  for (const kw of keywords) {
    const seen = new Set();
    const stat = { keyword: kw, total: 0, fetched: 0, windows: 0, capped: false };
    const window = async (a, b, top) => {
      let from = 0;
      let total = 0;
      let got = 0;
      for (;;) {
        const json = await http.getJson(buildSearchUrl({ q: keywordQuery(kw), startdt: a, enddt: b, from }));
        const hits = (json.hits && json.hits.hits) || [];
        total = (json.hits && json.hits.total && json.hits.total.value) || 0;
        for (const h of hits) {
          const hit = parseHit(h);
          if (!hit) continue;
          got++;
          seen.add(hit.accession);
          const prior = byAcc.get(hit.accession);
          if (prior) { if (!prior.matched_keywords.includes(kw)) prior.matched_keywords.push(kw); }
          else byAcc.set(hit.accession, { ...hit, matched_keywords: [kw] });
        }
        from += hits.length;
        if (!hits.length || from >= total || from >= maxPerKeyword) break;
      }
      stat.windows++;
      if (top) stat.total = total;
      if (got < total) {
        const span = daysBetween(a, b);
        if (span < 1) { stat.capped = true; return; }
        const mid = addDays(a, Math.floor(span / 2));
        await window(a, mid, false);
        await window(addDays(mid, 1), b, false);
      }
    };
    await window(startdt, enddt, true);
    stat.fetched = seen.size;
    perKeyword.push(stat);
  }
  return { hits: [...byAcc.values()], perKeyword };
}

// ---------- URLs ----------

export const docUrl = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${dropZeros(cik)}/${accession.replace(/-/g, "")}/primary_doc.xml`;
export const filingUrl = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${dropZeros(cik)}/${accession.replace(/-/g, "")}/${accession}-index.htm`;

/** Accept `<cik>/<accession>`, `<cik> <accession>` or an EDGAR Archives URL. (An accession alone cannot be fetched: the path needs the CIK.) */
export function parseFilingRef(ref) {
  const s = String(ref).trim();
  let m = /\/Archives\/edgar\/data\/(\d+)\/(\d{18})\b/.exec(s);
  if (m) return { cik: dropZeros(m[1]), accession: `${m[2].slice(0, 10)}-${m[2].slice(10, 12)}-${m[2].slice(12)}` };
  m = /^(\d+)[/ ](\d{10}-\d{2}-\d{6})$/.exec(s);
  if (m) return { cik: dropZeros(m[1]), accession: m[2] };
  return null;
}

// ---------- primary_doc.xml ----------

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const codePoint = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "");
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, n, d, h) => (n ? ENTITIES[m.toLowerCase()] : codePoint(d ? Number(d) : parseInt(h, 16))));
const clean = (s) => (s == null ? "" : decode(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim());

const rx = (name, flags) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, flags);
/** Inner text of the first <name>...</name> inside `xml`, or "" (absent or empty). */
const tag = (xml, name) => { const m = rx(name, "i").exec(xml || ""); return m ? clean(m[1]) : ""; };
const block = (xml, name) => { const m = rx(name, "i").exec(xml || ""); return m ? m[1] : ""; };
function blocks(xml, name) {
  const out = [];
  const re = rx(name, "gi");
  let m;
  while ((m = re.exec(xml || ""))) out.push(m[1]);
  return out;
}
const values = (xml, name) => blocks(xml, name).map(clean).filter(Boolean);

/** "230000" -> 230000. "Indefinite", "", "0" -> null (not a usable amount). */
export function parseAmount(text) {
  const t = String(text || "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

const SECURITY_FLAGS = [
  ["isEquityType", "Equity"], ["isDebtType", "Debt"], ["isOptionToAcquireType", "Option"],
  ["isSecurityToBeAcquiredType", "Convertible or underlying security"], ["isPooledInvestmentFundType", "Pooled fund interest"],
  ["isTenantInCommonType", "Tenant in common"], ["isMineralPropertyType", "Mineral property"], ["isOtherType", "Other"],
];
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')]+)/i;

/** A company website only if it is a bare domain or a site root (no path, query or fragment); otherwise "". */
export function normalizeWebsite(candidate) {
  const c = String(candidate || "").trim().replace(/[.,;]+$/, "");
  if (!c) return "";
  let u;
  try { u = new URL(/^https?:\/\//i.test(c) ? c : `https://${c}`); } catch { return ""; }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname) || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return "";
  return c.replace(/\/+$/, "");
}

export function parseFormD(xml, { accession, cik } = {}) {
  const issuer = block(xml, "primaryIssuer");
  const offering = block(xml, "offeringData");
  const industry = block(offering, "industryGroup");
  const sales = block(offering, "offeringSalesAmounts");
  const firstSale = block(offering, "dateOfFirstSale");
  const yearInc = block(issuer, "yearOfInc");
  const submissionType = tag(xml, "submissionType") || "D";
  const isAmendment = /^true$/i.test(tag(offering, "isAmendment")) || /\/A$/i.test(submissionType);

  const persons = [];
  for (const p of blocks(xml, "relatedPersonInfo")) {
    const first = tag(p, "firstName");
    const last = tag(p, "lastName");
    if (!first && !last) continue;
    persons.push({
      first_name: first, middle_name: tag(p, "middleName"), last_name: last,
      relationships: values(block(p, "relatedPersonRelationshipList"), "relationship"),
      clarification: tag(p, "relationshipClarification"),
    });
  }
  const sig = block(offering, "signature");
  const offeringText = tag(sales, "totalOfferingAmount");
  const soldText = tag(sales, "totalAmountSold");
  const total = parseAmount(offeringText);
  const sold = parseAmount(soldText);
  const notes = [tag(sales, "clarificationOfResponse"), tag(offering, "clarificationOfResponse")].filter(Boolean).join(" ");
  // Form D has no website field; take one only if the filer wrote a URL into a free-text field (never from addresses).
  const freeText = [notes, tag(block(offering, "businessCombinationTransaction"), "clarificationOfResponse"), tag(xml, "issuerWebsite"), tag(xml, "website")].join(" ");
  const web = normalizeWebsite(tag(xml, "issuerWebsite") || tag(xml, "website")) || normalizeWebsite((URL_RE.exec(freeText) || [])[1]);

  const row = {
    accession: accession || "",
    cik: dropZeros(tag(issuer, "cik") || cik || ""),
    issuer_name: tag(issuer, "entityName"),
    form: submissionType.toUpperCase() === "D/A" || isAmendment ? "D/A" : "D",
    is_amendment: isAmendment,
    state: tag(issuer, "stateOrCountry"),
    city: tag(issuer, "city"),
    jurisdiction: tag(issuer, "jurisdictionOfInc"),
    entity_type: tag(issuer, "entityType"),
    year_of_inc: tag(yearInc, "value") || (/true/i.test(tag(yearInc, "overFiveYears")) ? "over five years ago" : ""),
    industry_group: tag(industry, "industryGroupType"),
    investment_fund_type: tag(industry, "investmentFundType"),
    revenue_range: tag(offering, "revenueRange"),
    total_offering_amount: total,
    total_offering_text: offeringText,
    total_amount_sold: sold,
    total_amount_sold_text: soldText,
    total_remaining_text: tag(sales, "totalRemaining"),
    date_of_first_sale: tag(firstSale, "value"),
    first_sale_yet_to_occur: /^true$/i.test(tag(firstSale, "yetToOccur")),
    investors_count: tag(offering, "totalNumberAlreadyInvested"),
    securities: SECURITY_FLAGS.filter(([k]) => new RegExp(`<${k}>\\s*true\\s*</${k}>`, "i").test(offering)).map(([, l]) => l),
    exemptions: values(block(offering, "federalExemptionsExclusions"), "item"),
    related_persons: persons,
    signer: { name: tag(sig, "nameOfSigner") || tag(sig, "signatureName"), title: tag(sig, "signatureTitle"), date: tag(sig, "signatureDate") },
    website: web,
    notes,
  };
  // The raise figure: money actually sold if reported, else the offering size if it is a number.
  row.raise_amount = sold || total || null;
  row.raise_amount_basis = sold ? "sold" : total ? "offering" : null;
  return row;
}

const isFormD = (xml) => /<edgarSubmission/i.test(xml);

/** Fetch (cached) and parse one filing's primary_doc.xml. Only a real Form D document is ever cached. */
export async function fetchFiling(http, { cik, accession }) {
  const url = docUrl(cik, accession);
  const xml = await http.cachedText(url, async () => {
    const text = await http.getText(url);
    if (!isFormD(text)) throw new Error(`${accession}: response was not a Form D document`);
    return text;
  }, isFormD);
  const row = parseFormD(xml, { accession, cik });
  row.filing_url = filingUrl(row.cik || cik, accession);
  row.doc_url = url;
  return row;
}
