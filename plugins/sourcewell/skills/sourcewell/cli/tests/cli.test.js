import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, deps, main, parseArgs } from "../src/cli.js";
import { createCommands, addMonths, htmlToText } from "../src/commands.js";
import { doc, fakeClock, jsonRes, mockFetch, tmpDir } from "./helpers.js";

const fx = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");

async function run(argv, handler) {
  const clock = fakeClock();
  clock.t = Date.parse("2026-10-28T12:00:00Z");
  const f = mockFetch(handler || (() => jsonRes(doc("x", []))));
  const out = []; const err = [];
  Object.assign(deps, { fetch: f, sleep: clock.sleep, now: clock.now, stdout: (s) => out.push(s), stderr: (s) => err.push(s), cacheDir: tmpDir() });
  process.exitCode = 0;
  await main(argv);
  const code = process.exitCode; process.exitCode = 0;
  return { f, out: out.join(""), err: err.join(""), code };
}

test("command list", () => {
  for (const n of ["contracts search", "contracts vendor", "solicitations list", "bids list", "rebid", "agencies list", "doctor"]) assert.ok(COMMANDS[n], n);
});

test("parseArgs handles --k v, --k=v and booleans", () => {
  const { words, flags } = parseArgs(["contracts", "search", "--q", "construction equipment", "--field=description", "--no-cache"]);
  assert.deepEqual(words, ["contracts", "search"]);
  assert.equal(flags.q, "construction equipment");
  assert.equal(flags.field, "description");
  assert.equal(flags["no-cache"], true);
});

test("contracts search builds the description filter and prints rows as JSON", async () => {
  const r = await run(["contracts", "search", "--q", "construction equipment", "--field", "description"], () => jsonRes(doc("node--contractprofile", [
    { title: "John Deere 011723-JDC", field_cp_brand_name: "John Deere", field_cp_contract_number: "011723-JDC", field_cp_end_date: "2028-04-14", field_cp_contract_description: "Heavy construction equipment" },
  ])));
  assert.equal(r.code, 0);
  const u = new URL(r.f.calls[0].url);
  assert.equal(u.searchParams.get("filter[f0][condition][path]"), "field_cp_contract_description");
  assert.equal(u.searchParams.get("filter[f0][condition][operator]"), "CONTAINS");
  assert.equal(u.searchParams.get("filter[f0][condition][value]"), "construction equipment");
  const o = JSON.parse(r.out);
  assert.equal(o.count, 1);
  assert.equal(o.rows[0].contract_number, "011723-JDC");
  assert.equal(o.rows[0].vendor, "John Deere");
});

test("--expiring-within adds a date window from today", async () => {
  const r = await run(["contracts", "search", "--expiring-within", "6"]);
  const p = new URL(r.f.calls[0].url).searchParams;
  assert.equal(p.get("filter[f0][condition][operator]"), ">=");
  assert.equal(p.get("filter[f0][condition][value]"), "2026-10-28");
  assert.equal(p.get("filter[f1][condition][operator]"), "<=");
  assert.equal(p.get("filter[f1][condition][value]"), "2027-04-28");
});

test("addMonths clamps month ends", () => {
  assert.equal(addMonths("2026-08-31", 6), "2027-02-28");
  assert.equal(addMonths("2026-10-28", 3), "2027-01-28");
});

test("agencies list --state UT --format csv", async () => {
  const r = await run(["agencies", "list", "--state", "ut", "--format", "csv"], () => jsonRes(doc("node--account", [
    { title: "Alpine School District", field_state_code: "UT", field_city: "American Fork", field_type: "Education", field_sub_type: "Public K-12", field_member_number: "12397" },
  ])));
  const p = new URL(r.f.calls[0].url).searchParams;
  assert.equal(p.get("filter[f0][condition][value]"), "UT");
  assert.equal(p.get("fields[node--account]"), "title,field_type,field_sub_type,field_city,field_state_code,field_member_status,field_website,field_member_number");
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "name,state,city,type,sub_type,member_status,website,member_number");
  assert.equal(lines[1], "Alpine School District,UT,American Fork,Education,Public K-12,,,12397");
});

