// account_search.js: one page of a Sales Navigator account (company) search, via the in-page API.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit account_search.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// params: {
//   query:  Rest.li search query. Filters come FIRST, keywords are a top-level key after them:
//           "(filters:List((type:REGION,values:List((id:103644278,selectionType:INCLUDED)))),keywords:supplement%20OR%20vitamin)"
//           (keywords URL-encoded; Boolean OR and quoted phrases work). A query copied from a page
//           URL is cleaned (recentSearchParam stripped, unquoted once).
//   start?: 0, count?: 25 (1..25; use count 1 to size a search), decorationId?: override,
//   raw?:   true to keep every field instead of the slim form
// }
// returns: { status, ms, total, start, rows, elements: [...] }  or  { status, error|body }
// Elements carry companyName, industry, employeeCountRange, entityUrn (company id) and NO website:
// use companies_websites.js for that. Viewable results stop at 1,000 (start 0..975).
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
  const count = Math.min(25, Math.max(1, Number.isInteger(p.count) ? p.count : 25));
  if (start >= 1000 && !p.ignoreCap) return { status: 0, error: 'beyond_viewable_cap_1000' };
  const deco = p.decorationId || 'com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4';
  const path = '/sales-api/salesApiAccountSearch?q=searchQuery&query=' + query +
    '&start=' + start + '&count=' + count + '&decorationId=' + deco;
  const t0 = performance.now();
  try {
    const r = await fetch(path, {
      credentials: 'include',
      headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
    });
    const ms = Math.round(performance.now() - t0);
    if (r.status !== 200) return { status: r.status, ms, body: (await r.text()).slice(0, 200) };
    const j = await r.json();
    const els = j.elements || [];
    return { status: 200, ms, total: (j.paging || {}).total, start, rows: els.length,
      elements: p.raw ? els : els.map(slim) };
  } catch (e) {
    return { status: 0, error: String(e).slice(0, 200) };
  }
}
