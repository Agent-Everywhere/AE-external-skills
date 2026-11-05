#!/usr/bin/env node

// src/cli.js
import { readFile as readFile4 } from "node:fs/promises";
import { basename, dirname as dirname2 } from "node:path";

// src/http.js
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/allowlist.js
var HOSTS = ["efts.sec.gov", "www.sec.gov"];
var SEARCH_PATH = "/LATEST/search-index";
var SEARCH_PARAMS = ["q", "forms", "dateRange", "startdt", "enddt", "from"];
var DOC_RE = /^\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/primary_doc\.xml$/;
var AllowlistError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AllowlistError";
  }
};
function assertAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new AllowlistError(`not a URL: ${url}`);
  }
  if (u.protocol !== "https:") throw new AllowlistError(`only https is allowed: ${url}`);
  if (u.username || u.password || u.port) throw new AllowlistError(`credentials or ports are not allowed: ${url}`);
  if (!HOSTS.includes(u.hostname)) throw new AllowlistError(`host not allowed: ${u.hostname} (allowed: ${HOSTS.join(", ")})`);
  if (u.hostname === "efts.sec.gov") {
    if (u.pathname !== SEARCH_PATH) throw new AllowlistError(`path not allowed on efts.sec.gov: ${u.pathname}`);
    for (const k of u.searchParams.keys()) if (!SEARCH_PARAMS.includes(k)) throw new AllowlistError(`search parameter not allowed: ${k}`);
  } else {
    if (!DOC_RE.test(u.pathname) || u.search) throw new AllowlistError(`path not allowed on www.sec.gov: ${u.pathname}${u.search}`);
  }
  return u;
}

