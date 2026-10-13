// count.js: exact result totals for one or many searches, using count=1 (tiny responses).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// params: {
//   kind:    'lead' | 'account'
//   query:   one Rest.li query string      (or)
//   queries: [{ label, query }, ...]       sized one after another with a pause between
//   delayMs?: 3500 pause between queries; stops at the first 403/429
// }
// returns: { results: [{ label, status, total, ms }] }
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
  const last = results[results.length - 1] || {};
  return { status: results.every((x) => x.status === 200) ? 200 : (last.status || 0), results };
}
