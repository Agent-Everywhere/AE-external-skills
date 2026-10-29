import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, deps, main } from "../src/cli.js";
import { collect, diff, normalizeConfig, runWatch, WatchConfigError } from "../src/watch.js";
import { EXAMPLE_CONFIG } from "../src/watch-example.js";
import { doc, fakeClock, jsonRes, mockFetch, tmpDir } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");
const world = () => JSON.parse(fx("watch-world.json"));
const TODAY = "2026-10-28";

const CFG = {
  profile: "test profile",
  keywords: ["truck bod", "service bod", "crane", "fleet", "chassis", "van", "snow", "plow"],
  exclude_keywords: ["school food"],
  contract_keywords: ["truck bod", "service bod", "crane", "fleet"],
  competitor_brands: ["Knapheide", "IMT", "Stellar"],
  closing_soon_days: 14,
  contract_expiring_months: 18,
};

/** Fake commands driven by a mutable world; w.fail makes every call throw. */
function fake(w) {
  const guard = () => { if (w.fail) throw new Error("HTTP 503 for the portal"); };
  const low = (s) => String(s).toLowerCase();
  return {
    bidsList: async ({ status }) => { guard(); return { rows: w.bids.filter((b) => b.status === status).map((b) => ({ ...b })) }; },
    awardsList: async ({ year }) => { guard(); return { rows: (w.awards[year] || []).map((a) => ({ ...a })) }; },
    contractsSearch: async ({ q }) => { guard(); return { rows: w.contracts.filter((c) => low(`${c.description} ${c.keywords} ${c.vendor}`).includes(low(q))) }; },
    contractsVendor: async ({ name }) => { guard(); return { rows: w.contracts.filter((c) => low(c.vendor).includes(low(name))) }; },
  };
}

function session(w, cfg = CFG) {
  const dir = tmpDir();
  const configPath = join(dir, "watch.json");
  writeFileSync(configPath, JSON.stringify(cfg));
  const stateDir = join(dir, "state");
  const run = (date, { format = "json" } = {}) => runWatch({ commands: fake(w), today: () => date, configPath, stateDir, format });
  const latest = () => readFileSync(join(stateDir, "latest.json"), "utf8");
  return { run, latest, stateDir, dir, configPath };
}
const byType = (r, t) => r.result.changes.filter((c) => c.type === t);

test("baseline: current landscape of matching open/planned bids, expiring and competitor contracts", async () => {
  const s = session(world());
  const r = await s.run(TODAY);
  assert.equal(r.result.baseline, true);
  assert.deepEqual(new Set(r.result.changes.map((c) => c.type)), new Set(["NEW_BID", "CONTRACT_EXPIRING", "COMPETITOR_CONTRACT"]));
  assert.deepEqual(byType(r, "NEW_BID").map((c) => c.number).sort(), ["110726", "111026", "TBD"]); // b1, b6, planned b2
  assert.deepEqual(byType(r, "CONTRACT_EXPIRING").map((c) => c.contract_number).sort(), ["030126-KNP"]); // 030426-ABC ends beyond 18 months; 030626-OLD already ended
  assert.deepEqual(byType(r, "COMPETITOR_CONTRACT").map((c) => c.brand), ["Knapheide"]); // Imtech is not "IMT"
  assert.equal(r.result.summary.total, r.result.changes.length);
  assert.ok(existsSync(join(s.stateDir, `snapshot-${TODAY}.json`)));
  assert.equal(JSON.parse(s.latest()).date, TODAY);
  const md = await session(world()).run(TODAY, { format: "md" });
  assert.match(md.text, /Baseline run: current landscape/);
  assert.match(md.text, /\[110726 Truck Bodies, Service Cranes and Upfit Services\]\(https:\/\/portal\.example\/Tender\/Detail\/b1\)/);
});

test("a second identical run reports nothing new", async () => {
  const s = session(world());
  await s.run(TODAY);
  const r = await s.run(TODAY);
  assert.equal(r.result.baseline, false);
  assert.deepEqual(r.result.changes, []);
  assert.deepEqual(r.result.summary, { total: 0, by_type: {} });
  assert.match((await s.run(TODAY, { format: "md" })).text, /Nothing new today\./);
});