// src/http.js
var VERSION = "0.1.0";
var APP_NAME = "sec-funding-signals";
var MIN_INTERVAL_MS = 250;
var userAgent = (email) => `${APP_NAME} ${email}`;
var HttpError = class extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
};
var realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function createHttp({
  email,
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => Date.now(),
  minIntervalMs = MIN_INTERVAL_MS,
  maxRetries = 4,
  backoffMs = 1e3,
  cacheDir,
  noCache = false
} = {}) {
  if (!email) throw new Error("a contact email is required for the SEC User-Agent");
  const ua = userAgent(email);
  let last = -Infinity;
  let chain = Promise.resolve();
  const stats = { requests: 0, retries: 0, cacheHits: 0 };
  function slot() {
    const p = chain.then(async () => {
      const wait = last + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    chain = p.catch(() => {
    });
    return p;
  }
  async function requestOnce(url, accept) {
    let attempt = 0;
    for (; ; ) {
      await slot();
      stats.requests++;
      let res = null;
      let err = null;
      try {
        res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { "user-agent": ua, accept } });
      } catch (e) {
        err = e;
      }
      const retryable = err || res.status === 429 || res.status >= 500;
      if (!retryable) return res;
      if (attempt >= maxRetries) {
        if (err) throw new HttpError(`network error after ${attempt + 1} attempts: ${err.message}`, 0, url);
        throw new HttpError(`HTTP ${res.status} after ${attempt + 1} attempts`, res.status, url);
      }
      let delay = backoffMs * 2 ** attempt;
      const ra = res && res.headers && res.headers.get && res.headers.get("retry-after");
      if (ra && Number.isFinite(Number(ra))) delay = Math.max(delay, Number(ra) * 1e3);
      attempt++;
      stats.retries++;
      await sleep(delay);
    }
  }
  async function get(url, accept = "application/json, application/xml;q=0.9, text/xml;q=0.9") {
    let u = url;
    for (let hop = 0; hop < 4; hop++) {
      assertAllowed(u);
      const res = await requestOnce(u, accept);
      const loc = res.status >= 300 && res.status < 400 && res.headers && res.headers.get && res.headers.get("location");
      if (loc) {
        u = new URL(loc, u).toString();
        continue;
      }
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${u}`, res.status, u);
      return res;
    }
    throw new HttpError(`too many redirects from ${url}`, 0, url);
  }
  const getJson = async (url) => (await get(url)).json();
  const getText = async (url) => (await get(url)).text();
  const keyFile = (key) => join(cacheDir, createHash("sha256").update(key).digest("hex") + ".json");
  async function cachedText(key, produce) {
    if (!noCache && cacheDir) {
      try {
        const { value: value2 } = JSON.parse(await readFile(keyFile(key), "utf8"));
        if (typeof value2 === "string") {
          stats.cacheHits++;
          return value2;
        }
      } catch {
      }
    }
    const value = await produce();
    if (!noCache && cacheDir) {
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(keyFile(key), JSON.stringify({ key, value }));
      } catch {
      }
    }
    return value;
  }
  return { get, getJson, getText, cachedText, stats, cacheDir, userAgent: ua };
}

// src/config.js
import { readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2, resolve, dirname } from "node:path";
var CONFIG_NAME = "sec-funding-signals.config.json";
var EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
var defaultConfigPath = (cwd) => join2(cwd, CONFIG_NAME);
var cacheDirFor = (configPath) => join2(dirname(resolve(configPath)), ".sec-funding-cache");
async function loadConfig(path) {
  try {
    return JSON.parse(await readFile2(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`could not read ${path}: ${e.message}`);
  }
}
async function saveConfig(path, { email }) {
  if (!EMAIL_RE.test(email || "")) throw new Error(`"${email}" does not look like an email address`);
  await writeFile2(path, JSON.stringify({ contact_email: email }, null, 2) + "\n");
}
function resolveEmail({ flag, env, config }) {
  for (const [source, v] of [["--email flag", flag], ["SEC_FUNDING_CONTACT_EMAIL", env && env.SEC_FUNDING_CONTACT_EMAIL], ["config file", config && config.contact_email]]) {
    if (v) {
      if (!EMAIL_RE.test(String(v))) throw new Error(`contact email from ${source} does not look like an email address`);
      return { email: String(v), source };
    }
  }
  return null;
}

// src/presets.js
var RULES = {
  strong: ["The issuer's own product or service is clearly in the target space (it builds or sells it, not just uses it)."],
  maybe: ["Name or industry hints at the target space but the business is unclear: confirm on the company's website."],
  no: ["Holding company, investment vehicle or service business with no product in the target space.", "Matches an exclusion (existing customer or competitor)."]
};
var PRESETS = {
  "physical-ai": {
    name: "physical-ai",
    offer: "FILL IN: what you sell, in one or two sentences",
    icp: {
      description: "Companies building robots and other physical AI systems that just raised money",
      industries: ["robotics", "autonomous systems", "industrial automation"],
      stages: ["seed", "series A", "series B"],
      raise_size: "any disclosed amount",
      geography: ""
    },
    keywords: ["robot*", "humanoid", "embodied AI", "autonom*", "teleoperation", "robot learning", "manipulation"],
    excludes: { terms: [], companies: [] },
    min_amount: null,
    max_amount: null,
    states: [],
    qualify_rules: RULES,
    buyer_titles: ["CEO", "Founder", "CTO", "VP Engineering", "Head of Operations"]
  },
  "ai-data": {
    name: "ai-data",
    offer: "FILL IN: what you sell, in one or two sentences",
    icp: {
      description: "Companies building AI data, evaluation and model products that just raised money",
      industries: ["artificial intelligence", "data services", "software"],
      stages: ["seed", "series A", "series B"],
      raise_size: "any disclosed amount",
      geography: ""
    },
    keywords: ["AI training data", "data annotation", "LLM evaluation", "vertical AI", "foundation model"],
    excludes: { terms: [], companies: [] },
    min_amount: null,
    max_amount: null,
    states: [],
    qualify_rules: RULES,
    buyer_titles: ["CEO", "Founder", "CTO", "Head of Data", "Head of AI"]
  }
};
var presetNames = () => Object.keys(PRESETS);
var getPreset = (name) => PRESETS[name] ? JSON.parse(JSON.stringify(PRESETS[name])) : null;

// src/profile.js
import { readFile as readFile3, writeFile as writeFile3 } from "node:fs/promises";
import { existsSync } from "node:fs";
var ProfileError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfileError";
  }
};
var PROFILE_KEYS = ["name", "offer", "icp", "keywords", "excludes", "min_amount", "max_amount", "states", "qualify_rules", "buyer_titles"];
var isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function validateProfile(p) {
  const errors = [];
  const warnings = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return { errors: ["profile must be a JSON object"], warnings };
  for (const k of Object.keys(p)) if (!PROFILE_KEYS.includes(k)) warnings.push(`unknown key "${k}" is ignored`);
  if (p.name !== void 0 && typeof p.name !== "string") errors.push("name must be a string");
  if (p.offer !== void 0 && typeof p.offer !== "string") errors.push("offer must be a string");
  if (typeof p.offer === "string" && /FILL IN/i.test(p.offer)) warnings.push("offer is still the placeholder: ask the user what they sell");
  if (p.offer === void 0 || p.offer === "") warnings.push("offer is empty: the opener line needs it");
  if (!isStrArr(p.keywords) || !p.keywords.length) errors.push("keywords must be a non-empty array of strings");
  if (p.icp !== void 0 && (typeof p.icp !== "object" || Array.isArray(p.icp) || p.icp === null)) errors.push("icp must be an object");
  if (p.excludes !== void 0) {
    const e = p.excludes;
    if (!e || typeof e !== "object" || Array.isArray(e)) errors.push("excludes must be an object with terms and companies arrays");
    else for (const k of ["terms", "companies"]) if (e[k] !== void 0 && !isStrArr(e[k])) errors.push(`excludes.${k} must be an array of strings`);
  }
  for (const k of ["min_amount", "max_amount"]) {
    if (p[k] !== void 0 && p[k] !== null && !(typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] >= 0)) errors.push(`${k} must be a non-negative number or null`);
  }
  if (typeof p.min_amount === "number" && typeof p.max_amount === "number" && p.min_amount > p.max_amount) errors.push("min_amount is greater than max_amount");
  if (p.states !== void 0) {
    if (!isStrArr(p.states) || p.states.some((s) => !/^[A-Za-z]{2}$/.test(s))) errors.push("states must be an array of two-letter state codes");
  }
  if (p.qualify_rules !== void 0) {
    const q2 = p.qualify_rules;
    if (!q2 || typeof q2 !== "object" || Array.isArray(q2)) errors.push("qualify_rules must be an object with strong, maybe and no arrays");
    else for (const k of ["strong", "maybe", "no"]) if (q2[k] !== void 0 && !isStrArr(q2[k])) errors.push(`qualify_rules.${k} must be an array of strings`);
  }
  if (p.buyer_titles !== void 0 && !isStrArr(p.buyer_titles)) errors.push("buyer_titles must be an array of strings");
  return { errors, warnings };
}
async function loadProfile(path) {
  let text;
  try {
    text = await readFile3(path, "utf8");
  } catch (e) {
    throw new ProfileError(`could not read profile ${path}: ${e.code === "ENOENT" ? "file not found" : e.message}`);
  }
  let p;
  try {
    p = JSON.parse(text);
  } catch (e) {
    throw new ProfileError(`profile ${path} is not valid JSON: ${e.message}`);
  }
  const { errors, warnings } = validateProfile(p);
  if (errors.length) throw new ProfileError(`profile ${path} is invalid:
- ${errors.join("\n- ")}`);
  return { profile: p, warnings };
}
async function saveProfile(path, profile, { overwrite = false } = {}) {
  const { errors } = validateProfile(profile);
  if (errors.length) throw new ProfileError(`profile is invalid:
- ${errors.join("\n- ")}`);
  if (!overwrite && existsSync(path)) throw new ProfileError(`${path} already exists: not overwriting your profile (pick another path or delete it)`);
  await writeFile3(path, JSON.stringify(profile, null, 2) + "\n");
}
async function resolveKeywords(spec, { presets, readFileImpl = readFile3 } = {}) {
  const s = String(spec || "").trim();
  if (!s) throw new ProfileError("no keywords given");
  const split = (text) => text.split(/[\r\n,]+/).map((x) => x.replace(/#.*$/, "").trim()).filter(Boolean);
  let list2;
  if (existsSync(s)) list2 = split(await readFileImpl(s, "utf8"));
  else if (presets && presets[s]) list2 = [...presets[s].keywords];
  else list2 = split(s);
  const seen = /* @__PURE__ */ new Set();
  list2 = list2.filter((k) => {
    const key = k.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!list2.length) throw new ProfileError("no keywords found");
  return list2;
}

// src/edgar.js
var EFTS = "https://efts.sec.gov" + SEARCH_PATH;
var iso = (d) => d.toISOString().slice(0, 10);
function parseSince(value, today2) {
  const v = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    if (Number.isNaN(Date.parse(v + "T00:00:00Z"))) throw new Error(`invalid date: ${v}`);
    return v;
  }
  const m = /^(\d{1,4})([dwm])$/i.exec(v);
  if (!m) throw new Error(`--since must be a date (YYYY-MM-DD) or a span like 30d, 12w, 6m: got "${v}"`);
  const n = Number(m[1]);
  const d = /* @__PURE__ */ new Date(today2 + "T00:00:00Z");
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
function keywordQuery(kw) {
  const k = String(kw).trim();
  if (/^".*"$/.test(k)) return k;
  return /\s/.test(k) ? `"${k}"` : k;
}
function buildSearchUrl({ q: q2, startdt, enddt, from = 0 }) {
  const p = new URLSearchParams();
  if (q2) p.set("q", q2);
  p.set("forms", "D");
  p.set("dateRange", "custom");
  p.set("startdt", startdt);
  p.set("enddt", enddt);
  if (from) p.set("from", String(from));
  return `${EFTS}?${p.toString()}`;
}
var stripCik = (s) => String(s || "").replace(/\s*\(CIK[^)]*\)\s*$/i, "").replace(/\s+/g, " ").trim();
var dropZeros = (s) => String(s).replace(/^0+/, "") || "0";
function parseHit(h) {
  const s = h._source || {};
  const accession = String(h._id || "").split(":")[0] || s.adsh;
  if (!accession) return null;
  return {
    accession,
    cik: dropZeros(s.ciks && s.ciks[0] || ""),
    name: stripCik(s.display_names && s.display_names[0]),
    form: s.form || s.file_type || "D",
    filing_date: s.file_date || "",
    state: s.biz_states && s.biz_states[0] || "",
    location: s.biz_locations && s.biz_locations[0] || ""
  };
}
async function searchFilings(http, { keywords, startdt, enddt, maxPerKeyword = 500 }) {
  const byAcc = /* @__PURE__ */ new Map();
  const perKeyword = [];
  for (const kw of keywords) {
    let from = 0;
    let total = 0;
    let fetched = 0;
    for (; ; ) {
      const json = await http.getJson(buildSearchUrl({ q: keywordQuery(kw), startdt, enddt, from }));
      const hits = json.hits && json.hits.hits || [];
      total = json.hits && json.hits.total && json.hits.total.value || 0;
      for (const h of hits) {
        const hit = parseHit(h);
        if (!hit) continue;
        fetched++;
        const prior = byAcc.get(hit.accession);
        if (prior) {
          if (!prior.matched_keywords.includes(kw)) prior.matched_keywords.push(kw);
        } else byAcc.set(hit.accession, { ...hit, matched_keywords: [kw] });
      }
      from += hits.length;
      if (!hits.length || from >= total || from >= maxPerKeyword) break;
    }
    perKeyword.push({ keyword: kw, total, fetched, capped: fetched < total });
  }
  return { hits: [...byAcc.values()], perKeyword };
}
var docUrl = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${dropZeros(cik)}/${accession.replace(/-/g, "")}/primary_doc.xml`;
var filingUrl = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${dropZeros(cik)}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
function parseFilingRef(ref) {
  const s = String(ref).trim();
  let m = /\/Archives\/edgar\/data\/(\d+)\/(\d{18})\b/.exec(s);
  if (m) return { cik: dropZeros(m[1]), accession: `${m[2].slice(0, 10)}-${m[2].slice(10, 12)}-${m[2].slice(12)}` };
  m = /^(\d+)[/ ](\d{10}-\d{2}-\d{6})$/.exec(s);
  if (m) return { cik: dropZeros(m[1]), accession: m[2] };
  return null;
}
var ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
var decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, n, d, h) => n ? ENTITIES[m.toLowerCase()] : String.fromCodePoint(d ? Number(d) : parseInt(h, 16)));
var clean = (s) => s == null ? "" : decode(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
var rx = (name, flags) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, flags);
var tag = (xml, name) => {
  const m = rx(name, "i").exec(xml || "");
  return m ? clean(m[1]) : "";
};
var block = (xml, name) => {
  const m = rx(name, "i").exec(xml || "");
  return m ? m[1] : "";
};
function blocks(xml, name) {
  const out = [];
  const re = rx(name, "gi");
  let m;
  while (m = re.exec(xml || "")) out.push(m[1]);
  return out;
}
var values = (xml, name) => blocks(xml, name).map(clean).filter(Boolean);
function parseAmount(text) {
  const t = String(text || "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}
var SECURITY_FLAGS = [
  ["isEquityType", "Equity"],
  ["isDebtType", "Debt"],
  ["isOptionToAcquireType", "Option"],
  ["isSecurityToBeAcquiredType", "Convertible or underlying security"],
  ["isPooledInvestmentFundType", "Pooled fund interest"],
  ["isTenantInCommonType", "Tenant in common"],
  ["isMineralPropertyType", "Mineral property"],
  ["isOtherType", "Other"]
];
var URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')]+)/i;
function parseFormD(xml, { accession, cik } = {}) {
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
      first_name: first,
      middle_name: tag(p, "middleName"),
      last_name: last,
      relationships: values(block(p, "relatedPersonRelationshipList"), "relationship"),
      clarification: tag(p, "relationshipClarification")
    });
  }
  const sig = block(offering, "signature");
  const offeringText = tag(sales, "totalOfferingAmount");
  const soldText = tag(sales, "totalAmountSold");
  const total = parseAmount(offeringText);
  const sold = parseAmount(soldText);
  const notes = [tag(sales, "clarificationOfResponse"), tag(offering, "clarificationOfResponse")].filter(Boolean).join(" ");
  const freeText = [notes, tag(block(offering, "businessCombinationTransaction"), "clarificationOfResponse"), tag(xml, "issuerWebsite"), tag(xml, "website")].join(" ");
  const web = URL_RE.exec(freeText);
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
    website: web ? web[1].replace(/[.,;]+$/, "") : "",
    notes
  };
  row.raise_amount = sold || total || null;
  row.raise_amount_basis = sold ? "sold" : total ? "offering" : null;
  return row;
}
async function fetchFiling(http, { cik, accession }) {
  const url = docUrl(cik, accession);
  const xml = await http.cachedText(url, () => http.getText(url));
  if (!/<edgarSubmission/i.test(xml)) throw new Error(`${accession}: not a Form D document`);
  const row = parseFormD(xml, { accession, cik });
  row.filing_url = filingUrl(row.cik || cik, accession);
  row.doc_url = url;
  return row;
}

