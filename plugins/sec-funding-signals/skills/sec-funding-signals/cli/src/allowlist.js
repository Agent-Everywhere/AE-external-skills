// Strict allowlist of the only hosts and paths this CLI will ever request. Anything else throws before a network call.

export const HOSTS = ["efts.sec.gov", "www.sec.gov"];
export const SEARCH_PATH = "/LATEST/search-index";
export const SEARCH_PARAMS = ["q", "forms", "dateRange", "startdt", "enddt", "from"];
const DOC_RE = /^\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/primary_doc\.xml$/;

export class AllowlistError extends Error {
  constructor(message) { super(message); this.name = "AllowlistError"; }
}

/** Throws unless `url` is an https EDGAR full-text search request or a Form D primary_doc.xml. Returns the URL object. */
export function assertAllowed(url) {
  let u;
  try { u = new URL(url); } catch { throw new AllowlistError(`not a URL: ${url}`); }
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