test("second run produces every change type", async () => {
  const w = world();
  const s = session(w);
  await s.run(TODAY);
  const b = (id) => w.bids.find((x) => x.id === id);
  b("b1").addendums = 2; b("b1").documents = 4; b("b1").plan_takers = 55; b("b1").days_left = 14;
  b("b2").status = "Open"; b("b2").number = "111126"; b("b2").closing = "2027-01-05T20:30:00.000Z"; b("b2").closing_local = "Tue Jan 5, 2027"; b("b2").days_left = 36;
  w.bids.push({ ...b("b4"), id: "b7", number: "111226", name: "Utility Bodies and Aerial Devices Fleet", description: "service bodies", days_left: 30, url: "https://portal.example/Tender/Detail/b7" });
  b("b5").status = "Awarded";
  w.awards[2026][0].awardees = ["Acme Bodies LLC", "Truckco Inc"];
  w.contracts.push({ contract_number: "030726-STL", vendor: "Stellar", end_date: "2030-01-01", description: "Service cranes", keywords: "crane", category: "" });
  const r = await s.run("2026-12-10"); // 2028-06-01 is now inside the 18-month window
  assert.equal(r.result.baseline, false);
  const types = r.result.changes.map((c) => c.type);
  assert.deepEqual([...new Set(types)], ["NEW_BID", "STATUS_CHANGE", "CLOSING_SOON", "ADDENDUM", "PLAN_TAKERS_JUMP", "NEW_AWARD", "CONTRACT_EXPIRING", "COMPETITOR_CONTRACT"]);
  assert.equal(byType(r, "NEW_BID").map((c) => c.id).join(), "b7");
  assert.deepEqual(byType(r, "STATUS_CHANGE").map((c) => [c.id, c.from, c.to]).sort(), [["b2", "Planned", "Open"], ["b5", "Closed", "Awarded"]]);
  const cs = byType(r, "CLOSING_SOON").find((c) => c.id === "b1");
  assert.equal(cs.threshold, 14);
  const ad = byType(r, "ADDENDUM")[0];
  assert.deepEqual([ad.id, ad.addendums_delta, ad.documents_delta], ["b1", 2, 1]);
  const pj = byType(r, "PLAN_TAKERS_JUMP")[0];
  assert.deepEqual([pj.id, pj.from, pj.plan_takers, pj.delta], ["b1", 40, 55, 15]);
  const na = byType(r, "NEW_AWARD")[0];
  assert.deepEqual([na.number, na.awardees], ["110126", ["Acme Bodies LLC", "Truckco Inc"]]);
  assert.equal(na.url, "https://portal.example/Tender/Detail/b5");
  assert.deepEqual(byType(r, "CONTRACT_EXPIRING").map((c) => c.contract_number), ["030426-ABC"]);
  assert.equal(byType(r, "CONTRACT_EXPIRING")[0].note, "upcoming re-bid signal");
  assert.deepEqual(byType(r, "COMPETITOR_CONTRACT").map((c) => c.brand), ["Stellar"]);
  assert.equal(r.result.summary.total, r.result.changes.length);
  assert.equal(r.result.summary.by_type.STATUS_CHANGE, 2);
  const md = (await s.run("2026-12-10", { format: "md" }));
  assert.match(md.text, /Nothing new today/); // the md run is the next day's diff: everything above was already recorded
  // the CONTRACT_EXPIRING crossing is reported once, then never again
  assert.equal(byType(await s.run("2026-12-11"), "CONTRACT_EXPIRING").length, 0);
});

