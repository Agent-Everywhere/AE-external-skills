#!/usr/bin/env node

// src/http.js
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
var VERSION = "0.1.0";
var USER_AGENT = `sourcewell-cli/${VERSION} (read-only research; +https://github.com/Agent-Everywhere/AE-external-skills)`;
var DAY_MS = 24 * 60 * 60 * 1e3;
function defaultCacheDir() {
  return process.env.SOURCEWELL_CACHE_DIR || join(homedir(), ".cache", "sourcewell");
}
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
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => Date.now(),
  minIntervalMs = 500,
  // 2 requests per second
  maxRetries = 4,
  backoffMs = 1e3,
  cacheDir = defaultCacheDir(),
  ttlMs = DAY_MS,
  noCache = false
} = {}) {
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
  async function request(url, init = {}) {
    let attempt = 0;
    for (; ; ) {
      await slot();
      stats.requests++;
      let res = null;
      let err = null;
      try {
        res = await fetchImpl(url, { ...init, headers: { "user-agent": USER_AGENT, accept: "application/json, text/html;q=0.9", ...init.headers || {} } });
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
  const keyFile = (key) => join(cacheDir, createHash("sha256").update(key).digest("hex") + ".json");
  async function cached(key, produce, { ttl = ttlMs } = {}) {
    if (!noCache) {
      try {
        const { t, value: value2 } = JSON.parse(await readFile(keyFile(key), "utf8"));
        if (now() - t < ttl) {
          stats.cacheHits++;
          return value2;
        }
      } catch {
      }
    }
    const value = await produce();
    if (!noCache) {
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(keyFile(key), JSON.stringify({ t: now(), key, value }));
      } catch {
      }
    }
    return value;
  }
  async function getJson(url, { onRedirect } = {}) {
    let u = url;
    for (let hop = 0; hop < 4; hop++) {
      const res = await request(u, { method: "GET", redirect: "manual" });
      const loc = res.status >= 300 && res.status < 400 && res.headers && res.headers.get && res.headers.get("location");
      if (loc) {
        if (!onRedirect) throw new HttpError(`unexpected redirect (HTTP ${res.status}) from ${u}: not followed`, res.status, u);
        u = onRedirect(new URL(loc, u).toString());
        continue;
      }
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${u}`, res.status, u);
      return res.json();
    }
    throw new HttpError(`too many redirects from ${url}`, 0, url);
  }
  return { request, cached, getJson, stats, cacheDir };
}

// src/allowlist.js
var BASE = "https://www.sourcewell-mn.gov";
var JSONAPI_PREFIX = "/jsonapi";
var ALLOWED = {
  "node/contractprofile": {
    type: "node--contractprofile",
    fields: [
      "title",
      "field_cp_contract_number",
      "field_cp_end_date",
      "field_cp_contract_description",
      "field_cp_products_services",
      "field_cp_search_keywords",
      "field_cp_brand_name",
      "field_cp_eziqc_category"
    ]
  },
  "node/contract": {
    type: "node--contract",
    fields: [
      "title",
      "field_account_name",
      "field_contract_start_date",
      "field_contract_end_date",
      "field_solicitation_title",
      "field_city",
      "field_state_sf"
    ]
  },
  "node/competitive_solicitations": {
    type: "node--competitive_solicitations",
    fields: ["title", "field_solicitation_bid_rfp_num", "field_solicitation_process_statu"]
  },
  "node/account": {
    type: "node--account",
    fields: [
      "title",
      "field_type",
      "field_sub_type",
      "field_record_type",
      "field_city",
      "field_state_code",
      "field_member_status",
      "field_website",
      "field_member_number"
    ]
  },
  "taxonomy_term/category": { type: "taxonomy_term--category", fields: ["name"] },
  "taxonomy_term/states": { type: "taxonomy_term--states", fields: ["name"] }
};
var OPERATORS = ["=", "<>", "CONTAINS", "STARTS_WITH", ">", ">=", "<", "<=", "IS NULL", "IS NOT NULL"];
var AllowlistError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AllowlistError";
    this.code = "ALLOWLIST";
  }
};
function assertResource(resource) {
  if (typeof resource !== "string" || !Object.prototype.hasOwnProperty.call(ALLOWED, resource)) {
    throw new AllowlistError(`resource not on the allowlist: ${JSON.stringify(resource)}. Allowed: ${Object.keys(ALLOWED).join(", ")}`);
  }
  return ALLOWED[resource];
}
function assertFields(resource, fields) {
  const spec = assertResource(resource);
  const list = fields && fields.length ? fields : spec.fields;
  for (const f of list) {
    if (!spec.fields.includes(f)) throw new AllowlistError(`field not on the allowlist for ${resource}: ${JSON.stringify(f)}`);
  }
  return list;
}
function assertPath(resource, path) {
  const spec = assertResource(resource);
  if (!spec.fields.includes(path)) throw new AllowlistError(`filter/sort path not on the allowlist for ${resource}: ${JSON.stringify(path)}`);
}
function assertNextLink(href, resource) {
  const spec = assertResource(resource);
  let u;
  try {
    u = new URL(href);
  } catch {
    throw new AllowlistError(`bad next link: ${href}`);
  }
  if (u.origin !== BASE) throw new AllowlistError(`next link leaves the allowed origin: ${u.origin}`);
  if (u.pathname !== `${JSONAPI_PREFIX}/${resource}`) throw new AllowlistError(`next link points at a different resource: ${u.pathname}`);
  const sparse = u.searchParams.get(`fields[${spec.type}]`);
  if (!sparse) throw new AllowlistError("next link dropped the sparse fieldset");
  assertFields(resource, sparse.split(","));
  return u.toString();
}
function assertRedirect(href, resource) {
  const spec = assertResource(resource);
  let u;
  try {
    u = new URL(href);
  } catch {
    throw new AllowlistError(`bad redirect target: ${href}`);
  }
  if (u.origin !== BASE) throw new AllowlistError(`redirect leaves the allowed origin: ${u.origin}`);
  if (u.pathname !== `${JSONAPI_PREFIX}/${resource}`) throw new AllowlistError(`redirect points at a different resource: ${u.pathname}`);
  const sparse = u.searchParams.get(`fields[${spec.type}]`);
  if (sparse) assertFields(resource, sparse.split(","));
  return u.toString();
}
var PORTAL_ORIGIN = "https://proportal.sourcewell-mn.gov";
var G = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
var T = "/Module/Tenders/en";
var PORTAL_ROUTES = [
  ["GET", new RegExp(`^${T}/?$`, "i")],
  ["GET", new RegExp(`^${T}/Login/Index/${G}$`, "i")],
  ["POST", new RegExp(`^${T}/Login/Index/${G}$`, "i")],
  ["POST", new RegExp(`^${T}/Tender/Search/${G}$`, "i")],
  ["GET", new RegExp(`^${T}/Tender/Detail/${G}$`, "i")],
  ["GET", new RegExp(`^${T}/Tender/ContractAwards/${G}$`, "i")],
  ["GET", new RegExp(`^${T}/Tender/DownloadBidDocuments/${G}$`, "i")],
  ["GET", new RegExp(`^${T}/Tender/PreviewDocuments/${G}$`, "i")]
];
function assertPortalRequest(method, href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    throw new AllowlistError(`bad portal URL: ${href}`);
  }
  if (u.origin !== PORTAL_ORIGIN) throw new AllowlistError(`portal request leaves the allowed origin: ${u.origin}`);
  const m = String(method).toUpperCase();
  if (!PORTAL_ROUTES.some(([vm, re]) => vm === m && re.test(u.pathname))) {
    throw new AllowlistError(`portal route not on the allowlist: ${m} ${u.pathname}`);
  }
  return u.toString();
}

// src/jsonapi.js
function buildUrl({ resource, fields, filters = [], sort, limit = 50 }) {
  const spec = assertResource(resource);
  const flds = assertFields(resource, fields);
  const params = [];
  const push = (k, v) => params.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  push(`fields[${spec.type}]`, flds.join(","));
  let n = 0;
  const cond = (key, c, group) => {
    assertPath(resource, c.path);
    const op = c.op || "=";
    if (!OPERATORS.includes(op)) throw new AllowlistError(`operator not allowed: ${JSON.stringify(op)}`);
    push(`filter[${key}][condition][path]`, c.path);
    push(`filter[${key}][condition][operator]`, op);
    if (op !== "IS NULL" && op !== "IS NOT NULL") push(`filter[${key}][condition][value]`, String(c.value));
    if (group) push(`filter[${key}][condition][memberOf]`, group);
  };
  for (const f of filters) {
    if (f.or) {
      const g = `g${n++}`;
      push(`filter[${g}][group][conjunction]`, "OR");
      for (const c of f.or) cond(`f${n++}`, c, g);
    } else cond(`f${n++}`, f);
  }
  if (sort) {
    const desc = sort.startsWith("-");
    assertPath(resource, desc ? sort.slice(1) : sort);
    push("sort", sort);
  }
  push("page[limit]", String(Math.min(Math.max(limit, 1), 50)));
  return `${BASE}${JSONAPI_PREFIX}/${resource}?${params.join("&")}`;
}
function createJsonApi(http, { maxPages = 400 } = {}) {
  async function fetchAll(query, { limit = Infinity } = {}) {
    let url = buildUrl(query);
    const rows = [];
    let pages = 0;
    while (url && rows.length < limit && pages < maxPages) {
      const u = url;
      const doc = await http.cached(`GET ${u}`, () => http.getJson(u, { onRedirect: (loc) => assertRedirect(loc, query.resource) }));
      pages++;
      for (const d of doc.data || []) rows.push({ id: d.id, ...d.attributes });
      const next = doc.links && doc.links.next && doc.links.next.href;
      url = next ? assertNextLink(next, query.resource) : null;
    }
    return rows.slice(0, limit);
  }
  return { fetchAll, buildUrl };
}

// src/proportal.js
import { writeFile as writeFile2, mkdir as mkdir2 } from "node:fs/promises";
import { join as join2 } from "node:path";
var PORTAL = PORTAL_ORIGIN;
var TENDERS_PATH = "/Module/Tenders/en";
var PAGE_URL = PORTAL + TENDERS_PATH;
var GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var HOUR_MS = 60 * 60 * 1e3;
var PAGE_SIZE = 100;
var BID_STATUSES = ["Open", "Planned", "Closed", "Unofficial", "Awarded", "Cancelled", "Terminated", "Archived"];
var attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? m[1] ?? m[2] : null;
};
var decode = (s) => String(s ?? "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, "&");
var text = (html) => decode(String(html ?? "").replace(/<\/(p|li|div|tr|h\d)>|<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
function parseTendersPage(html) {
  const nodeTag = (html.match(/<input\b[^>]*\bid=["']NodeId["'][^>]*>/i) || [])[0];
  const nodeId = nodeTag ? attr(nodeTag, "value") : null;
  if (!nodeId || !GUID_RE.test(nodeId)) throw new Error("portal page changed: bid list node id not found");
  const at = html.search(/id=["']bidDetailAntiForgery["']/i);
  const tail = at >= 0 ? html.slice(at, at + 600) : "";
  const tokenTag = (tail.match(/<input\b[^>]*__RequestVerificationToken[^>]*>/i) || [])[0];
  const token = tokenTag ? attr(tokenTag, "value") : null;
  if (!token) throw new Error("portal page changed: anti-forgery token not found");
  return { nodeId, token };
}
function parseLoginForm(html) {
  const at = html.search(/<form\b[^>]*\bid=["']frmLogin["']/i);
  if (at < 0) throw new Error("portal page changed: login form not found");
  const end = html.indexOf("</form>", at);
  const form = html.slice(at, end < 0 ? void 0 : end);
  const fields = {};
  for (const tag of form.match(/<input\b[^>]*>/gi) || []) {
    if ((attr(tag, "type") || "").toLowerCase() === "hidden" && attr(tag, "name")) fields[attr(tag, "name")] = attr(tag, "value") ?? "";
  }
  if (!fields.__RequestVerificationToken) throw new Error("portal page changed: login token not found");
  return fields;
}
function parseMsDate(s) {
  const m = typeof s === "string" && s.match(/\/Date\((-?\d+)\)\//);
  return m ? new Date(Number(m[1])).toISOString() : null;
}
function parseTitle(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^([A-Za-z]{2,5})\s+(?:[-–—]\s+)?([A-Z0-9][A-Z0-9-]*)\s+[-–—:]\s+(.*)$/);
  return m ? { type: m[1].toUpperCase(), number: m[2], name: m[3] } : { type: "", number: "", name: t };
}
function parseBids(payload, { full = false } = {}) {
  if (!payload || payload.success !== true || !Array.isArray(payload.data)) throw new Error("portal search returned an unexpected response");
  return payload.data.map((r) => {
    const t = parseTitle(r.Title);
    const planned = r.Status === "Planned" || String(r.DateClosingDisplay || "").includes("9999");
    const row = {
      number: t.number,
      type: t.type,
      name: t.name,
      status: r.Status,
      closing: planned ? "" : parseMsDate(r.DateClosing),
      closing_local: planned ? "" : r.DateClosingDisplay || "",
      days_left: planned ? "" : r.DaysLeft,
      planned_issue: planned ? parseMsDate(r.DatePlannedIssue) || "" : "",
      // Planned = upcoming RFP: estimated publish date
      days_to_issue: planned ? r.DaysLeftPublish ?? "" : "",
      plan_takers: r.PlanTakers ?? "",
      documents: r.Documents,
      addendums: r.Addendums ?? "",
      id: r.Id,
      url: `${PAGE_URL}/Tender/Detail/${r.Id}`
    };
    if (full) row.description = text(r.Description);
    return row;
  });
}
function parseDetail(html) {
  const fields = {};
  for (const m of html.matchAll(/<th\b[^>]*scope=["']row["'][^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    const label = text(m[1]).replace(/:$/, "").trim().toLowerCase();
    if (label && !(label in fields)) fields[label] = m[2];
  }
  if (!fields["bid number"] && !fields["bid name"]) throw new Error("portal page changed: bid detail table not found");
  const t = (k) => text(fields[k] || "");
  const cats = [];
  const catHtml = fields.categories || "";
  for (const m of catHtml.matchAll(/<li\b[^>]*>\s*(\d{4,6}\s*-\s*[^<]*?)\s*(?:<ul|<\/li)/gi)) {
    const c = decode(m[1]).replace(/\s+/g, " ").trim();
    if (!cats.includes(c)) cats.push(c);
  }
  return {
    number: t("bid number"),
    name: t("bid name"),
    status: t("bid status"),
    classification: t("bid classification"),
    type: t("bid type"),
    closing: t("bid closing date"),
    question_deadline: t("question deadline"),
    submission_type: t("submission type"),
    public_opening: t("public opening"),
    description: t("description"),
    categories: cats
  };
}
function parseAwards(html, year) {
  const heads = [...html.matchAll(/<strong>\s*([^<#]*?)#\s*([^<]*?)\s*<\/strong>/gi)];
  if (!heads.length && (html.length > 3e3 || /Award is to|<table/i.test(html))) throw new Error("portal page changed: no awards headings found in the contract awards report");
  return heads.map((h, i) => {
    const seg = html.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : void 0);
    const t = parseTitle(decode(h[2]));
    const bidders = [...seg.matchAll(/<td style="width:30%;">([^<]*)<\/td>\s*<td style="width:30%;">[^<]*<\/td>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean);
    const award = (seg.match(/Award is to([\s\S]*?)<\/td>/i) || [])[1] || "";
    const awardees = [...award.matchAll(/<em>([\s\S]*?)<\/em>/gi)].map((m) => decode(m[1]).replace(/\s+/g, " ").trim());
    return { year: Number(year), number: t.number, type: t.type, name: t.name, bidder_count: bidders.length, awardees, bidders };
  });
}
function makeJar() {
  const m = /* @__PURE__ */ new Map();
  return {
    absorb(res) {
      const h = res.headers;
      let list = [];
      if (h && typeof h.getSetCookie === "function") list = h.getSetCookie();
      else if (h && h.get && h.get("set-cookie")) list = h.get("set-cookie").split(/,(?=\s*[^;,]+=)/);
      for (const c of list) {
        const [kv] = c.split(";");
        const i = kv.indexOf("=");
        if (i > 0) m.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
    },
    header: () => [...m].map(([k, v]) => `${k}=${v}`).join("; ")
  };
}
function createPortal(http) {
  let homeP = null;
  async function call(jar, method, url, { headers = {}, body } = {}) {
    let m = method;
    let u = url;
    let b = body;
    for (let hop = 0; hop < 6; hop++) {
      assertPortalRequest(m, u);
      const cookie = jar.header();
      const res = await http.request(u, { method: m, redirect: "manual", headers: { ...headers, ...cookie ? { cookie } : {} }, ...b ? { body: b } : {} });
      jar.absorb(res);
      const loc = res.status >= 300 && res.status < 400 && res.headers.get("location");
      if (!loc) return { res, url: u };
      u = new URL(loc, u).toString();
      m = "GET";
      b = void 0;
      headers = { ...headers };
      delete headers["content-type"];
    }
    throw new Error("too many redirects from the portal");
  }
  function home() {
    homeP ??= (async () => {
      const jar = makeJar();
      const { res } = await call(jar, "GET", PAGE_URL, { headers: { accept: "text/html" } });
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${PAGE_URL}`, res.status, PAGE_URL);
      return { ...parseTendersPage(await res.text()), jar };
    })();
    homeP.catch(() => {
      homeP = null;
    });
    return homeP;
  }
  async function page(url, key) {
    return http.cached(key || `GET ${url}`, async () => {
      const { res } = await call(makeJar(), "GET", url, { headers: { accept: "text/html" } });
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
      return res.text();
    });
  }
  async function listBids({ status = "Open", q: q2 = "", full = false } = {}) {
    const wanted = String(status).toLowerCase() === "all" ? "" : BID_STATUSES.find((s) => s.toLowerCase() === String(status).toLowerCase());
    if (wanted === void 0) throw new Error(`unknown bid status ${JSON.stringify(status)}; use one of ${BID_STATUSES.map((s) => s.toLowerCase()).join(", ")}, all`);
    const payloads = await http.cached(`bids ${wanted} ${q2}`, async () => {
      const { nodeId, token, jar } = await home();
      const dir = wanted === "Open" || wanted === "Planned" ? "ASC" : "DESC";
      const out = [];
      let start = 0;
      for (; ; ) {
        const url = `${PAGE_URL}/Tender/Search/${nodeId}?status=${encodeURIComponent(wanted)}&limit=${PAGE_SIZE}&start=${start}&dir=${dir}&from=&to=&sort=${encodeURIComponent(`DateClosing ${dir},Id`)}`;
        const { res } = await call(jar, "POST", url, {
          headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest", accept: "application/json" },
          body: new URLSearchParams({ keywords: q2, __RequestVerificationToken: token }).toString()
        });
        if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
        let payload;
        try {
          payload = JSON.parse(await res.text());
        } catch {
          throw new Error("portal search did not return JSON (the page may have changed)");
        }
        if (!payload.success || !Array.isArray(payload.data)) throw new Error("portal search returned an unexpected response");
        if (!Number.isFinite(Number(payload.total))) throw new Error("portal page changed: bid search response has no total");
        out.push(payload);
        start += payload.data.length;
        if (!payload.data.length || start >= Number(payload.total)) break;
      }
      return out;
    }, { ttl: HOUR_MS });
    return payloads.flatMap((p) => parseBids(p, { full }));
  }
  async function resolveId(ref) {
    const r = String(ref || "").trim();
    if (GUID_RE.test(r)) return r;
    const num3 = r.replace(/^(?:RFP|IFB|RFQ)\s+/i, "").toLowerCase();
    if (!num3) throw new Error("need a tender id or an RFP number");
    const hit = (await listBids({ status: "All" })).filter((b) => b.number.toLowerCase() === num3);
    if (!hit.length) throw new Error(`no bid found with number ${JSON.stringify(r)}`);
    return hit[0].id;
  }
  async function bidDetail(ref) {
    const id = await resolveId(ref);
    const url = `${PAGE_URL}/Tender/Detail/${id}`;
    return { id, url, ...parseDetail(await page(url)) };
  }
  async function awards({ year, rfp } = {}) {
    if (!/^\d{4}$/.test(String(year))) throw new Error("--year must be a four-digit year, e.g. 2023");
    const { nodeId } = await home();
    const rows = parseAwards(await page(`${PAGE_URL}/Tender/ContractAwards/${nodeId}?year=${year}`), year);
    if (!rfp) return rows;
    const want = String(rfp).replace(/^(?:RFP|IFB|RFQ)\s+/i, "").toLowerCase();
    return rows.filter((r) => r.number.toLowerCase() === want);
  }
  async function downloadDocs({ ref, outDir, username, password }) {
    if (!username || !password) throw new Error("docs download needs your own portal login: set SOURCEWELL_USER and SOURCEWELL_PASSWORD (or pipe the password with --password-stdin)");
    const id = await resolveId(ref);
    const { nodeId } = await home();
    const jar = makeJar();
    const loginUrl = `${PAGE_URL}/Login/Index/${nodeId}`;
    const lp = await call(jar, "GET", loginUrl, { headers: { accept: "text/html" } });
    if (!lp.res.ok) throw new HttpError(`HTTP ${lp.res.status} for the login page`, lp.res.status, loginUrl);
    const fields = parseLoginForm(await lp.res.text());
    const body = new URLSearchParams({ ...fields, Username: username, Password: password }).toString();
    const post = await http.request(assertPortalRequest("POST", loginUrl), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(), accept: "text/html" },
      body
    });
    jar.absorb(post);
    if (!(post.status >= 300 && post.status < 400)) throw new Error("portal login failed: check SOURCEWELL_USER and SOURCEWELL_PASSWORD (nothing was downloaded)");
    const dl = await call(jar, "GET", `${PAGE_URL}/Tender/DownloadBidDocuments/${id}`, { headers: { accept: "*/*" } });
    if (/\/Login\//i.test(new URL(dl.url).pathname)) throw new Error("portal did not accept the login (redirected back to sign-in); nothing was downloaded");
    if (!dl.res.ok) throw new HttpError(`HTTP ${dl.res.status} downloading documents`, dl.res.status, dl.url);
    const buf = Buffer.from(await dl.res.arrayBuffer());
    if (buf.length < 4 || buf.toString("latin1", 0, 2) !== "PK") throw new Error("portal did not return a ZIP file (the bid may have no documents)");
    const bid = (await listBids({ status: "All" })).find((b) => b.id.toLowerCase() === id.toLowerCase());
    const base = (bid && bid.number ? `${bid.type || "bid"}-${bid.number}` : `bid-${id.slice(0, 8)}`).replace(/[^A-Za-z0-9._-]+/g, "_");
    await mkdir2(outDir, { recursive: true });
    const file = join2(outDir, `${base}-documents.zip`);
    await writeFile2(file, buf);
    return { file, bytes: buf.length, bid_number: bid ? bid.number : "", id };
  }
  return { listBids, bidDetail, awards, downloadDocs, resolveId, home };
}

