// Test harness: run one page snippet in Node against a fake document/fetch.
// usage: node node_snippet_runner.js <snippet.js> '<params json>' '<cookie string>' '<responses json>'
// responses: [{status, body}] consumed in order by fetch. Prints {result, calls:[{url, headers}]}.
const fs = require('fs');
const [, , snippetPath, paramsJson, cookie, responsesJson] = process.argv;
const responses = JSON.parse(responsesJson || '[]');
const calls = [];
global.document = { cookie: cookie || '' };
global.location = { pathname: '/sales/home' };
global.fetch = async (url, opts) => {
  calls.push({ url, headers: opts && opts.headers, credentials: opts && opts.credentials });
  const next = responses.shift() || { status: 200, body: {} };
  return { status: next.status, json: async () => next.body, text: async () => JSON.stringify(next.body) };
};
const source = fs.readFileSync(snippetPath, 'utf8');
const fn = eval('(\n' + source.trim().replace(/;+$/, '') + '\n)');
fn(JSON.parse(paramsJson || '{}')).then((result) => {
  console.log(JSON.stringify({ result, calls }));
});
