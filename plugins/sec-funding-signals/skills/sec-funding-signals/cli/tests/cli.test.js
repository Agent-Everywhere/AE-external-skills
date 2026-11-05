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
    if (url.hostname === "efts.sec.gov") return over.search ? over.search(url) : res(searchPage(over.hits || HITS));
    const acc = /\/(\d{10})(\d{2})(\d{6})\/primary_doc\.xml$/.exec(url.pathname);
    const key = `${acc[1]}-${acc[2]}-${acc[3]}`;
    if (over.fail && over.fail.includes(key)) return res("", { status: over.failStatus || 404 });
    if (over.doc) { const d = over.doc(key); if (d !== undefined) return res(d); }
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
  const { words, flags } = parseArgs(["search", "--keywords", "a,b", "--since=60d", "--include-funds"]);
  assert.deepEqual(words, ["search"]);
  assert.equal(flags.keywords, "a,b");
  assert.equal(flags.since, "60d");
  assert.equal(flags["include-funds"], true);
});

test("default search: operating companies only, funds/SPVs/exclusions dropped before fetching, deduped by CIK, latest filing wins", async () => {
  const dir = tmpDir();
  const profile = join(dir, "p.json");
  writeFileSync(profile, JSON.stringify({ offer: "x", keywords: ["alpha"], excludes: { terms: [], companies: ["Acme"] } }));
  const r = await run(["search", "--profile", profile, "--since", "60d"], { cwd: dir });
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
  assert.equal(row.raise_amount, 2500000, "the later amendment reports no amount: the original's is kept");
  assert.equal(row.raise_amount_basis, "sold");
  assert.equal(row.amount_from, A1);
  assert.equal(row.date_of_first_sale, "2026-09-15");
  assert.equal(row.first_sale_age_days, 51);
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
  const r = await run(["search", "--profile", profile, "--since", "60d", "--include-funds"], { cwd: dir });
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
  const r = await run(["search", "--keywords", "ai-data", "--since", "60d"], { f });
  assert.equal(r.code, 0, r.err);
  const qs = f.calls.map((c) => new URL(c.url).searchParams.get("q"));
  assert.deepEqual(qs, ['"AI training data"', '"data annotation"', '"LLM evaluation"', '"vertical AI"', '"foundation model"']);
  assert.equal(r.json().count, 0);
});

test("amount filters: below min and above max are dropped; undisclosed amounts need --include-unknown-amount", async () => {
  const amendmentOnly = () => world({ hits: [HITS[1]] });
  let r = await run(["search", "--keywords", "alpha", "--since", "60d", "--min-amount", "1000000"], { f: amendmentOnly() });
  assert.equal(r.json().count, 0);
  assert.equal(r.json().meta.filtered.unknown_amount, 1);
  r = await run(["search", "--keywords", "alpha", "--since", "60d", "--min-amount", "1000000", "--include-unknown-amount"], { f: amendmentOnly() });
  assert.equal(r.json().count, 1);
  const both = () => world({ hits: [HITS[0], HITS[1]] });
  r = await run(["search", "--keywords", "alpha", "--since", "60d", "--min-amount", "1000000"], { f: both() });
  assert.equal(r.json().count, 1, "a later amendment does not hide the amount the original disclosed");
  const single = () => world({ hits: [HITS[0]] });
  assert.equal((await run(["search", "--keywords", "alpha", "--since", "60d", "--min-amount", "$2,000,000"], { f: single() })).json().count, 1);
  r = await run(["search", "--keywords", "alpha", "--since", "60d", "--min-amount", "3000000"], { f: single() });
  assert.equal(r.json().count, 0);
  assert.equal(r.json().meta.filtered.below_min_amount, 1);
  r = await run(["search", "--keywords", "alpha", "--since", "60d", "--max-amount", "1000000"], { f: single() });
  assert.equal(r.json().meta.filtered.above_max_amount, 1);
});

