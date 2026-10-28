// Pure helpers for Marketplace GraphQL discovery and reads.
// Never return cookies, fb_dtsg, lsd, jazoest, or raw POST bodies.
// Run: node graphql_redact.mjs --self-test

const SECRET_KEY = /(fb_dtsg|^lsd$|jazoest|^xs$|^c_user$|cookie|authorization|access_token|fb_dtsg_ag|^token$|secret|set-cookie|x-fb-lsd|^__s$|^__hsi$|^__dyn$|^__csr$)/i;
const WRITE_NAME = /send|mutation|create|delete|archive|mark.?sold|message_send|set_thread|modify/i;
const FRIENDLY = /^[A-Za-z][A-Za-z0-9_]{2,120}$/;
const DOC_ID = /^\d{5,24}$/;
const TEXT_KEY = /(text|body|snippet|message|title|listing)/i;
const WHO_KEY = /(buyer|seller|sender|participant|author|display_name|^name$)/i;
const TIME_KEY = /(time|timestamp|date)/i;
const ID_KEY = /(^id$|_id$|Id$)/;
const PAGES = new Set([
  'https://www.facebook.com/marketplace/inbox/',
  'https://www.facebook.com/marketplace/you/selling/',
]);

export function isDocId(value) {
  return typeof value === 'string' && DOC_ID.test(value);
}

export function isFriendlyName(value) {
  return typeof value === 'string' && FRIENDLY.test(value);
}

export function classifyOperation({ friendly_name = '', variable_keys = [], page = '' } = {}) {
  const name = String(friendly_name || '');
  const blob = `${name} ${(variable_keys || []).join(' ')} ${page}`.toLowerCase();
  if (WRITE_NAME.test(name)) return 'write_skip';
  if (/log|pixel|tracking|experiment|abtest|consent/i.test(name)) return 'other';
  if (/marketplace\/you\/selling|seller.?listing|you.?selling/.test(blob) && !/inbox|message/.test(name.toLowerCase())) {
    return 'selling_listings';
  }
  if (/\bbuying\b/.test(blob) && /inbox|thread/.test(blob)) return 'buying_inbox';
  if (/message|history/.test(blob) && /thread/.test(blob)) return 'thread_messages';
  if (/inbox/.test(blob) && /thread|conversation|message/.test(blob)) return 'selling_inbox';
  if (/listing|commerce_listing|product_item/.test(blob)) return 'listing_context';
  if (/inbox|thread/.test(blob)) return 'selling_inbox';
  return 'other';
}