// src/filters.js
var FUND_INDUSTRIES = ["pooled investment fund", "investing"];
var NAME_PATTERNS = [
  ["SPV", /\bSPV\b/i],
  ["Fund", /\bFunds?\b/i],
  ["Partners Fund", /\bPartners\s+Fund\b/i],
  ["a series of", /\ba\s+series\s+of\b/i],
  ["Series LLC", /\bSeries\s+LLC\b|\bLLC,?\s+Series\b/i],
  ["Holdings I/II/III", /\bHoldings,?\s+(?:[IVX]{1,5}|\d{1,2})\b/i],
  ["Co-Invest", /\bco-?invest(?:ment)?\b/i],
  ["Feeder", /\bfeeder\b/i],
  ["Syndicate", /\bsyndicate\b/i]
];
function vehicleNameReason(name) {
  for (const [label, re] of NAME_PATTERNS) if (re.test(name || "")) return `vehicle-name: matches "${label}"`;
  return null;
}
function fundReason({ name, industry_group, investment_fund_type }) {
  const ind = String(industry_group || "").trim().toLowerCase();
  if (FUND_INDUSTRIES.includes(ind)) return `fund: industry group "${industry_group}"`;
  if (investment_fund_type) return `fund: investment fund type "${investment_fund_type}"`;
  return vehicleNameReason(name);
}
var SUFFIX = /\b(?:inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|lp|llp|plc)\b\.?/g;
var normalizeName = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(SUFFIX, " ").replace(/[^a-z0-9]+/g, " ").trim();
var esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function containsTerm(text, term) {
  const t = String(term || "").trim();
  if (!t) return false;
  return new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])`, "i").test(text || "");
}
function excludeReason(name, excludes) {
  const ex = excludes || {};
  for (const t of ex.terms || []) if (containsTerm(name, t)) return `excluded: term "${t}"`;
  const n = ` ${normalizeName(name)} `;
  for (const c of ex.companies || []) {
    const cn = normalizeName(c);
    if (cn && n.includes(` ${cn} `)) return `excluded: company "${c}"`;
  }
  return null;
}
var reasonKind = (reason) => !reason ? null : reason.startsWith("excluded:") ? "excluded" : "vehicle";

// src/commands.js
var num = (v) => v === void 0 || v === null || v === "" ? null : Number(v);
var byLatest = (a, b) => (b.filing_date || "").localeCompare(a.filing_date || "") || b.accession.localeCompare(a.accession);
function dedupeByCik(rows) {
  const groups = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (!groups.has(r.cik)) groups.set(r.cik, []);
    groups.get(r.cik).push(r);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort(byLatest);
    const latest = { ...group[0] };
    latest.filing_count = group.length;
    latest.accessions = group.map((g) => g.accession);
    latest.first_filing_date = group.map((g) => g.filing_date).filter(Boolean).sort()[0] || latest.filing_date;
    latest.matched_keywords = [...new Set(group.flatMap((g) => g.matched_keywords || []))];
    const seen = /* @__PURE__ */ new Set();
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
var bump = (o, k, n = 1) => {
  o[k] = (o[k] || 0) + n;
};
async function runSearch({
  http,
  today: today2,
  keywords,
  since,
  until,
  states = [],
  minAmount,
  maxAmount,
  includeFunds = false,
  includeUnknownAmount = false,
  excludes = {},
  sample,
  maxPerKeyword = 500,
  onProgress = () => {
  }
}) {
  const startdt = parseSince(since, today2);
  const enddt = until || today2;
  if (startdt > enddt) throw new Error(`--since ${startdt} is after the end date ${enddt}`);
  const wantStates = states.map((s) => s.toUpperCase());
  const min = num(minAmount);
  const max = num(maxAmount);
  const { hits, perKeyword } = await searchFilings(http, { keywords, startdt, enddt, maxPerKeyword });
  hits.sort(byLatest);
  const uniqueIssuers = new Set(hits.map((h) => h.cik));
  const filtered = {};
  const examples = /* @__PURE__ */ new Map();
  const drop = (cik, name, reason) => {
    if (!examples.has(cik)) {
      bump(filtered, reasonKind(reason) === "excluded" ? "excluded" : reason.startsWith("fund") ? "fund" : "vehicle_name");
      examples.set(cik, { issuer: name, reason });
    }
  };
  const fetched = [];
  const errors = [];
  let n = 0;
  for (const hit of hits) {
    n++;
    const nameReason = excludeReason(hit.name, excludes) || vehicleNameReason(hit.name);
    if (nameReason && (reasonKind(nameReason) === "excluded" || !includeFunds)) {
      drop(hit.cik, hit.name, nameReason);
      continue;
    }
    if (wantStates.length && hit.state && !wantStates.includes(hit.state.toUpperCase())) {
      if (!examples.has(hit.cik)) bump(filtered, "state");
      examples.set(hit.cik, { issuer: hit.name, reason: `state ${hit.state} not in ${wantStates.join(",")}` });
      continue;
    }
    onProgress(`fetching filing ${n}/${hits.length}: ${hit.name}`);
    try {
      const row = await fetchFiling(http, { cik: hit.cik, accession: hit.accession });
      row.filing_date = hit.filing_date;
      row.matched_keywords = hit.matched_keywords;
      row.issuer_name = row.issuer_name || hit.name;
      const reason = excludeReason(row.issuer_name, excludes) || fundReason({ name: row.issuer_name, industry_group: row.industry_group, investment_fund_type: row.investment_fund_type });
      row.filtered_reason = reason;
      if (reason && (reasonKind(reason) === "excluded" || !includeFunds)) {
        drop(row.cik, row.issuer_name, reason);
        continue;
      }
      fetched.push(row);
    } catch (e) {
      errors.push({ accession: hit.accession, issuer: hit.name, error: e.message });
    }
  }
  let rows = dedupeByCik(fetched);
  rows = rows.filter((r) => {
    let why = null;
    if (wantStates.length && r.state && !wantStates.includes(r.state.toUpperCase())) {
      bump(filtered, "state");
      why = `state ${r.state}`;
    } else if (min !== null || max !== null) {
      if (r.raise_amount === null) {
        if (!includeUnknownAmount) {
          bump(filtered, "unknown_amount");
          why = "amount not disclosed";
        }
      } else if (min !== null && r.raise_amount < min) {
        bump(filtered, "below_min_amount");
        why = "below min";
      } else if (max !== null && r.raise_amount > max) {
        bump(filtered, "above_max_amount");
        why = "above max";
      }
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
      since: startdt,
      until: enddt,
      keywords,
      per_keyword: perKeyword,
      filings_found: hits.length,
      issuers_before_filtering: uniqueIssuers.size,
      issuers_after_fund_filter: uniqueIssuers.size - (filtered.fund || 0) - (filtered.vehicle_name || 0) - (filtered.excluded || 0),
      issuers_after_all_filters: kept,
      operating_company_rows: operating,
      include_funds: includeFunds,
      filtered,
      filtered_examples: [...examples.values()].slice(0, 25),
      ...sample ? { sample } : {},
      complete: errors.length === 0,
      fetch_errors: errors,
      requests: http.stats.requests,
      cache_hits: http.stats.cacheHits
    }
  };
}
async function showFiling({ http, ref, cik }) {
  let target = parseFilingRef(ref);
  if (!target) {
    if (!/^\d{10}-\d{2}-\d{6}$/.test(ref)) throw new Error(`not a filing reference: ${ref}. Use <cik>/<accession>, an EDGAR Archives URL, or an accession number (with --cik)`);
    target = { accession: ref, cik: cik || ref.slice(0, 10) };
  } else if (cik) target.cik = String(cik);
  try {
    return { rows: [await fetchFiling(http, target)] };
  } catch (e) {
    if (e.status === 404 && !cik) throw new Error(`filing ${target.accession} not found under CIK ${target.cik}: pass the issuer's CIK with --cik`);
    throw e;
  }
}
var FITS = ["strong", "maybe", "no"];
function normalizeJudgments(json) {
  const list2 = Array.isArray(json) ? json : json && Array.isArray(json.judgments) ? json.judgments : null;
  if (!list2) throw new Error('judgments must be a JSON array (or {"judgments": [...]}) of {cik, fit, fit_reason, evidence}');
  return list2;
}
function mergeJudgments(rows, list2) {
  const problems = [];
  const stripZeros = (s) => String(s).replace(/^0+/, "");
  const byCik = new Map(rows.map((r) => [stripZeros(r.cik), r]));
  const byName = new Map(rows.map((r) => [r.issuer_name.toLowerCase(), r]));
  const apply = [];
  list2.forEach((j, i) => {
    const label = `judgment #${i + 1}${j && (j.cik || j.issuer_name) ? ` (${j.cik || j.issuer_name})` : ""}`;
    if (!j || typeof j !== "object") {
      problems.push(`${label}: not an object`);
      return;
    }
    const fit = String(j.fit || "").trim().toLowerCase();
    if (!FITS.includes(fit)) {
      problems.push(`${label}: fit must be strong, maybe or no (got ${JSON.stringify(j.fit)})`);
      return;
    }
    if (!String(j.fit_reason || "").trim()) {
      problems.push(`${label}: fit_reason is required (one line)`);
      return;
    }
    const row = j.cik !== void 0 && byCik.get(stripZeros(j.cik)) || j.issuer_name && byName.get(String(j.issuer_name).toLowerCase());
    if (!row) {
      problems.push(`${label}: no matching issuer in the search results`);
      return;
    }
    apply.push([row, { fit, fit_reason: String(j.fit_reason).trim(), evidence: j.evidence ? String(j.evidence).trim() : "", website: j.website ? String(j.website).trim() : "" }]);
  });
  if (problems.length) {
    const e = new Error(`judgments not applied:
- ${problems.join("\n- ")}`);
    e.problems = problems;
    throw e;
  }
  for (const [row, v] of apply) {
    row.fit = v.fit;
    row.fit_reason = v.fit_reason;
    row.evidence = v.evidence;
    if (v.website) row.website = v.website;
  }
  const counts = { strong: 0, maybe: 0, no: 0, unjudged: 0 };
  for (const r of rows) counts[r.fit || "unjudged"]++;
  return { rows, counts, applied: apply.length };
}

