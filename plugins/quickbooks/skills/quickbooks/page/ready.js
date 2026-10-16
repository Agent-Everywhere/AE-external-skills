// ready.js: is this tab a signed-in QBO app page with the web app loaded?
// returns: { state: 'ready' | 'loading' | 'signed_out' | 'company_select' | 'gated' | 'other', url, title }
async () => {
  const u = location.href;
  const base = { url: u.split('?')[0], title: document.title };
  if (/accounts\.intuit\.com/.test(u) || /iux_redirect_reason/.test(u)) return Object.assign({ state: 'signed_out' }, base);
  if (/\/app\/(companyselection|selectcompany)/i.test(u)) return Object.assign({ state: 'company_select' }, base);
  if (/\/app\/(obillupgrade|limitexceeded)/.test(u)) return Object.assign({ state: 'gated' }, base);
  if (!/qbo\.intuit\.com$/.test(location.hostname)) return Object.assign({ state: 'other' }, base);
  const hasCookie = /(?:^|; )qbo\.currentcompanyid=/.test(document.cookie);
  const plugins = window.qbo && window.qbo.pluginsInfo && window.qbo.pluginsInfo.plugins;
  return Object.assign({ state: hasCookie && plugins ? 'ready' : 'loading' }, base);
}
