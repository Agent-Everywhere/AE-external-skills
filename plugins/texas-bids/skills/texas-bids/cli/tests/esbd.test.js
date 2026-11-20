import test from "node:test";
import assert from "node:assert/strict";
import { PER_PAGE, SERVICE_URL, EsbdError, fetchAll, isoToUsDate, normalizeLine, parseListResponse, search, usDateToIso } from "../src/esbd.js";
import { createHttp } from "../src/http.js";
import { esbdFetch, fakeClock, fixture, mockFetch, res } from "./helpers.js";

const mkHttp = (f) => { const c = fakeClock(); return createHttp({ fetchImpl: f, sleep: c.sleep, now: c.now }); };

test("date helpers convert between the site's US dates and ISO", () => {
  assert.equal(usDateToIso("11/7/2026"), "2026-11-07");
  assert.equal(usDateToIso("12/22/2026"), "2026-12-22");
  assert.equal(usDateToIso("11/20/2026 12:01 am"), "2026-11-20");
  assert.equal(usDateToIso(""), "");
  assert.equal(isoToUsDate("2026-01-05"), "01/05/2026");
  assert.throws(() => isoToUsDate("1/5/2026"), EsbdError);
});

test("parseListResponse reads a real open-solicitations reply", () => {
  const r = parseListResponse(fixture("open-page1.json"));
  assert.equal(r.rows.length, 6);
  assert.equal(r.total, 495);
  assert.equal(r.perPage, PER_PAGE);
  const hvac = r.rows.find((x) => x.id === "802-27-86722");
  assert.deepEqual(
    { title: hvac.title, agency: hvac.agency, agency_number: hvac.agency_number, status: hvac.status, posted: hvac.posted, due: hvac.due, due_time: hvac.due_time, internal_id: hvac.internal_id, url: hvac.url },
    { title: "Replace HVAC, Bentsen-Rio Grande Valley SP", agency: "Parks & Wildlife Department", agency_number: "802", status: "Posted", posted: "2026-11-20", due: "2026-12-07", due_time: "2:00 PM", internal_id: "578391", url: "https://www.txsmartbuy.gov/esbd/802-27-86722" },
  );
  assert.deepEqual(hvac.class_codes, ["91036-Heating, Air Conditioning, And Ventilation Maintenance And Repair Services (Including Installation)"]);
});