// src/commands.js
var PROFILE_FIELDS = [
  "title",
  "field_cp_contract_number",
  "field_cp_end_date",
  "field_cp_contract_description",
  "field_cp_search_keywords",
  "field_cp_brand_name",
  "field_cp_eziqc_category"
];
var FIELD_MAP = {
  description: "field_cp_contract_description",
  keywords: "field_cp_search_keywords",
  title: "title",
  number: "field_cp_contract_number",
  brand: "field_cp_brand_name"
};
var clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
function htmlToText(v) {
  const s = v && typeof v === "object" ? v.value : v;
  return clean(
    String(s ?? "").replace(/<\/(p|li|ul|ol|div|h\d)>|<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&amp;/g, "&")
  );
}
function profileRow(a, { full = false } = {}) {
  const number = a.field_cp_contract_number || "";
  const title = clean(a.title);
  const row = {
    contract_number: number,
    vendor: clean(a.field_cp_brand_name) || (number ? clean(title.replace(number, "")) : title),
    end_date: a.field_cp_end_date || "",
    description: clean(a.field_cp_contract_description),
    keywords: clean(a.field_cp_search_keywords),
    category: a.field_cp_eziqc_category || ""
  };
  if (full) row.products_services = htmlToText(a.field_cp_products_services);
  return row;
}
function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
var byEnd = (a, b) => (a.end_date || "9999").localeCompare(b.end_date || "9999") || a.contract_number.localeCompare(b.contract_number);
function createCommands({ api, portal, today }) {
  const profileFields = (full) => full ? [...PROFILE_FIELDS, "field_cp_products_services"] : PROFILE_FIELDS;
  async function contractsSearch({ q: q2, field, expiringWithin, limit, full } = {}) {
    if (!q2 && expiringWithin === void 0) throw new Error("contracts search needs --q <text> or --expiring-within <months>");
    const filters = [];
    if (q2) {
      if (field && !FIELD_MAP[field]) throw new Error(`--field must be one of ${Object.keys(FIELD_MAP).join(", ")}`);
      const paths = field ? [FIELD_MAP[field]] : [FIELD_MAP.description, FIELD_MAP.keywords, FIELD_MAP.title];
      const conds = paths.map((path) => ({ path, op: "CONTAINS", value: q2 }));
      filters.push(conds.length === 1 ? conds[0] : { or: conds });
    }
    if (expiringWithin !== void 0) {
      const months = Number(expiringWithin);
      if (!Number.isFinite(months) || months < 0) throw new Error("--expiring-within must be a number of months");
      const start = today();
      filters.push({ path: "field_cp_end_date", op: ">=", value: start }, { path: "field_cp_end_date", op: "<=", value: addMonths(start, months) });
    }
    const rows = await api.fetchAll({ resource: "node/contractprofile", fields: profileFields(full), filters, sort: "field_cp_end_date" }, { limit });
    return { rows: rows.map((a) => profileRow(a, { full })).sort(byEnd) };
  }
  async function contractsVendor({ name, limit, full } = {}) {
    if (!name) throw new Error("contracts vendor needs a name");
    const filters = [{ or: [{ path: "field_cp_brand_name", op: "CONTAINS", value: name }, { path: "title", op: "CONTAINS", value: name }] }];
    const rows = await api.fetchAll({ resource: "node/contractprofile", fields: profileFields(full), filters, sort: "field_cp_end_date" }, { limit });
    return { rows: rows.map((a) => profileRow(a, { full })).sort(byEnd) };
  }
  const solRow = (a) => ({
    number: clean(a.field_solicitation_bid_rfp_num),
    title: clean(a.title),
    status: a.field_solicitation_process_statu || ""
  });
  async function solicitationsList({ open, status, limit } = {}) {
    const want = status || (open ? "Open" : "");
    const filters = want ? [{ path: "field_solicitation_process_statu", op: "=", value: want }] : [];
    const rows = await api.fetchAll({ resource: "node/competitive_solicitations", filters, sort: "title" }, { limit });
    return { rows: rows.map(solRow).sort((a, b) => a.number.localeCompare(b.number)) };
  }
  async function bidsList({ status, q: q2, full } = {}) {
    return { rows: await portal.listBids({ status: status || "Open", q: q2 || "", full }) };
  }
  async function bidsDetail({ ref } = {}) {
    if (!ref) throw new Error("bids detail needs a tender id or an RFP number");
    const d = await portal.bidDetail(ref);
    return { rows: [d] };
  }
  async function awardsList({ year, rfp } = {}) {
    if (!year) throw new Error("awards needs --year YYYY");
    return { rows: await portal.awards({ year, rfp }) };
  }
  async function docsDownload({ ref, outDir, username, password } = {}) {
    if (!ref) throw new Error("docs download needs a tender id or an RFP number");
    if (!outDir) throw new Error("docs download needs --out <directory>");
    return { rows: [await portal.downloadDocs({ ref, outDir, username, password })] };
  }
  async function agenciesList({ state, type, limit } = {}) {
    if (!state && !type && limit === void 0) throw new Error("agencies list needs --state XX and/or --type <text> (or --limit N): the full list is very large");
    const filters = [];
    if (state) {
      if (!/^[A-Za-z]{2}$/.test(state)) throw new Error("--state must be a two-letter code, e.g. UT");
      filters.push({ path: "field_state_code", op: "=", value: state.toUpperCase() });
    }
    if (type) filters.push({ or: [{ path: "field_type", op: "CONTAINS", value: type }, { path: "field_sub_type", op: "CONTAINS", value: type }] });
    const fields = ["title", "field_type", "field_sub_type", "field_city", "field_state_code", "field_member_status", "field_website", "field_member_number"];
    const rows = await api.fetchAll({ resource: "node/account", fields, filters, sort: "title" }, { limit });
    return {
      rows: rows.map((a) => ({
        name: clean(a.title),
        state: a.field_state_code || "",
        city: a.field_city || "",
        type: a.field_type || "",
        sub_type: a.field_sub_type || "",
        member_status: a.field_member_status || "",
        website: a.field_website || "",
        member_number: a.field_member_number || ""
      }))
    };
  }
  async function termsList(resource, { limit } = {}) {
    const rows = await api.fetchAll({ resource, sort: void 0 }, { limit });
    return { rows: rows.map((a) => ({ name: clean(a.name) })).sort((a, b) => a.name.localeCompare(b.name)) };
  }
  function deriveQueries(title) {
    const main2 = clean(title).split(/,?\s+(?:with|and\s+related|related|including)\s+/i)[0];
    const toks = main2.split(/(\s*,\s*(?:and\s+)?|\s+and\s+)/i);
    const parts = [];
    for (let i = 0; i < toks.length; i += 2) parts.push({ text: clean(toks[i]), joinedByAnd: /^\s+and\s+$/i.test(toks[i + 1] || "") });
    const out = [];
    const add = (t) => {
      t = clean(t);
      if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    };
    parts.forEach((p, i) => {
      const words = p.text.split(" ");
      if (words.length >= 2) {
        add(p.text);
        if (words.length >= 3) add(words.slice(-2).join(" "));
      } else if (p.joinedByAnd) {
        const next = parts.slice(i + 1).find((x) => x.text.split(" ").length >= 2);
        if (next) add(`${p.text} ${next.text.split(" ").pop()}`);
      } else if (p.text.length >= 5) add(p.text);
    });
    return out.slice(0, 6);
  }
  async function rebid({ ref, limit } = {}) {
    if (!ref) throw new Error("rebid needs an RFP number (e.g. 110326) or a contract number (e.g. 011723-JDC)");
    const m = clean(ref).match(/^(?:RFP|IFB|RFQ)?\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)$/i);
    if (!m) throw new Error(`cannot read ${JSON.stringify(ref)} as an RFP or contract number`);
    const id = m[1];
    const isContract = /^\d{6}-[A-Za-z0-9]+$/.test(id);
    const solNum = isContract ? id.split("-")[0] : id;
    const sols = await api.fetchAll({ resource: "node/competitive_solicitations", filters: [{ path: "field_solicitation_bid_rfp_num", op: "=", value: solNum }] });
    let title = sols[0] ? clean(sols[0].title) : "";
    let status = sols[0] ? sols[0].field_solicitation_process_statu : "";
    if (!title) {
      const bids = (await portal.listBids({ status: "All" })).filter((b) => b.number.toLowerCase() === solNum.toLowerCase());
      if (bids[0]) {
        title = bids[0].name;
        status = bids[0].status;
      }
    }
    if (!title) throw new Error(`no solicitation found for ${solNum}`);
    const queries = deriveQueries(title);
    const seen = /* @__PURE__ */ new Map();
    for (const phrase of queries) {
      const filters = [{ or: [
        { path: "field_cp_contract_description", op: "CONTAINS", value: phrase },
        { path: "field_cp_search_keywords", op: "CONTAINS", value: phrase }
      ] }];
      const rows2 = await api.fetchAll({ resource: "node/contractprofile", fields: PROFILE_FIELDS, filters, sort: "field_cp_end_date" }, { limit });
      for (const a of rows2) {
        const r = seen.get(a.id) || { ...profileRow(a), matched_terms: [] };
        r.matched_terms.push(phrase);
        seen.set(a.id, r);
      }
    }
    const prefixes = /* @__PURE__ */ new Map();
    for (const r of seen.values()) {
      const px = r.contract_number.split("-")[0];
      if (/^\d{6}$/.test(px)) prefixes.set(px, (prefixes.get(px) || 0) + 1);
    }
    const priors = [...prefixes].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([px]) => px);
    if (isContract && !priors.includes(solNum)) priors.unshift(solNum);
    const prior_awards = [];
    for (const px of priors) {
      const year = 2e3 + Number(px.slice(4));
      try {
        const [a] = await portal.awards({ year, rfp: px });
        prior_awards.push(a ? { rfp: px, year, name: a.name, bidder_count: a.bidder_count, awardees: a.awardees } : { rfp: px, year, note: "not in the awards report for that year" });
      } catch (e) {
        prior_awards.push({ rfp: px, year, note: `awards lookup failed: ${e.message}` });
      }
    }
    const rows = [...seen.values()].map((r) => ({ ...r, matched_terms: r.matched_terms.join("; ") })).sort((a, b) => b.matched_terms.split("; ").length - a.matched_terms.split("; ").length || byEnd(a, b));
    return { rows, meta: { solicitation: solNum, title, status, queries, prior_awards, note: "Holders are matched on title words in contract descriptions and keywords: verify each row against its description." } };
  }
  return { contractsSearch, contractsVendor, solicitationsList, bidsList, bidsDetail, awardsList, docsDownload, agenciesList, termsList, rebid, deriveQueries };
}

