import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emit, render, toCsv } from "../src/output.js";
import { tmpDir } from "./helpers.js";

test("CSV quotes commas, quotes and newlines; joins arrays; blanks nulls", () => {
  const csv = toCsv([{ a: "x,y", b: 'say "hi"', c: "l1\nl2", d: ["p", "q"], e: null }]);
  assert.equal(csv, 'a,b,c,d,e\n"x,y","say ""hi""","l1\nl2",p; q,\n');
});

test("CSV columns are the union of row keys in first-seen order", () => {
  assert.equal(toCsv([{ a: 1 }, { b: 2, a: 3 }]), "a,b\n1,\n3,2\n");
});

test("JSON output has count, optional meta and rows", () => {
  const o = JSON.parse(render({ rows: [{ a: 1 }], meta: { m: 1 } }, "json"));
  assert.deepEqual(o, { count: 1, meta: { m: 1 }, rows: [{ a: 1 }] });
  assert.throws(() => render({ rows: [] }, "xml"));
});

test("--out writes a file and reports on stderr, not stdout", async () => {
  const f = join(tmpDir(), "o.csv");
  let stdout = "";
  const note = await emit({ rows: [{ a: 1 }] }, { format: "csv", out: f, stdout: (s) => { stdout += s; } });
  assert.equal(readFileSync(f, "utf8"), "a\n1\n");
  assert.equal(stdout, "");
  assert.match(note, /wrote 1 rows/);
});