test("only just-raised offerings by default: an amendment whose first sale predates the window is dropped; --include-old-offerings keeps it", async () => {
  const old = (key) => (key === A2 ? fixture("form-d-undisclosed.xml").replace("<yetToOccur>true</yetToOccur>", "<value>2024-12-20</value>").replace("<totalAmountSold>0<", "<totalAmountSold>900000<") : undefined);
  let r = await run(["search", "--keywords", "alpha", "--since", "30d"], { f: world({ hits: [HITS[1]], doc: old }) });
  assert.equal(r.json().count, 0);
  assert.equal(r.json().meta.filtered.old_offering, 1);
  assert.match(r.json().meta.filtered_examples[0].reason, /amendment of an older offering \(first sale 2024-12-20/);
  assert.equal(r.json().meta.new_offerings_only, true);
  r = await run(["search", "--keywords", "alpha", "--since", "30d", "--include-old-offerings"], { f: world({ hits: [HITS[1]], doc: old }) });
  assert.equal(r.json().count, 1);
  assert.equal(r.json().rows[0].first_sale_age_days, 685);
  // a new filing (not an amendment) is never dropped on first-sale age
  r = await run(["search", "--keywords", "alpha", "--since", "10d"], { f: world({ hits: [HITS[0]] }) });
  assert.equal(r.json().count, 1);
});

test("--states filters on the filing's issuer state only; the search hit's business state never drops a filing before it is read", async () => {
  const f = world();
  const r = await run(["search", "--keywords", "alpha", "--since", "60d", "--states", "ca,ny", "--include-funds"], { f });
  const names = r.json().rows.map((x) => x.issuer_name).sort();
  assert.deepEqual(names, ["Sample Opportunity Vehicle LP", "Widget Robotics SPV I LLC"]);
  assert.ok(r.json().meta.filtered.state >= 1);
  assert.equal(docCalls(f), 5, "every filing is fetched and judged on its own state");
  // Acme's search hit says CA but its filing says TX: --states tx keeps it, --states ca drops it
  const acme = () => world({ hits: [HITS[4]] });
  assert.equal((await run(["search", "--keywords", "alpha", "--since", "60d", "--states", "tx"], { f: acme() })).json().count, 1);
  assert.equal((await run(["search", "--keywords", "alpha", "--since", "60d", "--states", "ca"], { f: acme() })).json().count, 0);
  const bad = await run(["search", "--keywords", "alpha", "--since", "60d", "--states", "California"]);
  assert.equal(bad.code, 2);
});

test("a state drop never overwrites the reason an issuer was already dropped for", async () => {
  const r = await run(["search", "--keywords", "alpha", "--since", "60d", "--states", "tx"]);
  const ex = Object.fromEntries(r.json().meta.filtered_examples.map((e) => [e.issuer, e.reason]));
  assert.match(ex["Sample Opportunity Vehicle LP"], /^fund:/);
});

test("--sample keeps the newest N issuers; --limit trims rows", async () => {
  const r = await run(["search", "--keywords", "alpha", "--since", "60d", "--include-funds", "--sample", "2"]);
  const o = r.json();
  assert.equal(o.count, 2);
  assert.equal(o.meta.sample, 2);
  assert.equal((await run(["search", "--keywords", "alpha", "--since", "60d", "--include-funds", "--limit", "1"])).json().count, 1);
});

test("a filing that cannot be fetched makes the run PARTIAL: reported, exit code 3, other rows still returned", async () => {
  const r = await run(["search", "--keywords", "alpha", "--since", "60d"], { f: world({ fail: [FUND] }) });
  assert.equal(r.code, 3);
  assert.match(r.err, /PARTIAL/);
  const o = r.json();
  assert.equal(o.meta.complete, false);
  assert.equal(o.meta.fetch_errors[0].accession, FUND);
  assert.equal(o.count, 2);
});

test("search needs keywords, --since and a contact email", async () => {
  assert.equal((await run(["search", "--since", "60d"])).code, 2);
  assert.equal((await run(["search", "--keywords", "a"])).code, 2);
  const f = world();
  const clock = fakeClock(); const err = [];
  Object.assign(deps, { fetch: f, sleep: clock.sleep, now: clock.now, stdout: () => {}, stderr: (s) => err.push(s), cwd: () => tmpDir(), env: {} });
  process.exitCode = 0;
  await main(["search", "--keywords", "a", "--since", "60d"]);
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
  await main(["search", "--keywords", "a", "--since", "60d"]);
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
  let r = await run(["search", "--profile", profile, "--since", "60d"], { f, cwd: dir });
  assert.deepEqual(f.calls.filter((c) => c.url.includes("efts")).map((c) => new URL(c.url).searchParams.get("q")), ["alpha", "beta"]);
  assert.equal(r.json().count, 0, "profile min_amount applied");
  f = world({ hits: [HITS[0]] });
  r = await run(["search", "--profile", profile, "--since", "60d", "--min-amount", "1000"], { f, cwd: dir });
  assert.equal(r.json().count, 1, "flag overrides the profile");
  assert.equal(r.json().meta.profile.offer, "x");
});

test("--out-dir writes JSON, full CSV, Apollo company CSV and people CSV; annotate merges fit and drops 'no' from the Apollo files", async () => {
  const dir = tmpDir();
  const outDir = join(dir, "out");
  let r = await run(["search", "--keywords", "alpha", "--since", "60d", "--include-funds", "--out-dir", outDir, "--name", "run1"], { cwd: dir });
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
  let r = await run(["search", "--keywords", "alpha", "--since", "60d", "--out-dir", dir, "--name", "r"], { cwd: dir });
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

const opHits = (n) => Array.from({ length: n }, (_, i) => hit(`000000${1000 + i}-26-000001`, 1000 + i, `Op Co ${i}`, { date: `2026-10-${String(20 - i).padStart(2, "0")}`, state: "TX" }));
const opDoc = (key) => fixture("form-d-operating.xml").replace("0001234567", key.slice(0, 10)).replace(/Example Widgets, Inc\./g, `Op Co ${Number(key.slice(6, 10)) - 1000}`);

test("--sample stops fetching as soon as N operating rows are collected", async () => {
  const f = world({ hits: opHits(8), doc: opDoc });
  const r = await run(["search", "--keywords", "alpha", "--since", "60d", "--sample", "3"], { f });
  assert.equal(r.json().count, 3);
  assert.equal(docCalls(f), 3);
  assert.equal(r.json().meta.sample_stopped_early, true);
  const all = world({ hits: opHits(8), doc: opDoc });
  assert.equal((await run(["search", "--keywords", "alpha", "--since", "60d"], { f: all })).json().count, 8);
  assert.equal(docCalls(all), 8);
});

test("circuit breaker: three refusals in a row stop the run with a clear message instead of hammering the SEC", async () => {
  const f = world({ hits: opHits(8), fail: opHits(8).map((h) => h._id.split(":")[0]), failStatus: 403 });
  const r = await run(["search", "--keywords", "alpha", "--since", "60d"], { f });
  assert.equal(r.code, 1);
  assert.match(r.err, /refused 3 requests in a row \(HTTP 403\).*contact email/);
  assert.equal(docCalls(f), 3);
});

test("every request carries a timeout signal", async () => {
  const f = world({ hits: [] });
  await run(["search", "--keywords", "alpha", "--since", "60d"], { f });
  assert.ok(f.calls.every((c) => c.init.signal), "AbortSignal.timeout on each fetch");
});

test("a keyword over the cap splits the date range into windows; one still capped on a single day makes the run PARTIAL (exit 3)", async () => {
  const f = world({ search: (url) => {
    const p = url.searchParams;
    if (p.get("from")) return res(searchPage([], 500));
    return res(searchPage([hit(`0001000000-26-${p.get("startdt").replace(/-/g, "").slice(2)}`, 5, "X Fund", { date: p.get("startdt") })], 500));
  } });
  const r = await run(["search", "--keywords", "alpha", "--since", "2026-11-02"], { f });
  assert.equal(r.code, 3);
  assert.match(r.err, /still capped.*PARTIAL/);
  const o = r.json();
  assert.equal(o.meta.complete, false);
  assert.deepEqual(o.meta.capped, ["alpha"]);
  assert.ok(o.meta.per_keyword[0].windows > 1);
});

test("--until must be a date; an unreadable keywords file is a usage error", async () => {
  assert.equal((await run(["search", "--keywords", "a", "--since", "60d", "--until", "tomorrow"])).code, 2);
  assert.equal((await run(["search", "--keywords-file", "/nonexistent/kw.txt", "--since", "60d"])).code, 2);
  assert.equal((await run(["search", "--keywords", "./nope.txt", "--since", "60d"])).code, 2);
});

test("annotate on a file whose rows lack issuer_name is a clean error, not a TypeError", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "r.json"), JSON.stringify({ rows: [{ cik: "1" }] }));
  writeFileSync(join(dir, "j.json"), "[]");
  const r = await run(["annotate", "--in", join(dir, "r.json"), "--judgments", join(dir, "j.json")]);
  assert.equal(r.code, 2);
  assert.match(r.err, /row 1 has no issuer_name/);
});
