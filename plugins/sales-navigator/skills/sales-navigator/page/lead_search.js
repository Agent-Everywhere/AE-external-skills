// lead_search.js: one page of a Sales Navigator lead (people) search, via the in-page API.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit lead_search.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// params: {
//   query:  Rest.li search query, e.g. "(filters:List((type:CURRENT_TITLE,values:List((text:VP%20Operations,selectionType:INCLUDED)))))"
//           A query copied from a page URL is cleaned (recentSearchParam stripped, unquoted once).
//   start?: 0, count?: 25 (1..100, cut at the viewable cap; use count 1 to size a search), decorationId?: override,
//   raw?:   true to keep every field (images, badges, CRM status) instead of the slim form,
//   timeoutMs?: 25000 per request (aborted with AbortController; keep it under the runtime's evaluate_timeout_ms, 60000),
//   budgetMs?:  50000 for all attempts together. A request that times out is retried with a halved count (min 10) while
//               the budget allows; large ACCOUNT_LIST searches can be slow at count 100.
// }
// returns: { status, ms, total, start, rows, count, retries, elements: [...] }  or  { status, error|body }
// `count` is the count actually used (page on with start += rows). When every attempt times out:
//   { status: 0, error: 'fetch_timeout', count, retries, tried: [counts], hint }.
// total is exact (paging.total). Viewable results stop at 2,500 (start 0..2475).
async (params) => {
  const p = params || {};
  const DROP = new Set(['profilePictureDisplayImage', 'companyPictureDisplayImage', 'displayImage',
    'trackingId', 'spotlightBadges', 'crmStatus', '$recipeType']);
  const slim = (v) => {
    if (Array.isArray(v)) return v.map(slim);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) if (!DROP.has(k)) out[k] = slim(v[k]);
      return out;
    }
    return v;
  };
  const cleanQuery = (input) => {
    let s = String(input || '').trim();
    if (/^https?:/i.test(s)) {
      const i = s.indexOf('query=');
      s = i >= 0 ? s.slice(i + 6).split('&')[0] : '';
    }
    if (/^%28/i.test(s)) s = decodeURIComponent(s);
    const at = s.indexOf('recentSearchParam:');
    if (at >= 0) {
      const open = s.indexOf('(', at);
      let depth = 0, end = -1;
      for (let i = open; i >= 0 && i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) { end = i; break; }
      }
      if (end > 0) {
        let from = at, to = end + 1;
        if (s[to] === ',') to++;
        else if (s[from - 1] === ',') from--;
        s = s.slice(0, from) + s.slice(to);
      }
    }
    return s;
  };
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const query = cleanQuery(p.query);
  if (!query) return { status: 0, error: 'query_required' };
  const start = Number.isInteger(p.start) && p.start >= 0 ? p.start : 0;
  const count = Math.min(100, Math.max(1, Number.isInteger(p.count) ? p.count : 25), p.ignoreCap ? 100 : Math.max(1, 2500 - start));
  if (start >= 2500 && !p.ignoreCap) return { status: 0, error: 'beyond_viewable_cap_2500' };
  const deco = p.decorationId || 'com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14';
  const path = '/sales-api/salesApiLeadSearch?q=searchQuery&query=' + query;
  const t0 = performance.now();
  const timeoutMs = Number.isFinite(p.timeoutMs) && p.timeoutMs >= 1 ? p.timeoutMs : 25000;
  const budgetMs = Number.isFinite(p.budgetMs) && p.budgetMs >= 1 ? p.budgetMs : 50000;
  const tried = [];
  let n = count;
  for (;;) {
    tried.push(n);
    const left = budgetMs - (performance.now() - t0);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, Math.max(1, Math.min(timeoutMs, left)));
    try {
      const r = await fetch(path + '&start=' + start + '&count=' + n + '&decorationId=' + deco, {
        credentials: 'include',
        signal: ctl.signal,
        headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
      });
      if (r.status !== 200) {
        const body = (await r.text()).slice(0, 200);
        return { status: r.status, ms: Math.round(performance.now() - t0), body };
      }
      const j = await r.json();
      const els = j.elements || [];
      return { status: 200, ms: Math.round(performance.now() - t0), total: (j.paging || {}).total, start, rows: els.length,
        count: n, retries: tried.length - 1, elements: p.raw ? els : els.map(slim) };
    } catch (e) {
      if (!timedOut) return { status: 0, error: String(e).slice(0, 200) };
      const next = Math.max(10, Math.floor(n / 2));
      if (next >= n || budgetMs - (performance.now() - t0) < Math.min(1000, timeoutMs / 2)) {
        return { status: 0, error: 'fetch_timeout', ms: Math.round(performance.now() - t0), count: n,
          retries: tried.length - 1, tried,
          hint: 'lower count (min 10) or raise the plan evaluate_timeout_ms and pass a larger timeoutMs/budgetMs' };
      }
      n = next;
    } finally {
      clearTimeout(timer);
    }
  }
}
