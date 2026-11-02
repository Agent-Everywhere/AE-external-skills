// contact_info.js: read LinkedIn "Contact info" for a list of connections, from the user's OWN logged-in
// linkedin.com tab. One profile per call, paced, read-only. Run it as: (<this file>)({vanities: [...]})
// Params: {vanities:[...], decorationId?}
//   decorationId: full id such as com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-16
//   Pacing is fixed at 6 to 12 seconds between calls (params.__test === true overrides it, for tests only).
// Returns {rows:[{vanity,status:"ok"|"not_found"|"error",email,phones,websites,http,reason?}], stopped_reason, not_processed}
// Never returns the csrf token or any cookie. No retries, no parallel calls, at most 40 profiles per run.
// After every row the rows so far are saved to localStorage "liEmailsLastRun" (recover: see SKILL.md).
async function (params) {
  const MAX_PER_RUN = 40;
  const DEFAULT_DECORATION = 'com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-16';
  const PROFILE = 'com.linkedin.voyager.dash.identity.profile.Profile';
  const STOP_STATUS = [401, 403, 429, 999, 410];
  const g = globalThis;
  const p = params || {};
  const decoration = (typeof p.decorationId === 'string' && p.decorationId.trim()) || DEFAULT_DECORATION;
  const testing = p.__test === true;
  const minDelay = testing && Number.isFinite(+p.minDelayMs) ? Math.max(0, +p.minDelayMs) : 6000;
  const maxDelay = testing && Number.isFinite(+p.maxDelayMs) ? Math.max(minDelay, +p.maxDelayMs) : 12000;

  const seen = new Set();
  const all = [];
  for (const v of Array.isArray(p.vanities) ? p.vanities : []) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && !seen.has(s)) { seen.add(s); all.push(s); }
  }
  const batch = all.slice(0, MAX_PER_RUN);
  const out = { rows: [], stopped_reason: null, not_processed: all.length };

  const persist = (partial) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('liEmailsLastRun', JSON.stringify(
          { rows: out.rows, stopped_reason: out.stopped_reason, partial: !!partial, saved_at: new Date().toISOString() }));
      }
    } catch (e) { /* storage is optional */ }
  };
  const finish = (reason) => {
    out.stopped_reason = reason || null;
    out.not_processed = all.length - out.rows.length;
    persist(false);
    try { if (typeof copy === 'function') copy(JSON.stringify(out)); } catch (e) { /* clipboard is optional */ }
    return out;
  };

  if (g.__liEmailsRunning) {   // another run is live in this tab: touch nothing (not even the saved partial)
    out.stopped_reason = 'already_running';
    return out;
  }
  g.__liEmailsRunning = true;
  try {
    const host = (typeof location !== 'undefined' && location && location.hostname) || '';
    if (host && !/(^|\.)linkedin\.com$/i.test(host)) return finish('wrong_page');
    const m = /(?:^|;\s*)JSESSIONID=([^;]*)/.exec((typeof document !== 'undefined' && document.cookie) || '');
    const csrf = m ? m[1].replace(/^"+|"+$/g, '') : '';
    if (!csrf) return finish('no_session');

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const low = (s) => String(s || '').toLowerCase();
    const asEmail = (x) => {
      const s = typeof x === 'string' ? x : (x && typeof x.emailAddress === 'string' ? x.emailAddress : '');
      const t = s.trim();
      return t.length <= 254 && /^[^\s@=+\-][^\s@]*@[^\s@]+$/.test(t) ? t : null;
    };
    const clip = (s) => String(s).trim().slice(0, 200);
    const phoneOf = (x) => {
      if (!x) return '';
      const n = x.phoneNumber !== undefined ? x.phoneNumber : x.number;
      if (typeof n === 'string') return n;
      if (n && typeof n === 'object' && typeof n.number === 'string') return n.number;
      return typeof x === 'string' ? x : '';
    };
    const siteOf = (x) => (typeof x === 'string' ? x : (x && (x.url || x.website)) || '');
    const strings = (list, fn) => (Array.isArray(list) ? list : []).map(fn)
      .filter((s) => typeof s === 'string' && s.trim()).map(clip).slice(0, 5);

    // One request. Fills `row`; returns 'ok' | 'none' (no usable profile) | 'hard' (not profile-specific failure)
    // | 'neutral' (profile-specific server error) | 'stop:<reason>'.
    const readOne = async (row, vanity) => {
      let res;
      try {
        res = await fetch('/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity='
          + encodeURIComponent(vanity) + '&decorationId=' + encodeURIComponent(decoration), {
          method: 'GET',
          credentials: 'include',
          headers: {
            'csrf-token': csrf,
            'x-restli-protocol-version': '2.0.0',
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
          },
        });
      } catch (e) { row.reason = 'network_error'; return 'hard'; }
      row.http = res.status;
      const where = String(res.url || '');
      if (res.redirected && /checkpoint|challenge/i.test(where)) return 'stop:checkpoint';
      if (res.redirected && /\/login|\/uas\/|authwall/i.test(where)) return 'stop:login_redirect';
      if (STOP_STATUS.includes(res.status)) return 'stop:http_' + res.status;
      if (res.status === 400) return 'stop:decoration_rotated';
      if (res.status === 404) { row.status = 'not_found'; return 'none'; }
      if (res.status !== 200) { row.reason = 'http_' + res.status; return 'neutral'; }
      let body;
      try { body = await res.json(); } catch (e) { row.reason = 'non_json_response'; return 'hard'; }
      const included = body && Array.isArray(body.included) ? body.included : [];
      const profs = included.filter((o) => o && o.$type === PROFILE);
      const mine = (id) => typeof id === 'string'
        && [low(vanity), low(encodeURIComponent(vanity))].includes(low(id));
      // Tie the answer to the requested person: the Profile named for this vanity, else the one the response
      // itself points at (data['*elements'][0] / data.entityUrn). Never "the first Profile".
      let prof = profs.find((o) => mine(o.publicIdentifier));
      if (!prof) {
        const d = (body && body.data) || {};
        const urn = (Array.isArray(d['*elements']) && d['*elements'][0]) || d.entityUrn;
        const hit = urn ? profs.find((o) => o.entityUrn === urn) : null;
        if (hit && (typeof hit.publicIdentifier !== 'string' || mine(hit.publicIdentifier))) prof = hit;
      }
      if (!prof) { row.reason = profs.length ? 'identity_mismatch' : 'no_profile'; return 'none'; }
      row.status = 'ok';
      row.email = asEmail(prof.emailAddress);
      row.phones = strings(prof.phoneNumbers, phoneOf);
      row.websites = strings(prof.websites, siteOf);
      return 'ok';
    };

    let okCount = 0, noneRun = 0, hardRun = 0;
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await sleep(minDelay + Math.random() * (maxDelay - minDelay));
      const row = { vanity: batch[i], status: 'error', email: null, phones: [], websites: [], http: 0 };
      out.rows.push(row);
      const kind = await readOne(row, batch[i]);
      persist(true);
      if (kind.startsWith('stop:')) return finish(kind.slice(5));
      if (kind === 'ok') { okCount++; noneRun = 0; hardRun = 0; }
      else if (kind === 'none') { noneRun++; hardRun = 0; }
      else if (kind === 'hard') hardRun++;
      if (hardRun >= 3) return finish('repeated_errors');
      if (okCount === 0 && noneRun >= 3) return finish('suspect_endpoint');
    }
    return finish(null);
  } finally {
    g.__liEmailsRunning = false;
  }
}
