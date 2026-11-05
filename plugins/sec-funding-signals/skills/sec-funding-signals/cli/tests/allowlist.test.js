import test from "node:test";
import assert from "node:assert/strict";
import { AllowlistError, HOSTS, assertAllowed } from "../src/allowlist.js";
import { buildSearchUrl, docUrl } from "../src/edgar.js";

test("allowlist is exactly the two SEC hosts", () => {
  assert.deepEqual([...HOSTS].sort(), ["efts.sec.gov", "www.sec.gov"]);
});

test("the URLs this CLI builds pass", () => {
  assertAllowed(buildSearchUrl({ q: '"humanoid"', startdt: "2026-01-01", enddt: "2026-02-01", from: 100 }));
  assertAllowed(buildSearchUrl({ startdt: "2026-01-01", enddt: "2026-02-01" }));
  assertAllowed(docUrl("0001234567", "0001234567-26-000001"));
});

test("other hosts, schemes, paths, params and credentials are refused before any request", () => {
  for (const u of [
    "http://efts.sec.gov/LATEST/search-index?q=x",
    "https://example.com/LATEST/search-index?q=x",
    "https://data.sec.gov/submissions/CIK0001234567.json",
    "https://efts.sec.gov/LATEST/other",
    "https://efts.sec.gov/LATEST/search-index?q=x&evil=1",
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany",
    "https://www.sec.gov/Archives/edgar/data/1/000123456726000001/other.xml",
    "https://www.sec.gov/Archives/edgar/data/1/000123456726000001/primary_doc.xml?x=1",
    "https://www.sec.gov:8443/Archives/edgar/data/1/000123456726000001/primary_doc.xml",
    "https://user:pw@www.sec.gov/Archives/edgar/data/1/000123456726000001/primary_doc.xml",
    "https://efts.sec.gov.evil.com/LATEST/search-index",
    "not a url",
  ]) assert.throws(() => assertAllowed(u), AllowlistError, u);
});
