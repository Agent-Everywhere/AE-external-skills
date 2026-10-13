// typeahead.js: resolve filter values (geography, industry, ...) to the ids a query needs.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit typeahead.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// params: { type: 'BING_GEO' | 'INDUSTRY' | ..., term: 'text' (or terms: ['a','b']), count?: 10, delayMs?: 3500 }
// Geography uses type BING_GEO (the resulting filter type is REGION; United States = 103644278).
// A wrong type or shape returns HTTP 200 with an EMPTY elements list: that is silent, so this
// returns empty:true with the term. Treat empty as "no such value" and try another spelling or
// build the filter once in the Sales Navigator UI and read the ids off its request.
// returns: { status, results: [{ term, empty, elements: [{ id, displayValue }] }] }
async (params) => {
  const p = params || {};
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  if (!p.type) return { status: 0, error: 'type_required' };
  const terms = Array.isArray(p.terms) ? p.terms : [p.term];
  if (!terms.length || !terms[0]) return { status: 0, error: 'term_required' };
  const count = Math.min(25, Math.max(1, Number.isInteger(p.count) ? p.count : 10));
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 3500;
  const results = [];
  let status = 200;
  for (let i = 0; i < terms.length; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const path = '/sales-api/salesApiFacetTypeahead?q=query&start=0&count=' + count +
      '&type=' + encodeURIComponent(p.type) + '&query=' + encodeURIComponent(terms[i]);
    try {
      const r = await fetch(path, {
        credentials: 'include',
        headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
      });
      if (r.status !== 200) {
        status = r.status;
        results.push({ term: terms[i], status: r.status, body: (await r.text()).slice(0, 200) });
        if (r.status === 403 || r.status === 429) break;
        continue;
      }
      const j = await r.json();
      const elements = (j.elements || []).map((e) => ({ id: e.id, displayValue: e.displayValue }));
      results.push({ term: terms[i], empty: elements.length === 0, elements });
    } catch (e) {
      status = 0;
      results.push({ term: terms[i], error: String(e).slice(0, 120) });
    }
  }
  return { status, results };
}
