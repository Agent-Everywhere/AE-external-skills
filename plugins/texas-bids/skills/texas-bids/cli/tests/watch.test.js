import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_VERSION, StateError, diff, loadState, saveState } from "../src/watch.js";
import { parseListResponse } from "../src/esbd.js";
import { fixture, tmpDir } from "./helpers.js";

const rows = () => parseListResponse(fixture("open-page1.json")).rows;

test("first run is a baseline: everything is new", () => {
  const d = diff({ prev: null, rows: rows(), today: "2026-11-20" });
  assert.equal(d.baseline, true);
  assert.equal(d.fresh.length, 6);
  assert.equal(Object.keys(d.state.seen).length, 6);
  assert.equal(d.state.version, STATE_VERSION);
});

test("second run with no changes reports zero new", () => {
  const first = diff({ prev: null, rows: rows(), today: "2026-11-20" });
  const second = diff({ prev: first.state, rows: rows(), today: "2026-11-21" });
  assert.equal(second.baseline, false);
  assert.equal(second.fresh.length, 0);
  assert.equal(Object.keys(second.state.seen).length, 6);
});

test("only genuinely new solicitations are reported; an addendum on a seen one is not", () => {
  const first = diff({ prev: null, rows: rows(), today: "2026-11-20" });
  const next = rows();
  next[0] = { ...next[0], status: "Addendum Posted" };
  next.push({ ...next[1], id: "NEW-1", internal_id: "999001", title: "A brand new bid" });
  const d = diff({ prev: first.state, rows: next, today: "2026-11-21" });
  assert.deepEqual(d.fresh.map((r) => r.id), ["NEW-1"]);
  assert.equal(d.state.seen["999001"].first_seen, "2026-11-21");
});

test("a seen solicitation that drops out of the results stays remembered until 120 days after its due date", () => {
  const first = diff({ prev: null, rows: rows(), today: "2026-11-20" });
  const gone = diff({ prev: first.state, rows: [], today: "2026-12-01" });
  assert.equal(Object.keys(gone.state.seen).length, 6);
  const later = diff({ prev: first.state, rows: [], today: "2027-06-30" });
  assert.equal(Object.keys(later.state.seen).length, 0);
});

test("state round-trips through a file, written atomically", async () => {
  const dir = tmpDir();
  const p = join(dir, "nested", "state.json");
  assert.equal(await loadState(p), null);
  const d = diff({ prev: null, rows: rows(), today: "2026-11-20" });
  await saveState(p, d.state);
  assert.deepEqual(await loadState(p), d.state);
  assert.deepEqual(JSON.parse(await readFile(p, "utf8")).version, 1);
});

test("a corrupt or foreign state file is a clear error, never a silent reset", async () => {
  const dir = tmpDir();
  const p = join(dir, "state.json");
  await writeFile(p, "{not json");
  await assert.rejects(loadState(p), StateError);
  await writeFile(p, JSON.stringify({ hello: 1 }));
  await assert.rejects(loadState(p), /not a texas-bids state file/);
});
