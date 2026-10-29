import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED, AllowlistError, assertFields, assertNextLink, assertResource } from "../src/allowlist.js";
import { buildUrl, createJsonApi } from "../src/jsonapi.js";
import { createHttp } from "../src/http.js";
import { fakeClock, mockFetch, tmpDir } from "./helpers.js";

test("allowlist has exactly the intended resources", () => {
  assert.deepEqual(Object.keys(ALLOWED).sort(), [
    "node/account", "node/competitive_solicitations", "node/contract", "node/contractprofile",
    "taxonomy_term/category", "taxonomy_term/states",
  ]);
});

test("account is limited to the nine permitted fields", () => {
  assert.deepEqual(ALLOWED["node/account"].fields.sort(), [
    "field_city", "field_member_number", "field_member_status", "field_record_type", "field_state_code",
    "field_sub_type", "field_type", "field_website", "title",
  ]);
});

test("resources off the allowlist are refused, including node/contact, user/*, key/*", () => {
  for (const r of ["node/contact", "user/user", "user/role", "contact_message/feedback", "oauth2_token/access_token", "key/key", "salesforce_mapped_object/x", "node/page", "node/contractprofile/abc", "", undefined, "__proto__", "constructor"]) {
    assert.throws(() => assertResource(r), AllowlistError, String(r));
    assert.throws(() => buildUrl({ resource: r }), AllowlistError, String(r));
  }
});

test("fields off the allowlist are refused (field_ein) and are never sent", () => {
  assert.throws(() => assertFields("node/account", ["title", "field_ein"]), AllowlistError);
  assert.throws(() => buildUrl({ resource: "node/account", fields: ["field_ein"] }), AllowlistError);
  assert.throws(() => buildUrl({ resource: "node/contractprofile", fields: ["field_ein"] }), AllowlistError);
});

test("filter and sort paths are checked too", () => {
  assert.throws(() => buildUrl({ resource: "node/account", filters: [{ path: "field_ein", op: "CONTAINS", value: "1" }] }), AllowlistError);
  assert.throws(() => buildUrl({ resource: "node/account", filters: [{ or: [{ path: "title", op: "CONTAINS", value: "a" }, { path: "field_ein", op: "=", value: "1" }] }] }), AllowlistError);
  assert.throws(() => buildUrl({ resource: "node/account", sort: "-field_ein" }), AllowlistError);
  assert.throws(() => buildUrl({ resource: "node/account", filters: [{ path: "title", op: "LIKE", value: "a" }] }), AllowlistError);
});

test("every resource always sends a sparse fieldset, account included", () => {
  for (const [res, spec] of Object.entries(ALLOWED)) {
    const u = new URL(buildUrl({ resource: res }));
    assert.equal(u.searchParams.get(`fields[${spec.type}]`), spec.fields.join(","), res);
  }
  const acct = new URL(buildUrl({ resource: "node/account" }));
  assert.ok(!acct.searchParams.get("fields[node--account]").includes("ein"));
});

test("next links must stay on the same resource, origin and sparse fieldset", () => {
  const ok = "https://www.sourcewell-mn.gov/jsonapi/node/account?fields%5Bnode--account%5D=title&page%5Boffset%5D=50&page%5Blimit%5D=50";
  assert.ok(assertNextLink(ok, "node/account"));
  assert.throws(() => assertNextLink("https://evil.example/jsonapi/node/account?fields[node--account]=title", "node/account"), AllowlistError);
  assert.throws(() => assertNextLink("https://www.sourcewell-mn.gov/jsonapi/node/contact?fields[node--contact]=title", "node/account"), AllowlistError);
  assert.throws(() => assertNextLink("https://www.sourcewell-mn.gov/jsonapi/node/account?page%5Boffset%5D=50", "node/account"), AllowlistError);
  assert.throws(() => assertNextLink("https://www.sourcewell-mn.gov/jsonapi/node/account?fields%5Bnode--account%5D=title,field_ein", "node/account"), AllowlistError);
});

test("a poisoned next link is refused before any request is made", async () => {
  const f = mockFetch(() => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [], links: { next: { href: "https://www.sourcewell-mn.gov/jsonapi/node/contact?fields%5Bnode--contact%5D=title" } } }) }));
  const clock = fakeClock();
  const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: tmpDir(), noCache: true });
  const api = createJsonApi(http);
  await assert.rejects(() => api.fetchAll({ resource: "node/account" }), AllowlistError);
  assert.equal(f.calls.length, 1);
});
