import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_COLUMNS, FULL_COLUMNS, PEOPLE_COLUMNS, companyNotes, companyRows, emit, peopleRows, render, toCsv, writeOutputs } from "../src/output.js";
import { tmpDir } from "./helpers.js";

const row = (o = {}) => ({
  issuer_name: "Example Widgets, Inc.", cik: "1234567", state: "TX", city: "AUSTIN", industry_group: "Other Technology", form: "D", is_amendment: false,
  filing_date: "2026-10-01", date_of_first_sale: "2026-09-15", raise_amount: 2500000, raise_amount_basis: "sold", total_offering_amount: 5000000, website: "",
  filing_url: "https://www.sec.gov/x-index.htm", accession: "0001234567-26-000001", matched_keywords: ["robot*"], filing_count: 1,
  related_persons: [{ first_name: "PAT", last_name: "SAMPLE", relationships: ["Executive Officer", "Director"], clarification: "Chief Executive Officer" }, { first_name: "Jordan", last_name: "Example", relationships: ["Director"], clarification: "" }],
  signer: { name: "Pat Sample", title: "CEO" }, filtered_reason: null, ...o,
});

test("CSV quotes, joins arrays and blanks nulls", () => {
  assert.equal(toCsv([{ a: "x,y", b: 'say "hi"', d: ["p", "q"], e: null }]), 'a,b,d,e\n"x,y","say ""hi""",p; q,\n');
});

test("spreadsheet formula characters are neutralised, plain negatives and numbers are not", () => {
  const csv = toCsv([{ a: "=HYPERLINK(1)", b: "+1 Robotics", c: "@x", d: "-cmd", e: "-5", f: 7 }]);
  assert.equal(csv, "a,b,c,d,e,f\n'=HYPERLINK(1),'+1 Robotics,'@x,'-cmd,-5,7\n");
});

test("JSON output has count, meta and rows; csv is the full table with fit columns", () => {
  const o = JSON.parse(render({ rows: [row()], meta: { m: 1 } }));
  assert.deepEqual(Object.keys(o), ["count", "meta", "rows"]);
  const csv = render({ rows: [row()] }, "csv").split("\n")[0].split(",");
  assert.deepEqual(csv, FULL_COLUMNS);
  for (const c of ["fit", "fit_reason", "evidence", "filtered_reason"]) assert.ok(csv.includes(c), c);
  assert.throws(() => render({ rows: [] }, "xml"));
});

test("csv of non-filing rows (doctor, presets) uses their own columns", () => {
  assert.equal(render({ rows: [{ check: "node", ok: true }] }, "csv"), "check,ok\nnode,true\n");
});

test("Apollo company rows: Company Name and Website first, raise facts, notes, and EDGAR link", () => {
  assert.deepEqual(COMPANY_COLUMNS.slice(0, 2), ["Company Name", "Website"]);
  const [c] = companyRows([row({ website: "https://widgets.example.com" })]);
  assert.equal(c["Company Name"], "Example Widgets, Inc.");
  assert.equal(c.Website, "https://widgets.example.com");
  assert.equal(c["Raise Amount (USD)"], 2500000);
  assert.equal(c["Raise Date"], "2026-09-15");
  assert.match(c.Notes, /\$2,500,000 sold of a \$5,000,000 offering; first sale 2026-09-15; SEC Form D new filing filed 2026-10-01/);
});

test("notes say so when the amount is undisclosed or only the offering size is known", () => {
  assert.match(companyNotes(row({ raise_amount: null, raise_amount_basis: null, total_offering_amount: null })), /^Raise amount not disclosed/);
  assert.match(companyNotes(row({ raise_amount: 1000000, raise_amount_basis: "offering", total_offering_amount: 1000000, is_amendment: true })), /^Offering of \$1,000,000 \(amount sold not reported\).*amendment/);
});

test("rows judged fit 'no' leave the Apollo company and people CSVs but stay in the full CSV", () => {
  const rows = [row({ fit: "strong", fit_reason: "builds it" }), row({ issuer_name: "Other Co", cik: "2", fit: "no", fit_reason: "services firm" }), row({ issuer_name: "Unjudged Co", cik: "3" })];
  assert.deepEqual(companyRows(rows).map((r) => r["Company Name"]), ["Example Widgets, Inc.", "Unjudged Co"]);
  assert.ok(!peopleRows(rows).some((p) => p["Company Name"] === "Other Co"));
  const full = render({ rows }, "csv");
  assert.match(full, /Other Co/);
  assert.match(full, /services firm/);
  assert.equal(companyRows(rows)[0].Fit, "strong");
});

test("people rows: first, last, title, relationship, company; names are title-cased; signer added once; no addresses", () => {
  assert.deepEqual(PEOPLE_COLUMNS.slice(0, 5), ["First Name", "Last Name", "Title", "Relationship", "Company Name"]);
  const people = peopleRows([row()]);
  assert.deepEqual(people.map((p) => [p["First Name"], p["Last Name"], p.Title, p.Relationship, p.Source]), [
    ["Pat", "Sample", "Chief Executive Officer", "Executive Officer / Director", "related person"],
    ["Jordan", "Example", "Director", "Director", "related person"],
  ]);
  const other = peopleRows([row({ related_persons: [], signer: { name: "Sam Q Signer", title: "Founder" } })]);
  assert.deepEqual([other[0]["First Name"], other[0]["Last Name"], other[0].Title, other[0].Source], ["Sam", "Q Signer", "Founder", "signer"]);
});

test("a signer who is also a related person fills in a missing title instead of duplicating", () => {
  const people = peopleRows([row({ related_persons: [{ first_name: "Sam", last_name: "Signer", relationships: [], clarification: "" }], signer: { name: "Sam Signer", title: "President" } })]);
  assert.equal(people.length, 1);
  assert.equal(people[0].Title, "President");
});

test("writeOutputs writes the JSON, full, Apollo-companies and people files", async () => {
  const dir = tmpDir();
  const { files, counts } = await writeOutputs(dir, "run", { rows: [row()], meta: {} });
  assert.deepEqual(counts, { full: 1, companies: 1, people: 2 });
  assert.equal(JSON.parse(readFileSync(files.json, "utf8")).count, 1);
  assert.match(readFileSync(files.companies, "utf8"), /^Company Name,Website,/);
  assert.match(readFileSync(files.people, "utf8"), /^First Name,Last Name,Title,/);
  assert.ok(files.full.endsWith("run-full.csv") && files.people.startsWith(dir));
});

test("--out writes a file and reports on stderr, not stdout", async () => {
  const f = join(tmpDir(), "o.json");
  let stdout = "";
  const note = await emit({ rows: [row()] }, { format: "json", out: f, stdout: (s) => { stdout += s; } });
  assert.equal(stdout, "");
  assert.match(note, /wrote 1 rows/);
});