test("md digest has headline counts, a section per change type and links", async () => {
  const w = world();
  const s = session(w);
  await s.run(TODAY);
  w.bids.find((x) => x.id === "b1").addendums = 1;
  w.bids.find((x) => x.id === "b6").plan_takers = 30;
  const { text } = await s.run("2026-10-29", { format: "md" });
  assert.match(text, /^# Sourcewell watch: 2026-10-29 \(test profile\)/);
  assert.match(text, /\*\*2 changes\*\*/);
  assert.match(text, /## New addenda or documents \(1\)\n- \[110726 Truck Bodies.*\]\(https:\/\/portal\.example\/Tender\/Detail\/b1\): \+1 addendum \(1\)/);
  assert.match(text, /## Plan-taker jumps \(1\)\n- .*plan takers 22 -> 30 \(\+8\)/);
});

test("exclude_keywords removes matches (bids, awards and contracts)", async () => {
  const w = world();
  const withEx = await collect({ commands: fake(w), cfg: normalizeConfig(CFG, TODAY), today: TODAY, prev: null });
  assert.ok(!withEx.bids.b3, "school food bid excluded");
  assert.ok(withEx.bids.b1);
  assert.ok(!Object.keys(withEx.contracts).includes("030526-SCH"), "school food contract excluded");
  const without = await collect({ commands: fake(w), cfg: normalizeConfig({ ...CFG, exclude_keywords: [] }, TODAY), today: TODAY, prev: null });
  assert.ok(without.bids.b3, "control: matches when not excluded");
  assert.ok(Object.keys(without.contracts).includes("030526-SCH"));
});

test("exclude_keywords match whole words: bus is not business, fire is not firewall, consult still hits consulting", async () => {
  const w = world();
  const add = (id, name, description) => w.bids.push({ ...w.bids[0], id, number: id, name, description, url: `https://portal.example/Tender/Detail/${id}` });
  add("x1", "Service Bodies for Small Business Fleets", "Open to any business.");
  add("x2", "Service Bodies and Firewall Appliances", "Plain.");
  add("x3", "Service Bodies and School Buses", "Plain.");
  add("x4", "Service Bodies with Fleet Consulting Services", "Plain.");
  add("x5", "Service Bodies and Fire Trucks", "Plain.");
  const cfg = normalizeConfig({ ...CFG, exclude_keywords: ["bus", "fire", "consult"] }, TODAY);
  const cur = await collect({ commands: fake(w), cfg, today: TODAY, prev: null });
  assert.ok(cur.bids.x1, "business is not excluded by bus");
  assert.ok(cur.bids.x2, "firewall is not excluded by fire");
  assert.ok(!cur.bids.x3, "buses is excluded by bus");
  assert.ok(!cur.bids.x4, "consulting is excluded by consult");
  assert.ok(!cur.bids.x5, "fire trucks is excluded by fire");
  const cfg2 = normalizeConfig({ ...CFG, exclude_keywords: ["school bus"] }, TODAY);
  const cur2 = await collect({ commands: fake(w), cfg: cfg2, today: TODAY, prev: null });
  assert.ok(cur2.bids.x1 && !cur2.bids.x3, "school bus excludes School Buses and leaves business alone");
});

test("on contracts, exclude_keywords look at the description only (not the keywords field or the vendor name)", async () => {
  const w = world();
  w.contracts.push(
    { contract_number: "040101-KWD", vendor: "Keyword Body Co", end_date: "2027-06-01", description: "Truck bodies", keywords: "refuse, school food, truck body", category: "" },
    { contract_number: "040102-VND", vendor: "Refuse Truck Bodies Inc", end_date: "2027-06-01", description: "Truck bodies", keywords: "truck body", category: "" },
    { contract_number: "040103-DSC", vendor: "Plain Co", end_date: "2027-06-01", description: "Refuse truck bodies", keywords: "truck body", category: "" },
  );
  const cfg = normalizeConfig({ ...CFG, exclude_keywords: ["refuse", "school food"] }, TODAY);
  const cur = await collect({ commands: fake(w), cfg, today: TODAY, prev: null });
  assert.ok(cur.contracts["040101-KWD"], "excluded term only in keywords: kept");
  assert.ok(cur.contracts["040102-VND"], "excluded term only in the vendor name: kept");
  assert.ok(!cur.contracts["040103-DSC"], "excluded term in the description: dropped");
  assert.ok(!cur.contracts["030526-SCH"], "school food in the description: dropped");
});

test("contracts are de-duplicated by contract number in the snapshot and in every digest section", async () => {
  const w = world();
  const knp = w.contracts[0];
  w.contracts.push({ ...knp, contract_number: " 030126-knp " }); // same contract, found by another query, odd spacing and case
  const s = session(w, { ...CFG, contract_expiring_months: 24 });
  const r = await s.run(TODAY);
  const snap = JSON.parse(s.latest());
  assert.equal(Object.keys(snap.contracts).filter((k) => k.includes("030126-KNP")).length, 1);
  for (const t of ["CONTRACT_EXPIRING", "COMPETITOR_CONTRACT"]) {
    const nums = byType(r, t).map((c) => c.contract_number.trim().toUpperCase());
    assert.equal(nums.length, new Set(nums).size, t);
  }
  assert.equal(byType(r, "COMPETITOR_CONTRACT").length, 1);
  assert.equal(byType(await s.run(TODAY), "COMPETITOR_CONTRACT").length, 0);
});

test("matching is case-insensitive substring on name+description", async () => {
  const w = world();
  const cur = await collect({ commands: fake(w), cfg: normalizeConfig({ ...CFG, keywords: ["SERVICE BODIES"] }, TODAY), today: TODAY, prev: null });
  assert.deepEqual(Object.keys(cur.bids), ["b1"]); // only in b1's description, found despite the case
});

test("old closed bids are ignored unless already tracked; awards identified without a number", async () => {
  const w = world();
  const cur = await collect({ commands: fake(w), cfg: normalizeConfig(CFG, TODAY), today: TODAY, prev: null });
  assert.ok(cur.bids.b5);
  assert.ok(!cur.bids.b8);
  assert.deepEqual(Object.keys(cur.awards), []); // award for 110126 has no awardees yet; parking award does not match
});

test("fetch failure exits non-zero path: latest.json is left untouched and no snapshot is written", async () => {
  const w = world();
  const s = session(w);
  await s.run(TODAY);
  const before = s.latest();
  const files = readdirSync(s.stateDir).sort();
  w.bids.find((x) => x.id === "b1").addendums = 9;
  w.fail = true;
  await assert.rejects(s.run("2026-10-29"), /503/);
  assert.equal(s.latest(), before);
  assert.deepEqual(readdirSync(s.stateDir).sort(), files);
  w.fail = false;
  const r = await s.run("2026-10-29"); // the change is still reported once the fetch works
  assert.equal(byType(r, "ADDENDUM").length, 1);
});

test("a failed first run records no baseline", async () => {
  const w = world(); w.fail = true;
  const s = session(w);
  await assert.rejects(s.run(TODAY), /503/);
  assert.ok(!existsSync(join(s.stateDir, "latest.json")));
});

test("a corrupt latest.json is an error, never a silent re-baseline", async () => {
  const s = session(world());
  await s.run(TODAY);
  writeFileSync(join(s.stateDir, "latest.json"), "{not json");
  await assert.rejects(s.run("2026-10-29"), /not valid JSON/);
  assert.equal(readFileSync(join(s.stateDir, "latest.json"), "utf8"), "{not json");
});

test("CLOSING_SOON fires once per threshold crossing, then again only for the final 3 days", async () => {
  const w = world();
  const b1 = w.bids.find((x) => x.id === "b1");
  const s = session(w);
  const closing = async (date, days) => { b1.days_left = days; return byType(await s.run(date), "CLOSING_SOON").filter((c) => c.id === "b1"); };
  assert.deepEqual(await closing("2026-10-28", 20), []); // baseline
  const first = await closing("2026-10-29", 14);
  assert.equal(first.length, 1); assert.equal(first[0].threshold, 14); assert.equal(first[0].final, false);
  assert.deepEqual(await closing("2026-10-30", 13), []);
  assert.deepEqual(await closing("2026-10-31", 12), []);
  assert.deepEqual(await closing("2026-11-01", 4), []);
  const last = await closing("2026-11-02", 3);
  assert.equal(last.length, 1); assert.equal(last[0].threshold, 3); assert.equal(last[0].final, true);
  assert.deepEqual(await closing("2026-11-03", 2), []);
  assert.deepEqual(await closing("2026-11-04", 1), []);
});

test("a bid already inside the window at baseline does not alert next day, but still alerts at 3 days", async () => {
  const w = world();
  const s = session(w);
  await s.run(TODAY); // b6 has 16 days left: no alert; b1 20
  w.bids.find((x) => x.id === "b6").days_left = 15;
  const nb = w.bids.find((x) => x.id === "b1"); nb.days_left = 5;
  const r1 = await s.run("2026-10-29");
  assert.deepEqual(byType(r1, "CLOSING_SOON").map((c) => c.id), ["b1"]); // 5 <= 14 first crossing (b6 at 15 is outside)
  assert.deepEqual(byType(await s.run("2026-10-30"), "CLOSING_SOON"), []);
  nb.days_left = 2;
  const r3 = await s.run("2026-10-31");
  assert.deepEqual(byType(r3, "CLOSING_SOON").map((c) => [c.id, c.threshold]), [["b1", 3]]);
});

test("a bid first seen already closing soon reports NEW_BID and one CLOSING_SOON for the lowest threshold crossed", () => {
  const cfg = normalizeConfig(CFG, TODAY);
  const entry = { id: "n", number: "1", name: "Crane", status: "Open", closing: "", closing_local: "x", days_left: 2, planned_issue: "", plan_takers: 0, documents: 0, addendums: 0, url: "u", matched: ["crane"] };
  const prev = { version: 1, date: TODAY, bids: {}, awards: {}, contracts: {} };
  const changes = diff({ prev, cur: { bids: { n: entry }, awards: {}, contracts: {} }, cfg, today: TODAY });
  assert.deepEqual(changes.map((c) => [c.type, c.threshold]), [["NEW_BID", undefined], ["CLOSING_SOON", 3]]);
});

test("keeps the last 30 snapshots", async () => {
  const s = session(world());
  await s.run("2026-01-01");
  for (let d = 2; d <= 34; d++) writeFileSync(join(s.stateDir, `snapshot-2026-02-${String(d).padStart(2, "0")}.json`), "{}");
  await s.run("2026-10-28");
  const snaps = readdirSync(s.stateDir).filter((f) => f.startsWith("snapshot-"));
  assert.equal(snaps.length, 30);
  assert.ok(snaps.includes("snapshot-2026-10-28.json"));
  assert.ok(!snaps.includes("snapshot-2026-01-01.json"));
  assert.ok(existsSync(join(s.stateDir, "latest.json")));
  assert.ok(!readdirSync(s.stateDir).some((f) => f.endsWith(".tmp")));
});

test("config validation", () => {
  assert.throws(() => normalizeConfig({}, TODAY), WatchConfigError);
  assert.throws(() => normalizeConfig({ keywords: [] }, TODAY), /must not be empty/);
  assert.throws(() => normalizeConfig({ keywords: ["a"], closing_soon_days: 0 }, TODAY), /closing_soon_days/);
  assert.deepEqual(normalizeConfig({ keywords: ["a"] }, "2026-10-28").award_years, [2026, 2025]);
});

test("example config is valid, embedded copy matches watch.example.json, and carries no company or person names", () => {
  const file = JSON.parse(readFileSync(join(here, "..", "..", "watch.example.json"), "utf8"));
  assert.deepEqual(file, EXAMPLE_CONFIG);
  assert.equal(file.profile, "work-truck upfitter (example)");
  assert.ok(normalizeConfig(file, TODAY).keywords.includes("truck bod"));
});

// ---- CLI wiring ----

async function cli(argv, handler) {
  const clock = fakeClock();
  clock.t = Date.parse("2026-10-28T12:00:00Z");
  const f = mockFetch(handler || (() => jsonRes(doc("x", []))));
  const out = []; const err = [];
  Object.assign(deps, { fetch: f, sleep: clock.sleep, now: clock.now, stdout: (x) => out.push(x), stderr: (x) => err.push(x), cacheDir: tmpDir() });
  process.exitCode = 0;
  await main(argv);
  const code = process.exitCode; process.exitCode = 0;
  return { f, out: out.join(""), err: err.join(""), code };
}

const portalHandler = (url, init) => {
  if (url.includes("/Tender/Search/")) return /status=Open&/.test(url) ? jsonRes(fx("tenders-search.json")) : jsonRes({ success: true, data: [], total: 0 });
  if (url.includes("ContractAwards")) return jsonRes(fx("contract-awards.html"));
  if (url.includes("proportal")) return jsonRes(fx("tenders-page.html"));
  return jsonRes(doc("node--contractprofile", []));
};

test("watch commands are registered", () => {
  assert.ok(COMMANDS["watch run"] && COMMANDS["watch init"]);
});

test("watch init writes the example config and refuses to overwrite it", async () => {
  const out = join(tmpDir(), "watch.json");
  const r = await cli(["watch", "init", "--out", out]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), EXAMPLE_CONFIG);
  const again = await cli(["watch", "init", "--out", out]);
  assert.equal(again.code, 2);
  assert.match(again.err, /already exists/);
});

test("watch run end to end: baseline then nothing new; --out writes the digest too; allowlist unchanged", async () => {
  const dir = tmpDir();
  const config = join(dir, "watch.json");
  writeFileSync(config, JSON.stringify({ keywords: ["construction equipment"], award_years: [2023] }));
  const state = join(dir, "state");
  const digest = join(dir, "digest.md");
  const r1 = await cli(["watch", "run", "--config", config, "--state-dir", state, "--out", digest], portalHandler);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /Baseline run: current landscape/);
  assert.match(r1.out, /110326 Heavy and Compact Construction Equipment/);
  assert.equal(readFileSync(digest, "utf8"), r1.out);
  const r2 = await cli(["watch", "run", "--config", config, "--state-dir", state, "--format", "json"], portalHandler);
  assert.equal(r2.code, 0, r2.err);
  const o = JSON.parse(r2.out);
  assert.equal(o.baseline, false);
  assert.deepEqual(o.changes, []);
  assert.equal(o.date, "2026-10-28");
  for (const c of r1.f.calls.concat(r2.f.calls)) assert.match(c.url, /^https:\/\/(proportal\.sourcewell-mn\.gov|[a-z.-]*sourcewell[a-z.-]*)\//);
});

test("watch run exits non-zero on a fetch failure and records nothing", async () => {
  const dir = tmpDir();
  const config = join(dir, "watch.json");
  writeFileSync(config, JSON.stringify({ keywords: ["construction"] }));
  const state = join(dir, "state");
  const ok = await cli(["watch", "run", "--config", config, "--state-dir", state], portalHandler);
  assert.equal(ok.code, 0, ok.err);
  const before = readFileSync(join(state, "latest.json"), "utf8");
  const bad = await cli(["watch", "run", "--config", config, "--state-dir", state, "--no-cache", "--out", join(dir, "d.md")], () => jsonRes("boom", { status: 500 }));
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /sourcewell:/);
  assert.equal(readFileSync(join(state, "latest.json"), "utf8"), before);
  assert.ok(!existsSync(join(dir, "d.md")));
});

test("watch run usage errors exit 2", async () => {
  assert.equal((await cli(["watch", "run"])).code, 2);
  const dir = tmpDir();
  assert.equal((await cli(["watch", "run", "--config", join(dir, "missing.json"), "--state-dir", dir])).code, 2);
  const cfg = join(dir, "c.json"); writeFileSync(cfg, JSON.stringify({ keywords: ["x"] }));
  assert.equal((await cli(["watch", "run", "--config", cfg, "--state-dir", dir, "--format", "csv"])).code, 2);
});
