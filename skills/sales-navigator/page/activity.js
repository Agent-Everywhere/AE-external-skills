// activity.js: one lead's recent posts and comments (findByMember insights), in the order LinkedIn returns them.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit activity.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// params: {
//   lead:   a Sales Nav lead URL, an entityUrn "urn:li:fs_salesProfile:(id,authType,authToken)", or
//           "id,authType,authToken"
//   days?:  90 look-back window
//   count?: 4 items, at most 10
// }
// One call counts as 1 small call. Only comment items were seen live: the post item shape is
// unverified, so text and url are read defensively and left out when absent.
// returns: { status, rows, elements: [{ createdAt, kind: 'post' | 'comment', text?, url? }], paging }
async (params) => {
  const p = params || {};
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const idMatch = (() => { try { return decodeURIComponent(String(p.lead || '')); } catch (e) { return String(p.lead || ''); } })()
    .match(/([\w-]{8,}),([A-Z_]+),([\w-]+)/);
  if (!idMatch) return { status: 0, error: 'lead_required' };
  const days = Math.min(730, Math.max(1, Number.isFinite(p.days) ? Math.floor(p.days) : 90));
  const count = Math.min(10, Math.max(1, Number.isInteger(p.count) ? p.count : 4));
  const end = Date.now();
  const start = end - days * 86400000;
  const urn = 'urn%3Ali%3Afs_salesProfile%3A%28' + [idMatch[1], idMatch[2], idMatch[3]].map(encodeURIComponent).join('%2C') + '%29';
  const path = '/sales-api/salesApiInsightsV2?insightTypes=List(LEAD_POST,LEAD_COMMENT)&q=findByMember&profile=' + urn +
    '&timeRange=(start:' + start + ',end:' + end + ')&start=0&count=' + count;
  // First string found under these keys, searched a few levels deep (post and comment bodies differ).
  const TEXT_KEYS = ['text', 'commentary', 'comment', 'message', 'body', 'content'];
  const URL_KEYS = ['url', 'permalink', 'activityUrl', 'shareUrl', 'commentUrl'];
  const find = (o, keys, depth) => {
    if (!o || typeof o !== 'object' || depth < 0) return undefined;
    for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k];
    for (const k of Object.keys(o)) {
      const v = find(o[k], keys, depth - 1);
      if (v) return v;
    }
    return undefined;
  };
  const t0 = performance.now();
  try {
    const r = await fetch(path, {
      credentials: 'include',
      headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
    });
    const ms = Math.round(performance.now() - t0);
    if (r.status !== 200) return { status: r.status, ms, body: (await r.text()).slice(0, 200) };
    const j = await r.json();
    const elements = (j.elements || []).map((e) => {
      const u = e.activityUnion || {};
      const text = find(u, TEXT_KEYS, 4);
      const url = find(u, URL_KEYS, 4);
      const row = { createdAt: e.createdAt, kind: u.commentActivity ? 'comment' : 'post' };
      if (text) row.text = text.slice(0, 500);
      if (url) row.url = url;
      return row;
    });
    const paging = j.paging || {};
    return { status: 200, ms, rows: elements.length, elements, paging: { start: paging.start, count: paging.count, total: paging.total } };
  } catch (e) {
    return { status: 0, error: String(e).slice(0, 200) };
  }
}