export function redactUrl(raw) {
  try {
    const u = new URL(String(raw), 'https://www.facebook.com');
    const doc = u.searchParams.get('doc_id');
    const friendly = u.searchParams.get('fb_api_req_friendly_name');
    const params = new URLSearchParams();
    if (isDocId(doc || '')) params.set('doc_id', doc);
    if (isFriendlyName(friendly || '')) params.set('fb_api_req_friendly_name', friendly);
    const q = params.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ''}`;
  } catch {
    return 'https://www.facebook.com/api/graphql/';
  }
}

export function friendlyFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return '';
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'x-fb-friendly-name' && isFriendlyName(value)) return value;
  }
  return '';
}

export function summarizeGraphqlPost(postData, headerFriendlyName = '') {
  let params;
  try {
    params = new URLSearchParams(String(postData || ''));
  } catch {
    return null;
  }
  const friendly = isFriendlyName(params.get('fb_api_req_friendly_name') || '')
    ? params.get('fb_api_req_friendly_name')
    : (isFriendlyName(headerFriendlyName) ? headerFriendlyName : '');
  const doc = params.get('doc_id') || '';
  const doc_id = isDocId(doc) ? doc : null;
  let variable_keys = [];
  const vars = params.get('variables');
  if (vars) {
    try {
      const obj = JSON.parse(vars);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        variable_keys = Object.keys(obj).filter(key => !SECRET_KEY.test(key)).slice(0, 40);
      }
    } catch {
      variable_keys = [];
    }
  }
  if (!doc_id && !friendly && variable_keys.length === 0) return null;
  return {
    doc_id,
    friendly_name: friendly || null,
    variable_keys,
    guess: classifyOperation({ friendly_name: friendly, variable_keys }),
    replay: classifyOperation({ friendly_name: friendly, variable_keys }) !== 'write_skip',
  };
}

export function fromPerformanceEntries(entries) {
  const out = [];
  for (const entry of entries || []) {
    const name = entry && (entry.name || entry);
    if (typeof name !== 'string' || !name.includes('/api/graphql')) continue;
    const url = redactUrl(name);
    const doc = (url.match(/[?&]doc_id=(\d{5,24})/) || [])[1] || null;
    const friendly = (url.match(/[?&]fb_api_req_friendly_name=([A-Za-z0-9_]+)/) || [])[1] || null;
    out.push({
      url,
      doc_id: isDocId(doc || '') ? doc : null,
      friendly_name: isFriendlyName(friendly || '') ? friendly : null,
    });
  }
  return out;
}

export function parseFbJsonChunks(text) {
  const cleaned = String(text || '').replace(/^\s*for\s*\(;;\);\s*/, '');
  if (!cleaned.trim()) return [];
  try {
    return [JSON.parse(cleaned)];
  } catch { /* fall through to newline-delimited JSON */ }
  const chunks = [];
  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      chunks.push(JSON.parse(trimmed));
    } catch { /* skip a non-json line */ }
  }
  return chunks.slice(0, 5);
}

export function keySketch(value, depth = 0) {
  if (depth > 6) return { truncated: true };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      item: value.length ? keySketch(value[0], depth + 1) : null,
    };
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 30)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = keySketch(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return { type: 'string', length: value.length };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (value == null) return { type: 'null' };
  return { type: typeof value };
}

function looksLikeSecretString(value) {
  if (typeof value !== 'string') return false;
  if (value.length >= 24 && !/\s/.test(value) && /token|dtsg|eyJ/i.test(value)) return true;
  return false;
}

export function projectFields(value, { textKeys = [], limit = 40 } = {}) {
  const allowed = new Set((textKeys || []).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(key) && !SECRET_KEY.test(key)));
  const texts = [];
  const ids = [];
  const walk = (node, path, depth) => {
    if (texts.length >= limit || depth > 8 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 30)) walk(item, path, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (SECRET_KEY.test(key) || key === 'errors' || key === 'extensions') continue;
      const next = path ? `${path}.${key}` : key;
      if (typeof child === 'string') {
        if (!child || child.length > 500 || looksLikeSecretString(child)) continue;
        const wanted = allowed.size
          ? allowed.has(key)
          : (TEXT_KEY.test(key) || WHO_KEY.test(key));
        if (wanted) texts.push({ path: next, text: child });
        else if (ID_KEY.test(key) && /^[\w.:-]{1,80}$/.test(child)) ids.push({ path: next, id: child });
      } else if (typeof child === 'number' && TIME_KEY.test(key)) {
        ids.push({ path: next, id: child });
      } else if (child && typeof child === 'object') {
        walk(child, next, depth + 1);
      }
    }
  };
  walk(value, '', 0);
  return { texts: texts.slice(0, limit), ids: ids.slice(0, limit) };
}

export function projectResponseText(text, options) {
  const chunks = parseFbJsonChunks(String(text || '').slice(0, 200000));
  const texts = [];
  const ids = [];
  const top_keys = [];
  let has_errors = false;
  const sketches = [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object' && !Array.isArray(chunk)) {
      if (chunk.errors) has_errors = true;
      top_keys.push(...Object.keys(chunk).filter(key => !SECRET_KEY.test(key)).slice(0, 20));
    }
    sketches.push(keySketch(chunk));
    const projected = projectFields(chunk, options);
    texts.push(...projected.texts);
    ids.push(...projected.ids);
  }
  const textKeys = options?.textKeys || [];
  const usable = textKeys.length > 0 && texts.length > 0 && ids.length > 0;
  return {
    top_keys: [...new Set(top_keys)].slice(0, 20),
    sketch: sketches.slice(0, 3),
    texts: textKeys.length ? texts.slice(0, 40) : [],
    ids: ids.slice(0, 40),
    has_errors,
    messages_in_graphql: texts.length > 0,
    usable_for_ledger: usable,
  };
}

export function sanitizeVariables(value, depth = 0) {
  if (depth > 3) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (value.length > 80 || /\s/.test(value) || /token|dtsg|cookie|secret/i.test(value)) return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeVariables(item, depth + 1)).filter(item => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 20)) {
      if (SECRET_KEY.test(key)) continue;
      const next = sanitizeVariables(child, depth + 1);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return undefined;
}

export function safePage(page) {
  return PAGES.has(page) ? page : 'https://www.facebook.com/marketplace/inbox/';
}

export function parseVerifiedRows(markdown) {
  const rows = [];
  for (const block of String(markdown || '').matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    let data;
    try {
      data = JSON.parse(block[1]);
    } catch {
      continue;
    }
    for (const row of Array.isArray(data?.rows) ? data.rows : []) {
      if (!row || row.status !== 'VERIFIED') continue;
      const friendly = isFriendlyName(row.friendly_name) ? row.friendly_name : '';
      const doc_id = isDocId(String(row.doc_id || '')) ? String(row.doc_id) : null;
      if (!friendly && !doc_id) continue;
      if (classifyOperation({ friendly_name: friendly, page: row.page || '' }) === 'write_skip') continue;
      const text_keys = (Array.isArray(row.text_keys) ? row.text_keys : [])
        .filter(key => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(key) && !SECRET_KEY.test(key))
        .slice(0, 12);
      rows.push({
        capability: String(row.capability || 'other').slice(0, 60),
        friendly_name: friendly || null,
        doc_id,
        page: safePage(row.page),
        tab: row.tab === 'Buying' ? 'Buying' : 'Selling',
        variables: sanitizeVariables(row.variables || {}) || {},
        text_keys,
      });
    }
  }
  return rows;
}

export function scrub(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => scrub(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = scrub(child, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/fb_dtsg[=:][^&\s"']+/gi, 'fb_dtsg=[redacted]')
      .replace(/[?&]lsd=[^&\s"']+/gi, 'lsd=[redacted]')
      .replace(/jazoest=\d+/gi, 'jazoest=[redacted]')
      .replace(/c_user=\d+/gi, 'c_user=[redacted]')
      .replace(/(?:^|[;\s])xs=[^;\s"']+/gi, ' xs=[redacted]');
  }
  return value;
}

const LEAK = /fb_dtsg["']?\s*[:=]\s*["']?(?!\[redacted\])[A-Za-z0-9]|(?:^|[?&\s])lsd=[A-Za-z0-9]|jazoest=\d{2,}|c_user=\d{3,}|(?:^|[;\s])xs=[A-Za-z0-9]/;

export function renderOutput(obj) {
  const text = JSON.stringify(scrub(obj), null, 1);
  if (LEAK.test(text)) {
    return {
      text: JSON.stringify({ fallback: true, reason: 'refused_to_print_secrets' }, null, 1),
      leaked: true,
    };
  }
  return { text, leaked: false };
}

export function publicError(text) {
  return scrub(String(text || 'error')).replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]').slice(0, 240);
}

export function localDebugUrl(url) {
  try {
    const parsed = new URL(String(url));
    return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function pickFacebookTab(tabs) {
  const pages = (Array.isArray(tabs) ? tabs : []).filter(tab => tab && tab.type === 'page' && tab.webSocketDebuggerUrl);
  return pages.find(tab => String(tab.url || '').includes('facebook.com')) || pages[0] || null;
}

export function dedupeOps(list) {
  const map = new Map();
  for (const op of list) {
    const key = `${op.phase || ''}|${op.friendly_name || ''}|${op.doc_id || ''}`;
    const prev = map.get(key);
    if (!prev || (!prev.sketch && op.sketch)) map.set(key, op);
  }
  return [...map.values()];
}

export const PAGE_RECORDER_JS = `(() => {
  if (window.__fbmGraphqlLog) return;
  const log = [];
  window.__fbmGraphqlLog = log;
  const secret = /^(fb_dtsg|lsd|jazoest|xs|c_user|__s|__hsi|fb_dtsg_ag)$/i;
  function record(url, body) {
    try {
      if (!String(url || '').includes('/api/graphql')) return;
      let raw = '';
      if (typeof body === 'string') raw = body;
      else if (body && typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) raw = body.toString();
      else return;
      const params = new URLSearchParams(raw);
      let keys = [];
      try {
        const parsed = JSON.parse(params.get('variables') || 'null');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          keys = Object.keys(parsed).filter(key => !secret.test(key)).slice(0, 40);
        }
      } catch { keys = []; }
      const doc = params.get('doc_id') || '';
      const friendly = params.get('fb_api_req_friendly_name') || '';
      log.push({
        doc_id: /^\\d{5,24}$/.test(doc) ? doc : null,
        friendly_name: /^[A-Za-z][A-Za-z0-9_]{2,120}$/.test(friendly) ? friendly : null,
        variable_keys: keys,
      });
      if (log.length > 80) log.shift();
    } catch { /* keep the page's own fetch working */ }
  }
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function(input, init) {
      try { record(typeof input === 'string' ? input : (input && input.url), init && init.body); } catch {}
      return origFetch.apply(this, arguments);
    };
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__fbmUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      try { record(this.__fbmUrl, body); } catch {}
      return origSend.apply(this, arguments);
    };
  }
})()`;

export function buildReadExpression({ docId, friendlyName, variables, textKeys }) {
  if (!isDocId(docId || '') || !isFriendlyName(friendlyName || '')) return null;
  if (classifyOperation({ friendly_name: friendlyName }) === 'write_skip') return null;
  const vars = sanitizeVariables(variables || {}) || {};
  const keys = (textKeys || []).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(key) && !SECRET_KEY.test(key)).slice(0, 12);
  return `(() => {
    const docId = ${JSON.stringify(docId)};
    const friendly = ${JSON.stringify(friendlyName)};
    const variables = ${JSON.stringify(vars)};
    const textKeys = ${JSON.stringify(keys)};
    function readTokens() {
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const field = name => (document.querySelector('input[name="' + name + '"]') || {}).value || '';
      let dtsg = field('fb_dtsg');
      let lsd = field('lsd');
      const dtsgMatch = html.match(/"DTSGInitialData",\\[\\],\\{"token":"([^"]+)"/) || html.match(/"DTSGInitData",\\[\\],\\{"token":"([^"]+)"/);
      const lsdMatch = html.match(/"LSD",\\[\\],\\{"token":"([^"]+)"/);
      if (!dtsg && dtsgMatch) dtsg = dtsgMatch[1];
      if (!lsd && lsdMatch) lsd = lsdMatch[1];
      try {
        if (!dtsg && window.require) dtsg = (window.require('DTSGInitialData') || {}).token || dtsg;
        if (!lsd && window.require) lsd = (window.require('LSD') || {}).token || lsd;
      } catch {}
      if (!dtsg || !lsd) return null;
      let sum = 0;
      for (const ch of dtsg) sum += ch.charCodeAt(0);
      const viewer = (document.cookie.match(/(?:^|; )c_user=(\\d+)/) || [])[1] || '';
      return { dtsg, lsd, jazoest: '2' + sum, viewer };
    }
    const tokens = readTokens();
    if (!tokens) return { error: 'missing_tokens' };
    const body = new URLSearchParams({
      fb_dtsg: tokens.dtsg,
      lsd: tokens.lsd,
      jazoest: tokens.jazoest,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: friendly,
      doc_id: docId,
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
      __user: tokens.viewer,
      __a: '1',
    });
    return fetch('/api/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': friendly },
      body,
    }).then(async res => {
      const raw = await res.text();
      const secretKey = /(fb_dtsg|^lsd$|jazoest|^xs$|^c_user$|cookie|authorization|access_token|^token$|secret)/i;
      let parsed = null;
      const cleaned = String(raw || '').replace(/^\\s*for\\s*\\(;;\\);\\s*/, '');
      try { parsed = JSON.parse(cleaned); } catch { parsed = null; }
      const texts = [];
      const ids = [];
      const allow = new Set(textKeys);
      const walk = (node, path, depth) => {
        if (!node || depth > 8 || texts.length >= 40) return;
        if (Array.isArray(node)) { for (const item of node.slice(0, 30)) walk(item, path, depth + 1); return; }
        if (typeof node !== 'object') return;
        for (const [key, child] of Object.entries(node)) {
          if (secretKey.test(key) || key === 'errors' || key === 'extensions') continue;
          const next = path ? path + '.' + key : key;
          if (typeof child === 'string' && child.length > 0 && child.length <= 500 && allow.has(key)) texts.push({ path: next, text: child });
          else if (typeof child === 'number' && /time|timestamp|date/i.test(key)) ids.push({ path: next, id: child });
          else if (typeof child === 'string' && /(^id$|_id$)/i.test(key) && child.length <= 80) ids.push({ path: next, id: child });
          else if (child && typeof child === 'object') walk(child, next, depth + 1);
        }
      };
      walk(parsed, '', 0);
      return {
        status: res.status,
        has_errors: !!(parsed && parsed.errors),
        top_keys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).filter(key => !secretKey.test(key)).slice(0, 20) : [],
        texts, ids,
        messages_in_graphql: texts.length > 0,
        usable_for_ledger: texts.length > 0 && ids.length > 0,
      };
    });
  })()`;
}

function fail(label) {
  console.log(`FAIL ${label}`);
  process.exitCode = 1;
}

function assertClean(label, value, secrets) {
  const rendered = renderOutput(value);
  if (rendered.leaked) return fail(`${label}_leak_guard`);
  for (const secret of secrets) {
    if (secret && rendered.text.includes(secret)) return fail(label);
  }
  return rendered;
}

function selfTest() {
  const dtsg = 'NAftestDTSGTOKEN1234567890EXTRA';
  const lsd = 'LSDSECRETVALUE9876543210';
  const cookie = 'xs=COOKIESECRETVALUE123456789';
  const cursor = 'CURSORSECRETTOKENVALUE1234567890';
  const post = new URLSearchParams({
    fb_dtsg: dtsg,
    lsd,
    jazoest: '29999',
    doc_id: '1234567890123',
    fb_api_req_friendly_name: 'MarketplaceInboxExampleQuery',
    variables: JSON.stringify({ count: 10, cursor, fb_dtsg: dtsg }),
  }).toString();
  const summary = summarizeGraphqlPost(post, '');
  assertClean('post_summary', summary, [dtsg, lsd, cookie, cursor, '29999']);
  if (summary.doc_id !== '1234567890123') fail('doc_id');
  if (summary.friendly_name !== 'MarketplaceInboxExampleQuery') fail('friendly');
  if (!summary.variable_keys.includes('count') || !summary.variable_keys.includes('cursor')) fail('variable_keys');
  if (summary.variable_keys.includes('fb_dtsg')) fail('variable_key_secret');
  if (summary.guess !== 'selling_inbox') fail('guess_inbox');

  const url = redactUrl(`https://www.facebook.com/api/graphql/?doc_id=1234567890123&fb_dtsg=${dtsg}&fb_api_req_friendly_name=MarketplaceInboxExampleQuery`);
  assertClean('url', { url }, [dtsg, lsd]);
  if (!url.includes('doc_id=1234567890123')) fail('url_doc');
  if (url.includes('fb_dtsg')) fail('url_dtsg_key');

  const header = friendlyFromHeaders({ Cookie: `c_user=100; ${cookie}`, 'X-FB-Friendly-Name': 'MarketplaceInboxExampleQuery', 'X-FB-LSD': lsd });
  assertClean('header', { header }, [dtsg, lsd, cookie]);
  if (header !== 'MarketplaceInboxExampleQuery') fail('header_name');

  if (classifyOperation({ friendly_name: 'SendMarketplaceMessageMutation' }) !== 'write_skip') fail('write_skip');
  const perf = fromPerformanceEntries([{ name: `https://www.facebook.com/api/graphql/?fb_dtsg=${dtsg}` }, { name: 'https://www.facebook.com/ajax/bootloader-endpoint/' }]);
  assertClean('perf', perf, [dtsg]);
  if (perf.length !== 1 || perf[0].url.includes('fb_dtsg')) fail('perf_strip');

  const body = JSON.stringify({
    data: { node: { id: '111', title: 'Bike', snippet: 'Is this still available?', updated_time: 1700000000, fb_dtsg: dtsg } },
    extensions: { token: dtsg },
  });
  const projected = projectResponseText(body, { textKeys: ['title', 'snippet'] });
  assertClean('project', projected, [dtsg, lsd, cookie]);
  if (!projected.usable_for_ledger) fail('usable');
  if (!projected.texts.some(row => row.text === 'Is this still available?')) fail('snippet');
  const sketch = keySketch(JSON.parse(body));
  assertClean('sketch', sketch, [dtsg]);
  if (JSON.stringify(sketch).includes('Bike')) fail('sketch_leaked_text');

  const verified = parseVerifiedRows('```json\n{"rows":[{"capability":"selling_inbox","status":"VERIFIED","friendly_name":"MarketplaceInboxExampleQuery","doc_id":"1234567890123","text_keys":["snippet"],"variables":{"count":5,"note":"has spaces"}}]}\n```\n```json\n{"rows":[{"status":"UNTESTED","friendly_name":"NopeQuery","doc_id":"1234567890123"}]}\n```');
  if (verified.length !== 1 || verified[0].variables.note || verified[0].variables.count !== 5) fail('verified_parse');
  const sendRow = parseVerifiedRows('```json\n{"rows":[{"status":"VERIFIED","friendly_name":"SendMarketplaceMessageMutation","doc_id":"1234567890123"}]}\n```');
  if (sendRow.length !== 0) fail('verified_write');

  const expr = buildReadExpression({ docId: '1234567890123', friendlyName: 'MarketplaceInboxExampleQuery', variables: { count: 5, fb_dtsg: dtsg }, textKeys: ['snippet'] });
  if (!expr || expr.includes(dtsg) || !expr.includes('1234567890123') || !expr.includes("fetch('/api/graphql/'")) fail('read_expr');
  new Function(`return ${expr}`);
  new Function(PAGE_RECORDER_JS);
  if (PAGE_RECORDER_JS.includes('console.')) fail('recorder_logs');
  if (buildReadExpression({ docId: '1234567890123', friendlyName: 'SendMarketplaceMessageMutation', variables: {} })) fail('read_expr_write');

  const scrubbed = renderOutput({ snippet: `prefix fb_dtsg=${dtsg}` });
  if (scrubbed.leaked || scrubbed.text.includes(dtsg)) fail('render_scrub');
  const leaked = renderOutput({ snippet: `prefix fb_dtsg: ${dtsg}` });
  if (!leaked.leaked || leaked.text.includes(dtsg)) fail('render_guard');

  if (pickFacebookTab([{ type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://127.0.0.1:9224/devtools/page/a' }, { type: 'page', url: 'https://www.facebook.com/marketplace/inbox/', webSocketDebuggerUrl: 'ws://127.0.0.1:9224/devtools/page/b' }]).url.includes('facebook') !== true) {
    fail('pick_tab');
  }
  if (!localDebugUrl('ws://127.0.0.1:9224/devtools/page/abc') || localDebugUrl('ws://evil.example/devtools/page/abc')) {
    fail('local_ws');
  }
  if (process.exitCode) return;
  console.log('ok');
}

if (process.argv.includes('--self-test')) selfTest();
