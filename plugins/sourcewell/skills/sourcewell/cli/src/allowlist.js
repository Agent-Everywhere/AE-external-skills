// Strict allowlist of the only JSON:API resources and fields this CLI will ever request.
// Anything else throws before a network call is made.

export const BASE = "https://www.sourcewell-mn.gov";
export const JSONAPI_PREFIX = "/jsonapi";

export const ALLOWED = {
  "node/contractprofile": {
    type: "node--contractprofile",
    fields: [
      "title", "field_cp_contract_number", "field_cp_end_date", "field_cp_contract_description",
      "field_cp_products_services", "field_cp_search_keywords", "field_cp_brand_name", "field_cp_eziqc_category",
    ],
  },
  "node/contract": {
    type: "node--contract",
    fields: [
      "title", "field_account_name", "field_contract_start_date", "field_contract_end_date",
      "field_solicitation_title", "field_city", "field_state_sf",
    ],
  },
  "node/competitive_solicitations": {
    type: "node--competitive_solicitations",
    fields: ["title", "field_solicitation_bid_rfp_num", "field_solicitation_process_statu"],
  },
  "node/account": {
    type: "node--account",
    fields: [
      "title", "field_type", "field_sub_type", "field_record_type", "field_city",
      "field_state_code", "field_member_status", "field_website", "field_member_number",
    ],
  },
  "taxonomy_term/category": { type: "taxonomy_term--category", fields: ["name"] },
  "taxonomy_term/states": { type: "taxonomy_term--states", fields: ["name"] },
};

export const OPERATORS = ["=", "<>", "CONTAINS", "STARTS_WITH", ">", ">=", "<", "<=", "IS NULL", "IS NOT NULL"];

export class AllowlistError extends Error {
  constructor(message) { super(message); this.name = "AllowlistError"; this.code = "ALLOWLIST"; }
}

export function assertResource(resource) {
  if (typeof resource !== "string" || !Object.prototype.hasOwnProperty.call(ALLOWED, resource)) {
    throw new AllowlistError(`resource not on the allowlist: ${JSON.stringify(resource)}. Allowed: ${Object.keys(ALLOWED).join(", ")}`);
  }
  return ALLOWED[resource];
}

/** Validate fields (a sparse fieldset is always sent; it defaults to every allowed field). Returns the list. */
export function assertFields(resource, fields) {
  const spec = assertResource(resource);
  const list = fields && fields.length ? fields : spec.fields;
  for (const f of list) {
    if (!spec.fields.includes(f)) throw new AllowlistError(`field not on the allowlist for ${resource}: ${JSON.stringify(f)}`);
  }
  return list;
}

export function assertPath(resource, path) {
  const spec = assertResource(resource);
  if (!spec.fields.includes(path)) throw new AllowlistError(`filter/sort path not on the allowlist for ${resource}: ${JSON.stringify(path)}`);
}

/** Validate a pagination `next` link: same origin, same allowed resource, sparse fieldset still present and allowed. */
export function assertNextLink(href, resource) {
  const spec = assertResource(resource);
  let u;
  try { u = new URL(href); } catch { throw new AllowlistError(`bad next link: ${href}`); }
  if (u.origin !== BASE) throw new AllowlistError(`next link leaves the allowed origin: ${u.origin}`);
  if (u.pathname !== `${JSONAPI_PREFIX}/${resource}`) throw new AllowlistError(`next link points at a different resource: ${u.pathname}`);
  const sparse = u.searchParams.get(`fields[${spec.type}]`);
  if (!sparse) throw new AllowlistError("next link dropped the sparse fieldset");
  assertFields(resource, sparse.split(","));
  return u.toString();
}

// ---- Bid portal: the only routes this CLI will ever call (everything else, including any
// register / submit / question route, throws before a request is made).
export const PORTAL_ORIGIN = "https://proportal.sourcewell-mn.gov";
const G = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const T = "/Module/Tenders/en";
export const PORTAL_ROUTES = [
  ["GET", new RegExp(`^${T}/?$`, "i")],
  ["GET", new RegExp(`^${T}/Login/Index/${G}$`, "i")],
  ["POST", new RegExp(`^${T}/Login/Index/${G}$`, "i")],
  ["POST", new RegExp(`^${T}/Tender/Search/${G}$`, "i")],
  ["GET", new RegExp(`^${T}/Tender/Detail/${G}$`, "i")],
  ["GET", new RegExp(`^${T}/Tender/ContractAwards/${G}$`, "i")],
  ["GET", new RegExp(`^${T}/Tender/DownloadBidDocuments/${G}$`, "i")],
  ["GET", new RegExp(`^${T}/Tender/PreviewDocuments/${G}$`, "i")],
];

export function assertPortalRequest(method, href) {
  let u;
  try { u = new URL(href); } catch { throw new AllowlistError(`bad portal URL: ${href}`); }
  if (u.origin !== PORTAL_ORIGIN) throw new AllowlistError(`portal request leaves the allowed origin: ${u.origin}`);
  const m = String(method).toUpperCase();
  if (!PORTAL_ROUTES.some(([vm, re]) => vm === m && re.test(u.pathname))) {
    throw new AllowlistError(`portal route not on the allowlist: ${m} ${u.pathname}`);
  }
  return u.toString();
}
