import test from "node:test";
import assert from "node:assert/strict";
import { LISTS, REPORTS, FORMS, GATED, classifyUrl, resolveOpen, searchPath } from "../src/routes.js";

test("verified routes are /app paths", () => {
  for (const r of Object.values(LISTS)) assert.match(r.path, /^\/app\//);
  for (const p of Object.values(FORMS)) assert.match(p, /^\/app\//);
  for (const r of Object.values(REPORTS)) if (r.path) assert.match(r.path, /^\/app\/report\/builder\?rptId=.+&token=/);
});

test("guessed routes that failed in the UI map are not used", () => {
  const all = JSON.stringify({ LISTS, REPORTS, FORMS });
  assert.ok(!all.includes("reportv2"));
  assert.ok(!all.includes("/app/creditmemo"));
  assert.ok(!all.includes("/app/salesreceipts"));
});

test("gated pages are flagged", () => {
  assert.equal(GATED["purchase-orders"].gate, "/app/obillupgrade");
  assert.equal(GATED["bill-payments"].gate, "/app/limitexceeded");
});

test("classifyUrl", () => {
  assert.equal(classifyUrl("https://accounts.intuit.com/app/sign-in?x"), "signed_out");
  assert.equal(classifyUrl("https://qbo.intuit.com/app/limitexceeded?referrer=x"), "gated");
  assert.equal(classifyUrl("https://qbo.intuit.com/app/homepage"), "app");
  assert.equal(classifyUrl("about:blank"), "other");
});

test("resolveOpen and searchPath", () => {
  assert.equal(resolveOpen("invoice"), "/app/invoice");
  assert.equal(resolveOpen("customers"), LISTS.customers.path);
  assert.equal(resolveOpen("/app/journal"), "/app/journal");
  assert.equal(resolveOpen("bogus"), null);
  assert.match(searchPath("a b"), /text=a%20b$/);
});
