// account.js: one company's profile detail, optionally headcount history and recent news alerts.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit account.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params companyId headcount news count delayMs
// @required companyId
// params: {
//   companyId:  the Sales Nav company id (digits) or "urn:li:fs_salesCompany:<id>"
//   headcount?: true adds employee count and range, decision-maker count, median tenure, monthly headcount (2 more requests)
//   news?:      true adds recent alerts (1 more request)
//   count?:     10 alerts, at most 20
//   delayMs?:   3500 pause between the requests of one run
// }
// One run opens 1 account page (log --accounts 1) and makes `requests` requests, 1 to 4 (log them as small
// calls); a failure stops the run and returns what was gathered with partial:true.
// returns: { status, requests, name, description, website, industry, type, yearFounded, specialties, headquarters,
//   revenueRange, employeeGrowthPercentages; headcount: { employeeCount, employeeCountRange,
//   decisionMakersDisplayCount, medianTenure, employeePercentageDifference, monthly }; news: [{ type, headline, createdAt }] }
async (params) => {
  const p = params || {};
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  // Digits only: the whole value, or the digits after the last ':' or '/' (a trailing ?query is ignored).
  const idMatch = String(p.companyId == null ? '' : p.companyId).trim().split(/[?#]/)[0].match(/(?:^|[:/])(\d+)\/?$/);
  const id = idMatch ? idMatch[1] : '';
  if (!id) return { status: 0, error: 'company_id_required' };
  const MAIN = '%28entityUrn%2Cname%2Caccount%28saved%2CnoteCount%2ClistCount%2CcrmStatus%2Cstarred%29%2CpictureInfo%2CcompanyPictureDisplayImage%2CcompanyBackgroundCoverImage%2Cdescription%2Cindustry%2Clocation%2Cheadquarters%2Cwebsite%2CrevenueRange%2CcrmOpportunities%2CflagshipCompanyUrl%2CemployeeGrowthPercentages%2Cemployees*~fs_salesProfile%28entityUrn%2CfirstName%2ClastName%2CfullName%2CpictureInfo%2CprofilePictureDisplayImage%29%2Cspecialties%2Ctype%2CyearFounded%29';
  const COUNTS = '%28entityUrn%2CemployeeCount%2CemployeeDisplayCount%2CemployeeCountRange%2CdecisionMakersDisplayCount%2CpersonaResultCounts%2CteamLinkConnectionsDisplayCount%2CsharedAlumniDisplayCount%2CsharedAlumniSchoolIds%29';
  const count = Math.min(20, Math.max(1, Number.isInteger(p.count) ? p.count : 10));
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 3500;
  const text = (v) => String((v && typeof v === 'object' ? v.text : v) || '');
  const t0 = performance.now();
  let n = 0;
  const get = async (path) => {
    if (n++ > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const r = await fetch(path, {
      credentials: 'include',
      headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
    });
    if (r.status !== 200) return { fail: { status: r.status, requests: n, ms: Math.round(performance.now() - t0), body: (await r.text()).slice(0, 200) } };
    return { json: await r.json() };
  };
  try {
    const main = await get('/sales-api/salesApiCompanies/' + id + '?decoration=' + MAIN);
    if (main.fail) return main.fail;
    const j = main.json;
    const hq = j.headquarters || {};
    const out = {
      status: 200,
      requests: n,
      name: j.name || '',
      description: (j.description || '').slice(0, 1500),
      website: j.website || '',
      industry: j.industry || '',
      type: j.type || '',
      yearFounded: j.yearFounded,
      specialties: j.specialties || [],
      headquarters: { city: hq.city, geographicArea: hq.geographicArea, country: hq.country },
      revenueRange: j.revenueRange,
      employeeGrowthPercentages: j.employeeGrowthPercentages || [],
    };
    if (p.headcount) {
      const c = await get('/sales-api/salesApiCompanies/' + id + '?decoration=' + COUNTS);
      if (c.fail) return Object.assign(out, c.fail, { partial: true });
      const h = await get('/sales-api/salesApiEmployeeInsights/' + id + '?employeeInsightType=TOTAL_HEADCOUNT');
      if (h.fail) return Object.assign(out, h.fail, { partial: true });
      const monthly = (h.json.monthlyHeadCounts || [])[0] || {};
      out.headcount = {
        employeeCount: c.json.employeeCount,
        employeeCountRange: c.json.employeeCountRange,
        decisionMakersDisplayCount: c.json.decisionMakersDisplayCount,
        medianTenure: h.json.medianTenure,
        employeePercentageDifference: monthly.employeePercentageDifference,
        monthly: monthly.headCountsByDate || [],
      };
    }
    if (p.news) {
      const a = await get('/sales-api/salesApiEntityAlerts?q=criteria&entityUrn=urn%3Ali%3Afs_salesCompany%3A' + id +
        '&sortBy=TIME&buyerAlertsIndex=0&start=0&count=' + count);
      if (a.fail) return Object.assign(out, a.fail, { partial: true });
      out.news = (a.json.elements || []).slice(0, count).map((e) => ({
        type: e.type, headline: text(e.headline).slice(0, 300), createdAt: e.createdAt,
      }));
    }
    out.requests = n;
    out.ms = Math.round(performance.now() - t0);
    return out;
  } catch (e) {
    return { status: 0, requests: n, error: String(e).slice(0, 200) };
  }
}
