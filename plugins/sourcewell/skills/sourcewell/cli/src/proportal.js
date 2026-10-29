// Sourcewell procurement portal (bids and tenders).
// Public, no login: bid list (JSON search endpoint the page itself uses), bid detail (HTML), contract
// awards report (HTML). Login needed only for `docs download`, with the user's own credentials, held in
// memory for the one call: never cached, never logged, never put on a command line.
// Every request is checked against the route allowlist in allowlist.js first.
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PORTAL_ORIGIN, assertPortalRequest } from "./allowlist.js";
import { HttpError } from "./http.js";

export const PORTAL = PORTAL_ORIGIN;
export const TENDERS_PATH = "/Module/Tenders/en";
export const PAGE_URL = PORTAL + TENDERS_PATH;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 60 * 60 * 1000;
const PAGE_SIZE = 100;
export const BID_STATUSES = ["Open", "Planned", "Closed", "Unofficial", "Awarded", "Cancelled", "Terminated", "Archived"];

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2]) : null;
};
const decode = (s) => String(s ?? "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, "&");
const text = (html) => decode(String(html ?? "").replace(/<\/(p|li|div|tr|h\d)>|<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** Pull the node id and the anti-forgery token the bid grid uses out of the portal's landing page. */
export function parseTendersPage(html) {
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

/** Hidden inputs (incl. the anti-forgery token) of the login form, id="frmLogin". */
export function parseLoginForm(html) {
  const at = html.search(/<form\b[^>]*\bid=["']frmLogin["']/i);
  if (at < 0) throw new Error("portal page changed: login form not found");
  const end = html.indexOf("</form>", at);
  const form = html.slice(at, end < 0 ? undefined : end);
  const fields = {};
  for (const tag of form.match(/<input\b[^>]*>/gi) || []) {
    if ((attr(tag, "type") || "").toLowerCase() === "hidden" && attr(tag, "name")) fields[attr(tag, "name")] = attr(tag, "value") ?? "";
  }
  if (!fields.__RequestVerificationToken) throw new Error("portal page changed: login token not found");
  return fields;
}

/** Parse "/Date(1793302200000)/" to an ISO timestamp. */
export function parseMsDate(s) {
  const m = typeof s === "string" && s.match(/\/Date\((-?\d+)\)\//);
  return m ? new Date(Number(m[1])).toISOString() : null;
}

/** "RFP 110326 - Heavy ..." -> {type:"RFP", number:"110326", name:"Heavy ..."}. */
export function parseTitle(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^([A-Za-z]{2,5})\s+(?:[-–—]\s+)?([A-Z0-9][A-Z0-9-]*)\s+[-–—:]\s+(.*)$/);
  return m ? { type: m[1].toUpperCase(), number: m[2], name: m[3] } : { type: "", number: "", name: t };
}

/** Map the portal's search response rows to compact bid rows. */
export function parseBids(payload, { full = false } = {}) {
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
      planned_issue: planned ? parseMsDate(r.DatePlannedIssue) || "" : "", // Planned = upcoming RFP: estimated publish date
      days_to_issue: planned ? r.DaysLeftPublish ?? "" : "",
      plan_takers: r.PlanTakers ?? "",
      documents: r.Documents,
      addendums: r.Addendums ?? "",
      id: r.Id,
      url: `${PAGE_URL}/Tender/Detail/${r.Id}`,
    };
    if (full) row.description = text(r.Description);
    return row;
  });
}

/** Parse the bid detail page: label/value table plus NAICS-style category lines. */
export function parseDetail(html) {
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
    categories: cats,
  };
}

/** Parse the contract awards report: per RFP, every bidder and every awardee. */
export function parseAwards(html, year) {
  const heads = [...html.matchAll(/<strong>\s*([^<#]*?)#\s*([^<]*?)\s*<\/strong>/gi)];
  // A year with no report is a short shell page. A substantial page with no recognisable headings means the layout changed.
  if (!heads.length && (html.length > 3000 || /Award is to|<table/i.test(html))) throw new Error("portal page changed: no awards headings found in the contract awards report");
  return heads.map((h, i) => {
    const seg = html.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const t = parseTitle(decode(h[2]));
    const bidders = [...seg.matchAll(/<td style="width:30%;">([^<]*)<\/td>\s*<td style="width:30%;">[^<]*<\/td>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean);
    const award = (seg.match(/Award is to([\s\S]*?)<\/td>/i) || [])[1] || "";
    const awardees = [...award.matchAll(/<em>([\s\S]*?)<\/em>/gi)].map((m) => decode(m[1]).replace(/\s+/g, " ").trim());
    return { year: Number(year), number: t.number, type: t.type, name: t.name, bidder_count: bidders.length, awardees, bidders };
  });
}

function makeJar() {
  const m = new Map();
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
    header: () => [...m].map(([k, v]) => `${k}=${v}`).join("; "),
  };
}

export function createPortal(http) {
  let homeP = null;

  /** One allowlisted portal request, following redirects by hand (each hop re-checked), cookies in `jar`. */
  async function call(jar, method, url, { headers = {}, body } = {}) {
    let m = method;
    let u = url;
    let b = body;
    for (let hop = 0; hop < 6; hop++) {
      assertPortalRequest(m, u);
      const cookie = jar.header();
      const res = await http.request(u, { method: m, redirect: "manual", headers: { ...headers, ...(cookie ? { cookie } : {}) }, ...(b ? { body: b } : {}) });
      jar.absorb(res);
      const loc = res.status >= 300 && res.status < 400 && res.headers.get("location");
      if (!loc) return { res, url: u };
      u = new URL(loc, u).toString();
      m = "GET"; b = undefined;
      headers = { ...headers }; delete headers["content-type"];
    }
    throw new Error("too many redirects from the portal");
  }

  /** Landing page: node id + token + session cookie, fetched once per process (memory only). */
  function home() {
    homeP ??= (async () => {
      const jar = makeJar();
      const { res } = await call(jar, "GET", PAGE_URL, { headers: { accept: "text/html" } });
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${PAGE_URL}`, res.status, PAGE_URL);
      return { ...parseTendersPage(await res.text()), jar };
    })();
    homeP.catch(() => { homeP = null; });
    return homeP;
  }

  async function page(url, key) {
    return http.cached(key || `GET ${url}`, async () => {
      const { res } = await call(makeJar(), "GET", url, { headers: { accept: "text/html" } });
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
      return res.text();
    });
  }

  /** List bids. status: Open (default), any of BID_STATUSES, or "All". Rows come from the portal's own search endpoint. */
  async function listBids({ status = "Open", q = "", full = false } = {}) {
    const wanted = String(status).toLowerCase() === "all" ? "" : BID_STATUSES.find((s) => s.toLowerCase() === String(status).toLowerCase());
    if (wanted === undefined) throw new Error(`unknown bid status ${JSON.stringify(status)}; use one of ${BID_STATUSES.map((s) => s.toLowerCase()).join(", ")}, all`);
    const payloads = await http.cached(`bids ${wanted} ${q}`, async () => {
      const { nodeId, token, jar } = await home();
      const dir = wanted === "Open" || wanted === "Planned" ? "ASC" : "DESC";
      const out = [];
      let start = 0;
      for (;;) {
        const url = `${PAGE_URL}/Tender/Search/${nodeId}?status=${encodeURIComponent(wanted)}&limit=${PAGE_SIZE}&start=${start}&dir=${dir}&from=&to=&sort=${encodeURIComponent(`DateClosing ${dir},Id`)}`;
        const { res } = await call(jar, "POST", url, {
          headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest", accept: "application/json" },
          body: new URLSearchParams({ keywords: q, __RequestVerificationToken: token }).toString(),
        });
        if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
        let payload;
        try { payload = JSON.parse(await res.text()); } catch { throw new Error("portal search did not return JSON (the page may have changed)"); }
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

  /** A tender id (GUID) or an RFP/bid number -> tender id. */
  async function resolveId(ref) {
    const r = String(ref || "").trim();
    if (GUID_RE.test(r)) return r;
    const num = r.replace(/^(?:RFP|IFB|RFQ)\s+/i, "").toLowerCase();
    if (!num) throw new Error("need a tender id or an RFP number");
    const hit = (await listBids({ status: "All" })).filter((b) => b.number.toLowerCase() === num);
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

  /** Download a bid's document ZIP. Needs the caller's own portal login; creds are used for this call only. */
  async function downloadDocs({ ref, outDir, username, password }) {
    if (!username || !password) throw new Error("docs download needs your own portal login: set SOURCEWELL_USER and SOURCEWELL_PASSWORD (or pipe the password with --password-stdin)");
    const id = await resolveId(ref);
    const { nodeId } = await home();
    const jar = makeJar(); // fresh session, memory only
    const loginUrl = `${PAGE_URL}/Login/Index/${nodeId}`;
    const lp = await call(jar, "GET", loginUrl, { headers: { accept: "text/html" } });
    if (!lp.res.ok) throw new HttpError(`HTTP ${lp.res.status} for the login page`, lp.res.status, loginUrl);
    const fields = parseLoginForm(await lp.res.text());
    const body = new URLSearchParams({ ...fields, Username: username, Password: password }).toString();
    const post = await http.request(assertPortalRequest("POST", loginUrl), {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(), accept: "text/html" },
      body,
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
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `${base}-documents.zip`);
    await writeFile(file, buf);
    return { file, bytes: buf.length, bid_number: bid ? bid.number : "", id };
  }

  return { listBids, bidDetail, awards, downloadDocs, resolveId, home };
}
