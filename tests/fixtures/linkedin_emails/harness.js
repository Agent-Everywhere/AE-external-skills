// Test harness for the snippets: mocks fetch, timers, document, localStorage and a Blob download.
// usage: node harness.js <snippet.js> '<params json>' '<cookie>' '<responses json>' [randomValue]
// env: PRESET_RUNNING=1 sets window.__liEmailsRunning first; HOSTNAME=<host> overrides location.hostname.
// responses: [{status, body, headers?, redirected?, url?, throw?}]; body null = response has no JSON body.
// Prints {result, calls, delays, clicks, clipboard, storage_writes, running_after}.
const fs = require('fs');
const [, , snippetPath, paramsJson, cookie, responsesJson, rnd] = process.argv;
const responses = JSON.parse(responsesJson || '[]');
const calls = [], delays = [], clicks = [], clipboard = [], storage_writes = [];
global.document = { cookie: cookie || '', body: { appendChild() {} },
  createElement: () => ({ click() { clicks.push({ href: this.href, download: this.download }); }, remove() {} }) };
global.location = { hostname: process.env.HOSTNAME || 'www.linkedin.com', pathname: '/feed/' };
global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };
global.copy = (s) => clipboard.push(s);
global.localStorage = { setItem: (k, v) => storage_writes.push([k, v]), getItem: () => null };
if (process.env.PRESET_RUNNING) globalThis.__liEmailsRunning = true;
if (rnd !== undefined) Math.random = () => Number(rnd);
const realSetTimeout = setTimeout;
global.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); };
global.fetch = async (url, opts) => {
  calls.push({ url, headers: opts && opts.headers, credentials: opts && opts.credentials });
  const next = responses.shift() || { status: 200, body: {} };
  if (next.throw) throw new Error('network down');
  const h = next.headers || {};
  return {
    status: next.status, redirected: !!next.redirected, url: next.url,
    headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
    json: async () => { if (next.body === null) throw new Error('no body'); return next.body; },
    blob: async () => ({ size: 1234 }),
  };
};
const source = fs.readFileSync(snippetPath, 'utf8');
const fn = eval('(\n' + source.trim().replace(/;+$/, '') + '\n)');
fn(JSON.parse(paramsJson || '{}')).then((result) => {
  console.log(JSON.stringify({ result, calls, delays: delays.filter((d) => d !== 60000), clicks, clipboard,
    storage_writes, running_after: !!globalThis.__liEmailsRunning }));
});
