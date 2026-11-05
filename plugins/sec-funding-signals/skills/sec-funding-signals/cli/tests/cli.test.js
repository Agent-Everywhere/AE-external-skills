import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, deps, main, parseArgs } from "../src/cli.js";
import { fakeClock, fixture, hit, mockFetch, res, searchPage, tmpDir } from "./helpers.js";

const A1 = "0001234567-26-000001"; // original filing, $2.5M sold
const A2 = "0001234567-26-000002"; // later amendment, amount undisclosed
const FUND = "0007654321-26-000001";
const SPV = "0000000555-26-000001";
const ACME = "0000000777-26-000001";
const DOCS = { [A1]: "form-d-operating.xml", [A2]: "form-d-undisclosed.xml", [FUND]: "form-d-fund.xml", [SPV]: "form-d-fund.xml", [ACME]: "form-d-operating.xml" };
const HITS = [
  hit(A1, 1234567, "Example Widgets, Inc.", { date: "2026-10-01", state: "TX" }),
  hit(A2, 1234567, "Example Widgets, Inc.", { form: "D/A", date: "2026-10-10", state: "TX" }),
  hit(FUND, 7654321, "Sample Opportunity Vehicle LP", { date: "2026-10-02", state: "NY" }),
  hit(SPV, 555, "Widget Robotics SPV I LLC", { date: "2026-10-03", state: "CA" }),
  hit(ACME, 777, "Acme Widgets Inc", { date: "2026-10-04", state: "CA" }),
];

function world(over = {}) {
  return mockFetch((u) => {
    const url = new URL(u);
    if (url.hostname === "efts.sec.gov") return res(searchPage(over.hits || HITS));
    const acc = /\/(\d{10})(\d{2})(\d{6})\/primary_doc\.xml$/.exec(url.pathname);
    const key = `${acc[1]}-${acc[2]}-${acc[3]}`;
    if (over.fail && over.fail.includes(key)) return res("", { status: 404 });
    let xml = fixture(DOCS[key]);
    if (key === SPV) xml = xml.replace("0007654321", "0000000555").replace("Sample Opportunity Vehicle LP", "Widget Robotics SPV I LLC");
    if (key === ACME) xml = xml.replace("0001234567", "0000000777").replace(/Example Widgets, Inc\./g, "Acme Widgets Inc");
    return res(xml);
  });
}

async function run(argv, { f = world(), cwd = tmpDir(), env = {} } = {}) {
  const clock = fakeClock();
  clock.t = Date.parse("2026-11-05T12:00:00Z");
  const out = []; const err = [];
  Object.assign(deps, { fetch: f, sleep: clock.sleep, now: clock.now, stdout: (s) => out.push(s), stderr: (s) => err.push(s), cwd: () => cwd, env });
  process.exitCode = 0;
  await main(["--email", "rep@sales.test", ...argv]);
  const code = process.exitCode; process.exitCode = 0;
  return { f, cwd, out: out.join(""), err: err.join(""), code, json: () => JSON.parse(out.join("")) };
}
const docCalls = (f) => f.calls.filter((c) => c.url.includes("primary_doc.xml")).length;

test("command list", () => {
  for (const n of ["setup", "doctor", "search", "show", "annotate", "profile init", "profile check", "presets"]) assert.ok(COMMANDS[n], n);
});

test("parseArgs handles --k v, --k=v and booleans", () => {
  const { words, flags } = parseArgs(["search", "--keywords", "a,b", "--since=30d", "--include-funds"]);
  assert.deepEqual(words, ["search"]);
  assert.equal(flags.keywords, "a,b");
  assert.equal(flags.since, "30d");
  assert.equal(flags["include-funds"], true);
});

