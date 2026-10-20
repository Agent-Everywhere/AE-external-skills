// companies_websites.js: company websites for account ids (search results carry none).
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit companies_websites.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params ids delayMs batch
// @required ids
// params: { ids: [company ids or "urn:li:fs_salesCompany:<id>" strings], delayMs?: 3500, batch?: 25 (1..100) }
// Ids are sent `batch` per call (default 25); more are chunked with a pause. The endpoint accepts up to 100 ids
// per call (200 and 300 return 400). The decoration must be URL-encoded exactly as below: raw parentheses
// return 400. Richer decorations work too (description, industry, ...): use companies_details.js for those.
// returns: { status, companies: [{ id, name, website }], missing: [ids with no website] }
async (params) => {
  const p = params || {};
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const ids = (Array.isArray(p.ids) ? p.ids : [])
    .map((v) => String(v).replace(/^.*:/, '').replace(/\D/g, ''))
    .filter(Boolean);
  if (!ids.length) return { status: 0, error: 'ids_required' };
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 3500;
  const batch = Math.min(100, Math.max(1, Number.isInteger(p.batch) ? p.batch : 25));
  const DECORATION = '%28entityUrn%2Cname%2Cwebsite%29'; // (entityUrn,name,website)
  const companies = [];
  const t0 = performance.now();
  for (let i = 0; i < ids.length; i += batch) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const chunk = ids.slice(i, i + batch);
    try {
      const r = await fetch('/sales-api/salesApiCompanies?ids=List(' + chunk.join(',') + ')&decoration=' + DECORATION, {
        credentials: 'include',
        headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
      });
      if (r.status !== 200) {
        return { status: r.status, ms: Math.round(performance.now() - t0), body: (await r.text()).slice(0, 200), companies };
      }
      const j = await r.json();
      const found = j.results || {};
      for (const id of chunk) {
        const c = found[id];
        if (c) companies.push({ id, name: c.name || '', website: c.website || '' });
      }
    } catch (e) {
      return { status: 0, error: String(e).slice(0, 200), companies };
    }
  }
  const have = new Set(companies.filter((c) => c.website).map((c) => c.id));
  return { status: 200, ms: Math.round(performance.now() - t0), rows: companies.length,
    companies, missing: ids.filter((id) => !have.has(id)) };
}
