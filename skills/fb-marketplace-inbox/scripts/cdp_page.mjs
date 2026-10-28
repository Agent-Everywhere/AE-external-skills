// CDP attach for a signed-in facebook.com tab. Read-only. Does not print cookies or tokens.
import {
  friendlyFromHeaders,
  publicError,
  redactUrl,
  summarizeGraphqlPost,
} from './graphql_redact.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function cdpPort() {
  return /^\d+$/.test(process.env.CDP_PORT || '') ? process.env.CDP_PORT : '9224';
}

export async function listTabs(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error('cdp_unreachable');
  const tabs = await res.json();
  if (!Array.isArray(tabs)) throw new Error('cdp_unreachable');
  return tabs;
}

export function connectCdp(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`cdp timeout ${method}`));
    }, 30000);
    pending.set(requestId, message => {
      clearTimeout(timer);
      resolve(message);
    });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('cdp_unreachable'));
  });
  return { ws, send, ready, on: listener => listeners.push(listener) };
}

export async function evalInPage(send, expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.error) throw new Error(publicError(res.error.message || 'cdp error'));
  const details = res.result?.exceptionDetails;
  if (details) throw new Error(publicError(details.text || details.exception?.description || 'eval failed'));
  return res.result?.result?.value;
}

export function attachGraphqlTap(conn) {
  const ops = new Map();
  const bodyQueue = [];
  conn.on(message => {
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params?.request || {};
      const url = String(request.url || '');
      if (!url.includes('/api/graphql')) return;
      const summary = summarizeGraphqlPost(request.postData || '', friendlyFromHeaders(request.headers));
      if (!summary) return;
      ops.set(message.params.requestId, { ...summary, url: redactUrl(url), status: null, phase: null, sketch: null });
    } else if (message.method === 'Network.responseReceived') {
      const row = ops.get(message.params.requestId);
      if (row) row.status = message.params.response?.status ?? null;
    } else if (message.method === 'Network.loadingFinished') {
      if (ops.has(message.params.requestId)) bodyQueue.push(message.params.requestId);
    }
  });
  return { ops, bodyQueue };
}

export async function responseText(send, requestId) {
  const res = await send('Network.getResponseBody', { requestId });
  if (res.error || !res.result) return '';
  let text = res.result.body || '';
  if (res.result.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
  return String(text).slice(0, 200000);
}

export async function preparePage(send, recorderJs) {
  await send('Page.enable');
  await send('Network.enable', { maxPostDataSize: 65536 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: recorderJs });
  await evalInPage(send, recorderJs);
}

export async function gotoFacebook(send, url) {
  await send('Page.navigate', { url });
}

export async function loginWall(send) {
  return evalInPage(send, `(() => {
    const text = (document.body && document.body.innerText || '').slice(0, 500);
    const login = /log in|log into facebook|checkpoint|captcha|confirm your identity/i.test(text);
    const market = /Marketplace/i.test(text);
    return { login_wall: login && !market };
  })()`);
}

export async function viewerFlags(send) {
  return evalInPage(send, `(() => {
    let viewer = null;
    const match = document.cookie.match(/(?:^|; )c_user=(\\d+)/);
    if (match) viewer = match[1];
    if (!viewer) {
      try {
        const data = window.require && window.require('CurrentUserInitialData');
        const id = data && data.USER_ID;
        if (id && /^\\d+$/.test(String(id))) viewer = String(id);
      } catch {}
    }
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    return {
      viewer_id: viewer,
      has_fb_dtsg: /"DTSGInitialData"|"DTSGInitData"|name="fb_dtsg"/.test(html),
      has_lsd: /"LSD",\\[\\]|name="lsd"/.test(html),
    };
  })()`);
}

export async function clickTab(send, tab) {
  const which = tab === 'Buying' ? 'Buying' : 'Selling';
  return evalInPage(send, `(() => {
    const tab = ${JSON.stringify(which)};
    const el = [...document.querySelectorAll('[role=main] [role=tab],[role=main] a,[role=main] span')].find(node => (node.innerText || '').trim() === tab);
    if (el) el.click();
    return { clicked: !!el };
  })()`);
}

export async function openFirstThread(send) {
  return evalInPage(send, `(() => {
    const root = document.querySelector('[role=main]');
    if (!root) return { clicked: false };
    [...document.querySelectorAll('[aria-label="Close chat"]')].forEach(button => button.click());
    const rows = [...root.querySelectorAll('[role=button]')].filter(node => node.innerText.split('\\n').length >= 3 && /\\d{1,2}:\\d{2}|[A-Z][a-z]{2} \\d{1,2}|\\d+[mhdw]$/.test(node.innerText.trim()));
    if (!rows[0]) return { clicked: false };
    rows[0].click();
    return { clicked: true };
  })()`);
}

export async function performanceGraphql(send) {
  return evalInPage(send, `(() => performance.getEntriesByType('resource').filter(entry => String(entry.name).includes('/api/graphql')).slice(-40).map(entry => ({ name: String(entry.name) })))()`);
}

export async function pageRecorderLog(send) {
  return evalInPage(send, `(() => (window.__fbmGraphqlLog || []).slice(-40))()`);
}
