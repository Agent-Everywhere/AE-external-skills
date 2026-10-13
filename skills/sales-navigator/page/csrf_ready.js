// csrf_ready.js: is the signed-in Sales Navigator page ready for same-origin API calls?
// Run on a loaded linkedin.com/sales page. The API token (JSESSIONID cookie) appears a moment
// after load; calling the API before that returns 403 in about 100 ms.
// params: { timeoutMs?: 10000 }
// returns: { ready: boolean, path: string }   (the token itself is never returned)
async (params) => {
  const p = params || {};
  const deadline = Date.now() + (Number.isFinite(p.timeoutMs) ? p.timeoutMs : 10000);
  const cookie = () => { try { return document.cookie; } catch (e) { return ''; } };
  const hasCsrf = () => /(?:^|;\s*)JSESSIONID="?[^";]+/.test(cookie());
  while (!hasCsrf() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ready: hasCsrf(), path: location.pathname };
}