test("default search: operating companies only, funds/SPVs/exclusions dropped before fetching, deduped by CIK, latest filing wins", async () => {
  const dir = tmpDir();
  const profile = join(dir, "p.json");
  writeFileSync(profile, JSON.stringify({ offer: "x", keywords: ["alpha"], excludes: { terms: [], companies: ["Acme"] } }));
  const r = await run(["search", "--profile", profile, "--since", "30d"], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  const o = r.json();
  assert.equal(o.count, 1);
  const row = o.rows[0];
  assert.equal(row.issuer_name, "Example Widgets, Inc.");
  assert.equal(row.accession, A2, "latest filing wins");
  assert.equal(row.form, "D/A");
  assert.equal(row.filing_count, 2);
  assert.deepEqual(row.accessions, [A2, A1]);
  assert.equal(row.first_filing_date, "2026-10-01");
  assert.equal(row.filtered_reason, null);
  assert.deepEqual(row.related_persons.map((p) => p.last_name), ["Sampleton", "SAMPLE", "Example"], "persons are unioned across filings");
  assert.equal(o.meta.issuers_before_filtering, 4);
  assert.equal(o.meta.issuers_after_fund_filter, 1);
  assert.deepEqual(o.meta.filtered, { fund: 1, vehicle_name: 1, excluded: 1 });
  assert.equal(o.meta.complete, true);
  assert.equal(docCalls(r.f), 3, "the SPV-named and excluded issuers are never fetched");
  const reasons = o.meta.filtered_examples.map((e) => e.reason).join("|");
  assert.match(reasons, /fund: industry group "Pooled Investment Fund"/);
  assert.match(reasons, /vehicle-name: matches "SPV"/);
  assert.match(reasons, /excluded: company "Acme"/);
});

test("--include-funds keeps funds and SPVs with their filtered_reason; user exclusions still apply", async () => {
  const dir = tmpDir();
  const profile = join(dir, "p.json");
  writeFileSync(profile, JSON.stringify({ offer: "x", keywords: ["alpha"], excludes: { terms: [], companies: ["Acme"] } }));
  const r = await run(["search", "--profile", profile, "--since", "30d", "--include-funds"], { cwd: dir });
  const o = r.json();
  assert.equal(o.count, 3);
  const by = Object.fromEntries(o.rows.map((x) => [x.issuer_name, x.filtered_reason]));
  assert.equal(by["Example Widgets, Inc."], null);
  assert.match(by["Sample Opportunity Vehicle LP"], /^fund:/);
  assert.match(by["Widget Robotics SPV I LLC"], /^fund:|^vehicle-name:/);
  assert.equal(o.meta.operating_company_rows, 1);
  assert.equal(o.meta.filtered.excluded, 1);
});

test("--keywords accepts a preset name and runs one EDGAR query per keyword", async () => {
  const f = world({ hits: [] });
  const r = await run(["search", "--keywords", "ai-data", "--since", "30d"], { f });
  assert.equal(r.code, 0, r.err);
  const qs = f.calls.map((c) => new URL(c.url).searchParams.get("q"));
  assert.deepEqual(qs, ['"AI training data"', '"data annotation"', '"LLM evaluation"', '"vertical AI"', '"foundation model"']);
  assert.equal(r.json().count, 0);
});

test("amount filters: below min and above max are dropped; undisclosed amounts need --include-unknown-amount", async () => {
  const only = world({ hits: [HITS[0], HITS[1]] });
  let r = await run(["search", "--keywords", "alpha", "--since", "30d", "--min-amount", "1000000"], { f: only });
  assert.equal(r.json().count, 0);
  assert.equal(r.json().meta.filtered.unknown_amount, 1);
  r = await run(["search", "--keywords", "alpha", "--since", "30d", "--min-amount", "1000000", "--include-unknown-amount"], { f: world({ hits: [HITS[0], HITS[1]] }) });
  assert.equal(r.json().count, 1);
  const single = () => world({ hits: [HITS[0]] });
  assert.equal((await run(["search", "--keywords", "alpha", "--since", "30d", "--min-amount", "$2,000,000"], { f: single() })).json().count, 1);
  r = await run(["search", "--keywords", "alpha", "--since", "30d", "--min-amount", "3000000"], { f: single() });
  assert.equal(r.json().count, 0);
  assert.equal(r.json().meta.filtered.below_min_amount, 1);
  r = await run(["search", "--keywords", "alpha", "--since", "30d", "--max-amount", "1000000"], { f: single() });
  assert.equal(r.json().meta.filtered.above_max_amount, 1);
});

test("--states filters on the issuer's state (before fetching when the search hit has one)", async () => {
  const f = world();
  const r = await run(["search", "--keywords", "alpha", "--since", "30d", "--states", "ca,ny", "--include-funds"], { f });
  const names = r.json().rows.map((x) => x.issuer_name).sort();
  assert.deepEqual(names, ["Sample Opportunity Vehicle LP", "Widget Robotics SPV I LLC"], "Acme's hit said CA but its filing says TX: the filing wins");
  assert.ok(r.json().meta.filtered.state >= 1);
  assert.equal(docCalls(f), 3);
  const bad = await run(["search", "--keywords", "alpha", "--since", "30d", "--states", "California"]);
  assert.equal(bad.code, 2);
});

test("--sample keeps the newest N issuers; --limit trims rows", async () => {
  const r = await run(["search", "--keywords", "alpha", "--since", "30d", "--include-funds", "--sample", "2"]);
  const o = r.json();
  assert.equal(o.count, 2);
  assert.equal(o.meta.sample, 2);
  assert.equal((await run(["search", "--keywords", "alpha", "--since", "30d", "--include-funds", "--limit", "1"])).json().count, 1);
});

test("a filing that cannot be fetched makes the run PARTIAL: reported, exit code 3, other rows still returned", async () => {
  const r = await run(["search", "--keywords", "alpha", "--since", "30d"], { f: world({ fail: [FUND] }) });
  assert.equal(r.code, 3);
  assert.match(r.err, /PARTIAL/);
  const o = r.json();
  assert.equal(o.meta.complete, false);
  assert.equal(o.meta.fetch_errors[0].accession, FUND);
  assert.equal(o.count, 2);
});

test("search needs keywords, --since and a contact email", async () => {
  assert.equal((await run(["search", "--since", "30d"])).code, 2);
  assert.equal((await run(["search", "--keywords", "a"])).code, 2);
  const f = world();
  const clock = fakeClock(); const err = [];
  Object.assign(deps, { fetch: f, sleep: clock.sleep, now: clock.now, stdout: () => {}, stderr: (s) => err.push(s), cwd: () => tmpDir(), env: {} });
  process.exitCode = 0;
  await main(["search", "--keywords", "a", "--since", "30d"]);
  assert.equal(process.exitCode, 2); process.exitCode = 0;
  assert.match(err.join(""), /ask the user for THEIR email/);
  assert.equal(f.calls.length, 0, "no request is made without a contact email");
});

test("setup saves the email in the working folder; later runs use it with no flag, and the User-Agent carries it", async () => {
  const dir = tmpDir();
  const clock = fakeClock(); const err = [];
  const f = world({ hits: [] });
  const base = { fetch: f, sleep: clock.sleep, now: clock.now, stdout: () => {}, stderr: (s) => err.push(s), cwd: () => dir, env: {} };
  Object.assign(deps, base);
  await main(["setup", "--email", "seller@company.test"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "sec-funding-signals.config.json"), "utf8")), { contact_email: "seller@company.test" });
  process.exitCode = 0;
  await main(["search", "--keywords", "a", "--since", "30d"]);
  assert.equal(process.exitCode ?? 0, 0);
  assert.equal(f.calls[0].init.headers["user-agent"], "sec-funding-signals seller@company.test");
  await main(["setup", "--email", "nope"]);
  assert.equal(process.exitCode, 1); process.exitCode = 0;
  await main(["setup"]);
  assert.equal(process.exitCode, 2); process.exitCode = 0;
});

