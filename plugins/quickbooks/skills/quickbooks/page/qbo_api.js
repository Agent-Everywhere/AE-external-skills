// qbo_api.js: call QuickBooks Online's own v3 API from inside a signed-in qbo.intuit.com tab.
// Same-origin fetch with the page's session cookies and CSRF cookie; the authorization header is the
// app's public browser API key (from window.qbo.pluginsInfo) plus realm and user ids, exactly as the
// QBO web app sends it. Returns compact JSON; never returns cookies, keys or tokens.
// params: {
//   method?: 'GET' | 'POST'        default GET
//   path:    '/query' | '/reports/ProfitAndLoss' | '/customer' | '/invoice?operation=void' ...
//            (relative to /api/v3/company/<realm>)
//   query?:  { key: value }        extra query-string params (minorversion is added)
//   body?:   object                JSON body for POST
// }
// returns: { status, realm, data } or { status: 0, error }
async (params) => {
  const p = params || {};
  const ck = (n) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n.replace(/\./g, '\\.') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  if (!/qbo\.intuit\.com$/.test(location.hostname)) return { status: 0, error: 'not_on_qbo' };
  const realm = ck('qbo.currentcompanyid');
  const uid = ck('userIdentifier');
  const csrf = ck('qbo.csrftoken');
  if (!realm || !csrf) return { status: 0, error: 'not_signed_in' };
  const plugins = (window.qbo && window.qbo.pluginsInfo && window.qbo.pluginsInfo.plugins) || {};
  const pl = plugins['qbo-web-app-ui'] || plugins['sales-list-ui'] || plugins['accounting-ledger-ui'];
  if (!pl || !pl.browserAuthKey) return { status: 0, error: 'app_not_ready' };
  const auth = 'Intuit_APIKey intuit_apikey=' + pl.browserAuthKey + ',intuit_appid=' + pl.assetAlias +
    ',intuit_apikey_version=1.0,intuit_realmid=' + realm + ',intuit_userid=' + uid;
  const qs = new URLSearchParams(Object.assign({ minorversion: '75' }, p.query || {}));
  const path = String(p.path || '/query');
  const url = '/api/v3/company/' + realm + path + (path.includes('?') ? '&' : '?') + qs.toString();
  const headers = { accept: 'application/json', authorization: auth, 'x-csrf-token': csrf, 'intuit-company-id': realm };
  const init = { method: p.method || 'GET', credentials: 'include', headers };
  if (p.body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(p.body); }
  let res;
  try { res = await fetch(url, init); } catch (e) { return { status: 0, error: 'fetch_failed: ' + String(e).slice(0, 120) }; }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 500) }; }
  return { status: res.status, realm, data };
}
