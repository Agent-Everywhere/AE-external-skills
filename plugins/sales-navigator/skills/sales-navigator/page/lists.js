// lists.js: read the seat's Sales Navigator lists (account or lead), one page or all of them. Read-only.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit lists.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params listType start count all delayMs name
// @required
// params: { listType?: 'ACCOUNT' (default) | 'LEAD', start?: 0, count?: 25 (1..25), all?: true to page through every
//   list (delayMs? 1500 between pages, at most 40 pages), name?: only lists whose name equals this (case-insensitive) }
// Verified: GET /sales-api/salesApiLists?q=listType&listType=ACCOUNT|LEAD&start=0&count=25 -> elements with id, name,
//   entityCount, listType, listSource, role.
// returns: { status, ms, total, start, rows, lists: [{ id, name, entityCount, listType, listSource }] }
//   or { status, error|body, lists }
async (params) => {
  const p = params || {};
  const listType = String(p.listType || 'ACCOUNT').toUpperCase();
  if (listType !== 'ACCOUNT' && listType !== 'LEAD') return { status: 0, error: 'list_type_invalid' };
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const count = Math.min(25, Math.max(1, Number.isInteger(p.count) ? p.count : 25));
  let start = Number.isInteger(p.start) && p.start >= 0 ? p.start : 0;
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 1500;
  const want = p.name === undefined || p.name === null ? '' : String(p.name).trim().toLowerCase();
  const lists = [];
  let total, rows = 0;
  const t0 = performance.now();
  for (let page = 0; page < (p.all ? 40 : 1); page++) {
    if (page > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const r = await fetch('/sales-api/salesApiLists?q=listType&listType=' + listType + '&start=' + start + '&count=' + count, {
        credentials: 'include',
        headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
      });
      if (r.status !== 200) {
        return { status: r.status, ms: Math.round(performance.now() - t0), body: (await r.text()).slice(0, 200), lists };
      }
      const j = await r.json();
      const els = j.elements || [];
      total = (j.paging || {}).total;
      rows += els.length;
      for (const e of els) {
        if (want && String(e.name || '').trim().toLowerCase() !== want) continue;
        lists.push({ id: e.id, name: e.name || '', entityCount: e.entityCount, listType: e.listType, listSource: e.listSource });
      }
      start += els.length;
      if (!els.length || !Number.isFinite(total) || start >= total) break;
    } catch (e) {
      return { status: 0, error: String(e).slice(0, 200), lists };
    }
  }
  return { status: 200, ms: Math.round(performance.now() - t0), total, start, rows, lists };
}