test("doctor without an email fails and makes no request; with one it checks both hosts", async () => {
  const f = world();
  const clock = fakeClock(); const out = [];
  Object.assign(deps, { fetch: f, sleep: clock.sleep, now: clock.now, stdout: (s) => out.push(s), stderr: () => {}, cwd: () => tmpDir(), env: {} });
  process.exitCode = 0;
  await main(["doctor"]);
  assert.equal(process.exitCode, 1); process.exitCode = 0;
  assert.equal(f.calls.length, 0);
  const r = await run(["doctor"], { f: world() });
  assert.equal(r.code, 0);
  const checks = r.json().rows.map((x) => [x.check, x.ok]);
  assert.deepEqual(checks, [["node", true], ["user-agent", true], ["efts.sec.gov (full-text search)", true], ["www.sec.gov (filing documents)", true]]);
});

test("show fetches one filing by cik/accession, URL, or accession alone (filer prefix as CIK, else --cik)", async () => {
  let r = await run(["show", `1234567/${A1}`]);
  assert.equal(r.json().rows[0].issuer_name, "Example Widgets, Inc.");
  r = await run(["show", "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm"]);
  assert.equal(r.json().rows[0].accession, A1);
  r = await run(["show", A1]);
  assert.equal(r.json().rows[0].cik, "1234567");
  const f = mockFetch(() => res("", { status: 404 }));
  r = await run(["show", "0009999999-26-000001"], { f });
  assert.equal(r.code, 1);
  assert.match(r.err, /--cik/);
  assert.equal((await run(["show", "garbage"])).code, 1);
});

