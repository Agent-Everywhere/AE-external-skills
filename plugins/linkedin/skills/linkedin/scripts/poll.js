// poll.js: one poll of the user's own classic LinkedIn: who accepted, who is still pending, who replied. Same-origin
// reads from the user's OWN logged-in linkedin.com tab, first page of each, read-only.
// Run it as: (<this file>)({since?, start?, conversationsSince?, includeText?, parts?, conversationsQueryId?, mailboxUrn?})
// Params (replies.py next prints since, start and conversationsSince):
//   since               epoch ms of the newest connection already seen; only newer connections count as accepted.
//   start               offset into the newest-first connections list (default 0; replies.py moves it when more than
//                       10 connections are new).
//   conversationsSince  epoch ms of the newest conversation activity already seen.
//   includeText         opt-in. Default false: message bodies are never returned. true returns at most 280
//                       characters of the latest message per replied conversation, as untrusted text.
//   parts               subset of ["pending","connections","conversations"] (default all three).
//   conversationsQueryId / mailboxUrn  override what the script reads from the page (see references/endpoints.md).
//   Pacing is fixed at 4 to 8 seconds between requests (params.__test === true overrides it, for tests only).
// Returns {accepted:[{member,vanity,connectedAt}], pending:[{member,vanity,sentAt}],
//          replied:[{member,vanity,conversation,lastMessageAt,fromThem:true,text?}],
//          cursor:{connectedAt,conversationsAt}, has_more_connections, seen:{...counts}, stopped_reason, request}
// vanity is "" when the response did not carry it; replies.py then matches on member id.
// Never returns cookies, tokens, invitation secrets or custom invite notes. After each request the result so far is
// saved to localStorage "liPollLastRun".
async function (params) {
  const PAGE = 10;
  const MAX_TEXT = 280;
  const STOP_STATUS = [401, 403, 429, 999, 410];
  const g = globalThis;
  const p = params || {};
  const testing = p.__test === true;
  const minDelay = testing && Number.isFinite(+p.minDelayMs) ? Math.max(0, +p.minDelayMs) : 4000;
  const maxDelay = testing && Number.isFinite(+p.maxDelayMs) ? Math.max(minDelay, +p.maxDelayMs) : 8000;
  const int = (x) => (Number.isFinite(+x) && +x > 0 ? Math.floor(+x) : 0);
  const since = int(p.since);
  const start = int(p.start);
  const convSince = int(p.conversationsSince);
  const includeText = p.includeText === true;
  const parts = Array.isArray(p.parts) && p.parts.length ? p.parts : ['pending', 'connections', 'conversations'];

  const out = { accepted: [], pending: [], replied: [], cursor: { connectedAt: 0, conversationsAt: 0 },
    has_more_connections: false, seen: {}, stopped_reason: null,
    request: { since, start, conversationsSince: convSince, includeText } };
  const persist = (partial) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('liPollLastRun', JSON.stringify(Object.assign({}, out, { partial: !!partial, saved_at: new Date().toISOString() })));
      }
    } catch (e) { /* storage is optional */ }
  };
  const finish = (reason) => {
    out.stopped_reason = reason || null;
    persist(false);
    try { if (typeof copy === 'function') copy(JSON.stringify(out)); } catch (e) { /* clipboard is optional */ }
    return out;
  };

  if (g.__liPollRunning) {   // another run is live in this tab: touch nothing
    out.stopped_reason = 'already_running';
    return out;
  }
  g.__liPollRunning = true;
  try {
    if (parts.some((x) => !['pending', 'connections', 'conversations'].includes(x))) return finish('bad_params');
    const host = (typeof location !== 'undefined' && location && location.hostname) || '';
    if (host && !/(^|\.)linkedin\.com$/i.test(host)) return finish('wrong_page');
    const m = /(?:^|;\s*)JSESSIONID=([^;]*)/.exec((typeof document !== 'undefined' && document.cookie) || '');
    const csrf = m ? m[1].replace(/^"+|"+$/g, '') : '';
    if (!csrf) return finish('no_session');

    // The conversations queryId is read from the page's own requests: check it before any request is made.
    let queryId = typeof p.conversationsQueryId === 'string' ? p.conversationsQueryId.trim() : '';
    if (parts.includes('conversations')) {
      if (!queryId && typeof performance !== 'undefined' && performance.getEntriesByType) {
        for (const e of performance.getEntriesByType('resource')) {
          const q = /queryId=(messengerConversations\.[A-Za-z0-9]+)/.exec(String((e && e.name) || ''));
          if (q) queryId = q[1];
        }
      }
      if (!/^messengerConversations\.[A-Za-z0-9]+$/.test(queryId)) return finish('queryid_not_found');
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let first = true;
    // One paced GET. Returns {body} or {stop: reason}. A 400 stops with `on400` (the id rotated), else http_400.
    const get = async (url, on400) => {
      if (!first) await sleep(minDelay + Math.random() * (maxDelay - minDelay));
      first = false;
      let res;
      try {
        res = await fetch(url, { method: 'GET', credentials: 'include', headers: {
          'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'accept': 'application/vnd.linkedin.normalized+json+2.1' } });
      } catch (e) { return { stop: 'network_error' }; }
      const where = String(res.url || '');
      if (res.redirected && /checkpoint|challenge/i.test(where)) return { stop: 'checkpoint' };
      if (res.redirected && /\/login|\/uas\/|authwall/i.test(where)) return { stop: 'login_redirect' };
      if (STOP_STATUS.includes(res.status)) return { stop: 'http_' + res.status };
      if (res.status === 400) return { stop: on400 || 'http_400' };
      if (res.status !== 200) return { stop: 'http_' + res.status };
      let body;
      try { body = await res.json(); } catch (e) { return { stop: 'non_json_response' }; }
      return { body };
    };
    const included = (b) => (b && Array.isArray(b.included) ? b.included : []);
    const lastSeg = (urn) => (typeof urn === 'string' ? urn.split(':').pop() : '');
    const idOf = (urn) => { const s = lastSeg(urn).replace(/[^A-Za-z0-9_-]/g, ''); return s.slice(0, 60); };
    const vanityFor = (inc, member) => {
      if (!member) return '';
      const hit = inc.find((o) => o && typeof o.publicIdentifier === 'string' && typeof o.entityUrn === 'string'
        && o.entityUrn.endsWith(':' + member));
      return hit && /^[A-Za-z0-9_.\-%]+$/.test(hit.publicIdentifier) ? hit.publicIdentifier : '';
    };

    // ---- 1. pending sent invitations ----------------------------------------------------------------------
    if (parts.includes('pending')) {
      const r = await get('/voyager/api/relationships/sentInvitationViewsV2?invitationType=CONNECTION&q=invitationType&start=0&count=' + PAGE);
      if (r.stop) return finish(r.stop);
      const inc = included(r.body);
      for (const o of inc) {
        if (o && typeof o.toMemberId === 'string' && typeof o.sentTime === 'number') {
          const member = idOf(o.toMemberId);
          out.pending.push({ member, vanity: vanityFor(inc, member), sentAt: o.sentTime });
        }
      }
      out.seen.invitations = out.pending.length;
      persist(true);
    }

    // ---- 2. connections, newest first -----------------------------------------------------------------------
    if (parts.includes('connections')) {
      const r = await get('/voyager/api/relationships/dash/connections?decorationId='
        + 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16'
        + '&count=' + PAGE + '&q=search&sortType=RECENTLY_ADDED&start=' + start, 'decoration_rotated');
      if (r.stop) return finish(r.stop);
      const inc = included(r.body);
      const conns = inc.filter((o) => o && typeof o.createdAt === 'number' && typeof o.connectedMember === 'string')
        .sort((a, b) => b.createdAt - a.createdAt);
      out.seen.connections = conns.length;
      for (const c of conns) {
        if (c.createdAt > out.cursor.connectedAt) out.cursor.connectedAt = c.createdAt;
        if (c.createdAt > since) {
          const member = idOf(c.connectedMember);
          out.accepted.push({ member, vanity: vanityFor(inc, member), connectedAt: c.createdAt });
        }
      }
      // A full page that is all newer than `since` may hide more new ones below it. The first poll (since 0) has no
      // cutoff to walk back to, so it never asks for more.
      out.has_more_connections = since > 0 && conns.length >= PAGE && conns.every((c) => c.createdAt > since);
      persist(true);
    }

    // ---- 3. conversations ----------------------------------------------------------------------------------
    if (parts.includes('conversations')) {
      let me = typeof p.mailboxUrn === 'string' ? idOf(p.mailboxUrn) : '';
      if (!me) {
        const r = await get('/voyager/api/me');
        if (r.stop) return finish(r.stop);
        for (const o of included(r.body)) {
          const d = o && typeof o.dashEntityUrn === 'string' && /^urn:li:fsd_profile:([A-Za-z0-9_-]+)$/.exec(o.dashEntityUrn);
          if (d) { me = d[1]; break; }
        }
        if (!me) return finish('me_not_found');
      }
      const r = await get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=' + queryId
        + '&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3A' + encodeURIComponent(me) + ')', 'queryid_rotated');
      if (r.stop) return finish(r.stop);
      const inc = included(r.body);
      const convs = inc.filter((o) => o && typeof o.lastActivityAt === 'number' && typeof o.entityUrn === 'string'
        && /conversation/i.test(o.entityUrn));
      const msgs = inc.filter((o) => o && typeof o.deliveredAt === 'number' && o.body !== undefined);
      const byUrn = new Map(inc.filter((o) => o && typeof o.entityUrn === 'string').map((o) => [o.entityUrn, o]));
      out.seen.conversations = convs.length;
      out.seen.messages = msgs.length;
      const isMe = (part) => JSON.stringify(part || {}).includes(me);
      for (const c of convs) {
        if (c.lastActivityAt > out.cursor.conversationsAt) out.cursor.conversationsAt = c.lastActivityAt;
        if (c.lastActivityAt <= convSince) continue;
        const partUrns = Array.isArray(c['*conversationParticipants']) ? c['*conversationParticipants'] : [];
        const others = partUrns.map((u) => byUrn.get(u)).filter((x) => x && !isMe(x));
        if (partUrns.length !== 2 || others.length !== 1) continue;   // one-to-one chats only
        // The latest message of this conversation, when the response ties messages to conversations.
        const mine = msgs.filter((x) => x['*conversation'] === c.entityUrn
          || (x.conversation && x.conversation.entityUrn === c.entityUrn));
        const latest = mine.sort((a, b) => b.deliveredAt - a.deliveredAt)[0];
        const sender = latest && (byUrn.get(latest['*sender']) || null);
        const fromThem = latest && sender ? !isMe(sender) : (c.unreadCount > 0 || c.read === false);
        if (!fromThem) continue;
        const them = others[0];
        const member = idOf(them.hostIdentityUrn || them.entityUrn);
        const vm = /linkedin\.com\/in\/([A-Za-z0-9_.\-%]+)/i.exec(JSON.stringify(them));
        const row = { member, vanity: vm ? vm[1] : '', conversation: c.entityUrn, lastMessageAt: c.lastActivityAt, fromThem: true };
        if (includeText && latest) {
          const t = latest.body && (typeof latest.body === 'string' ? latest.body : latest.body.text);
          if (typeof t === 'string') row.text = t.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
        }
        out.replied.push(row);
      }
      persist(true);
    }
    return finish(null);
  } finally {
    g.__liPollRunning = false;
  }
}