test("every row of every fixture has all the fields a user needs", () => {
  for (const f of ["open-page1.json", "open-fuel.json", "open-janitorial.json", "open-tank.json"]) {
    for (const row of parseListResponse(fixture(f)).rows) {
      for (const k of ["id", "title", "agency", "status", "posted", "due", "url"]) assert.ok(row[k], `${f} ${row.id} missing ${k}`);
      assert.match(row.posted, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(row.due, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test("normalizeLine keeps an agency name that does not end with its number, and encodes the url", () => {
  const row = normalizeLine({ solicitationId: "A B/1", title: " x  y ", agencyName: "Some Agency", agencyNumber: "9", statusName: "Posted", postingDate: "1/2/2026", responseDue: "1/3/2026", nigpCodes: "" });
  assert.equal(row.agency, "Some Agency");
  assert.equal(row.title, "x y");
  assert.equal(row.url, "https://www.txsmartbuy.gov/esbd/A%20B%2F1");
  assert.deepEqual(row.class_codes, []);
});

test("parseListResponse rejects a service error and a changed layout with a clear message", () => {
  assert.throws(() => parseListResponse({ errorStatusCode: "405", errorCode: "ERR_METHOD_NOT_ALLOWED", errorMessage: "no" }), /refused the request: ERR_METHOD_NOT_ALLOWED/);
  assert.throws(() => parseListResponse({ rows: [] }), /layout may have changed/);
  assert.throws(() => parseListResponse([]), /not an object/);
});

test("fetchAll pages until the reported total, asks for the open status, and sends the posting-date window", async () => {
  const page = (n) => ({ lines: Array.from({ length: n === 3 ? 2 : 24 }, (_, i) => ({ ...fixture("open-fuel.json").lines[0], internalid: `${n}-${i}`, solicitationId: `S${n}-${i}` })), page: n, recordsPerPage: 24, totalRecordsFound: 50 });
  const f = mockFetch((u, i, n, body) => res(page(body.page)));
  const r = await fetchAll({ http: mkHttp(f), keyword: "fuel", status: "open", since: "2026-11-01" });
  assert.equal(r.rows.length, 50);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].url, SERVICE_URL);
  assert.equal(f.calls[0].init.method, "POST");
  assert.deepEqual(f.calls[0].body, { keyword: "fuel", status: "1", page: 1, startDate: "11/01/2026" });
  assert.deepEqual(f.calls.map((c) => c.body.page), [1, 2, 3]);
});

test("search merges keywords with OR, de-duplicates, records which keyword matched, and sorts newest first", async () => {
  const f = esbdFetch({ fuel: fixture("open-fuel.json"), janitorial: fixture("open-janitorial.json"), tank: fixture("open-tank.json") });
  const r = await search({ http: mkHttp(f), keywords: ["Fuel", "janitorial", "tank", "janitorial"] });
  const ids = r.rows.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(r.total >= 5);
  assert.equal(f.calls.length, 3, "a repeated keyword is searched once");
  const tank = parseListResponse(fixture("open-tank.json")).rows.map((x) => x.id);
  const jan = parseListResponse(fixture("open-janitorial.json")).rows.map((x) => x.id);
  const both = tank.filter((id) => jan.includes(id));
  for (const id of both) assert.deepEqual(r.rows.find((x) => x.id === id).matched.sort(), ["janitorial", "tank"]);
  const posted = r.rows.map((x) => x.posted);
  assert.deepEqual(posted, [...posted].sort().reverse());
});

test("search filters: since, exclude words, agency include and exclude, limit", async () => {
  const f = () => esbdFetch({ janitorial: fixture("open-janitorial.json") });
  const all = await search({ http: mkHttp(f()), keywords: ["janitorial"] });
  assert.equal(all.rows.length, 3);
  const since = await search({ http: mkHttp(f()), keywords: ["janitorial"], since: "2026-11-01" });
  assert.deepEqual(since.rows.map((x) => x.id), ["FAC-01744-RFP"]);
  const ex = await search({ http: mkHttp(f()), keywords: ["janitorial"], exclude: ["seed lab"] });
  assert.equal(ex.rows.length, 2);
  const ag = await search({ http: mkHttp(f()), keywords: ["janitorial"], agencies: ["agriculture"] });
  assert.equal(ag.rows.length, 2);
  const nag = await search({ http: mkHttp(f()), keywords: ["janitorial"], excludeAgencies: ["agriculture"] });
  assert.deepEqual(nag.rows.map((x) => x.id), ["FAC-01744-RFP"]);
  const lim = await search({ http: mkHttp(f()), keywords: ["janitorial"], limit: 1 });
  assert.equal(lim.rows.length, 1);
  assert.equal(lim.total, 3);
});

test("search needs a keyword and a known status", async () => {
  await assert.rejects(search({ http: mkHttp(esbdFetch({})), keywords: [" "] }), /at least one keyword/);
  await assert.rejects(search({ http: mkHttp(esbdFetch({})), keywords: ["a"], status: "bogus" }), /unknown status/);
});

test("status all searches every status code", async () => {
  const f = esbdFetch({});
  await search({ http: mkHttp(f), keywords: ["a"], status: "all" });
  assert.deepEqual(f.calls.map((c) => c.body.status).sort(), ["1", "11", "2", "3", "5"]);
});

test("the detail URL percent-encodes ( ) ' so a markdown link around it cannot break", () => {
  const row = normalizeLine({ solicitationId: "RFP (2026)'s!*", title: "t", agencyName: "a", agencyNumber: "1", statusName: "Posted", postingDate: "1/2/2026", responseDue: "1/3/2026", nigpCodes: "" });
  assert.equal(row.url, "https://www.txsmartbuy.gov/esbd/RFP%20%282026%29%27s%21%2A");
  assert.doesNotMatch(row.url, /[()'!*]/);
});
