// contact_info.js: read LinkedIn "Contact info" for a list of connections, from the user's OWN logged-in
// linkedin.com tab. One profile per call, paced, read-only. Run it as: (<this file>)({vanities: [...]})
// Params: {vanities:[...], decorationId?, minDelayMs?, maxDelayMs?}
//   decorationId: full id such as com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-16
//   minDelayMs/maxDelayMs: default 6000/12000. Lower them only in tests; never for real runs.
// Returns {rows:[{vanity,status:"ok"|"not_found"|"error",email,phones,websites,http}], stopped_reason, not_processed}
// Never returns the csrf token or any cookie. No retries, no parallel calls, at most 40 profiles per run.
async function (params) {
  const MAX_PER_RUN = 40;
  const DEFAULT_DECORATION = 'com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-16';
  const STOP_STATUS = [401, 403, 429, 999, 410];
  const p = params || {};
  const decoration = (typeof p.decorationId === 'string' && p.decorationId.trim()) || DEFAULT_DECORATION;
  const minDelay = Math.max(0, Number.isFinite(+p.minDelayMs) ? +p.minDelayMs : 6000);
  const maxDelay = Math.max(minDelay, Number.isFinite(+p.maxDelayMs) ? +p.maxDelayMs : 12000);

  const seen = new Set();
  const all = [];
  for (const v of Array.isArray(p.vanities) ? p.vanities : []) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && !seen.has(s)) { seen.add(s); all.push(s); }
  }
  const batch = all.slice(0, MAX_PER_RUN);
  const out = { rows: [], stopped_reason: null, not_processed: all.length - batch.length };

  const finish = (reason) => {
    out.stopped_reason = reason || null;
    out.not_processed = all.length - out.rows.length;
    try { if (typeof copy === 'function') copy(JSON.stringify(out)); } catch (e) { /* clipboard is optional */ }
    return out;
  };

  const host = (typeof location !== 'undefined' && location && location.hostname) || '';
  if (host && !/(^|\.)linkedin\.com$/i.test(host)) return finish('wrong_page');
  const m = /(?:^|;\s*)JSESSIONID=([^;]*)/.exec((typeof document !== 'undefined' && document.cookie) || '');
  const csrf = m ? m[1].replace(/^"+|"+$/g, '') : '';
  if (!csrf) return finish('no_session');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const asEmail = (x) => {
    const s = typeof x === 'string' ? x : (x && typeof x.emailAddress === 'string' ? x.emailAddress : '');
    const t = s.trim();
    return t.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(t) ? t : null;
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

  let consecutiveErrors = 0;
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) await sleep(minDelay + Math.random() * (maxDelay - minDelay));
    const vanity = batch[i];
    const row = { vanity, status: 'error', email: null, phones: [], websites: [], http: 0 };
    out.rows.push(row);
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
    } catch (e) {
      return finish('network_error');
    }
    row.http = res.status;
    const where = String(res.url || '');
    if (res.redirected && /checkpoint|challenge/i.test(where)) return finish('checkpoint');
    if (res.redirected && /\/login|\/uas\/|authwall/i.test(where)) return finish('login_redirect');
    if (STOP_STATUS.includes(res.status)) return finish('http_' + res.status);
    if (res.status === 400) return finish('decoration_rotated');
    if (res.status === 404) { row.status = 'not_found'; consecutiveErrors = 0; continue; }
    if (res.status !== 200) {
      if (++consecutiveErrors >= 3) return finish('repeated_errors');
      continue;
    }
    let body;
    try { body = await res.json(); } catch (e) { return finish('non_json_response'); }
    consecutiveErrors = 0;
    const included = body && Array.isArray(body.included) ? body.included : [];
    const prof = included.find((o) => o && o.$type === 'com.linkedin.voyager.dash.identity.profile.Profile');
    if (!prof) { row.status = 'not_found'; continue; }
    row.status = 'ok';
    row.email = asEmail(prof.emailAddress);
    row.phones = strings(prof.phoneNumbers, phoneOf);
    row.websites = strings(prof.websites, siteOf);
  }
  return finish(null);
}