test("agencies list without a filter is refused with a clear message", async () => {
  const r = await run(["agencies", "list"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--state/);
  assert.equal(r.f.calls.length, 0);
});

test("--out writes a file", async () => {
  const f = join(tmpDir(), "a.json");
  const r = await run(["states", "list", "--out", f], () => jsonRes(doc("taxonomy_term--states", [{ name: "Utah" }])));
  assert.equal(r.out, "");
  assert.equal(JSON.parse(readFileSync(f, "utf8")).rows[0].name, "Utah");
});

test("solicitations list --open filters on status", async () => {
  const r = await run(["solicitations", "list", "--open"], () => jsonRes(doc("node--competitive_solicitations", [
    { title: "Heavy and Compact\r\nConstruction", field_solicitation_bid_rfp_num: "110326", field_solicitation_process_statu: "Open" },
  ])));
  const p = new URL(r.f.calls[0].url).searchParams;
  assert.equal(p.get("filter[f0][condition][path]"), "field_solicitation_process_statu");
  assert.equal(p.get("filter[f0][condition][value]"), "Open");
  assert.equal(JSON.parse(r.out).rows[0].title, "Heavy and Compact Construction");
});

test("bids list goes through the portal", async () => {
  const r = await run(["bids", "list", "--format", "csv"], (url, init) => init.method === "GET" ? jsonRes(fx("tenders-page.html")) : jsonRes(fx("tenders-search.json")));
  assert.match(r.out, /^number,type,name,status,closing,closing_local,days_left,planned_issue,days_to_issue,plan_takers,documents,addendums,id,url\n/);
  assert.match(r.out, /110326,RFP,Heavy and Compact/);
});

test("rebid derives phrases from the solicitation title and lists holders by end date", async () => {
  const r = await run(["rebid", "110326"], (url) => {
    if (url.includes("/competitive_solicitations")) return jsonRes(doc("node--competitive_solicitations", [{ title: "Heavy and Compact Construction Equipment with Related Attachments and Services", field_solicitation_bid_rfp_num: "110326", field_solicitation_process_statu: "Open" }]));
    return jsonRes(doc("node--contractprofile", [
      { title: "Hyundai 011723-HCE", field_cp_brand_name: "Hyundai", field_cp_contract_number: "011723-HCE", field_cp_end_date: "2028-04-14", field_cp_contract_description: "Heavy and medium construction equipment" },
      { title: "New Holland 011723-CNH-2", field_cp_brand_name: "New Holland", field_cp_contract_number: "011723-CNH-2", field_cp_end_date: "2027-04-14", field_cp_contract_description: "Heavy construction equipment" },
    ]));
  });
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  assert.deepEqual(o.meta.queries, ["Heavy Equipment", "Compact Construction Equipment", "Construction Equipment"]);
  assert.deepEqual(o.rows.map((x) => x.contract_number), ["011723-CNH-2", "011723-HCE"]);
  assert.match(o.rows[0].matched_terms, /Construction Equipment/);
});

test("rebid accepts a contract number and resolves its solicitation by the six-digit prefix", async () => {
  const r = await run(["rebid", "011723-JDC"], (url) => url.includes("/competitive_solicitations")
    ? jsonRes(doc("node--competitive_solicitations", [{ title: "Heavy Construction Equipment", field_solicitation_bid_rfp_num: "011723", field_solicitation_process_statu: "Awarded" }]))
    : jsonRes(doc("node--contractprofile", [])));
  assert.equal(new URL(r.f.calls[0].url).searchParams.get("filter[f0][condition][value]"), "011723");
  assert.equal(JSON.parse(r.out).meta.status, "Awarded");
});

test("deriveQueries", () => {
  const { deriveQueries } = createCommands({});
  assert.deepEqual(deriveQueries("Scoreboards, Digital Displays, and Video Boards with Related Services"), ["Scoreboards", "Digital Displays", "Video Boards"]);
  assert.deepEqual(deriveQueries("Parking Infrastructure Operations and Management Services"), ["Parking Infrastructure Operations", "Infrastructure Operations", "Management Services"]);
});

test("htmlToText flattens the products_services field", () => {
  assert.equal(htmlToText({ value: "<p>Hi &amp; bye</p><ul><li>A</li><li>B</li></ul>" }), "Hi & bye A B");
});

test("usage errors exit 2; unknown commands and options are rejected without network", async () => {
  for (const argv of [["nope"], ["contracts", "search", "--bogus", "x"], ["contracts", "vendor"], ["bids", "list", "--limit", "abc"]]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(r.f.calls.length, 0);
  }
});

test("CLI cannot be pointed at a resource off the allowlist", async () => {
  // there is no flag that selects a resource; the only way in is the library call, which throws
  const r = await run(["contracts", "search", "--q", "x", "--field", "field_ein"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--field must be one of/);
  assert.equal(r.f.calls.length, 0);
});

test("doctor reports each check and exits 1 when one fails", async () => {
  const r = await run(["doctor"], (url) => url.includes("proportal") ? jsonRes("nope", { status: 404 }) : jsonRes(doc("taxonomy_term--states", [{ name: "Utah" }])));
  const o = JSON.parse(r.out);
  assert.equal(o.rows.find((c) => c.check === "jsonapi").ok, true);
  assert.equal(o.rows.find((c) => c.check === "bid portal").ok, false);
  assert.equal(r.code, 1);
});

test("bids list --status open --q goes to the portal; --status all is accepted", async () => {
  const r = await run(["bids", "list", "--status", "open", "--q", "construction"], (url, init) => init.method === "GET" ? jsonRes(fx("tenders-page.html")) : jsonRes(fx("tenders-search.json")));
  assert.equal(r.code, 0, r.err);
  assert.match(r.f.calls[1].url, /status=Open/);
  assert.match(r.f.calls[1].init.body, /keywords=construction/);
  assert.equal(JSON.parse(r.out).rows.find((b) => b.number === "110326").plan_takers > 0, true);
});

test("awards --year --rfp", async () => {
  const r = await run(["awards", "--year", "2023", "--rfp", "011723", "--format", "csv"], (url) => url.includes("ContractAwards") ? jsonRes(fx("contract-awards.html")) : jsonRes(fx("tenders-page.html")));
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "year,number,type,name,bidder_count,awardees,bidders");
  assert.ok(lines[1].startsWith("2023,011723,RFP,Heavy Construction Equipment"));
  assert.ok(lines[1].includes(",Komatsu America Corp.; John Deere Shared Services LLC; Caterpillar Inc,"));
});

test("bids detail prints one row", async () => {
  const search = JSON.parse(fx("tenders-search.json"));
  const r = await run(["bids", "detail", "110326"], (url, init) => url.includes("/Tender/Detail/") ? jsonRes(fx("tender-detail.html")) : init.method === "GET" ? jsonRes(fx("tenders-page.html")) : jsonRes(search));
  assert.equal(JSON.parse(r.out).rows[0].question_deadline, "Mon Oct 26, 2026 4:30:00 PM (CDT)");
});

test("docs download: credentials only from env or stdin, never flags; nothing is fetched without them", async () => {
  for (const argv of [["docs", "download", "110326", "--out", "/tmp/x", "--password", "hunter2"], ["docs", "download", "110326", "--out", "/tmp/x", "--user", "a@b.c"]]) {
    const r = await run(argv);
    assert.equal(r.code, 2);
    assert.match(r.err, /never passed on the command line/);
    assert.ok(!r.err.includes("hunter2"));
    assert.equal(r.f.calls.length, 0);
  }
  deps.env = {};
  const r = await run(["docs", "download", "110326", "--out", join(tmpDir(), "d")]);
  deps.env = process.env;
  assert.equal(r.code, 2);
  assert.match(r.err, /SOURCEWELL_USER/);
  assert.equal(r.f.calls.length, 0);
});

test("docs download: password on stdin works and is not printed", async () => {
  const search = JSON.parse(fx("tenders-search.json"));
  const zip = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(8)]);
  const handler = (url, init) => {
    if (url.endsWith("/Module/Tenders/en")) return jsonRes(fx("tenders-page.html"));
    if (url.includes("/Login/Index/") && init.method === "GET") return jsonRes(fx("login-page.html"));
    if (url.includes("/Login/Index/")) { assert.match(init.body, /Password=pw-from-stdin/); return jsonRes("", { status: 302, headers: { location: "/Module/Tenders/en/Vendor/Dashboard/v" } }); }
    if (url.includes("/Tender/Search/")) return jsonRes(search);
    if (url.includes("DownloadBidDocuments")) return { ok: true, status: 200, headers: { get: () => null, getSetCookie: () => [] }, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
    throw new Error("unexpected " + url);
  };
  deps.env = { SOURCEWELL_USER: "me@example.com" };
  deps.readStdin = async () => "pw-from-stdin\n";
  const dir = join(tmpDir(), "docs");
  const r = await run(["docs", "download", "110326", "--out", dir, "--password-stdin"], handler);
  deps.env = process.env;
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes("pw-from-stdin") && !r.err.includes("pw-from-stdin"));
  assert.match(JSON.parse(r.out).rows[0].file, /RFP-110326-documents\.zip$/);
});

