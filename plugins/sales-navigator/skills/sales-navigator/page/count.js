// count.js: exact result totals for one or many searches, using count=1 (tiny responses).
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit count.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params kind query queries label delayMs
// @required query|queries
// params: {
//   kind:    'lead' | 'account'
//   query:   one Rest.li query string      (or)
//   queries: [{ label, query }, ...]       sized one after another with a pause between
//   delayMs?: 3500 pause between queries; stops at the first 403/429
// }
// returns: { status, failed, results: [{ label, status, total, ms }] }
//   status is 200 only when every query returned 200; otherwise it is the first 403/429 if any, else the
//   first non-200 status. failed counts the queries that did not return 200 (a runner treats failed > 0
//   as not ok).
// total is paging.total: exact for the query as sent, but only the first 2,500 (leads) or
// 1,000 (accounts) results are viewable, so shard until each total is under that cap.
async (params) => {
  const p = params || {};
  const kind = p.kind === 'account' ? 'account' : 'lead';
  const api = kind === 'account'
    ? '/sales-api/salesApiAccountSearch?q=searchQuery&query='
    : '/sales-api/salesApiLeadSearch?q=searchQuery&query=';
  const deco = kind === 'account'
    ? 'com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4'
    : 'com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14';
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const items = Array.isArray(p.queries) ? p.queries : [{ label: p.label || 'query', query: p.query }];
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 3500;
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const t0 = performance.now();
    try {
      const r = await fetch(api + item.query + '&start=0&count=1&decorationId=' + deco, {
        credentials: 'include',
        headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
      });
      const ms = Math.round(performance.now() - t0);
      if (r.status !== 200) {
        results.push({ label: item.label, status: r.status, ms });
        if (r.status === 403 || r.status === 429) break;
        continue;
      }
      const j = await r.json();
      results.push({ label: item.label, status: 200, total: (j.paging || {}).total, ms });
    } catch (e) {
      results.push({ label: item.label, status: 0, error: String(e).slice(0, 120) });
    }
  }
  const bad = results.filter((x) => x.status !== 200);
  const stop = bad.find((x) => x.status === 403 || x.status === 429);
  return { status: bad.length ? (stop || bad[0]).status : 200, failed: bad.length, results };
}
