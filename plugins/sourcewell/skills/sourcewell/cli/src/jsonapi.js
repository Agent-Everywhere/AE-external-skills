// Read-only client for the public JSON:API. GET only, allowlisted resources/fields only.
import { ALLOWED, BASE, JSONAPI_PREFIX, OPERATORS, AllowlistError, assertFields, assertNextLink, assertPath, assertRedirect, assertResource } from "./allowlist.js";

/**
 * Build a JSON:API URL.
 * filters: [{path, op, value}] (ANDed) or [{or: [{path, op, value}, ...]}] (an OR group, ANDed with the rest).
 */
export function buildUrl({ resource, fields, filters = [], sort, limit = 50 }) {
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
  if (sort) { const desc = sort.startsWith("-"); assertPath(resource, desc ? sort.slice(1) : sort); push("sort", sort); }
  push("page[limit]", String(Math.min(Math.max(limit, 1), 50)));
  return `${BASE}${JSONAPI_PREFIX}/${resource}?${params.join("&")}`;
}

export function createJsonApi(http, { maxPages = 400 } = {}) {
  /** Fetch every page (following links.next.href) up to `limit` rows. Returns the raw `attributes` + id of each row. */
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

export { ALLOWED };
