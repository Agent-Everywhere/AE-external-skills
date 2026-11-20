// saved_search_create.js: create ONE saved people (lead) search. A seat WRITE: only after the user confirmed the exact
// saved-search name this run. Never modifies, renames or deletes a saved search (there is no delete here).
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit saved_search_create.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params name query leadSearchQuery seat reuse delayMs
// @required name query|leadSearchQuery
// params: { name: the confirmed saved-search name,
//   query: a Rest.li search query as lead_search.js takes it, e.g. "(filters:List((type:PAST_COMPANY,values:List((id:urn%3Ali%3Aorganization%3A1,selectionType:INCLUDED)))))"
//     (a query copied from a page URL is cleaned: recentSearchParam stripped, unquoted once); converted here to the JSON form,
//     ids and text percent-decoded once, (or)
//   leadSearchQuery: that search as plain JSON, { filters: [{ type, values: [{ id|text, selectionType }] }], keywords? },
//     with raw ids (urn:li:organization:<id>) and plain text,
//   seat?: a seat urn "urn:li:seat:<digits>" (default: the seat of an existing saved search, else the first licence from
//     the identity call; the result says which),
//   reuse?: true to return the existing saved search with that name instead of refusing, delayMs?: 1500 between reads }
// Verified 2026-11-20: POST /sales-api/salesApiSavedSearchesV2 (content-type application/json; charset=UTF-8) with
//   { name, seat, useCase: 'SAVED_LEAD_SEARCH', frequency: 'DAILY', filters: [], keywords: '', searchQuery: { leadSearchQuery } }
//   returns 201 with an empty body and the id in the x-restli-id header ({seat=urn:li:seat:N, id=N}). The seat comes from
//   GET /sales-api/salesApiIdentity?q=findLicensesByCurrentMember&includeRecentlyInactiveDueToAdminReassignment=true
//   (elements carry seatUrn). `frequency` is the model default; other values are untested.
// Reads the saved searches first (same listing as saved_searches.js): a search with the same name (trimmed,
// case-insensitive) is refused with error saved_search_name_exists (and its id) unless `reuse` is true. After the POST it
// re-lists and returns verified: true only when a search with that name is listed; `echo` is the listing's own echo of the
// filters (display titles and values), the proof the filters were understood. Log it as small calls and one saved search.
// returns: { status, id, name, seat, seatSource, licenses, verified, filterCount, echo, reused }  or  { status, error|body }
async (params) => {
  const p = params || {};
  const name = String(p.name === undefined || p.name === null ? '' : p.name).trim();
  if (!name) return { status: 0, error: 'name_required' };
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
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
  // Rest.li object notation to JSON: (k:v,k2:v2) is an object, List(a,b) an array, anything else a string, percent-decoded once.
  const parseRestli = (s) => {
    let i = 0;
    const fail = (why) => { throw new Error('query_parse: ' + why + ' at ' + i); };
    const scalar = () => {
      const from = i;
      while (i < s.length && s[i] !== ',' && s[i] !== ')') i++;
      return decodeURIComponent(s.slice(from, i));
    };
    const value = () => {
      if (s.startsWith('List(', i)) {
        i += 5;
        const arr = [];
        if (s[i] === ')') { i++; return arr; }
        for (;;) {
          arr.push(value());
          if (s[i] === ',') { i++; continue; }
          if (s[i] === ')') { i++; return arr; }
          fail('expected , or ) in a List');
        }
      }
      if (s[i] === '(') {
        i++;
        const obj = {};
        if (s[i] === ')') { i++; return obj; }
        for (;;) {
          const colon = s.indexOf(':', i);
          if (colon < 0) fail('expected key:value');
          const key = s.slice(i, colon);
          i = colon + 1;
          obj[key] = value();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === ')') { i++; return obj; }
          fail('expected , or ) in an object');
        }
      }
      return scalar();
    };
    const out = value();
    if (i !== s.length) fail('trailing text');
    return out;
  };
  let lead = null;
  try {
    if (p.leadSearchQuery && typeof p.leadSearchQuery === 'object') {
      lead = p.leadSearchQuery;
    } else if (p.query) {
      const parsed = parseRestli(cleanQuery(p.query));
      lead = { filters: parsed.filters };
      if (parsed.keywords) lead.keywords = parsed.keywords;
    }
  } catch (e) {
    return { status: 0, error: 'query_invalid', detail: String(e).slice(0, 200) };
  }
  if (!lead || !Array.isArray(lead.filters) || !lead.filters.length || !lead.filters.every((f) => f && typeof f.type === 'string'
      && Array.isArray(f.values) && f.values.length)) return { status: 0, error: 'query_invalid' };
  if (p.seat !== undefined && !/^urn:li:seat:\d+$/.test(String(p.seat))) return { status: 0, error: 'seat_invalid' };
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 1500;
  const headers = { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' };
  const DECORATION = '%28createdAt%2Cid%2ClastViewedAt%2Cname%2CnewHitsCount%2Cseat%2Ckeywords%2Cfilters%29';
  const listAll = async () => {
    const all = [];
    let start = 0;
    for (let page = 0; page < 40; page++) {
      if (page > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const r = await fetch('/sales-api/salesApiSavedSearchesV2?q=savedPeopleSearches&count=50&start=' + start +
        '&decoration=' + DECORATION, { credentials: 'include', headers });
      if (r.status !== 200) return { status: r.status, body: (await r.text()).slice(0, 200) };
      const j = await r.json();
      const els = j.elements || [];
      all.push(...els);
      start += els.length;
      const total = (j.paging || {}).total;
      if (!els.length || !Number.isFinite(total) || start >= total) break;
    }
    return { status: 200, all };
  };
  const findByName = (all) => all.find((e) => String(e.name || '').trim().toLowerCase() === name.toLowerCase());
  try {
    const before = await listAll();
    if (before.status !== 200) return before;
    const same = findByName(before.all);
    if (same) {
      if (p.reuse === true) return { status: 200, id: same.id, name: same.name, seat: same.seat, verified: true, reused: true };
      return { status: 0, error: 'saved_search_name_exists', id: same.id, name: same.name };
    }
    let seat = p.seat === undefined ? '' : String(p.seat);
    let seatSource = seat ? 'param' : '';
    let licenses;
    if (!seat) {
      const r = await fetch('/sales-api/salesApiIdentity?q=findLicensesByCurrentMember&includeRecentlyInactiveDueToAdminReassignment=true',
        { credentials: 'include', headers });
      if (r.status !== 200) return { status: r.status, error: 'seat_lookup_failed', body: (await r.text()).slice(0, 200) };
      const j = await r.json();
      const urns = (j.elements || []).map((e) => e && e.seatUrn).filter((u) => typeof u === 'string');
      licenses = urns.length;
      const known = before.all.map((e) => e.seat).find((u) => urns.includes(u));
      if (known) { seat = known; seatSource = 'existing_saved_search'; }
      else if (urns.length) { seat = urns[0]; seatSource = 'first_license'; }
      else return { status: 0, error: 'seat_not_found', licenses: 0 };
    }
    const body = { name, seat, useCase: 'SAVED_LEAD_SEARCH', frequency: 'DAILY', filters: [], keywords: '',
      searchQuery: { leadSearchQuery: lead } };
    const r = await fetch('/sales-api/salesApiSavedSearchesV2', {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({ 'content-type': 'application/json; charset=UTF-8' }, headers),
      body: JSON.stringify(body),
    });
    if (r.status < 200 || r.status > 299) return { status: r.status, body: (await r.text()).slice(0, 200) };
    const header = r.headers && r.headers.get ? r.headers.get('x-restli-id') : null;
    const m = header ? String(header).match(/id=(\d+)/) : null;
    let id = m ? m[1] : null;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const after = await listAll();
    if (after.status !== 200) return { status: after.status, error: 'created_but_unverified', id, body: after.body };
    const hit = findByName(after.all);
    if (id === null && hit) id = String(hit.id);
    const echo = hit ? JSON.stringify(hit.filters || []) : '';
    return { status: r.status, id, name, seat, seatSource, licenses, verified: !!hit,
      filterCount: hit && Array.isArray(hit.filters) ? hit.filters.length : 0, echo: echo.slice(0, 2000), reused: false };
  } catch (e) {
    return { status: 0, error: String(e).slice(0, 200) };
  }
}
