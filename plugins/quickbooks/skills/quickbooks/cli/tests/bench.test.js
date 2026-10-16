import test from "node:test";
import assert from "node:assert/strict";
import { runBench } from "../src/bench.js";

const fakeQbo = (over = {}) => ({ ensureReady: async () => ({}), company: async () => ({}), count: async () => 0, query: async () => ({}), ...over });

test("bench --only takes a comma list and survives a failed reload", async () => {
  let n = 0;
  const page = { goto: async () => { if (n++ === 0) throw new Error("CDP timeout: Page.navigate"); } };
  const rows = [];
  const r = await runBench(fakeQbo(), page, { runs: 2, only: "status,company", onRow: (row) => rows.push(row.command) });
  assert.deepEqual(r.map((x) => x.command), ["status", "company"]);
  assert.equal(r[0].errors, 1);
  assert.equal(r[0].cold.n, 1);
  assert.equal(r[0].warm.n, 2);
  assert.deepEqual(rows, ["status", "company"]);
  assert.equal(r.aborted, undefined);
});

test("bench stops and keeps partial results when the browser connection closes", async () => {
  const page = { goto: async () => {} };
  let calls = 0;
  const q = fakeQbo({ company: async () => { if (++calls > 1) throw new Error("CDP connection closed"); return {}; } });
  const r = await runBench(q, page, { runs: 2, only: "status,company,count" });
  assert.deepEqual(r.map((x) => x.command), ["status", "company"]);
  assert.match(r.aborted, /company/);
  assert.equal(r[1].cold.n, 1);
});
