// list_create.js: create ONE empty Sales Navigator list (account or lead). A seat WRITE: only after the user confirmed
// the exact list name this run. Never modifies, renames or deletes a list.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit list_create.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params name listType description reuse delayMs
// @required name listType
// params: { name: the confirmed list name, listType: 'ACCOUNT' | 'LEAD', description?: text,
//   reuse?: true to return the existing list with that name instead of refusing, delayMs?: 1500 between read pages }
// Verified: POST /sales-api/salesApiLists with JSON {"name", "listType", "role":"OWNER"}; a body WITHOUT role returns 422.
// Reads the existing lists first (same endpoint as lists.js, up to 40 pages): a list with the same name (trimmed,
// case-insensitive) is refused with error list_name_exists (and its id) unless `reuse` is true. The new id is taken from
// the x-restli-id header, else the body id, else the lists are re-read by name. Log it as small calls.
// returns: { status, id, name, reused }  or  { status, error|body }
async (params) => {
  const p = params || {};
  const name = String(p.name === undefined || p.name === null ? '' : p.name).trim();
  if (!name) return { status: 0, error: 'name_required' };
  const listType = String(p.listType || '').toUpperCase();
  if (listType !== 'ACCOUNT' && listType !== 'LEAD') return { status: 0, error: 'list_type_invalid' };
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 1500;
  const headers = { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' };
  const findByName = async () => {
    let start = 0;
    for (let page = 0; page < 40; page++) {
      if (page > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const r = await fetch('/sales-api/salesApiLists?q=listType&listType=' + listType + '&start=' + start + '&count=25', {
        credentials: 'include', headers,
      });
      if (r.status !== 200) return { status: r.status, body: (await r.text()).slice(0, 200) };
      const j = await r.json();
      const els = j.elements || [];
      const hit = els.find((e) => String(e.name || '').trim().toLowerCase() === name.toLowerCase());
      if (hit) return { status: 200, id: hit.id, name: hit.name };
      start += els.length;
      const total = (j.paging || {}).total;
      if (!els.length || !Number.isFinite(total) || start >= total) break;
    }
    return { status: 200 };
  };
  try {
    const before = await findByName();
    if (before.status !== 200) return before;
    if (before.id !== undefined) {
      if (p.reuse === true) return { status: 200, id: before.id, name: before.name, reused: true };
      return { status: 0, error: 'list_name_exists', id: before.id, name: before.name };
    }
    const body = { name, listType, role: 'OWNER' };
    if (p.description) body.description = String(p.description);
    const r = await fetch('/sales-api/salesApiLists', {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({ 'content-type': 'application/json' }, headers),
      body: JSON.stringify(body),
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
      await new Promise((resolve) => setTimeout(resolve, delay));
      const after = await findByName();
      if (after.status !== 200) return { status: after.status, error: 'created_but_id_unread', body: after.body };
      if (after.id === undefined) return { status: r.status, error: 'created_but_id_unread' };
      id = after.id;
    }
    return { status: r.status, id: /^\d+$/.test(String(id)) ? String(id) : id, name, reused: false };
  } catch (e) {
    return { status: 0, error: String(e).slice(0, 200) };
  }
}
