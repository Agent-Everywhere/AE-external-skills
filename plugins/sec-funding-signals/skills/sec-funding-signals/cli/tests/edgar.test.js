import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl, docUrl, fetchFiling, filingUrl, keywordQuery, normalizeWebsite, parseAmount, parseFilingRef, parseFormD, parseHit, parseSince, searchFilings } from "../src/edgar.js";
import { createHttp } from "../src/http.js";
import { existsSync, readdirSync } from "node:fs";
import { fakeClock, fixture, hit, mockFetch, res, searchPage, tmpDir } from "./helpers.js";

test("parseSince: dates, days, weeks and calendar months", () => {
  assert.equal(parseSince("2026-01-15", "2026-11-05"), "2026-01-15");
  assert.equal(parseSince("30d", "2026-11-05"), "2026-10-06");
  assert.equal(parseSince("2w", "2026-11-05"), "2026-10-22");
  assert.equal(parseSince("6m", "2026-11-05"), "2026-05-05");
  assert.equal(parseSince("1m", "2026-03-31"), "2026-02-28");
  for (const bad of ["", "soon", "30", "2026-13-45", "-5d"]) assert.throws(() => parseSince(bad, "2026-11-05"), /--since|invalid/, bad);
});

test("keywordQuery quotes phrases, leaves single words and wildcards alone", () => {
  assert.equal(keywordQuery("embodied AI"), '"embodied AI"');
  assert.equal(keywordQuery("robot*"), "robot*");
  assert.equal(keywordQuery('"exact phrase"'), '"exact phrase"');
});

test("search URL asks for Form D in a custom date range", () => {
  const u = new URL(buildSearchUrl({ q: '"a b"', startdt: "2026-01-01", enddt: "2026-02-01", from: 100 }));
  assert.equal(u.hostname, "efts.sec.gov");
  assert.equal(u.searchParams.get("forms"), "D");
  assert.equal(u.searchParams.get("dateRange"), "custom");
  assert.equal(u.searchParams.get("startdt"), "2026-01-01");
  assert.equal(u.searchParams.get("from"), "100");
});

test("URLs and filing references", () => {
  assert.equal(docUrl("0001234567", "0001234567-26-000001"), "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/primary_doc.xml");
  assert.equal(filingUrl("1234567", "0001234567-26-000001"), "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm");
  assert.deepEqual(parseFilingRef("1234567/0001234567-26-000001"), { cik: "1234567", accession: "0001234567-26-000001" });
  assert.deepEqual(parseFilingRef("https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm"), { cik: "1234567", accession: "0001234567-26-000001" });
  assert.equal(parseFilingRef("0001234567-26-000001"), null);
});

test("parseHit strips the CIK from the display name and zero-pads off the CIK", () => {
  const h = parseHit(hit("0001234567-26-000001", 1234567, "Example Widgets, Inc."));
  assert.equal(h.name, "Example Widgets, Inc.");
  assert.equal(h.cik, "1234567");
  assert.equal(h.accession, "0001234567-26-000001");
  assert.equal(h.filing_date, "2026-10-20");
});

test("parseAmount: numbers parse, 'Indefinite', blanks and zero are unusable", () => {
  assert.equal(parseAmount("2500000"), 2500000);
  assert.equal(parseAmount("$1,000"), 1000);
  for (const v of ["Indefinite", "", "0", undefined]) assert.equal(parseAmount(v), null);
});

test("parseFormD extracts the issuer, offering, amounts, dates, people and signer", () => {
  const r = parseFormD(fixture("form-d-operating.xml"), { accession: "0001234567-26-000001" });
  assert.equal(r.cik, "1234567");
  assert.equal(r.issuer_name, "Example Widgets, Inc.");
  assert.equal(r.form, "D");
  assert.equal(r.is_amendment, false);
  assert.equal(r.state, "TX");
  assert.equal(r.city, "AUSTIN");
  assert.equal(r.industry_group, "Other Technology");
  assert.equal(r.total_offering_amount, 5000000);
  assert.equal(r.total_amount_sold, 2500000);
  assert.equal(r.raise_amount, 2500000);
  assert.equal(r.raise_amount_basis, "sold");
  assert.equal(r.date_of_first_sale, "2026-09-15");
  assert.equal(r.year_of_inc, "2024");
  assert.equal(r.investors_count, "12");
  assert.deepEqual(r.securities, ["Equity", "Option"]);
  assert.equal(r.website, "https://widgets.example.com");
  assert.equal(r.related_persons.length, 2);
  assert.deepEqual(r.related_persons[0], { first_name: "PAT", middle_name: "", last_name: "SAMPLE", relationships: ["Executive Officer", "Director"], clarification: "Chief Executive Officer" });
  assert.deepEqual(r.related_persons[1].relationships, ["Director"]);
  assert.deepEqual(r.signer, { name: "Pat Sample", title: "CEO", date: "2026-09-28" });
  assert.ok(!JSON.stringify(r).includes("SAMPLE WAY"), "street addresses are not kept");
});

test("parseFormD: amendments, undisclosed amounts and a first sale that has not happened", () => {
  const r = parseFormD(fixture("form-d-undisclosed.xml"), { accession: "0001234567-26-000002" });
  assert.equal(r.form, "D/A");
  assert.equal(r.is_amendment, true);
  assert.equal(r.total_offering_amount, null);
  assert.equal(r.total_offering_text, "Indefinite");
  assert.equal(r.raise_amount, null);
  assert.equal(r.raise_amount_basis, null);
  assert.equal(r.first_sale_yet_to_occur, true);
  assert.equal(r.date_of_first_sale, "");
  assert.equal(r.website, "");
});