// src/output.js
import { mkdir as mkdir2, writeFile as writeFile4 } from "node:fs/promises";
import { join as join3 } from "node:path";
var cell = (v) => {
  if (v === null || v === void 0) return "";
  let s = Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return s;
};
var q = (s) => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
function toCsv(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(q).join(",")];
  for (const r of rows) lines.push(cols.map((c) => q(cell(r[c]))).join(","));
  return lines.join("\n") + "\n";
}
function render(result, format = "json") {
  if (format === "csv") return result.rows.length && !("issuer_name" in result.rows[0]) ? toCsv(result.rows) : toCsv(fullRows(result.rows), FULL_COLUMNS);
  if (format !== "json") throw new Error(`unknown --format ${JSON.stringify(format)}; use json or csv`);
  const body = { count: result.rows.length, ...result.meta ? { meta: result.meta } : {}, rows: result.rows };
  return JSON.stringify(body, null, 2) + "\n";
}
var usd = (n) => n === null || n === void 0 || n === "" ? "" : "$" + Number(n).toLocaleString("en-US");
var titleCase = (s) => s && s === s.toUpperCase() && /[A-Z]/.test(s) ? s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s || "";
var personName = (p) => [p.first_name, p.last_name].filter(Boolean).map(titleCase).join(" ");
var personTitle = (p) => p.clarification || (p.relationships || []).join(" / ");
var isNo = (row) => String(row.fit || "").toLowerCase() === "no";
var FULL_COLUMNS = [
  "issuer_name",
  "cik",
  "state",
  "city",
  "industry_group",
  "form",
  "is_amendment",
  "filing_date",
  "date_of_first_sale",
  "raise_amount",
  "raise_amount_basis",
  "total_offering_amount",
  "total_offering_text",
  "total_amount_sold",
  "total_remaining_text",
  "investors_count",
  "year_of_inc",
  "entity_type",
  "revenue_range",
  "securities",
  "website",
  "people",
  "matched_keywords",
  "filing_count",
  "first_filing_date",
  "filtered_reason",
  "fit",
  "fit_reason",
  "evidence",
  "filing_url",
  "accession"
];
var fullRows = (rows) => rows.map((r) => ({
  ...r,
  people: (r.related_persons || []).map((p) => `${personName(p)} (${personTitle(p) || "related person"})`).join("; ")
}));
function companyNotes(r) {
  const parts = [];
  if (r.raise_amount) parts.push(r.raise_amount_basis === "offering" ? `Offering of ${usd(r.raise_amount)} (amount sold not reported)` : `${usd(r.raise_amount)} sold`);
  else parts.push("Raise amount not disclosed");
  if (r.total_offering_amount && r.raise_amount_basis === "sold" && r.total_offering_amount !== r.raise_amount) parts[parts.length - 1] += ` of a ${usd(r.total_offering_amount)} offering`;
  if (r.date_of_first_sale) parts.push(`first sale ${r.date_of_first_sale}`);
  parts.push(`SEC Form D ${r.is_amendment ? "amendment" : "new filing"} filed ${r.filing_date}`);
  if (r.industry_group) parts.push(r.industry_group);
  return parts.join("; ");
}
var COMPANY_COLUMNS = ["Company Name", "Website", "Raise Amount (USD)", "Raise Date", "Filing Date", "Total Offering (USD)", "State", "City", "Industry Group", "Notes", "Fit", "Fit Reason", "Evidence", "EDGAR URL"];
function companyRows(rows) {
  return rows.filter((r) => !isNo(r)).map((r) => ({
    "Company Name": r.issuer_name,
    Website: r.website || "",
    "Raise Amount (USD)": r.raise_amount ?? "",
    "Raise Date": r.date_of_first_sale || r.filing_date || "",
    "Filing Date": r.filing_date,
    "Total Offering (USD)": r.total_offering_amount ?? "",
    State: r.state,
    City: r.city,
    "Industry Group": r.industry_group,
    Notes: companyNotes(r),
    Fit: r.fit || "",
    "Fit Reason": r.fit_reason || "",
    Evidence: r.evidence || "",
    "EDGAR URL": r.filing_url
  }));
}
var PEOPLE_COLUMNS = ["First Name", "Last Name", "Title", "Relationship", "Company Name", "Website", "Raise Amount (USD)", "Filing Date", "Source", "Fit", "EDGAR URL"];
function peopleRows(rows) {
  const out = [];
  for (const r of rows) {
    if (isNo(r)) continue;
    const seen = /* @__PURE__ */ new Map();
    const push = (first, last, title, relationship, source) => {
      const key = `${first} ${last}`.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key) return;
      if (seen.has(key)) {
        const prior = seen.get(key);
        if (!prior.Title && title) prior.Title = title;
        return;
      }
      const row = {
        "First Name": titleCase(first),
        "Last Name": titleCase(last),
        Title: title,
        Relationship: relationship,
        "Company Name": r.issuer_name,
        Website: r.website || "",
        "Raise Amount (USD)": r.raise_amount ?? "",
        "Filing Date": r.filing_date,
        Source: source,
        Fit: r.fit || "",
        "EDGAR URL": r.filing_url
      };
      seen.set(key, row);
      out.push(row);
    };
    for (const p of r.related_persons || []) push(p.first_name, p.last_name, p.clarification || "", (p.relationships || []).join(" / "), "related person");
    const sig = r.signer || {};
    if (sig.name) {
      const parts = sig.name.trim().split(/\s+/);
      push(parts[0] || "", parts.slice(1).join(" "), sig.title || "", "", "signer");
    }
  }
  for (const row of out) if (!row.Title) row.Title = row.Relationship;
  return out;
}
async function writeOutputs(dir, name, result) {
  await mkdir2(dir, { recursive: true });
  const files = {
    json: join3(dir, `${name}.json`),
    full: join3(dir, `${name}-full.csv`),
    companies: join3(dir, `${name}-apollo-companies.csv`),
    people: join3(dir, `${name}-people.csv`)
  };
  const companies = companyRows(result.rows);
  const people = peopleRows(result.rows);
  await writeFile4(files.json, render(result, "json"));
  await writeFile4(files.full, toCsv(fullRows(result.rows), FULL_COLUMNS));
  await writeFile4(files.companies, toCsv(companies, COMPANY_COLUMNS));
  await writeFile4(files.people, toCsv(people, PEOPLE_COLUMNS));
  return { files, counts: { full: result.rows.length, companies: companies.length, people: people.length } };
}
async function emit(result, { format = "json", out, stdout }) {
  const text = render(result, format);
  if (out) {
    await writeFile4(out, text);
    return `wrote ${result.rows.length} rows to ${out}`;
  }
  stdout(text);
  return null;
}

