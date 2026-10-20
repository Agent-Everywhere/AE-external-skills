// profile.js: one lead's profile detail (positions, summary, degree), optionally education, skills and badges.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit profile.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// @params lead extras delayMs
// @required lead
// params: {
//   lead:    a Sales Nav lead URL, an entityUrn "urn:li:fs_salesProfile:(id,authType,authToken)", or
//            "id,authType,authToken" (the entityUrn parts a lead search row carries)
//   extras?: true also fetches educations, skills, languages, connections, badges (one more call, paced)
//   delayMs?: 3500 pause before the extras call
// }
// One run opens 1 profile (log --profiles 1) and makes `requests` requests, 1 or 2 (log them as small
// calls). contactInfo (email, phone) is part of
// the page's own decoration but is never copied into the result.
// returns: { status, requests, fullName, headline, location, degree, summary, pendingInvitation, flagshipProfileUrl,
//   positions: [{ title, companyName, companyId, description, startedOn, endedOn, current, location }],
//   and with extras: educations, skills [{ name, endorsements }], languages, numOfConnections,
//   memberBadges { openLink, premium }, inmailRestriction }
async (params) => {
  const p = params || {};
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const idMatch = (() => { try { return decodeURIComponent(String(p.lead || '')); } catch (e) { return String(p.lead || ''); } })()
    .match(/([\w-]{8,}),([A-Z_]+),([\w-]+)/);
  if (!idMatch) return { status: 0, error: 'lead_required' };
  const key = '(profileId:' + idMatch[1] + ',authType:' + idMatch[2] + ',authToken:' + idMatch[3] + ')';
  const MAIN = '%28entityUrn%2CobjectUrn%2CfirstName%2ClastName%2CfullName%2Cheadline%2Cpronoun%2Cdegree%2CprofileUnlockInfo%2Clocation%2ClistCount%2Csummary%2CsavedLead%2CdefaultPosition%2CcontactInfo%2CcrmStatus%2CpendingInvitation%2Cunlocked%2CflagshipProfileUrl%2CfullNamePronunciationAudio%2Cmemorialized%2Cpositions*%28companyName%2Ccurrent%2Cnew%2Cdescription%2CendedOn%2CposId%2CstartedOn%2Ctitle%2Clocation%2CrichMedia*%2CcompanyUrn~fs_salesCompany%28entityUrn%2Cname%2CcompanyPictureDisplayImage%29%29%2CcrmManualMatched%29';
  const EXTRAS = '%28entityUrn%2CprofilePictureDisplayImage%2CprofileBackgroundPicture%2CrelatedColleagueCompanyId%2CblockThirdPartyDataSharing%2CnoteCount%2Ceducations*%28degree%2CeduId%2CendedOn%2CschoolName%2CstartedOn%2CfieldsOfStudy*%2CrichMedia*%2Cschool~fs_salesSchool%28entityUrn%2ClogoId%2Cname%2Curl%2CschoolPictureDisplayImage%29%29%2CvolunteeringExperiences*%28cause%2CcompanyName%2Cdescription%2CendedOn%2Crole%2CstartedOn%2Ccompany~fs_salesCompany%28entityUrn%2CpictureInfo%2Cname%2CcompanyPictureDisplayImage%29%29%2Cskills*%2Clanguages*%2ClatestTouchPointActivity%2CmemberBadges%2CnumOfConnections%2CnumOfSharedConnections%2CshowTotalConnectionsPage%2CinmailRestriction%2ClastMessagingActivity%29';
  const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);
  const date = (d) => (d && d.year ? { year: d.year, month: d.month } : undefined);
  const t0 = performance.now();
  let n = 0;
  const get = async (decoration) => {
    n++;
    const r = await fetch('/sales-api/salesApiProfiles/' + key + '?decoration=' + decoration, {
      credentials: 'include',
      headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json' },
    });
    if (r.status !== 200) return { fail: { status: r.status, requests: n, ms: Math.round(performance.now() - t0), body: (await r.text()).slice(0, 200) } };
    return { json: await r.json() };
  };
  try {
    const main = await get(MAIN);
    if (main.fail) return main.fail;
    const j = main.json;
    const out = {
      status: 200,
      requests: n,
      fullName: j.fullName || '',
      headline: j.headline || '',
      location: j.location || '',
      degree: j.degree,
      summary: cut(j.summary || '', 1500),
      pendingInvitation: !!j.pendingInvitation,
      flagshipProfileUrl: j.flagshipProfileUrl || '',
      positions: (j.positions || []).map((x) => ({
        title: x.title || '',
        companyName: x.companyName || '',
        companyId: String(x.companyUrn || '').replace(/^.*:/, ''),
        description: cut(x.description || '', 400),
        startedOn: date(x.startedOn),
        endedOn: date(x.endedOn),
        current: !!x.current,
        location: x.location || '',
      })),
    };
    if (p.extras) {
      const delay = Number.isFinite(p.delayMs) ? p.delayMs : 3500;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const ex = await get(EXTRAS);
      if (ex.fail) return Object.assign(out, ex.fail, { partial: true });
      const e = ex.json;
      const badges = e.memberBadges || {};
      out.educations = (e.educations || []).map((x) => ({
        schoolName: x.schoolName || '', degree: x.degree || '', fieldsOfStudy: x.fieldsOfStudy || [],
        startedOn: date(x.startedOn), endedOn: date(x.endedOn),
      }));
      out.skills = (e.skills || []).map((x) => ({ name: x.name, endorsements: x.numOfEndorsement || 0 }));
      out.languages = (e.languages || []).map((x) => ({ name: x.name, proficiency: x.proficiency }));
      out.numOfConnections = e.numOfConnections;
      out.memberBadges = { openLink: !!badges.openLink, premium: !!badges.premium };
      out.inmailRestriction = e.inmailRestriction;
    }
    out.requests = n;
    out.ms = Math.round(performance.now() - t0);
    return out;
  } catch (e) {
    return { status: 0, requests: n, error: String(e).slice(0, 200) };
  }
}
