// search_people.js: classic LinkedIn people search (no Sales Navigator), from the user's OWN logged-in linkedin.com
// tab. Fetches /search/results/people/ pages same-origin, one at a time, and reads the result cards out of the HTML.
// Run it as: (<this file>)({keywords, network?, page_from?, pages?, geoUrn?, extra?, search?})
// Params:
//   keywords   required, up to 200 characters.
//   network    ["F","S","O"] (1st, 2nd, 3rd and beyond). Default ["F","S"].
//   page_from  first result page, 1 to 100 (default 1). pages: how many pages, 1 to 5 (default 3).
//   geoUrn     optional geo id (digits, or urn:li:fsd_geo:<digits>).
//   extra      optional raw query string for other LinkedIn search filters; it cannot override keywords, network,
//              page or geoUrn.
//   search     optional ledger search id (s1, s2...), echoed back so find_people.py can match the run.
//   issue      optional run id printed by `find_people.py next-pages`, echoed back in `request` so `merge` settles the
//              right reservation. Pass the printed params unchanged.
//   Pacing is fixed at 8 to 15 seconds between pages (params.__test === true overrides it, for tests only).
// Returns {rows:[{vanity,name,degree,headline,location,page}], pages_read, pages_attempted, stopped_reason, request}
//   pages_read counts pages that held people; pages_attempted counts every fetch.
// Reads the page HTML with a small tokenizer, not DOMParser: the result cards nest <a> inside <a>, which a browser's
// HTML parser re-parents, so a text-level reader gives the same answer in the page and in the tests.
// Never returns cookies or tokens. After every page the rows so far are saved to localStorage "liFindPeopleLastRun".
async function (params) {
  const MAX_PAGES = 5;
  const LAST_PAGE = 100;
  const STOP_STATUS = [401, 403, 429, 999, 410];
  const g = globalThis;
  const p = params || {};
  const testing = p.__test === true;
  const minDelay = testing && Number.isFinite(+p.minDelayMs) ? Math.max(0, +p.minDelayMs) : 8000;
  const maxDelay = testing && Number.isFinite(+p.maxDelayMs) ? Math.max(minDelay, +p.maxDelayMs) : 15000;

  const out = { rows: [], pages_read: 0, pages_attempted: 0, stopped_reason: null, request: {} };
  const persist = (partial) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('liFindPeopleLastRun', JSON.stringify(
          { rows: out.rows, pages_read: out.pages_read, pages_attempted: out.pages_attempted,
            stopped_reason: out.stopped_reason, request: out.request, partial: !!partial,
            saved_at: new Date().toISOString() }));
      }
    } catch (e) { /* storage is optional */ }
  };
  const finish = (reason, detail) => {
    out.stopped_reason = reason || null;
    if (detail) out.detail = detail;
    persist(false);
    try { if (typeof copy === 'function') copy(JSON.stringify(out)); } catch (e) { /* clipboard is optional */ }
    return out;
  };

  if (g.__liFindPeopleRunning) {   // another run is live in this tab: touch nothing (not even the saved partial)
    out.stopped_reason = 'already_running';
    return out;
  }
  g.__liFindPeopleRunning = true;
  try {
    // ---- params ---------------------------------------------------------------------------------------------
    const keywords = typeof p.keywords === 'string' ? p.keywords.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (!keywords) return finish('bad_params', 'keywords is required');
    let network = ['F', 'S'];
    if (p.network !== undefined) {
      const n = (Array.isArray(p.network) ? p.network : [p.network]).map((x) => String(x).toUpperCase());
      if (!n.length || n.some((x) => !['F', 'S', 'O'].includes(x))) return finish('bad_params', 'network takes F, S, O');
      network = n.filter((x, i) => n.indexOf(x) === i);
    }
    const pageFrom = p.page_from === undefined ? 1 : Math.floor(+p.page_from);
    if (!(pageFrom >= 1 && pageFrom <= LAST_PAGE)) return finish('bad_params', 'page_from must be 1 to ' + LAST_PAGE);
    const pagesAsked = p.pages === undefined ? 3 : Math.floor(+p.pages);
    if (!(pagesAsked >= 1)) return finish('bad_params', 'pages must be 1 to ' + MAX_PAGES);
    const pages = Math.min(pagesAsked, MAX_PAGES, LAST_PAGE - pageFrom + 1);
    let geo = '';
    if (p.geoUrn !== undefined && p.geoUrn !== null && p.geoUrn !== '') {
      const m = /^(?:urn:li:fsd_geo:)?(\d{1,12})$/.exec(String(p.geoUrn).trim());
      if (!m) return finish('bad_params', 'geoUrn must be a geo id such as 103644278');
      geo = m[1];
    }
    let extra = '';
    if (typeof p.extra === 'string' && p.extra.trim()) {
      const e = p.extra.trim().replace(/^[?&]+/, '');
      if (!/^[A-Za-z0-9_%.\-=&~+,:()'!\[\]*]*$/.test(e)) return finish('bad_params', 'extra holds unexpected characters');
      extra = e.split('&').filter((kv) => kv && !['keywords', 'network', 'page', 'geourn'].includes(kv.split('=')[0].toLowerCase())).join('&');
    }
    const search = typeof p.search === 'string' && /^s\d{1,3}$/.test(p.search) ? p.search : undefined;
    const issue = typeof p.issue === 'string' && /^[0-9A-Za-z-]{1,40}$/.test(p.issue) ? p.issue : undefined;
    out.request = { keywords, network, page_from: pageFrom, pages };
    if (geo) out.request.geoUrn = geo;
    if (extra) out.request.extra = extra;
    if (search) out.request.search = search;
    if (issue) out.request.issue = issue;

    const host = (typeof location !== 'undefined' && location && location.hostname) || '';
    if (host && !/(^|\.)linkedin\.com$/i.test(host)) return finish('wrong_page');

    // ---- reading the page ----------------------------------------------------------------------------------
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      if (k === 'nbsp') return ' ';
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    });
    const squash = (s) => decode(s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const attrsOf = (raw) => {
      const a = {};
      const re = /([^\s=\/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let m;
      while ((m = re.exec(raw))) a[m[1].toLowerCase()] = decode(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '');
      return a;
    };
    const vanityOf = (href) => {
      const m = /^(?:https?:\/\/(?:[\w-]+\.)?linkedin\.com)?\/in\/([^\/?#\s]+)/i.exec(href || '');
      if (!m || !/^[A-Za-z0-9_.\-%]+$/.test(m[1])) return '';
      let d;
      try { d = decodeURIComponent(m[1]); } catch (e) { return ''; }
      return d && d.replace(/\./g, '') && !/[\u0000- \u007f"'`$\\\/<>;|&(){}\[\]*?!#]/.test(d) && d.length <= 100 ? d : '';
    };
    const normDegree = (t) => {
      const m = /[•·]\s*(1st|2nd|3rd\+?)/i.exec(t);
      if (!m) return '';
      const d = m[1].toLowerCase();
      return d === '1st' || d === '2nd' ? d : '3rd+';
    };
    const isExtraLine = (line, own) => line.anchors.some((a) => vanityOf(a.href) !== own)
      || /mutual connections?|followers?\b|^[•·\s]*$/i.test(line.text) || /^(current|past):/i.test(line.text);

    // Tokens: comments and script/style bodies dropped, tags with attributes, text.
    const tokenize = (html) => {
      const toks = [];
      const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)|</g;
      let m;
      while ((m = re.exec(html))) {
        if (m[2] !== undefined) {
          const tag = m[2].toLowerCase();
          if (m[1]) { toks.push({ t: 'close', tag }); continue; }
          const self = /\/\s*$/.test(m[3]) || VOID.has(tag);
          toks.push({ t: 'open', tag, attrs: attrsOf(m[3]), self });
          if (!self && (tag === 'script' || tag === 'style')) {
            // Case-insensitive match on the original string: lower-casing it first (toLowerCase) can change its
            // length for non-ASCII text, which would shift every offset after it.
            const endRe = new RegExp('</' + tag + '(?=[\\s>/])', 'ig');
            endRe.lastIndex = re.lastIndex;
            const em = endRe.exec(html);
            re.lastIndex = em ? em.index : html.length;
          }
        } else if (m[4] !== undefined) toks.push({ t: 'text', text: m[4] });
      }
      return toks;
    };

    // Returns {main, rows, cards, mainText, pageLabels}.
    const readPage = (html, pageNo) => {
      const start = html.search(/<main[\s>]/i);
      const res = { main: start >= 0, rows: [], cards: 0, mainText: '', pageLabels: [] };
      if (start < 0) return res;
      let endAt = -1;
      const mainEnd = /<\/main\s*>/ig;
      for (let mm = mainEnd.exec(html); mm; mm = mainEnd.exec(html)) endAt = mm.index;
      const toks = tokenize(html.slice(start, endAt > start ? endAt : html.length));
      const stack = [];
      let card = null;
      let lines = [];
      let lineStack = [];
      let anchorStack = [];
      const texts = [];
      const closeCard = () => {
        const c = card;
        card = null;
        res.cards++;
        const own = (c.anchors.map((a) => vanityOf(a.href)).find(Boolean)) || '';
        if (!own) return;
        const nameLine = c.lines.findIndex((l) => l.anchors.some((a) => vanityOf(a.href) === own));
        if (nameLine < 0) return;
        const nl = c.lines[nameLine];
        const nameAnchor = nl.anchors.find((a) => vanityOf(a.href) === own);
        let degree = normDegree(nl.text);
        if (!degree && c.lines[nameLine + 1]) degree = normDegree(c.lines[nameLine + 1].text);
        const rest = c.lines.slice(nameLine + 1).filter((l) => l.text && !isExtraLine(l, own) && !normDegree(l.text));
        res.rows.push({ vanity: own, name: squash(nameAnchor.text).slice(0, 120), degree,
          headline: (rest[0] ? rest[0].text : '').slice(0, 300), location: (rest[1] ? rest[1].text : '').slice(0, 120), page: pageNo });
      };
      for (const tk of toks) {
        if (tk.t === 'open') {
          if (!tk.self) stack.push(tk.tag);
          if (tk.attrs.role === 'listitem' && !card && !tk.self) {
            card = { depth: stack.length, anchors: [], lines: [] };
            lines = card.lines;
            lineStack = [];
            anchorStack = [];
          }
          const label = tk.attrs['aria-label'];
          if (label && /^Page \d+$/.test(label)) res.pageLabels.push(+label.slice(5));
          if (card && tk.tag === 'p' && !tk.self) {
            const line = { text: '', anchors: [], depth: stack.length };
            lineStack.push(line);
          }
          if (card && tk.tag === 'a' && !tk.self) {
            const a = { href: tk.attrs.href || '', text: '', depth: stack.length };
            anchorStack.push(a);
            card.anchors.push(a);
            lineStack.forEach((l) => l.anchors.push(a));
          }
        } else if (tk.t === 'text') {
          const s = squash(tk.text);
          if (s) texts.push(s);
          if (card) {
            anchorStack.forEach((a) => { a.text += ' ' + tk.text; });
            lineStack.forEach((l) => { l.text += ' ' + tk.text; });
          }
        } else {
          const i = stack.lastIndexOf(tk.tag);
          if (i < 0) continue;
          stack.length = i;
          if (card) {
            while (lineStack.length && lineStack[lineStack.length - 1].depth > stack.length) {
              const l = lineStack.pop();
              l.text = squash(l.text);
              l.anchors.forEach((a) => { a.text = squash(a.text); });
              if (l.text) lines.push(l);
            }
            while (anchorStack.length && anchorStack[anchorStack.length - 1].depth > stack.length) anchorStack.pop();
            if (stack.length < card.depth) closeCard();
          }
        }
      }
      if (card) closeCard();
      res.mainText = texts.join(' ');
      return res;
    };

    // ---- the run --------------------------------------------------------------------------------------------
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const seen = new Set();
    const base = '/search/results/people/?keywords=' + encodeURIComponent(keywords)
      + '&network=' + encodeURIComponent(JSON.stringify(network))
      + (geo ? '&geoUrn=' + encodeURIComponent(JSON.stringify([geo])) : '')
      + (extra ? '&' + extra : '');
    for (let i = 0; i < pages; i++) {
      const pageNo = pageFrom + i;
      if (i > 0) await sleep(minDelay + Math.random() * (maxDelay - minDelay));
      let res;
      out.pages_attempted++;
      try {
        res = await fetch(base + (pageNo > 1 ? '&page=' + pageNo : ''), {
          method: 'GET', credentials: 'include', headers: { accept: 'text/html,application/xhtml+xml' } });
      } catch (e) { return finish('network_error'); }
      const where = String(res.url || '');
      if (res.redirected && /checkpoint|challenge/i.test(where)) return finish('checkpoint');
      if (res.redirected && /\/login|\/uas\/|authwall/i.test(where)) return finish('login_redirect');
      if (res.redirected && where && !/\/search\/results\/people/i.test(where)) return finish('unexpected_redirect');
      if (STOP_STATUS.includes(res.status)) return finish('http_' + res.status);
      if (res.status !== 200) return finish('http_' + res.status);
      let html;
      try { html = await res.text(); } catch (e) { return finish('network_error'); }
      const page = readPage(String(html), pageNo);
      if (!page.main) return finish('suspect_layout', 'no <main> results container');
      for (const r of page.rows) {
        const k = r.vanity.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.rows.push(r); }
      }
      if (page.rows.length) out.pages_read++;
      persist(true);
      if (/commercial use limit|reached the monthly limit/i.test(page.mainText)) return finish('commercial_use_limit');
      if (!page.cards) {
        if (/no results found/i.test(page.mainText)) return finish(pageNo === 1 ? 'no_results' : 'end_of_results');
        return finish('suspect_layout', 'results container without result cards');
      }
      if (!page.rows.length) return finish('suspect_layout', 'result cards without a /in/ profile link');
      if (pageNo >= LAST_PAGE) return finish('end_of_results');
    }
    return finish(null);
  } finally {
    g.__liFindPeopleRunning = false;
  }
}