test("rebid adds prior RFP awardees from the awards report", async () => {
  const r = await run(["rebid", "110326"], (url, init) => {
    if (url.includes("/competitive_solicitations")) return jsonRes(doc("node--competitive_solicitations", [{ title: "Heavy and Compact Construction Equipment with Related Attachments and Services", field_solicitation_bid_rfp_num: "110326", field_solicitation_process_statu: "Open" }]));
    if (url.includes("ContractAwards")) { assert.match(url, /year=2023$/); return jsonRes(fx("contract-awards.html")); }
    if (url.includes("proportal")) return jsonRes(fx("tenders-page.html"));
    return jsonRes(doc("node--contractprofile", [
      { title: "A 011723-AAA", field_cp_contract_number: "011723-AAA", field_cp_end_date: "2028-04-14", field_cp_brand_name: "A" },
      { title: "B 011723-BBB", field_cp_contract_number: "011723-BBB", field_cp_end_date: "2028-04-14", field_cp_brand_name: "B" },
    ]));
  });
  assert.equal(r.code, 0, r.err);
  const pa = JSON.parse(r.out).meta.prior_awards;
  assert.equal(pa[0].rfp, "011723");
  assert.deepEqual(pa[0].awardees, ["Komatsu America Corp.", "John Deere Shared Services LLC", "Caterpillar Inc"]);
});