test("parseFormD: fund filings carry their industry group and fund type", () => {
  const r = parseFormD(fixture("form-d-fund.xml"), { accession: "0007654321-26-000001" });
  assert.equal(r.industry_group, "Pooled Investment Fund");
  assert.equal(r.investment_fund_type, "Venture Capital Fund");
  assert.equal(r.year_of_inc, "over five years ago");
});

test("searchFilings pages through results, unions by accession and records matched keywords", async () => {
  const clock = fakeClock();
  const page1 = Array.from({ length: 3 }, (_, i) => hit(`0001000000-26-00000${i}`, 1000 + i, `Co ${i}`));
  const f = mockFetch((u) => {
    const p = new URL(u).searchParams;
    const q = p.get("q"); const from = Number(p.get("from") || 0);
    if (q === "alpha") return res(searchPage(from === 0 ? page1.slice(0, 2) : page1.slice(2), 3));
    if (q === '"beta gamma"') return res(searchPage([page1[0]], 1));
    return res(searchPage([]));
  });
  const http = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now });
  const { hits, perKeyword } = await searchFilings(http, { keywords: ["alpha", "beta gamma"], startdt: "2026-01-01", enddt: "2026-02-01" });
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.find((h) => h.cik === "1000").matched_keywords, ["alpha", "beta gamma"]);
  assert.deepEqual(perKeyword.map((k) => [k.keyword, k.total, k.fetched, k.capped]), [["alpha", 3, 3, false], ["beta gamma", 1, 1, false]]);
  assert.equal(f.calls.length, 3);
});

test("a keyword over the cap splits the date range in halves until every window fits, so nothing is silently dropped", async () => {
  const clock = fakeClock();
  const f = mockFetch((u) => {
    const p = new URL(u).searchParams;
    const a = p.get("startdt"); const b = p.get("enddt");
    const span = (Date.parse(b) - Date.parse(a)) / 86400000;
    if (span >= 2) return res(searchPage(p.get("from") ? [] : [hit(`0001000000-26-${a.replace(/-/g, "").slice(2)}`, 1, `Co ${a}`)], 50));
    return res(searchPage([hit(`0002000000-26-${a.replace(/-/g, "").slice(2)}`, 2, `Day ${a}`), hit(`0003000000-26-${a.replace(/-/g, "").slice(2)}`, 3, `Day2 ${a}`)], 2));
  });
  const http = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now });
  const { hits, perKeyword } = await searchFilings(http, { keywords: ["x"], startdt: "2026-01-01", enddt: "2026-01-08", maxPerKeyword: 5 });
  assert.equal(perKeyword[0].capped, false);
  assert.ok(perKeyword[0].windows > 1);
  assert.ok(hits.length >= 8, `windows were searched separately: ${hits.length} hits`);
  const dates = f.calls.map((c) => new URL(c.url).searchParams.get("startdt"));
  assert.ok(dates.includes("2026-01-01"));
});

test("a single day that still exceeds the cap is reported as capped", async () => {
  const clock = fakeClock();
  const f = mockFetch((u) => res(searchPage(new URL(u).searchParams.get("from") ? [] : [hit("0001000000-26-000001", 1, "A")], 500)));
  const http = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now });
  const { perKeyword } = await searchFilings(http, { keywords: ["x"], startdt: "2026-01-01", enddt: "2026-01-01", maxPerKeyword: 2 });
  assert.equal(perKeyword[0].capped, true);
});

test("a non-Form-D page served with 200 is never cached, and a bad cached entry is refetched", async () => {
  const clock = fakeClock();
  const dir = tmpDir();
  let body = "<html>Request rate threshold exceeded</html>";
  const f = mockFetch(() => res(body));
  const http = createHttp({ email: "a@b.co", fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: dir });
  await assert.rejects(() => fetchFiling(http, { cik: "1234567", accession: "0001234567-26-000001" }), /not a Form D document/);
  assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0, "nothing cached");
  body = fixture("form-d-operating.xml");
  const row = await fetchFiling(http, { cik: "1234567", accession: "0001234567-26-000001" });
  assert.equal(row.issuer_name, "Example Widgets, Inc.");
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(files.every((x) => !x.endsWith(".tmp")), "cache files are written atomically");
  await fetchFiling(http, { cik: "1234567", accession: "0001234567-26-000001" });
  assert.equal(f.calls.length, 2, "second read came from the cache");
});

test("an invalid numeric entity does not crash the parser", () => {
  const r = parseFormD(fixture("form-d-operating.xml").replace("Example Widgets, Inc.", "Bad &#99999999999; Entity &#xD800; Co").replace("Example Widgets, Inc.", "x"), { accession: "a" });
  assert.equal(r.issuer_name, "Bad Entity Co");
});

test("website: only a bare domain or a site root is kept; paths and queries are not", () => {
  assert.equal(normalizeWebsite("https://example.com"), "https://example.com");
  assert.equal(normalizeWebsite("https://example.com/"), "https://example.com");
  assert.equal(normalizeWebsite("www.example.com"), "www.example.com");
  assert.equal(normalizeWebsite("example.com"), "example.com");
  for (const bad of ["https://example.com/news", "https://example.com/?a=1", "https://example.com/#x", "https://localhost", "not a url", ""]) assert.equal(normalizeWebsite(bad), "", bad);
  const xml = fixture("form-d-operating.xml").replace("https://widgets.example.com", "https://widgets.example.com/press/2026");
  assert.equal(parseFormD(xml, { accession: "a" }).website, "");
});
