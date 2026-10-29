import test from "node:test";
import assert from "node:assert/strict";
import { buildUrl, createJsonApi } from "../src/jsonapi.js";
import { createHttp } from "../src/http.js";
import { doc, fakeClock, jsonRes, mockFetch, tmpDir } from "./helpers.js";

const q = (url) => new URL(url).searchParams;

test("filter URL: CONTAINS, =, >=, IS NOT NULL, sparse fields, page limit", () => {
  const u = buildUrl({
    resource: "node/contractprofile",
    fields: ["title", "field_cp_end_date"],
    filters: [
      { path: "field_cp_contract_description", op: "CONTAINS", value: "construction equipment" },
      { path: "field_cp_end_date", op: ">=", value: "2026-10-28" },
      { path: "field_cp_brand_name", op: "IS NOT NULL" },
      { path: "title", op: "=", value: "John Deere 011723-JDC" },
    ],
    sort: "-field_cp_end_date",
  });
  assert.ok(u.startsWith("https://www.sourcewell-mn.gov/jsonapi/node/contractprofile?"));
  const p = q(u);
  assert.equal(p.get("fields[node--contractprofile]"), "title,field_cp_end_date");
  assert.equal(p.get("filter[f0][condition][path]"), "field_cp_contract_description");
  assert.equal(p.get("filter[f0][condition][operator]"), "CONTAINS");
  assert.equal(p.get("filter[f0][condition][value]"), "construction equipment");
  assert.equal(p.get("filter[f1][condition][operator]"), ">=");
  assert.equal(p.get("filter[f2][condition][operator]"), "IS NOT NULL");
  assert.equal(p.get("filter[f2][condition][value]"), null);
  assert.equal(p.get("filter[f3][condition][value]"), "John Deere 011723-JDC");
  assert.equal(p.get("sort"), "-field_cp_end_date");
  assert.equal(p.get("page[limit]"), "50");
});

test("filter URL: OR group uses memberOf", () => {
  const p = q(buildUrl({ resource: "node/contractprofile", filters: [{ or: [{ path: "title", op: "CONTAINS", value: "a" }, { path: "field_cp_brand_name", op: "CONTAINS", value: "a" }] }] }));
  assert.equal(p.get("filter[g0][group][conjunction]"), "OR");
  assert.equal(p.get("filter[f1][condition][memberOf]"), "g0");
  assert.equal(p.get("filter[f2][condition][memberOf]"), "g0");
});

test("values with special characters are encoded", () => {
  const u = buildUrl({ resource: "node/account", filters: [{ path: "title", op: "CONTAINS", value: "A&B [x]=1" }] });
  assert.equal(q(u).get("filter[f0][condition][value]"), "A&B [x]=1");
  assert.ok(!u.includes("A&B"));
});

test("page limit is clamped to 50", () => {
  assert.equal(q(buildUrl({ resource: "node/account", limit: 500 })).get("page[limit]"), "50");
});

function setup(handler) {
  const clock = fakeClock();
  const f = mockFetch(handler);
  const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: tmpDir(), noCache: true });
  return { f, api: createJsonApi(http), clock };
}

test("fetchAll follows links.next.href until exhausted", async () => {
  const base = "https://www.sourcewell-mn.gov/jsonapi/node/account?fields%5Bnode--account%5D=title";
  const { f, api } = setup((url) => {
    if (!url.includes("offset")) return jsonRes(doc("node--account", [{ title: "A" }, { title: "B" }], `${base}&page%5Boffset%5D=2`));
    if (url.includes("offset%5D=2")) return jsonRes(doc("node--account", [{ title: "C" }], `${base}&page%5Boffset%5D=3`));
    return jsonRes(doc("node--account", [{ title: "D" }]));
  });
  const rows = await api.fetchAll({ resource: "node/account", fields: ["title"] });
  assert.deepEqual(rows.map((r) => r.title), ["A", "B", "C", "D"]);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((c) => c.init.method === "GET"));
});

test("fetchAll stops at limit", async () => {
  const base = "https://www.sourcewell-mn.gov/jsonapi/node/account?fields%5Bnode--account%5D=title";
  const { f, api } = setup(() => jsonRes(doc("node--account", [{ title: "A" }, { title: "B" }], `${base}&page%5Boffset%5D=2`)));
  const rows = await api.fetchAll({ resource: "node/account", fields: ["title"] }, { limit: 3 });
  assert.equal(rows.length, 3);
  assert.equal(f.calls.length, 2);
});

test("only GET is ever used", async () => {
  const { f, api } = setup(() => jsonRes(doc("node--account", [])));
  await api.fetchAll({ resource: "node/account" });
  assert.deepEqual(f.calls.map((c) => c.init.method), ["GET"]);
});

test("redirects are not followed blindly: off-origin and other-resource Locations are refused, same-resource ones are re-validated", async () => {
  const mk = (location) => {
    const clock = fakeClock();
    const f = mockFetch((url) => (url.includes("contractprofile") && !url.includes("moved")
      ? jsonRes("", { status: 302, headers: { location } })
      : jsonRes(doc("node--contractprofile", [{ title: "A" }]))));
    const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: tmpDir(), noCache: true });
    return { f, api: createJsonApi(http) };
  };
  const query = { resource: "node/contractprofile", fields: ["title"] };
  const off = mk("https://evil.example/jsonapi/node/contractprofile?fields[node--contractprofile]=title");
  await assert.rejects(() => off.api.fetchAll(query), /allowed origin/);
  assert.equal(off.f.calls.length, 1, "the off-origin Location was not requested");
  assert.equal(off.f.calls[0].init.redirect, "manual");
  const other = mk("https://www.sourcewell-mn.gov/jsonapi/user/user");
  await assert.rejects(() => other.api.fetchAll(query), /different resource|not on the allowlist/);
  const same = mk("https://www.sourcewell-mn.gov/jsonapi/node/contractprofile?fields[node--contractprofile]=title&moved=1");
  const rows = await same.api.fetchAll(query);
  assert.equal(rows.length, 1);
  assert.equal(same.f.calls.length, 2);
});

test("getJson without a redirect validator fails on a redirect", async () => {
  const clock = fakeClock();
  const f = mockFetch(() => jsonRes("", { status: 301, headers: { location: "https://www.sourcewell-mn.gov/jsonapi/node/contractprofile" } }));
  const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: tmpDir(), noCache: true });
  await assert.rejects(() => http.getJson("https://www.sourcewell-mn.gov/jsonapi/taxonomy_term/states"), /redirect/);
  assert.equal(f.calls.length, 1);
});
