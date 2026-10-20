// list_save_sharded.js: save accounts (company ids) to a confirmed account list and AUTO-ROTATE to numbered shard lists
// ("<base> #2", "<base> #3", ...) when the list reaches the 1,000 cap. A seat WRITE: only list creation and saves, and
// only to lists in the confirmed name family; it never renames, deletes or edits any other list.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit list_save_sharded.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params listId ids name shardAt batch delayMs readDelayMs maxShards
// @required listId ids
// params: { listId: id of the confirmed account list (required), ids: [company ids or "urn:li:fs_salesCompany:<id>";
//   anything else is counted in `invalid`], name?: the confirmed list name (default: read from the list itself),
//   shardAt?: 1000 (1..1000) the list size that triggers rotation, batch?: 50 (1..50), delayMs?: 3500 between saves,
//   readDelayMs?: 500 between list-read pages, maxShards?: 20 shards at most in one run }
// Live fact (2026-10-14): past 1,000 accounts a save returns HTTP 200 with value.listEntityActionResponses[].status
// 'EXCEED_LIMIT' per entity and the count stays 1,000. So: entries are counted by status (EXCEED_LIMIT is never "saved");
// each batch is cut to the room left under shardAt; after every batch the list's entityCount is re-read (GET
// /sales-api/salesApiLists, as lists.js does); at shardAt, or on any EXCEED_LIMIT, the run moves to "<base> #N+1" (the
// existing list with that exact name when there is one, else a new one created as list_create.js does) and the
// remaining / EXCEED_LIMIT ids are saved there. The base name is the confirmed name without a trailing " #N".
// Stops at the first non-200 response. Log each call as a small call (run_log.py --saved-accounts N).
// returns: { status, ms, saved, failed: [ids not saved anywhere, incl. not attempted], exceeded: EXCEED_LIMIT entries seen
//   (all re-queued), batches, invalid, base, shards: [{ listId, name, saved, exceeded, entityCount, created, countMismatches }] }
//   or { status, error|body, ...same fields }
async (params) => {
  const p = params || {};
  const listId = String(p.listId === undefined || p.listId === null ? '' : p.listId).trim().replace(/^.*:/, '');
  if (!listId) return { status: 0, error: 'list_id_required' };
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const queue = [];
  let invalid = 0;
  for (const v of (Array.isArray(p.ids) ? p.ids : [])) {
    const id = String(v).trim().replace(/^.*:/, '');
    if (!/^\d+$/.test(id)) { invalid++; continue; }
    if (!queue.includes(id)) queue.push(id);
  }
  if (!queue.length) return { status: 0, error: 'ids_required', invalid };
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 3500;
  const readDelay = Number.isFinite(p.readDelayMs) ? p.readDelayMs : 500;
  const batch = Math.min(50, Math.max(1, Number.isInteger(p.batch) ? p.batch : 50));
  const shardAt = Math.min(1000, Math.max(1, Number.isInteger(p.shardAt) ? p.shardAt : 1000));
  const maxShards = Math.max(1, Number.isInteger(p.maxShards) ? p.maxShards : 20);
  const baseHeaders = { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const t0 = performance.now();
  const shards = [];
  const failed = [];
  let saved = 0, exceeded = 0, batches = 0;
  const done = (extra) => Object.assign({ status: 200, ms: Math.round(performance.now() - t0), saved, failed, exceeded,
    batches, invalid, base: base, shards }, extra || {});
  const stop = (extra) => { failed.push(...queue.splice(0)); return done(extra); };
  let base = '';

  // Find an account list by predicate, reading the lists endpoint 25 at a time (a remembered page first).
  let hint = 0;
  const findList = async (match) => {
    let total, first = true;
    for (let pass = 0; pass < 2; pass++) {
      for (let page = 0; page < 40; page++) {
        const start = pass === 0 ? hint : page * 25;
        if (pass === 1 && start === hint) continue;
        if (pass === 1 && Number.isFinite(total) && start >= total) break;
        if (!first) await sleep(readDelay);
        first = false;
        const r = await fetch('/sales-api/salesApiLists?q=listType&listType=ACCOUNT&start=' + start + '&count=25', {
          credentials: 'include', headers: baseHeaders,
        });
        if (r.status !== 200) return { status: r.status, body: (await r.text()).slice(0, 200) };
        const j = await r.json();
        const els = j.elements || [];
        total = (j.paging || {}).total;
        const hit = els.find(match);
        if (hit) { hint = start; return { status: 200, list: hit }; }
        if (pass === 0 || !els.length) break;
      }
    }
    return { status: 200 };
  };
  const sameName = (name) => (e) => String(e.name || '').trim().toLowerCase() === name.toLowerCase();
  const countOf = (e) => (Number.isFinite(e.entityCount) ? e.entityCount : 0);

  // Open (reuse or create) the shard with this exact name.
  const openShard = async (name) => {
    const hit = await findList(sameName(name));
    if (hit.status !== 200) return hit;
    if (hit.list) return { status: 200, id: String(hit.list.id), name: hit.list.name || name, count: countOf(hit.list), created: false };
    const r = await fetch('/sales-api/salesApiLists', {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({ 'content-type': 'application/json' }, baseHeaders),
      body: JSON.stringify({ name, listType: 'ACCOUNT', role: 'OWNER' }),
    });
    if (r.status < 200 || r.status > 299) return { status: r.status, body: (await r.text()).slice(0, 200) };
    let id = r.headers && r.headers.get ? r.headers.get('x-restli-id') : null;
    if (!id) {
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (j && j.id !== undefined && j.id !== null) id = j.id;
      else if (j && j.value && j.value.id !== undefined && j.value.id !== null) id = j.value.id;
    }
    if (id === null || id === undefined || id === '') {
      await sleep(readDelay);
      const again = await findList(sameName(name));
      if (again.status !== 200) return { status: again.status, error: 'created_but_id_unread', body: again.body };
      if (!again.list) return { status: r.status, error: 'created_but_id_unread' };
      id = again.list.id;
    }
    return { status: r.status, id: String(id), name, count: 0, created: true };
  };

  try {
    const first = await findList((e) => String(e.id) === listId);
    if (first.status !== 200) return stop({ status: first.status, body: first.body });
    if (!first.list) return stop({ status: 0, error: 'list_not_found' });
    const confirmed = String(p.name === undefined || p.name === null || !String(p.name).trim() ? first.list.name : p.name).trim();
    const m = confirmed.match(/^(.*?)\s*#(\d+)$/);
    base = m && m[1] ? m[1] : confirmed;
    let num = m && m[1] ? Math.max(1, parseInt(m[2], 10)) : 1;
    let cur = { listId, name: first.list.name || confirmed, count: countOf(first.list) };
    let shard = { listId, name: cur.name, saved: 0, exceeded: 0, entityCount: cur.count, created: false, countMismatches: 0 };
    shards.push(shard);
    let sent = false;

    while (queue.length) {
      if (cur.count >= shardAt) {
        if (shards.length >= maxShards) return stop({ status: 0, error: 'max_shards_reached' });
        num++;
        const opened = await openShard(base + ' #' + num);
        if (opened.status < 200 || opened.status > 299 || opened.error) {
          return stop({ status: opened.status, error: opened.error, body: opened.body });
        }
        cur = { listId: opened.id, name: opened.name, count: opened.count };
        shard = { listId: opened.id, name: opened.name, saved: 0, exceeded: 0, entityCount: opened.count,
          created: opened.created, countMismatches: 0 };
        shards.push(shard);
        continue;
      }
      const chunk = queue.slice(0, Math.min(batch, shardAt - cur.count));
      if (sent) await sleep(delay);
      sent = true;
      const r = await fetch('/sales-api/salesApiCompanies?action=save', {
        method: 'POST',
        credentials: 'include',
        headers: Object.assign({ 'content-type': 'application/json' }, baseHeaders),
        body: JSON.stringify({ companyIds: chunk.map(Number), lists: [cur.listId] }),
      });
      batches++;
      if (r.status !== 200) return stop({ status: r.status, body: (await r.text()).slice(0, 200) });
      const j = await r.json();
      const resp = ((j || {}).value || {}).listEntityActionResponses;
      const entries = Array.isArray(resp) ? resp : [];
      const stat = (e) => (e && e.status) || '';
      let ok = [], over = [], bad = [];
      if (entries.length && entries.every((e) => stat(e) === 'SUCCESS')) ok = chunk;
      else if (entries.length === chunk.length) {
        chunk.forEach((id, k) => { const s = stat(entries[k]); (s === 'SUCCESS' ? ok : s === 'EXCEED_LIMIT' ? over : bad).push(id); });
      } else if (entries.some((e) => stat(e) === 'EXCEED_LIMIT')) over = chunk;
      else bad = chunk;
      queue.splice(0, chunk.length);
      saved += ok.length; shard.saved += ok.length;
      exceeded += over.length; shard.exceeded += over.length;
      failed.push(...bad);
      queue.unshift(...over);
      const now = await findList((e) => String(e.id) === cur.listId);
      if (now.status !== 200) return stop({ status: now.status, error: 'count_unreadable', body: now.body });
      if (!now.list) return stop({ status: 0, error: 'list_not_found' });
      const nextCount = countOf(now.list);
      if (nextCount - cur.count !== ok.length) shard.countMismatches++;
      cur.count = over.length ? Math.max(nextCount, shardAt) : nextCount;
      shard.entityCount = nextCount;
    }
    return done();
  } catch (e) {
    return stop({ status: 0, error: String(e).slice(0, 200) });
  }
}
