// ui_read.js: DOM fallback. Read what a QBO page shows: heading, tables (headers + rows) and empty state.
// params: { maxRows?: 200, empty?: ['empty-state phrase', ...] }
// returns: { url, title, heading, empty, tables: [{ headers, rows }] }
async (params) => {
  const p = params || {};
  const max = p.maxRows || 200;
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const tables = [];
  for (const t of document.querySelectorAll('table,[role=table],[role=grid]')) {
    if (!vis(t)) continue;
    const headers = [...t.querySelectorAll('th,[role=columnheader]')].map(txt);
    const rows = [];
    for (const r of t.querySelectorAll('tbody tr,[role=row]')) {
      const cells = [...r.querySelectorAll('td,[role=cell],[role=gridcell]')].map(txt);
      if (cells.length && cells.some((c) => c)) rows.push(cells);
      if (rows.length >= max) break;
    }
    tables.push({ headers, rows });
  }
  const body = document.body ? document.body.innerText : '';
  const empty = (p.empty || []).some((s) => body.includes(s));
  const h = [...document.querySelectorAll('h1,h2')].filter(vis).map(txt).filter(Boolean);
  return { url: location.href.split('?')[0], title: document.title, heading: h[0] || '', empty, tables };
}