// src/cli.js
var deps = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: () => process.cwd(),
  env: process.env
};
var UsageError = class extends Error {
};
var GLOBAL = { string: ["format", "out", "limit", "email", "config"], bool: ["no-cache", "help", "version"] };
var COMMANDS = {
  setup: { string: [], bool: [], usage: "setup --email <your email>   (saves your contact email, which the SEC requires in the User-Agent, to sec-funding-signals.config.json in this folder)" },
  doctor: { string: [], bool: [], usage: "doctor" },
  presets: { string: [], bool: [], usage: "presets   (list the example keyword presets)" },
  "profile init": { string: ["preset"], bool: [], usage: "profile init --out <profile.json> [--preset physical-ai|ai-data]   (write an example profile to edit; refuses to overwrite)" },
  "profile check": { string: [], bool: [], positional: 1, usage: "profile check <profile.json>   (validate a profile and show what a run would use)" },
  search: {
    string: ["keywords", "profile", "since", "until", "states", "min-amount", "max-amount", "sample", "max-per-keyword", "out-dir", "name"],
    bool: ["include-funds", "include-unknown-amount"],
    usage: "search (--keywords <file|preset|a,b,c> | --profile <profile.json>) --since <YYYY-MM-DD|30d|12w|6m> [--until <date>] [--states CA,TX] [--min-amount N] [--max-amount N] [--include-funds] [--include-unknown-amount] [--sample N] [--out-dir <dir> [--name <prefix>]]"
  },
  show: { string: ["cik"], bool: [], positional: 1, usage: "show <accession | cik/accession | EDGAR filing URL> [--cik <cik>]" },
  annotate: { string: ["in", "judgments", "out-dir", "name"], bool: [], usage: 'annotate --in <search.json> --judgments <judgments.json> [--out-dir <dir>] [--name <prefix>]   (merge fit/fit_reason/evidence; fit "no" leaves the Apollo CSVs)' }
};
function helpText() {
  return `sec-funding-signals ${VERSION}: find companies that just raised money, from SEC Form D filings on EDGAR (public data)

Usage: sec-funding-signals <command> [options]

Commands:
${Object.values(COMMANDS).map((c) => "  " + c.usage).join("\n")}

Global options:
  --format json|csv   output format (default json; csv is the full table)
  --out <file>        write output to a file instead of stdout
  --limit <n>         keep only the first n rows
  --email <address>   contact email for this run only (not saved); also SEC_FUNDING_CONTACT_EMAIL
  --config <file>     config file (default ./sec-funding-signals.config.json)
  --no-cache          refetch filings instead of using the local filing cache
  --help, --version
`;
}
function parseArgs(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) {
        flags[name] = a.slice(eq + 1);
        continue;
      }
      const takes = GLOBAL.string.includes(name) || Object.values(COMMANDS).some((c) => c.string.includes(name));
      if (takes) {
        if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
        flags[name] = argv[++i];
      } else flags[name] = true;
    } else words.push(a);
  }
  return { words, flags };
}
function resolve2(words) {
  const two = words.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { name: two, args: words.slice(2) };
  if (COMMANDS[words[0]]) return { name: words[0], args: words.slice(1) };
  return null;
}
var posInt = (v, name) => {
  if (v === void 0) return void 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
};
var amount = (v, name) => {
  if (v === void 0) return void 0;
  const n = Number(String(v).replace(/[$,_]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a number of dollars`);
  return n;
};
var list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
var today = () => new Date(deps.now()).toISOString().slice(0, 10);
async function doctor({ email, source, http }) {
  const checks = [];
  const run = async (name, fn) => {
    const t = Date.now();
    try {
      checks.push({ check: name, ok: true, detail: await fn(), ms: Date.now() - t });
    } catch (e) {
      checks.push({ check: name, ok: false, detail: e.message, ms: Date.now() - t });
    }
  };
  await run("node", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 20) throw new Error(`Node ${process.versions.node}: need 20+`);
    return process.versions.node;
  });
  await run("user-agent", async () => {
    if (!email) throw new Error("no contact email set: run `setup --email <your email>` (the SEC requires one in the User-Agent)");
    return `"${userAgent(email)}" (from ${source})`;
  });
  if (!email) return { rows: checks };
  let first = null;
  await run("efts.sec.gov (full-text search)", async () => {
    const t = today();
    const { hits } = await searchFilings(http, { keywords: ["a"], startdt: parseSince("14d", t), enddt: t, maxPerKeyword: 1 });
    if (!hits.length) throw new Error("search returned no Form D filings for the last 14 days");
    first = hits[0];
    return `reachable (${hits.length} filing(s) returned)`;
  });
  await run("www.sec.gov (filing documents)", async () => {
    if (!first) throw new Error("skipped: search failed");
    const row = await fetchFiling(http, first);
    return `reachable (parsed ${row.accession})`;
  });
  return { rows: checks };
}
async function main(argv = process.argv.slice(2)) {
  try {
    const { words, flags } = parseArgs(argv);
    if (flags.version) {
      deps.stdout(VERSION + "\n");
      return;
    }
    if (flags.help || !words.length || words[0] === "help") {
      deps.stdout(helpText());
      return;
    }
    const cmd = resolve2(words);
    if (!cmd) throw new UsageError(`unknown command: ${words.join(" ")}

${helpText()}`);
    const spec = COMMANDS[cmd.name];
    for (const k of Object.keys(flags)) {
      if (!GLOBAL.string.includes(k) && !GLOBAL.bool.includes(k) && !spec.string.includes(k) && !spec.bool.includes(k)) throw new UsageError(`unknown option --${k} for "${cmd.name}". Usage: ${spec.usage}`);
    }
    if (cmd.args.length !== (spec.positional || 0)) throw new UsageError(`usage: ${spec.usage}`);
    const limit = posInt(flags.limit, "limit");
    const configPath = flags.config || defaultConfigPath(deps.cwd());
    if (cmd.name === "setup") {
      if (!flags.email) throw new UsageError("setup needs --email <your email address>");
      await saveConfig(configPath, { email: flags.email });
      deps.stderr(`saved your contact email to ${configPath}
Requests will identify as: ${userAgent(flags.email)}
`);
      return;
    }
    if (cmd.name === "presets") {
      await emit({ rows: presetNames().map((n2) => ({ preset: n2, keywords: PRESETS[n2].keywords })) }, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
      return;
    }
    if (cmd.name === "profile init") {
      if (!flags.out) throw new UsageError("profile init needs --out <profile.json>");
      const name = flags.preset || "physical-ai";
      const p = getPreset(name);
      if (!p) throw new UsageError(`unknown preset "${name}" (presets: ${presetNames().join(", ")})`);
      await saveProfile(flags.out, p);
      deps.stderr(`wrote example profile "${name}" to ${flags.out}: fill in offer, icp, excludes and qualify_rules
`);
      return;
    }
    if (cmd.name === "profile check") {
      const { profile: profile2, warnings } = await loadProfile(cmd.args[0]);
      await emit({ rows: [{ ok: true, keywords: profile2.keywords, states: profile2.states || [], min_amount: profile2.min_amount ?? null, max_amount: profile2.max_amount ?? null, excludes: profile2.excludes || {}, buyer_titles: profile2.buyer_titles || [], warnings }] }, { format: "json", out: flags.out, stdout: deps.stdout });
      return;
    }
    if (cmd.name === "annotate") {
      if (!flags.in || !flags.judgments) throw new UsageError("annotate needs --in <search.json> and --judgments <judgments.json>");
      let result2;
      try {
        result2 = JSON.parse(await readFile4(flags.in, "utf8"));
      } catch (e) {
        throw new UsageError(`could not read ${flags.in}: ${e.message}`);
      }
      if (!result2 || !Array.isArray(result2.rows)) throw new UsageError(`${flags.in} is not a search result (no rows)`);
      let judgments;
      try {
        judgments = JSON.parse(await readFile4(flags.judgments, "utf8"));
      } catch (e) {
        throw new UsageError(`could not read ${flags.judgments}: ${e.message}`);
      }
      const merged = mergeJudgments(result2.rows, normalizeJudgments(judgments));
      result2.meta = { ...result2.meta || {}, fit_counts: merged.counts, left_out_of_apollo_csvs: merged.counts.no };
      const dir = flags["out-dir"] || dirname2(flags.in);
      const name = flags.name || basename(flags.in).replace(/\.json$/i, "");
      const { files, counts } = await writeOutputs(dir, name, result2);
      deps.stdout(JSON.stringify({ files, counts, fit_counts: merged.counts }, null, 2) + "\n");
      return;
    }
    const config = await loadConfig(configPath);
    const resolved = resolveEmail({ flag: flags.email, env: deps.env, config });
    if (!resolved && cmd.name !== "doctor") throw new UsageError("no contact email set. The SEC requires one in the User-Agent: ask the user for THEIR email, then run `setup --email <it>` in their working folder.");
    const http = resolved ? createHttp({ email: resolved.email, fetchImpl: deps.fetch, sleep: deps.sleep, now: deps.now, cacheDir: cacheDirFor(configPath), noCache: !!flags["no-cache"] }) : null;
    if (cmd.name === "doctor") {
      const result2 = await doctor({ email: resolved && resolved.email, source: resolved && resolved.source, http });
      await emit(result2, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
      if (result2.rows.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }
    if (cmd.name === "show") {
      const result2 = await showFiling({ http, ref: cmd.args[0], cik: flags.cik });
      await emit(result2, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
      return;
    }
    let profile = null;
    if (flags.profile) {
      const loaded = await loadProfile(flags.profile);
      profile = loaded.profile;
      for (const w of loaded.warnings) deps.stderr(`profile warning: ${w}
`);
    }
    let keywords;
    try {
      keywords = flags.keywords ? await resolveKeywords(flags.keywords, { presets: PRESETS }) : profile ? profile.keywords : null;
    } catch (e) {
      throw new UsageError(e.message);
    }
    if (!keywords) throw new UsageError("search needs --keywords <file|preset|a,b,c> or --profile <profile.json>");
    if (!flags.since) throw new UsageError("search needs --since <YYYY-MM-DD|30d|12w|6m>");
    const states = flags.states ? list(flags.states) : profile && profile.states || [];
    if (states.some((s) => !/^[A-Za-z]{2}$/.test(s))) throw new UsageError("--states takes two-letter codes, e.g. CA,TX");
    let n = 0;
    const result = await runSearch({
      http,
      today: today(),
      keywords,
      since: flags.since,
      until: flags.until,
      states,
      minAmount: flags["min-amount"] !== void 0 ? amount(flags["min-amount"], "min-amount") : profile && profile.min_amount,
      maxAmount: flags["max-amount"] !== void 0 ? amount(flags["max-amount"], "max-amount") : profile && profile.max_amount,
      includeFunds: !!flags["include-funds"],
      includeUnknownAmount: !!flags["include-unknown-amount"],
      excludes: profile && profile.excludes || {},
      sample: posInt(flags.sample, "sample"),
      maxPerKeyword: posInt(flags["max-per-keyword"], "max-per-keyword") || 500,
      onProgress: (m) => {
        if (++n % 10 === 1) deps.stderr(m + "\n");
      }
    });
    if (limit) result.rows = result.rows.slice(0, limit);
    if (profile) result.meta.profile = { name: profile.name || null, offer: profile.offer || "", buyer_titles: profile.buyer_titles || [] };
    if (flags["out-dir"]) {
      const name = flags.name || `sec-funding-${today()}`;
      const { files, counts } = await writeOutputs(flags["out-dir"], name, result);
      deps.stdout(JSON.stringify({ files, counts, meta: result.meta }, null, 2) + "\n");
    } else {
      const note = await emit(result, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
      if (note) deps.stderr(note + "\n");
    }
    if (!result.meta.complete) {
      deps.stderr(`sec-funding-signals: ${result.meta.fetch_errors.length} filing(s) could not be fetched; results are PARTIAL (see meta.fetch_errors). Run again.
`);
      process.exitCode = 3;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProfileError) {
      deps.stderr(`sec-funding-signals: ${e.message}
`);
      process.exitCode = 2;
    } else if (e instanceof AllowlistError) {
      deps.stderr(`sec-funding-signals: refused: ${e.message}
`);
      process.exitCode = 2;
    } else {
      deps.stderr(`sec-funding-signals: ${e.message}
`);
      process.exitCode = 1;
    }
  }
}
if (typeof process !== "undefined" && process.stdout && process.stdout.on) process.stdout.on("error", (e) => {
  if (e.code !== "EPIPE") throw e;
  process.exit(0);
});

// bin/sec-funding-signals.js
await main();
