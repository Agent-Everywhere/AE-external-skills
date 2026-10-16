import test from "node:test";
import assert from "node:assert/strict";
import { Qbo, QboError, WriteBlocked } from "../src/qbo.js";
import { fakePage, queryHandler } from "./helpers.js";

test("list projects default columns", async () => {
  const page = fakePage({ api: queryHandler({ Customer: [{ Id: "1", DisplayName: "A", Balance: 0, Active: true }] }) });
  const r = await new Qbo(page).list("customers");
  assert.equal(r.count, 1);
  assert.deepEqual(Object.keys(r.rows[0]), ["Id", "DisplayName", "PrimaryEmailAddr.Address", "Balance", "Active"]);
});

test("signed-out page raises exit code 3", async () => {
  const page = fakePage({ state: "signed_out" });
  await assert.rejects(new Qbo(page).list("customers"), (e) => e instanceof QboError && e.exitCode === 3);
});

test("HTTP 401 maps to exit 5", async () => {
  const page = fakePage({ api: () => ({ status: 401, data: { fault: { error: [{ message: "AuthenticationFailed", code: "3200" }] } } }) });
  await assert.rejects(new Qbo(page).company(), (e) => e.exitCode === 5);
});

test("writes are dry runs without confirm and send nothing", async () => {
  const page = fakePage({ api: queryHandler({}) });
  await assert.rejects(new Qbo(page).createCustomer({ name: "X" }, false), (e) => e instanceof WriteBlocked && e.plan.body.DisplayName === "X");
  assert.equal(page.calls.filter((c) => c.method === "POST").length, 0);
});

test("createInvoice resolves customer by name and posts a line", async () => {
  const base = queryHandler({ Customer: [{ Id: "7", DisplayName: "AE Skill Test" }], Item: [{ Id: "1", Name: "Services" }] });
  const page = fakePage({ api: (p) => (p.method === "POST" ? { status: 200, data: { Invoice: { Id: "9", TotalAmt: 5 } } } : base(p)) });
  const inv = await new Qbo(page).createInvoice({ customer: "AE Skill Test", amount: "5" }, true);
  assert.equal(inv.Id, "9");
  const post = page.calls.find((c) => c.method === "POST");
  assert.equal(post.path, "/invoice");
  assert.equal(post.body.CustomerRef.value, "7");
  assert.equal(post.body.Line[0].SalesItemLineDetail.ItemRef.value, "1");
});

test("remove inactivates customers and deletes transactions", async () => {
  const getters = { "/customer/1": { Customer: { Id: "1", SyncToken: "0", DisplayName: "A" } }, "/purchase/2": { Purchase: { Id: "2", SyncToken: "3" } } };
  const page = fakePage({ api: (p) => (getters[p.path] ? { status: 200, data: getters[p.path] } : { status: 200, data: { Customer: { Id: "1", Active: false } } }) });
  const q = new Qbo(page);
  await q.remove("customers", "1", true);
  await q.remove("expenses", "2", true);
  const posts = page.calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts[0].body, { Id: "1", SyncToken: "0", sparse: true, Active: false, DisplayName: "A" });
  assert.equal(posts[1].path, "/purchase?operation=delete");
});

test("voidTxn uses operation=void for invoices and refuses bills", async () => {
  const page = fakePage({ api: (p) => ({ status: 200, data: { Invoice: { Id: "1", SyncToken: "1" } } }) });
  const q = new Qbo(page);
  await q.voidTxn("invoices", "1", true);
  assert.equal(page.calls.at(-1).path, "/invoice?operation=void");
  await assert.rejects(q.voidTxn("bills", "1", true), /cannot be voided/);
});

test("report passes dates and method", async () => {
  const page = fakePage({ api: () => ({ status: 200, data: { Header: { ReportName: "ProfitAndLoss" }, Columns: { Column: [] }, Rows: {} } }) });
  await new Qbo(page).report("pandl", { from: "2026-01-01", to: "2026-02-01", method: "accrual" });
  assert.deepEqual(page.calls[0].query, { start_date: "2026-01-01", end_date: "2026-02-01", accounting_method: "Accrual" });
  await assert.rejects(new Qbo(page).report("nope"), /unknown report/);
});

test("search runs name and document lookups", async () => {
  const page = fakePage({ api: queryHandler({ Account: [{ Id: "7", Name: "Cash", Active: true }] }) });
  const hits = await new Qbo(page).search("Cash");
  assert.ok(hits.some((h) => h.type === "Account" && h.id === "7"));
  assert.ok(page.calls.some((c) => /like '%Cash%'/.test(c.query.query)));
});