// src/output.js
import { writeFile as writeFile3 } from "node:fs/promises";
var cell = (v) => {
  if (v === null || v === void 0) return "";
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
var q = (s) => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
function toCsv(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(q).join(",")];
  for (const r of rows) lines.push(cols.map((c) => q(cell(r[c]))).join(","));
  return lines.join("\n") + "\n";
}
function render(result, format = "json") {
  if (format === "csv") return toCsv(result.rows);
  if (format !== "json") throw new Error(`unknown --format ${JSON.stringify(format)}; use json or csv`);
  const body = { count: result.rows.length, ...result.meta ? { meta: result.meta } : {}, rows: result.rows };
  return JSON.stringify(body, null, 2) + "\n";
}
async function emit(result, { format = "json", out, stdout }) {
  const text2 = render(result, format);
  if (out) {
    await writeFile3(out, text2);
    return `wrote ${result.rows.length} rows to ${out}`;
  }
  stdout(text2);
  return null;
}

// src/watch.js
import { mkdir as mkdir3, readFile as readFile2, readdir, rename, unlink, writeFile as writeFile4 } from "node:fs/promises";
import { join as join3 } from "node:path";
var CHANGE_TYPES = [
  "NEW_BID",
  "STATUS_CHANGE",
  "CLOSING_SOON",
  "ADDENDUM",
  "PLAN_TAKERS_JUMP",
  "NEW_AWARD",
  "CONTRACT_EXPIRING",
  "COMPETITOR_CONTRACT"
];
var SNAPSHOT_VERSION = 1;
var KEEP_SNAPSHOTS = 30;
var RECENT_DAYS = 180;
var FINAL_DAYS = 3;
var BID_STATUSES2 = ["Open", "Planned", "Closed", "Awarded"];
var WatchConfigError = class extends Error {
};
var clean2 = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
var low = (s) => clean2(s).toLowerCase();
var uniq = (a) => [...new Set(a)];
function strList(v, name, { required = false } = {}) {
  if (v === void 0 || v === null) {
    if (required) throw new WatchConfigError(`config: "${name}" is required (a list of words to watch for)`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new WatchConfigError(`config: "${name}" must be a list of strings`);
  const out = uniq(v.map(clean2).filter(Boolean));
  if (required && !out.length) throw new WatchConfigError(`config: "${name}" must not be empty`);
  return out;
}
function normalizeConfig(raw, todayIso) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WatchConfigError("config must be a JSON object");
  const year = Number(todayIso.slice(0, 4));
  const posInt = (v, name, dflt) => {
    if (v === void 0) return dflt;
    if (!Number.isInteger(v) || v < 1) throw new WatchConfigError(`config: "${name}" must be a positive whole number`);
    return v;
  };
  let years = raw.award_years;
  if (years === void 0) years = [year, year - 1];
  if (!Array.isArray(years) || years.some((y) => !Number.isInteger(y) || y < 2e3 || y > 2100)) throw new WatchConfigError('config: "award_years" must be a list of four-digit years');
  return {
    profile: clean2(raw.profile),
    keywords: strList(raw.keywords, "keywords", { required: true }),
    exclude_keywords: strList(raw.exclude_keywords, "exclude_keywords"),
    contract_keywords: strList(raw.contract_keywords, "contract_keywords"),
    competitor_brands: strList(raw.competitor_brands, "competitor_brands"),
    closing_soon_days: posInt(raw.closing_soon_days, "closing_soon_days", 14),
    contract_expiring_months: posInt(raw.contract_expiring_months, "contract_expiring_months", 18),
    award_years: uniq(years)
  };
}
var hits = (text2, terms) => {
  const t = low(text2);
  return terms.filter((w) => t.includes(w.toLowerCase()));
};
var wordRe = (w) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
var excludeRe = (w) => new RegExp(`(?<![a-z0-9])${clean2(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?:s|es|ed|ing|ings|ant|ants|ancy|ations?)?(?![a-z0-9])`);
var excluded = (text2, cfg) => {
  const t = low(text2);
  return (cfg._excludeRes ??= cfg.exclude_keywords.map(excludeRe)).some((re) => re.test(t));
};
var matchOf = (text2, terms, cfg) => {
  const m = hits(text2, terms);
  return m.length && !excluded(text2, cfg) ? m : [];
};
var num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
var daysBetween = (isoA, isoB) => Math.round((Date.parse(isoB) - Date.parse(isoA)) / 864e5);
var addDays = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);
function bidEntry(r, matched) {
  return {
    id: r.id,
    number: r.number,
    name: r.name,
    status: r.status,
    closing: r.closing || "",
    closing_local: r.closing_local || "",
    days_left: r.days_left === "" || r.days_left === void 0 || r.days_left === null ? null : num(r.days_left),
    planned_issue: r.planned_issue || "",
    plan_takers: num(r.plan_takers),
    documents: num(r.documents),
    addendums: num(r.addendums),
    url: r.url,
    matched
  };
}
function awardIdentity(a) {
  let number = clean2(a.number);
  let name = clean2(a.name);
  if (!number) {
    const m = name.match(/^(?:[A-Za-z]{2,5}\s*#?\s*)?([A-Za-z]{0,3}-?\d{5,6})\s*[-–—:]\s*(.*)$/);
    if (m) {
      number = m[1];
      name = clean2(m[2]);
    }
  }
  return { number, name };
}
var contractKey = (c) => clean2(c.contract_number).toUpperCase() || `${c.vendor}|${c.end_date}`;
async function collect({ commands, cfg, today, prev }) {
  const bids = {};
  const seenIds = /* @__PURE__ */ new Set();
  const awardRows = {};
  const cutoff = addDays(today, -RECENT_DAYS);
  for (const status of BID_STATUSES2) {
    const { rows } = await commands.bidsList({ status, full: true });
    for (const r of rows) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      const matched = matchOf(`${r.name} ${r.description || ""}`, cfg.keywords, cfg);
      if (!matched.length) continue;
      const open = r.status === "Open" || r.status === "Planned";
      if (!open && !(prev && prev.bids[r.id]) && (r.closing || "").slice(0, 10) < cutoff) continue;
      bids[r.id] = bidEntry(r, matched);
    }
  }
  const matchingNumbers = new Set(Object.values(bids).map((b) => b.number.toLowerCase()).filter((n) => n && n !== "tbd"));
  const awards = {};
  for (const year of cfg.award_years) {
    const { rows } = await commands.awardsList({ year });
    awardRows[year] = rows.length;
    for (const a of rows) {
      const { number, name } = awardIdentity(a);
      if (!a.awardees.length) continue;
      const byName = matchOf(name, cfg.keywords, cfg).length > 0;
      const byNumber = number && matchingNumbers.has(number.toLowerCase());
      if (!byName && !byNumber) continue;
      awards[`${year}:${number || name}`] = { year: Number(year), number, name, awardees: a.awardees, bidder_count: a.bidder_count };
    }
  }
  const raw = /* @__PURE__ */ new Map();
  for (const kw of cfg.contract_keywords) {
    const { rows } = await commands.contractsSearch({ q: kw });
    for (const c of rows) raw.set(contractKey(c), c);
  }
  for (const brand of cfg.competitor_brands) {
    const { rows } = await commands.contractsVendor({ name: brand });
    for (const c of rows) raw.set(contractKey(c), c);
  }
  const contracts = {};
  const brandRes = cfg.competitor_brands.map((b) => [b, wordRe(b)]);
  for (const [key, c] of raw) {
    const text2 = `${c.description} ${c.keywords} ${c.vendor}`;
    const kw = hits(text2, cfg.contract_keywords);
    const brand = (brandRes.find(([, re]) => re.test(low(c.vendor))) || [])[0] || null;
    if (!kw.length && !brand || excluded(c.description, cfg)) continue;
    contracts[key] = {
      contract_number: c.contract_number,
      vendor: c.vendor,
      end_date: c.end_date,
      description: c.description.slice(0, 240),
      brand,
      matched: kw
    };
  }
  return { bids, awards, contracts, fetchedIds: seenIds, meta: { bids_fetched: seenIds.size, award_rows: awardRows } };
}
function assertNotDegraded(prev, cur) {
  const pm = prev && prev.meta;
  if (!pm) return;
  if (pm.bids_fetched > 0 && cur.meta.bids_fetched === 0) throw new Error(`degraded upstream: the bid lists came back empty (the previous run saw ${pm.bids_fetched}); nothing was recorded`);
  for (const [year, n] of Object.entries(pm.award_rows || {})) {
    if (n > 0 && cur.meta.award_rows[year] === 0) throw new Error(`degraded upstream: the ${year} awards report came back empty (the previous run saw ${n} RFPs); nothing was recorded`);
  }
}
function diff({ prev, cur, cfg, today, fetchedIds = /* @__PURE__ */ new Set() }) {
  const baseline = !prev;
  const changes = [];
  if (prev) {
    for (const p of Object.values(prev.bids)) {
      if (cur.bids[p.id] || fetchedIds.has(p.id)) continue;
      if (p.missing_since && daysBetween(p.missing_since, today) > 365) continue;
      cur.bids[p.id] = p.missing_since ? p : { ...p, missing_since: today };
      if (!p.missing_since) changes.push({ type: "STATUS_CHANGE", number: p.number, name: p.name, status: p.status, closing: p.closing_local || p.closing, days_left: p.days_left, planned_issue: p.planned_issue, url: p.url, id: p.id, from: p.status, to: "no longer listed" });
    }
  }
  const horizon = addMonths(today, cfg.contract_expiring_months);
  const thresholds = uniq([cfg.closing_soon_days, FINAL_DAYS]).sort((a, b) => b - a);
  const bidFields = (b) => ({ number: b.number, name: b.name, status: b.status, closing: b.closing_local || b.closing, days_left: b.days_left, planned_issue: b.planned_issue, url: b.url, id: b.id });
  for (const b of Object.values(cur.bids)) {
    if (b.missing_since) continue;
    const p = prev && prev.bids[b.id];
    const isOpen = b.status === "Open" || b.status === "Planned";
    const crossed = b.status === "Open" && b.days_left !== null && b.days_left >= 0 ? thresholds.filter((t) => b.days_left <= t) : [];
    const before = p && p.alerted || [];
    b.alerted = uniq([...before, ...crossed]).sort((x, y) => y - x);
    if (baseline) {
      if (isOpen) changes.push({ type: "NEW_BID", ...bidFields(b), matched: b.matched });
      continue;
    }
    if (!p) {
      if (isOpen) changes.push({ type: "NEW_BID", ...bidFields(b), matched: b.matched });
    } else {
      if (p.status !== b.status) changes.push({ type: "STATUS_CHANGE", ...bidFields(b), from: p.status, to: b.status });
      if (b.addendums > p.addendums || b.documents > p.documents) {
        changes.push({
          type: "ADDENDUM",
          ...bidFields(b),
          addendums: b.addendums,
          documents: b.documents,
          addendums_delta: Math.max(0, b.addendums - p.addendums),
          documents_delta: Math.max(0, b.documents - p.documents)
        });
      }
      if (b.plan_takers > p.plan_takers) changes.push({ type: "PLAN_TAKERS_JUMP", ...bidFields(b), plan_takers: b.plan_takers, from: p.plan_takers, delta: b.plan_takers - p.plan_takers });
    }
    const fresh = crossed.filter((t) => !before.includes(t));
    if (fresh.length) changes.push({ type: "CLOSING_SOON", ...bidFields(b), threshold: Math.min(...fresh), final: Math.min(...fresh) <= FINAL_DAYS });
  }
  if (!baseline) {
    for (const [key, a] of Object.entries(cur.awards)) {
      if (prev.awards[key]) continue;
      const bid = Object.values(cur.bids).find((b) => a.number && b.number.toLowerCase() === a.number.toLowerCase());
      changes.push({ type: "NEW_AWARD", number: a.number, name: a.name, year: a.year, awardees: a.awardees, bidder_count: a.bidder_count, ...bid ? { url: bid.url } : {} });
    }
  }
  for (const [key, c] of Object.entries(cur.contracts)) {
    const p = prev && prev.contracts[key];
    const inWindow = c.end_date >= today && c.end_date <= horizon;
    c.expiring_reported = !!(p && p.expiring_reported || inWindow);
    const row = { contract_number: c.contract_number, vendor: c.vendor, end_date: c.end_date, description: c.description };
    if (inWindow && !(p && p.expiring_reported)) {
      changes.push({ type: "CONTRACT_EXPIRING", ...row, months_left: Math.max(0, Math.round(daysBetween(today, c.end_date) / 30.4)), note: "upcoming re-bid signal" });
    }
    if (c.brand && !p) changes.push({ type: "COMPETITOR_CONTRACT", ...row, brand: c.brand });
  }
  const order = (t) => CHANGE_TYPES.indexOf(t);
  const dated = (c) => c.type === "CONTRACT_EXPIRING" || c.type === "COMPETITOR_CONTRACT" ? c.end_date : "";
  return changes.map((c, i) => [c, i]).sort((a, b) => order(a[0].type) - order(b[0].type) || dated(a[0]).localeCompare(dated(b[0])) || a[1] - b[1]).map(([c]) => c);
}
function summarize(changes) {
  const by_type = {};
  for (const t of CHANGE_TYPES) {
    const n = changes.filter((c) => c.type === t).length;
    if (n) by_type[t] = n;
  }
  return { total: changes.length, by_type };
}
var TITLES = {
  NEW_BID: "New bids",
  STATUS_CHANGE: "Status changes",
  CLOSING_SOON: "Closing soon",
  ADDENDUM: "New addenda or documents",
  PLAN_TAKERS_JUMP: "Plan-taker jumps",
  NEW_AWARD: "New awards",
  CONTRACT_EXPIRING: "Contracts expiring (upcoming re-bids)",
  COMPETITOR_CONTRACT: "Competitor contracts"
};
var LABELS = {
  NEW_BID: ["new bid", "new bids"],
  STATUS_CHANGE: ["status change", "status changes"],
  CLOSING_SOON: ["closing soon", "closing soon"],
  ADDENDUM: ["addendum update", "addendum updates"],
  PLAN_TAKERS_JUMP: ["plan-taker jump", "plan-taker jumps"],
  NEW_AWARD: ["new award", "new awards"],
  CONTRACT_EXPIRING: ["expiring contract", "expiring contracts"],
  COMPETITOR_CONTRACT: ["competitor contract", "competitor contracts"]
};
var BASELINE_TITLES = { NEW_BID: "Open and planned bids matching your watch", CONTRACT_EXPIRING: "Contracts expiring (upcoming re-bids)", COMPETITOR_CONTRACT: "Competitor contracts" };
var link = (c) => c.url ? `[${c.number && c.number !== "TBD" ? `${c.number} ` : ""}${c.name}](${c.url})` : `${c.number ? c.number + " " : ""}${c.name}`;
var when = (c) => c.status === "Planned" ? `planned issue ${String(c.planned_issue).slice(0, 10) || "TBD"}` : c.closing ? `closes ${c.closing}${c.days_left !== null && c.days_left !== void 0 ? ` (${c.days_left}d)` : ""}` : "";
var LINE = {
  NEW_BID: (c) => `${link(c)} [${c.status}] ${when(c)}`.trim(),
  STATUS_CHANGE: (c) => `${link(c)}: ${c.from} -> ${c.to}`,
  CLOSING_SOON: (c) => `${link(c)}: ${c.days_left} day${c.days_left === 1 ? "" : "s"} left${c.final ? " (final)" : ""}, closes ${c.closing}`,
  ADDENDUM: (c) => `${link(c)}: ${[c.addendums_delta && `+${c.addendums_delta} addendum${c.addendums_delta === 1 ? "" : "s"} (${c.addendums})`, c.documents_delta && `+${c.documents_delta} document${c.documents_delta === 1 ? "" : "s"} (${c.documents})`].filter(Boolean).join(", ")}`,
  PLAN_TAKERS_JUMP: (c) => `${link(c)}: plan takers ${c.from} -> ${c.plan_takers} (+${c.delta})`,
  NEW_AWARD: (c) => `${c.url ? link(c) : `${c.number ? c.number + " " : ""}${c.name}`} (${c.year}): awarded to ${c.awardees.join("; ")}`,
  CONTRACT_EXPIRING: (c) => `${c.vendor} ${c.contract_number}: ends ${c.end_date} (~${c.months_left} mo)${c.description ? `: ${c.description.slice(0, 100)}` : ""}`,
  COMPETITOR_CONTRACT: (c) => `${c.brand}: ${c.vendor} ${c.contract_number}, ends ${c.end_date}${c.description ? `: ${c.description.slice(0, 100)}` : ""}`
};
function renderMd(result, cfg) {
  const { date, baseline, changes, summary } = result;
  const L = [`# Sourcewell watch: ${date}${cfg.profile ? ` (${cfg.profile})` : ""}`, ""];
  if (!changes.length) {
    L.push(baseline ? "Baseline run: nothing matched your watch yet." : "Nothing new today.", "");
    return L.join("\n");
  }
  const counts = Object.entries(summary.by_type).map(([t, n]) => `${n} ${LABELS[t][n === 1 ? 0 : 1]}`);
  L.push(baseline ? "**Baseline run: current landscape** (changes will be reported from tomorrow)" : `**${summary.total} change${summary.total === 1 ? "" : "s"}**`, counts.join(" | "), "");
  for (const t of CHANGE_TYPES) {
    const rows = changes.filter((c) => c.type === t);
    if (!rows.length) continue;
    L.push(`## ${baseline ? BASELINE_TITLES[t] : TITLES[t]} (${rows.length})`);
    for (const c of rows) L.push(`- ${LINE[t](c)}`);
    L.push("");
  }
  return L.join("\n");
}
function render2(result, cfg, format) {
  if (format === "json") return JSON.stringify(result, null, 2) + "\n";
  if (format === "md") return renderMd(result, cfg);
  throw new WatchConfigError(`watch --format must be md or json (got ${JSON.stringify(format)})`);
}
async function atomicWrite(file, text2) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile4(tmp, text2);
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {
    });
    throw e;
  }
}
async function loadLatest(stateDir) {
  let text2;
  try {
    text2 = await readFile2(join3(stateDir, "latest.json"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  let snap;
  try {
    snap = JSON.parse(text2);
  } catch {
    throw new Error(`${join3(stateDir, "latest.json")} is not valid JSON: fix or delete it (deleting re-runs the baseline)`);
  }
  if (!snap || snap.version !== SNAPSHOT_VERSION || !snap.bids || !snap.awards || !snap.contracts) throw new Error(`${join3(stateDir, "latest.json")} is not a watch snapshot this version understands: delete it to re-run the baseline`);
  return snap;
}
async function pruneSnapshots(stateDir) {
  const files = (await readdir(stateDir)).filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_SNAPSHOTS))) await unlink(join3(stateDir, f)).catch(() => {
  });
}
async function loadConfig(path, todayIso) {
  let text2;
  try {
    text2 = await readFile2(path, "utf8");
  } catch (e) {
    throw new WatchConfigError(`cannot read config ${path}: ${e.code === "ENOENT" ? "file not found (create one with: watch init --out watch.json)" : e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch (e) {
    throw new WatchConfigError(`config ${path} is not valid JSON: ${e.message}`);
  }
  return normalizeConfig(raw, todayIso);
}
async function runWatch({ commands, today, configPath, stateDir, format = "md", deliver }) {
  if (!configPath) throw new WatchConfigError("watch run needs --config <watch.json>");
  if (!stateDir) throw new WatchConfigError("watch run needs --state-dir <dir>");
  if (format !== "md" && format !== "json") throw new WatchConfigError(`watch --format must be md or json (got ${JSON.stringify(format)})`);
  const date = today();
  const cfg = await loadConfig(configPath, date);
  const prev = await loadLatest(stateDir);
  const { fetchedIds, ...cur } = await collect({ commands, cfg, today: date, prev });
  assertNotDegraded(prev, cur);
  const changes = diff({ prev, cur, cfg, today: date, fetchedIds });
  const snapshot = { version: SNAPSHOT_VERSION, date, ...cur };
  const result = { date, baseline: !prev, changes, summary: summarize(changes) };
  const text2 = render2(result, cfg, format);
  if (deliver) await deliver(text2);
  await mkdir3(stateDir, { recursive: true });
  const body = JSON.stringify(snapshot, null, 1) + "\n";
  await atomicWrite(join3(stateDir, `snapshot-${date}.json`), body);
  await atomicWrite(join3(stateDir, "latest.json"), body);
  await pruneSnapshots(stateDir);
  return { text: text2, result };
}

// src/watch-example.js
var EXAMPLE_CONFIG = {
  profile: "work-truck upfitter (example)",
  keywords: [
    "truck bod",
    "service bod",
    "utility bod",
    "dump bod",
    "upfit",
    "mechanic truck",
    "service truck",
    "work truck",
    "chassis",
    "crane",
    "lube",
    "flatbed",
    "truck equipment",
    "vocational",
    "bucket truck",
    "digger derrick",
    "van upfit",
    "cargo van",
    "heavy and compact construction"
  ],
  exclude_keywords: [
    "electrification",
    "charging",
    "curb",
    "consult",
    "ambulance",
    "fire",
    "school bus",
    "office",
    "fuel",
    "surveillance",
    "MRO",
    "airport",
    "rental",
    "refuse",
    "salt",
    "recycling",
    "vegetation"
  ],
  contract_keywords: [
    "truck bod",
    "service bod",
    "dump bod",
    "upfit",
    "work truck",
    "chassis",
    "crane",
    "flatbed",
    "truck equipment",
    "bucket truck",
    "digger derrick",
    "van upfit"
  ],
  competitor_brands: [
    "Stellar",
    "Knapheide",
    "Reading",
    "Auto Crane",
    "IMT",
    "Maintainer",
    "Miller",
    "Ranger Design",
    "Bedrock",
    "Altec",
    "Terex",
    "Elliott"
  ],
  closing_soon_days: 14,
  contract_expiring_months: 24
};

// src/cli.js
import { readFile as readFile3, writeFile as writeFile5 } from "node:fs/promises";
import { existsSync } from "node:fs";
var deps = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cacheDir: void 0,
  env: process.env,
  readStdin: async () => {
    let d = "";
    process.stdin.setEncoding("utf8");
    for await (const c of process.stdin) d += c;
    return d;
  }
};
var UsageError = class extends Error {
};
var GLOBAL = { string: ["format", "out", "limit"], bool: ["no-cache", "full", "help", "version"] };
var COMMANDS = {
  "contracts search": { string: ["q", "field", "expiring-within"], bool: [], usage: "contracts search --q <text> [--field description|keywords|title|number|brand] [--expiring-within <months>]" },
  "contracts vendor": { string: [], bool: [], positional: 1, usage: "contracts vendor <name>" },
  "solicitations list": { string: ["status"], bool: ["open"], usage: "solicitations list [--open] [--status Open|Pending|Awarded]" },
  "bids list": { string: ["status", "q"], bool: [], usage: "bids list [--status open|planned|closed|awarded|archived|all] [--q <keywords>]" },
  "bids detail": { string: [], bool: [], positional: 1, usage: "bids detail <tenderId|rfp-number>" },
  awards: { string: ["year", "rfp"], bool: [], usage: "awards --year YYYY [--rfp <number>]" },
  "docs download": { string: [], bool: ["password-stdin"], positional: 1, usage: "docs download <tenderId|rfp-number> --out <dir>   (needs SOURCEWELL_USER + SOURCEWELL_PASSWORD or --password-stdin)" },
  rebid: { string: [], bool: [], positional: 1, usage: "rebid <rfp-or-contract-number>" },
  "agencies list": { string: ["state", "type"], bool: [], usage: "agencies list [--state XX] [--type <text>]" },
  "categories list": { string: [], bool: [], usage: "categories list" },
  "states list": { string: [], bool: [], usage: "states list" },
  "watch run": { string: ["config", "state-dir"], bool: ["cache"], usage: "watch run --config <watch.json> --state-dir <dir> [--format md|json] [--out <file>] [--cache]   (daily alerts: diff against the last snapshot; bypasses the local cache unless --cache)" },
  "watch init": { string: [], bool: [], usage: "watch init --out <watch.json>   (write the example watch config to edit)" },
  doctor: { string: [], bool: [], usage: "doctor" }
};
function helpText() {
  return `sourcewell ${VERSION}: read-only research of Sourcewell's public cooperative-purchasing data (unofficial)

Usage: sourcewell <command> [options]

Commands:
${Object.values(COMMANDS).map((c) => "  " + c.usage).join("\n")}

Global options:
  --format json|csv   output format (default json; watch run: md|json, default md)
  --out <file>        write output to a file instead of stdout
  --limit <n>         stop after n rows
  --full              include long text fields (contracts: products_services; bids: description)
  --no-cache          skip the 24h local cache (~/.cache/sourcewell)
  --help, --version
`;
}
function parseArgs(argv) {
  const words = [];
  const flags = {};
  let i = 0;
  const rest = [];
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      flags[name] = eq > 0 ? a.slice(eq + 1) : null;
      if (eq < 0) {
        const takes = GLOBAL.string.includes(name) || Object.values(COMMANDS).some((c) => c.string.includes(name));
        if (takes) {
          if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
          flags[name] = argv[++i];
        } else flags[name] = true;
      }
    } else words.push(a);
  }
  words.push(...rest);
  return { words, flags };
}
function resolve(words) {
  const two = words.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { name: two, args: words.slice(2) };
  if (COMMANDS[words[0]]) return { name: words[0], args: words.slice(1) };
  return null;
}
var num2 = (v, name) => {
  if (v === void 0) return void 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
};
async function doctor(http) {
  const checks = [];
  const run = async (name, fn) => {
    const t = Date.now();
    try {
      const detail = await fn();
      checks.push({ check: name, ok: true, detail, ms: Date.now() - t });
    } catch (e) {
      checks.push({ check: name, ok: false, detail: e.message, ms: Date.now() - t });
    }
  };
  await run("node", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 20) throw new Error(`Node ${process.versions.node}: need 20+`);
    return process.versions.node;
  });
  await run("jsonapi", async () => {
    const doc = await http.getJson(buildUrl({ resource: "taxonomy_term/states", limit: 1 }));
    if (!doc.data || !doc.data.length) throw new Error("no rows returned");
    return "public API reachable";
  });
  await run("bid portal", async () => {
    const res = await http.request(PAGE_URL, { method: "GET", headers: { accept: "text/html" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    parseTendersPage(await res.text());
    return "bid list reachable";
  });
  await run("cache dir", async () => http.cacheDir);
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
    const cmd = resolve(words);
    if (!cmd) throw new UsageError(`unknown command: ${words.join(" ")}

${helpText()}`);
    const spec = COMMANDS[cmd.name];
    for (const k of ["user", "username", "password", "pass"]) {
      if (k in flags) throw new UsageError(`--${k} is not accepted: credentials are never passed on the command line. Set SOURCEWELL_USER and SOURCEWELL_PASSWORD (or use --password-stdin).`);
    }
    for (const k of Object.keys(flags)) {
      if (!GLOBAL.string.includes(k) && !GLOBAL.bool.includes(k) && !spec.string.includes(k) && !spec.bool.includes(k)) throw new UsageError(`unknown option --${k} for "${cmd.name}". Usage: ${spec.usage}`);
    }
    const positional = spec.positional || 0;
    if (cmd.args.length !== positional) throw new UsageError(`usage: ${spec.usage}`);
    const http = createHttp({ fetchImpl: deps.fetch, sleep: deps.sleep, now: deps.now, cacheDir: deps.cacheDir || defaultCacheDir(), noCache: !!flags["no-cache"] || cmd.name === "watch run" && !flags.cache });
    const api = createJsonApi(http);
    const portal = createPortal(http);
    const today = () => new Date(deps.now()).toISOString().slice(0, 10);
    const c = createCommands({ api, portal, today });
    const limit = num2(flags.limit, "limit");
    const full = !!flags.full;
    if (cmd.name === "watch init") {
      const text2 = JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n";
      if (!flags.out) {
        deps.stdout(text2);
        return;
      }
      if (existsSync(flags.out)) throw new UsageError(`${flags.out} already exists: not overwriting your config (pick another --out or delete it)`);
      await writeFile5(flags.out, text2);
      deps.stderr(`wrote example watch config to ${flags.out}: edit the keyword lists, then run: watch run --config ${flags.out} --state-dir <dir>
`);
      return;
    }
    if (cmd.name === "watch run") {
      const format = flags.format || "md";
      if (format !== "md" && format !== "json") throw new UsageError("watch run --format must be md or json");
      let out;
      const deliver = async (text2) => {
        if (flags.out) {
          await writeFile5(flags.out, text2);
          if (await readFile3(flags.out, "utf8") !== text2) throw new Error(`could not verify the digest written to ${flags.out}`);
          deps.stderr(`wrote digest to ${flags.out}
`);
        }
        deps.stdout(text2);
      };
      try {
        out = await runWatch({ commands: c, today, configPath: flags.config, stateDir: flags["state-dir"], format, deliver });
      } catch (e) {
        if (e instanceof WatchConfigError) throw new UsageError(e.message);
        throw e;
      }
      return;
    }
    let result;
    switch (cmd.name) {
      case "contracts search":
        result = await c.contractsSearch({ q: flags.q, field: flags.field, expiringWithin: flags["expiring-within"], limit, full });
        break;
      case "contracts vendor":
        result = await c.contractsVendor({ name: cmd.args[0], limit, full });
        break;
      case "solicitations list":
        result = await c.solicitationsList({ open: !!flags.open, status: flags.status, limit });
        break;
      case "bids list":
        result = await c.bidsList({ status: flags.status, q: flags.q, full });
        if (limit) result.rows = result.rows.slice(0, limit);
        break;
      case "bids detail":
        result = await c.bidsDetail({ ref: cmd.args[0] });
        break;
      case "awards":
        result = await c.awardsList({ year: flags.year, rfp: flags.rfp });
        if (limit) result.rows = result.rows.slice(0, limit);
        break;
      case "docs download": {
        const username = deps.env.SOURCEWELL_USER;
        const password = flags["password-stdin"] ? (await deps.readStdin()).replace(/\r?\n$/, "") : deps.env.SOURCEWELL_PASSWORD;
        if (!username || !password) throw new UsageError("docs download needs your own portal login: set SOURCEWELL_USER and SOURCEWELL_PASSWORD (or pipe the password with --password-stdin)");
        result = await c.docsDownload({ ref: cmd.args[0], outDir: flags.out, username, password });
        flags.out = void 0;
        break;
      }
      case "rebid":
        result = await c.rebid({ ref: cmd.args[0], limit });
        break;
      case "agencies list":
        result = await c.agenciesList({ state: flags.state, type: flags.type, limit });
        break;
      case "categories list":
        result = await c.termsList("taxonomy_term/category", { limit });
        break;
      case "states list":
        result = await c.termsList("taxonomy_term/states", { limit });
        break;
      case "doctor":
        result = await doctor(http);
        break;
    }
    const note = await emit(result, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
    if (note) deps.stderr(note + "\n");
    if (result.meta && result.meta.note && !flags.out && (flags.format || "json") === "csv") deps.stderr(`${result.meta.title}: ${result.meta.note}
`);
    if (cmd.name === "doctor" && result.rows.some((r) => !r.ok)) process.exitCode = 1;
  } catch (e) {
    if (e instanceof UsageError) {
      deps.stderr(`sourcewell: ${e.message}
`);
      process.exitCode = 2;
    } else if (e instanceof AllowlistError) {
      deps.stderr(`sourcewell: refused: ${e.message}
`);
      process.exitCode = 2;
    } else {
      deps.stderr(`sourcewell: ${e.message}
`);
      process.exitCode = 1;
    }
  }
}
if (typeof process !== "undefined" && process.stdout && process.stdout.on) process.stdout.on("error", (e) => {
  if (e.code !== "EPIPE") throw e;
  process.exit(0);
});

// bin/sourcewell.js
await main();
