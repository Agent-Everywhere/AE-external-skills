// search_jobs.js: FALLBACK for linkedin-job-signals, used only when LinkedIn's public job pages are blocking the
// user's connection. Reads LinkedIn's own job search from the user's OWN signed-in linkedin.com tab, read-only, one
// request at a time. Run it as: (<this file>)({keywords, location?, days?, page_from?, pages?, search?, issue?})
// Params:
//   keywords   required, up to 200 characters.
//   location   optional place name, up to 120 characters (LinkedIn's seoLocation filter).
//   days       posted within the last N days, 1 to 90 (default 30). Sent as timePostedRange r<N*86400>.
//   page_from  first result page, 1 to 40 (default 1); each page is 25 jobs. pages: how many, 1 to 5 (default 3).
//   search     optional ledger search id (s1, s2...), echoed back. issue: the run id printed by `job_signals.py
//              next-pages`, echoed back in `request` so `merge` settles the right reservation. Pass the params unchanged.
//   Pacing is fixed at 8 to 15 seconds between requests (params.__test === true overrides it, for tests only).
// Returns {rows:[{job_id,title,company,company_id,location,listed_at,listed_text,page}], pages_read, pages_attempted,
//          total, stopped_reason, request}.
// Endpoint (see references/endpoints.md): GET /voyager/api/voyagerJobsDashJobCards?decorationId=...JobSearchCardsCollection-220
//   &count=25&q=jobSearch&query=(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:K,locationUnion:(seoLocation:(location:L)),
//   selectedFilters:(sortBy:List(DD),timePostedRange:List(rN)),spellCorrectionEnabled:true)&start=N
// Never returns cookies or tokens. After every page the rows so far are saved to localStorage "liJobSignalsLastRun".
async function (params) {
  const MAX_PAGES = 5;
  const PAGE = 25;
  const LAST_PAGE = 40;
  const STOP_STATUS = [401, 403, 429, 999, 410];
  const g = globalThis;
  const p = params || {};
  const testing = p.__test === true;
  const minDelay = testing && Number.isFinite(+p.minDelayMs) ? Math.max(0, +p.minDelayMs) : 8000;
  const maxDelay = testing && Number.isFinite(+p.maxDelayMs) ? Math.max(minDelay, +p.maxDelayMs) : 15000;
  const out = { rows: [], pages_read: 0, pages_attempted: 0, total: null, stopped_reason: null, request: {} };
  const persist = (partial) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('liJobSignalsLastRun', JSON.stringify(Object.assign({}, out, { partial: !!partial, saved_at: new Date().toISOString() })));
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
  if (g.__liJobSignalsRunning) {   // another run is live in this tab: touch nothing
    out.stopped_reason = 'already_running';
    return out;
  }
  g.__liJobSignalsRunning = true;
  try {
    const keywords = typeof p.keywords === 'string' ? p.keywords.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (!keywords) return finish('bad_params', 'keywords is required');
    const place = typeof p.location === 'string' ? p.location.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const days = p.days === undefined ? 30 : Math.floor(+p.days);
    if (!(days >= 1 && days <= 90)) return finish('bad_params', 'days must be 1 to 90');
    const pageFrom = p.page_from === undefined ? 1 : Math.floor(+p.page_from);
    if (!(pageFrom >= 1 && pageFrom <= LAST_PAGE)) return finish('bad_params', 'page_from must be 1 to ' + LAST_PAGE);
    const pagesAsked = p.pages === undefined ? 3 : Math.floor(+p.pages);
    if (!(pagesAsked >= 1)) return finish('bad_params', 'pages must be 1 to ' + MAX_PAGES);
    const pages = Math.min(pagesAsked, MAX_PAGES, LAST_PAGE - pageFrom + 1);
    const search = typeof p.search === 'string' && /^s\d{1,3}$/.test(p.search) ? p.search : undefined;
    const issue = typeof p.issue === 'string' && /^[0-9A-Za-z-]{1,40}$/.test(p.issue) ? p.issue : undefined;
    out.request = { keywords, days, page_from: pageFrom, pages };
    if (place) out.request.location = place;
    if (search) out.request.search = search;
    if (issue) out.request.issue = issue;

    const host = (typeof g.location !== 'undefined' && g.location && g.location.hostname) || '';
    if (host && !/(^|\.)linkedin\.com$/i.test(host)) return finish('wrong_page');
    const m = /(?:^|;\s*)JSESSIONID=([^;]*)/.exec((typeof document !== 'undefined' && document.cookie) || '');
    const csrf = m ? m[1].replace(/^"+|"+$/g, '') : '';
    if (!csrf) return finish('no_session');

    // Rest.li values: encodeURIComponent leaves ( and ) alone, which the server rejects inside a value.
    const enc = (s) => encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29');
    const query = '(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:' + enc(keywords)
      + (place ? ',locationUnion:(seoLocation:(location:' + enc(place) + '))' : '')
      + ',selectedFilters:(sortBy:List(DD),timePostedRange:List(r' + (days * 86400) + ')),spellCorrectionEnabled:true)';
    const base = '/voyager/api/voyagerJobsDashJobCards?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220'
      + '&count=' + PAGE + '&q=jobSearch&query=' + query;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (o) => (o && typeof o === 'object' ? (typeof o.text === 'string' ? o.text : '') : (typeof o === 'string' ? o : ''));
    const clip = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
    const dateOf = (ms) => (Number.isFinite(ms) && ms > 1e11 ? new Date(ms).toISOString().slice(0, 10) : '');
    // Cards of this page: JobPostingCard-like objects in included[] (they carry jobPostingTitle). The response may also
    // hold prefetched cards of the next page, so keep only those the page's own elements point at, when it names them.
    const readCards = (body, pageNo) => {
      const inc = body && Array.isArray(body.included) ? body.included : [];
      const data = body && body.data ? body.data : body || {};
      const named = new Set((JSON.stringify(data.elements || []).match(/jobPosting(?:Card)?[:(]\(?\d{5,15}/gi) || []).map((x) => /(\d{5,15})$/.exec(x)[1]));
      const rows = [];
      for (const c of inc) {
        if (!c || typeof c.jobPostingTitle !== 'string') continue;
        const idm = /jobPosting[:(]\(?(\d{5,15})/i.exec(String(c.jobPostingUrn || c['*jobPosting'] || c.preDashNormalizedJobPostingUrn || c.entityUrn || ''));
        if (!idm) continue;
        if (named.size && !named.has(idm[1])) continue;
        const cm = /fsd_company:(\d{1,15})/.exec(JSON.stringify(c.logo || c) || '');
        const foot = (Array.isArray(c.footerItems) ? c.footerItems : []).find((f) => f && /LISTED_DATE/i.test(String(f.type || '')));
        rows.push({ job_id: idm[1], title: clip(c.jobPostingTitle, 200), company: clip(text(c.primaryDescription), 150),
          company_id: cm ? cm[1] : '', location: clip(text(c.secondaryDescription), 150),
          listed_at: foot ? dateOf(+foot.timeAt) : '', listed_text: foot ? clip(text(foot.text), 60) : '', page: pageNo });
      }
      return { rows, total: data.paging && Number.isFinite(+data.paging.total) ? +data.paging.total : null,
        cards: inc.filter((c) => c && typeof c.jobPostingTitle === 'string').length };
    };

    const seen = new Set();
    for (let i = 0; i < pages; i++) {
      const pageNo = pageFrom + i;
      if (i > 0) await sleep(minDelay + Math.random() * (maxDelay - minDelay));
      out.pages_attempted++;
      let res;
      try {
        res = await fetch(base + '&start=' + ((pageNo - 1) * PAGE), { method: 'GET', credentials: 'include', headers: {
          'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'accept': 'application/vnd.linkedin.normalized+json+2.1' } });
      } catch (e) { return finish('network_error'); }
      const where = String(res.url || '');
      if (res.redirected && /checkpoint|challenge/i.test(where)) return finish('checkpoint');
      if (res.redirected && /\/login|\/uas\/|authwall/i.test(where)) return finish('login_redirect');
      if (STOP_STATUS.includes(res.status)) return finish('http_' + res.status);
      if (res.status === 400) return finish('decoration_rotated', 'the jobs decoration id changed: copy the current one from the Jobs page request');
      if (res.status !== 200) return finish('http_' + res.status);
      let body;
      try { body = await res.json(); } catch (e) { return finish('non_json_response'); }
      const page = readCards(body, pageNo);
      for (const r of page.rows) if (!seen.has(r.job_id)) { seen.add(r.job_id); out.rows.push(r); }
      if (page.total !== null) out.total = page.total;
      if (page.rows.length) out.pages_read++;
      persist(true);
      if (!page.cards) return finish(pageNo === 1 && !out.rows.length ? 'no_results' : 'end_of_results');
      if (!page.rows.length) return finish('suspect_layout', 'cards without a job id');
      if (out.total !== null && pageNo * PAGE >= out.total) return finish('end_of_results');
    }
    return finish(null);
  } finally {
    g.__liJobSignalsRunning = false;
  }
}
