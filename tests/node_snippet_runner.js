// Test harness: run one page snippet in Node against a fake document/fetch.
// usage: node node_snippet_runner.js <snippet.js> '<params json>' '<cookie string>' '<responses json>'
// responses: [{status, body, headers?}] consumed in order by fetch (headers: {lowercase name: value}; body null = no JSON body).
// Prints {result, calls:[{url, headers, credentials, method, body}]}.
const fs = require('fs');
const [, , snippetPath, paramsJson, cookie, responsesJson] = process.argv;
const responses = JSON.parse(responsesJson || '[]');
const calls = [];
global.document = { cookie: cookie || '' };
global.location = { pathname: '/sales/home' };
global.fetch = async (url, opts) => {
  calls.push({ url, headers: opts && opts.headers, credentials: opts && opts.credentials,
    method: opts && opts.method, body: opts && opts.body });
  const next = responses.shift() || { status: 200, body: {} };
  const out = next.headers || {};
  return {
    status: next.status,
    headers: { get: (k) => (out[String(k).toLowerCase()] === undefined ? null : out[String(k).toLowerCase()]) },
    json: async () => { if (next.body === null) throw new Error('no body'); return next.body; },
    text: async () => (next.body === null ? '' : JSON.stringify(next.body)),
  };
};
const source = fs.readFileSync(snippetPath, 'utf8');
const fn = eval('(\n' + source.trim().replace(/;+$/, '') + '\n)');
fn(JSON.parse(paramsJson || '{}')).then((result) => {
  console.log(JSON.stringify({ result, calls }));
});
