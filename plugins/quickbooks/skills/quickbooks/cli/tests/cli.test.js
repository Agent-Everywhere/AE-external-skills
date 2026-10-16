import test from "node:test";
import assert from "node:assert/strict";
import { buildProgram, deps, main } from "../src/cli.js";
import { fakePage, queryHandler } from "./helpers.js";

function capture() {
  const out = []; const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  return { text: () => out.join(""), restore: () => { process.stdout.write = orig; } };
}

function stubSession(page) {
  deps.connect = async () => ({ runtime: "cdp", page, cdp: { on: () => () => {} }, close: async () => {} });
}

test("command list", () => {
  const names = buildProgram().commands.map((c) => c.name());
  for (const n of ["doctor", "status", "company", "routes", "open", "list", "count", "get", "query", "search", "report", "create", "void", "delete", "ui", "discover", "emit", "bench"]) assert.ok(names.includes(n), n);
});

test("list --json prints rows", async () => {
  stubSession(fakePage({ api: queryHandler({ Vendor: [{ Id: "3", DisplayName: "V" }] }) }));
  const c = capture();
  try { await main(["node", "qbo", "--json", "list", "vendors"]); } finally { c.restore(); }
  const v = JSON.parse(c.text());
  assert.equal(v.entity, "Vendor");
  assert.equal(v.rows[0].DisplayName, "V");
});

test("create without --yes is a dry run", async () => {
  const page = fakePage({ api: queryHandler({}) });
  stubSession(page);
  const c = capture();
  try { await main(["node", "qbo", "--json", "create", "customer", "--name", "T"]); } finally { c.restore(); }
  const v = JSON.parse(c.text());
  assert.equal(v.applied, false);
  assert.equal(page.calls.filter((x) => x.method === "POST").length, 0);
});

test("query refuses non-SELECT", async () => {
  stubSession(fakePage({}));
  const c = capture();
  process.exitCode = 0;
  try { await main(["node", "qbo", "--json", "query", "delete from Invoice"]); } finally { c.restore(); }
  assert.equal(process.exitCode, 2);
  process.exitCode = 0;
});

test("emit prints a paste-ready IIFE offline", async () => {
  const c = capture();
  try { await main(["node", "qbo", "emit", "ready"]); } finally { c.restore(); }
  assert.match(c.text(), /^\(async \(\) => \{/);
  assert.match(c.text(), /\)\(\{\}\)\n$/);
});