test("profile init writes an example profile and refuses to overwrite; profile check validates", async () => {
  const dir = tmpDir();
  const path = join(dir, "profile.json");
  let r = await run(["profile", "init", "--preset", "ai-data", "--out", path]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).name, "ai-data");
  r = await run(["profile", "init", "--out", path]);
  assert.equal(r.code, 2);
  assert.match(r.err, /already exists/);
  r = await run(["profile", "init", "--preset", "nope", "--out", join(dir, "x.json")]);
  assert.equal(r.code, 2);
  r = await run(["profile", "check", path]);
  assert.equal(r.code, 0);
  assert.match(r.json().rows[0].warnings.join(), /placeholder/);
  writeFileSync(path, JSON.stringify({ keywords: [] }));
  assert.equal((await run(["profile", "check", path])).code, 2);
  assert.equal((await run(["presets"])).json().count, 2);
});

test("a profile supplies keywords, states and amounts; flags override it", async () => {
  const dir = tmpDir();
  const profile = join(dir, "p.json");
  writeFileSync(profile, JSON.stringify({ offer: "x", keywords: ["alpha", "beta"], states: ["TX"], min_amount: 3000000 }));
  let f = world({ hits: [HITS[0]] });
  let r = await run(["search", "--profile", profile, "--since", "30d"], { f, cwd: dir });
  assert.deepEqual(f.calls.filter((c) => c.url.includes("efts")).map((c) => new URL(c.url).searchParams.get("q")), ["alpha", "beta"]);
  assert.equal(r.json().count, 0, "profile min_amount applied");
  f = world({ hits: [HITS[0]] });
  r = await run(["search", "--profile", profile, "--since", "30d", "--min-amount", "1000"], { f, cwd: dir });
  assert.equal(r.json().count, 1, "flag overrides the profile");
  assert.equal(r.json().meta.profile.offer, "x");
});

test("--out-dir writes JSON, full CSV, Apollo company CSV and people CSV; annotate merges fit and drops 'no' from the Apollo files", async () => {
  const dir = tmpDir();
  const outDir = join(dir, "out");
  let r = await run(["search", "--keywords", "alpha", "--since", "30d", "--include-funds", "--out-dir", outDir, "--name", "run1"], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  const s = r.json();
  assert.deepEqual(s.counts, { full: 4, companies: 4, people: 7 });
  for (const k of ["json", "full", "companies", "people"]) assert.ok(existsSync(s.files[k]), k);

  const judgments = join(dir, "judgments.json");
  writeFileSync(judgments, JSON.stringify([
    { cik: "1234567", fit: "strong", fit_reason: "Builds the product itself", evidence: "homepage: widgets for factories", website: "https://widgets.example.com" },
    { cik: "0007654321", fit: "No", fit_reason: "Investment vehicle, not an operating company" },
  ]));
  r = await run(["annotate", "--in", s.files.json, "--judgments", judgments], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  const a = r.json();
  assert.deepEqual(a.fit_counts, { strong: 1, maybe: 0, no: 1, unjudged: 2 });
  assert.equal(a.counts.full, 4);
  assert.equal(a.counts.companies, 3, "the 'no' row leaves the Apollo company CSV");
  const full = readFileSync(s.files.full, "utf8");
  assert.match(full, /Investment vehicle, not an operating company/, "but stays in the full CSV with its reason");
  assert.match(full, /fit,fit_reason,evidence/);
  const companies = readFileSync(s.files.companies, "utf8");
  assert.doesNotMatch(companies, /Sample Opportunity Vehicle/);
  assert.match(companies, /https:\/\/widgets\.example\.com,.*strong,Builds the product itself,homepage/);
  assert.doesNotMatch(readFileSync(s.files.people, "utf8"), /Sample Opportunity Vehicle LP/);
  const json = JSON.parse(readFileSync(s.files.json, "utf8"));
  assert.equal(json.meta.left_out_of_apollo_csvs, 1);
  assert.equal(json.rows.find((x) => x.cik === "1234567").website, "https://widgets.example.com");
});

test("annotate applies nothing when any judgment is invalid", async () => {
  const dir = tmpDir();
  let r = await run(["search", "--keywords", "alpha", "--since", "30d", "--out-dir", dir, "--name", "r"], { cwd: dir });
  const file = r.json().files.json;
  const before = readFileSync(file, "utf8");
  const j = join(dir, "j.json");
  for (const [bad, msg] of [
    [[{ cik: "1234567", fit: "great", fit_reason: "x" }], /fit must be strong, maybe or no/],
    [[{ cik: "1234567", fit: "strong" }], /fit_reason is required/],
    [[{ cik: "999", fit: "strong", fit_reason: "x" }], /no matching issuer/],
    [{ nope: 1 }, /must be a JSON array/],
  ]) {
    writeFileSync(j, JSON.stringify(bad));
    r = await run(["annotate", "--in", file, "--judgments", j], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.err, msg);
  }
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal((await run(["annotate", "--in", file])).code, 2);
});
