import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SNIPPETS } from "../src/snippets.js";

const here = dirname(fileURLToPath(import.meta.url));

test("embedded snippets match ../page", () => {
  execFileSync(process.execPath, [join(here, "..", "scripts", "gen-snippets.mjs"), "--check"]);
});

test("snippets parse as async functions and never read secrets into the result", () => {
  for (const [name, src] of Object.entries(SNIPPETS)) {
    const fn = new Function(`return (${src.trim()})`)();
    assert.equal(typeof fn, "function", name);
  }
  assert.ok(!/return[^;]*browserAuthKey/.test(SNIPPETS["qbo_api.js"]));
});

test("qbo_api.js builds the request from cookies and app config", async () => {
  const fn = new Function(`return (${SNIPPETS["qbo_api.js"].trim()})`)();
  const seen = [];
  globalThis.location = { hostname: "qbo.intuit.com" };
  globalThis.document = { cookie: "qbo.currentcompanyid=123; userIdentifier=u1; qbo.csrftoken=c1" };
  globalThis.window = { qbo: { pluginsInfo: { plugins: { "qbo-web-app-ui": { browserAuthKey: "k", assetAlias: "Intuit.x" } } } } };
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return { status: 200, text: async () => '{"QueryResponse":{}}' }; };
  const r = await fn({ path: "/query", query: { query: "select * from Customer" } });
  assert.equal(r.status, 200);
  assert.equal(r.realm, "123");
  assert.match(seen[0].url, /^\/api\/v3\/company\/123\/query\?minorversion=75&query=select/);
  assert.equal(seen[0].init.headers["x-csrf-token"], "c1");
  assert.match(seen[0].init.headers.authorization, /^Intuit_APIKey intuit_apikey=k,intuit_appid=Intuit\.x,.*intuit_realmid=123,intuit_userid=u1$/);
  globalThis.document = { cookie: "" };
  assert.equal((await fn({})).error, "not_signed_in");
});
