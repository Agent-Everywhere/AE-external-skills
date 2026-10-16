import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery, flattenReport, faultMessage, project, qboString, resolveEntity, API_REPORTS } from "../src/entities.js";

test("resolveEntity by key, singular and v3 name", () => {
  assert.equal(resolveEntity("customers").entity, "Customer");
  assert.equal(resolveEntity("customer").entity, "Customer");
  assert.equal(resolveEntity("Purchase").key, "expenses");
  assert.equal(resolveEntity("nope"), null);
});

test("buildQuery adds paging and clamps maxresults", () => {
  assert.equal(buildQuery("Invoice", { limit: 5000, offset: 10 }), "select * from Invoice startposition 11 maxresults 1000");
  assert.equal(buildQuery("Invoice", { count: true, where: "Balance > '0'" }), "select count(*) from Invoice where Balance > '0'");
  assert.match(buildQuery("Bill", { orderBy: "TxnDate DESC" }), /orderby TxnDate DESC startposition 1 maxresults 100/);
});

test("qboString escapes quotes", () => {
  assert.equal(qboString("O'Brien"), "'O\\'Brien'");
});

test("project picks nested columns", () => {
  assert.deepEqual(project([{ Id: "1", CustomerRef: { name: "A" } }], ["Id", "CustomerRef.name", "X"]), [{ Id: "1", "CustomerRef.name": "A", X: null }]);
});

test("flattenReport walks sections and summaries", () => {
  const rep = {
    Header: { ReportName: "ProfitAndLoss", StartPeriod: "2026-01-01", EndPeriod: "2026-10-15", ReportBasis: "Cash" },
    Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
    Rows: { Row: [{ Header: { ColData: [{ value: "Income" }, { value: "" }] }, Rows: { Row: [{ ColData: [{ value: "Sales" }, { value: "10.00" }] }] }, Summary: { ColData: [{ value: "Total Income" }, { value: "10.00" }] } }] },
  };
  const f = flattenReport(rep);
  assert.equal(f.title, "ProfitAndLoss");
  assert.deepEqual(f.rows, [["Income", ""], ["  Sales", "10.00"], ["Total Income", "10.00"]]);
  assert.equal(f.noData, false);
});

test("flattenReport detects NoReportData", () => {
  assert.equal(flattenReport({ Header: { Option: [{ Name: "NoReportData", Value: "true" }] } }).noData, true);
});

test("faultMessage reads both fault shapes", () => {
  assert.match(faultMessage({ Fault: { Error: [{ Message: "Bad", Detail: "x", code: "6000" }] } }), /Bad: x \(code 6000\)/);
  assert.match(faultMessage({ fault: { error: [{ message: "Auth", code: "3200" }] } }), /Auth/);
  assert.equal(faultMessage({}), null);
});

test("every API report maps to a v3 report name", () => {
  for (const v of Object.values(API_REPORTS)) assert.match(v, /^[A-Z][A-Za-z]+$/);
});
