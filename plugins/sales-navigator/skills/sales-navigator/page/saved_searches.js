// saved_searches.js: read the seat's saved PEOPLE (lead) searches, one page or all of them. Read-only.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit saved_searches.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params start count all delayMs name withFilters
// @required
// params: { start?: 0, count?: 50 (1..50), all?: true to page through every saved search (delayMs? 1500 between pages,
//   at most 40 pages), name?: only searches whose name equals this (trimmed, case-insensitive), withFilters?: true to
//   return each search's `filters` (the listing's own echo of the filters, with display titles); default is a count only }
// Verified 2026-11-20: GET /sales-api/salesApiSavedSearchesV2?q=savedPeopleSearches&count=50&start=0&decoration=<encoded>
//   where the decoration (createdAt,id,lastViewedAt,name,newHitsCount,seat,keywords,filters) must be FULLY percent-encoded
//   (raw parentheses and commas return HTTP 400). Elements carry id, name, seat, createdAt, lastViewedAt, newHitsCount,
//   keywords, filters.
// returns: { status, ms, total, start, rows, searches: [{ id, name, seat, createdAt, lastViewedAt, newHitsCount, keywords,
//   filterCount, filters? }] }  or  { status, error|body, searches }
async (params) => {
  const p = params || {};
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const count = Math.min(50, Math.max(1, Number.isInteger(p.count) ? p.count : 50));
  let start = Number.isInteger(p.start) && p.start >= 0 ? p.start : 0;
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 1500;
  const want = p.name === undefined || p.name === null ? '' : String(p.name).trim().toLowerCase();
  const DECORATION = '%28createdAt%2Cid%2ClastViewedAt%2Cname%2CnewHitsCount%2Cseat%2Ckeywords%2Cfilters%29';
  const searches = [];
  let total, rows = 0;
  const t0 = performance.now();
  for (let page = 0; page < (p.all ? 40 : 1); page++) {
    if (page > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const r = await fetch('/sales-api/salesApiSavedSearchesV2?q=savedPeopleSearches&count=' + count + '&start=' + start +
        '&decoration=' + DECORATION, {
        credentials: 'include',
        headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
      });
      if (r.status !== 200) {
        return { status: r.status, ms: Math.round(performance.now() - t0), body: (await r.text()).slice(0, 200), searches };
      }
      const j = await r.json();
      const els = j.elements || [];
      total = (j.paging || {}).total;
      rows += els.length;
      for (const e of els) {
        if (want && String(e.name || '').trim().toLowerCase() !== want) continue;
        const row = { id: e.id, name: e.name || '', seat: e.seat, createdAt: e.createdAt, lastViewedAt: e.lastViewedAt,
          newHitsCount: e.newHitsCount, keywords: e.keywords || '', filterCount: Array.isArray(e.filters) ? e.filters.length : 0 };
        if (p.withFilters === true) row.filters = e.filters || [];
        searches.push(row);
      }
      start += els.length;
      if (!els.length || !Number.isFinite(total) || start >= total) break;
    } catch (e) {
      return { status: 0, error: String(e).slice(0, 200), searches };
    }
  }
  return { status: 200, ms: Math.round(performance.now() - t0), total, start, rows, searches };
}
