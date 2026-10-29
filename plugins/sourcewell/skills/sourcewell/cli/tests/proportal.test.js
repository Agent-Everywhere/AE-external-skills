import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttp } from "../src/http.js";
import { createPortal, parseAwards, parseBids, parseDetail, parseLoginForm, parseMsDate, parseTendersPage, parseTitle } from "../src/proportal.js";
import { AllowlistError, assertPortalRequest } from "../src/allowlist.js";
import { readdirSync } from "node:fs";
import { fakeClock, jsonRes, mockFetch, tmpDir } from "./helpers.js";

const fx = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", n), "utf8");

test("parseTendersPage takes the grid token (not the logout-form token) and the node id", () => {
  const { nodeId, token } = parseTendersPage(fx("tenders-page.html"));
  assert.equal(nodeId, "42b90b89-9f67-483a-96e3-9b0490d01d40");
  assert.equal(token, "FIXTURE-GRID-TOKEN");
});

test("parseTendersPage tolerates attribute order and fails loudly if the page changes", () => {
  const html = `<input id='NodeId' value='42b90b89-9f67-483a-96e3-9b0490d01d40'><div id="bidDetailAntiForgery"><input value="T2" type="hidden" name="__RequestVerificationToken"></div>`;
  assert.equal(parseTendersPage(html).token, "T2");
  assert.throws(() => parseTendersPage("<html></html>"), /node id not found/);
  assert.throws(() => parseTendersPage(`<input id="NodeId" value="42b90b89-9f67-483a-96e3-9b0490d01d40">`), /token not found/);
});

test("parseTitle and parseMsDate", () => {
  assert.deepEqual(parseTitle("RFP 110326 - Heavy and Compact Construction Equipment"), { type: "RFP", number: "110326", name: "Heavy and Compact Construction Equipment" });
  assert.deepEqual(parseTitle("IFB CO-102926 - Indefinite Delivery - Colorado"), { type: "IFB", number: "CO-102926", name: "Indefinite Delivery - Colorado" });
  assert.deepEqual(parseTitle("Something else"), { type: "", number: "", name: "Something else" });
  assert.equal(parseMsDate("/Date(1793302200000)/"), "2026-10-29T19:30:00.000Z");
  assert.equal(parseMsDate(null), null);
});

test("parseBids maps the saved fixture: name, status, closing date, days left, detail link", () => {
  const rows = parseBids(JSON.parse(fx("tenders-search.json")));
  assert.equal(rows.length, 8);
  const r = rows.find((x) => x.number === "110326");
  assert.equal(r.type, "RFP");
  assert.match(r.name, /^Heavy and Compact Construction Equipment/);
  assert.equal(r.status, "Open");
  assert.equal(r.closing_local, "Tue Nov 3, 2026 3:30:00 PM");
  assert.equal(r.days_left, 5);
  assert.match(r.url, /^https:\/\/proportal\.sourcewell-mn\.gov\/Module\/Tenders\/en\/Tender\/Detail\/[0-9a-f-]{36}$/);
  assert.equal(r.description, undefined);
  assert.ok(parseBids(JSON.parse(fx("tenders-search.json")), { full: true })[0].description.length > 10);
  assert.throws(() => parseBids({ success: false }), /unexpected/);
});

function portalWith(handler) {
  const clock = fakeClock();
  const f = mockFetch(handler);
  const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir: tmpDir(), noCache: true });
  return { f, portal: createPortal(http) };
}

test("listBids: GET page, then POST the search with cookie + token; no login involved", async () => {
  const search = JSON.parse(fx("tenders-search.json"));
  const { f, portal } = portalWith((url, init) => {
    if (init.method === "GET") return jsonRes(fx("tenders-page.html"), { headers: { "set-cookie-list": ["sess=abc; Path=/; HttpOnly", "tok=def; Secure"] } });
    return jsonRes(search);
  });
  const rows = await portal.listBids({ status: "Open" });
  assert.equal(rows.length, 8);
  assert.equal(f.calls.length, 2);
  const post = f.calls[1];
  assert.equal(post.init.method, "POST");
  assert.match(post.url, /\/Tender\/Search\/42b90b89-9f67-483a-96e3-9b0490d01d40\?status=Open&limit=100&start=0&dir=ASC/);
  assert.equal(post.init.headers.cookie, "sess=abc; tok=def");
  assert.match(post.init.body, /__RequestVerificationToken=FIXTURE-GRID-TOKEN/);
  assert.ok(!f.calls.some((c) => /Login/i.test(c.url)));
});

test("listBids pages through results using total", async () => {
  const all = JSON.parse(fx("tenders-search.json"));
  const { f, portal } = portalWith((url, init) => {
    if (init.method === "GET") return jsonRes(fx("tenders-page.html"));
    const start = Number(new URL(url).searchParams.get("start"));
    return jsonRes({ success: true, total: 8, data: all.data.slice(start, start + 5) });
  });
  // page size is 50 in the request, but the server may return fewer: keep going until total is reached
  const rows = await portal.listBids({ status: "Open" });
  assert.equal(rows.length, 8);
  assert.equal(f.calls.filter((c) => c.init.method === "POST").length, 2);
});

test("listBids rejects an unknown status", async () => {
  const { portal } = portalWith(() => jsonRes({}));
  await assert.rejects(() => portal.listBids({ status: "Bogus" }), /unknown bid status/);
});

const NODE = "42b90b89-9f67-483a-96e3-9b0490d01d40";
const TID = "cda1f70a-aaaa-bbbb-cccc-000000000001";
const P = `https://proportal.sourcewell-mn.gov/Module/Tenders/en`;

test("bids carry plan takers, documents and addendums, and the tender id", () => {
  const r = parseBids(JSON.parse(fx("tenders-search.json"))).find((x) => x.number === "110326");
  assert.equal(typeof r.plan_takers, "number");
  assert.ok("addendums" in r && "documents" in r);
  assert.match(r.id, /^[0-9a-f-]{36}$/);
});

test("listBids passes keywords and the status; Planned sorts ascending", async () => {
  const { f, portal } = portalWith((url, init) => init.method === "GET" ? jsonRes(fx("tenders-page.html")) : jsonRes(JSON.parse(fx("tenders-search.json"))));
  await portal.listBids({ status: "planned", q: "scoreboards" });
  const post = f.calls[1];
  assert.match(post.url, /status=Planned&limit=100&start=0&dir=ASC/);
  assert.match(post.init.body, /keywords=scoreboards/);
});

test("parseDetail: closing date, question deadline, description, category lines", () => {
  const d = parseDetail(fx("tender-detail.html"));
  assert.equal(d.number, "RFP 110326");
  assert.equal(d.status, "Open");
  assert.equal(d.closing, "Tue Nov 3, 2026 3:30:00 PM (CST)");
  assert.equal(d.question_deadline, "Mon Oct 26, 2026 4:30:00 PM (CDT)");
  assert.match(d.description, /^Sourcewell, a State of Minnesota/);
  assert.ok(d.categories.includes("423810 - Construction and Mining (except Oil Well) Machinery and Equipment Merchant Wholesalers"));
  assert.ok(d.categories.includes("33312 - Construction Machinery Manufacturing"));
  assert.throws(() => parseDetail("<html></html>"), /bid detail table not found/);
});

test("parseAwards: per RFP, bidders and awardees; entities decoded", () => {
  const a = parseAwards(fx("contract-awards.html"), 2023);
  assert.equal(a.length, 2);
  assert.equal(a[0].number, "011723");
  assert.equal(a[0].bidder_count, 5);
  assert.deepEqual(a[0].awardees, ["Komatsu America Corp.", "John Deere Shared Services LLC", "Caterpillar Inc"]);
  assert.equal(a[1].name, "Example Category & Services");
  assert.deepEqual(a[1].awardees, ["Acme O'Brien Co."]);
});

test("awards() fetches the year report with the node id and filters by RFP", async () => {
  const { f, portal } = portalWith((url) => url.includes("ContractAwards") ? jsonRes(fx("contract-awards.html")) : jsonRes(fx("tenders-page.html")));
  const rows = await portal.awards({ year: 2023, rfp: "RFP 011723" });
  assert.equal(rows.length, 1);
  assert.ok(f.calls.some((c) => c.url === `${P}/Tender/ContractAwards/${NODE}?year=2023`));
  await assert.rejects(() => portal.awards({ year: "23" }), /four-digit/);
});

test("bidDetail resolves an RFP number through the bid list", async () => {
  const search = JSON.parse(fx("tenders-search.json"));
  const id = search.data.find((r) => r.Title.includes("110326")).Id;
  const { f, portal } = portalWith((url, init) => {
    if (url.includes("/Tender/Detail/")) return jsonRes(fx("tender-detail.html"));
    return init.method === "GET" ? jsonRes(fx("tenders-page.html")) : jsonRes(search);
  });
  const d = await portal.bidDetail("RFP 110326");
  assert.equal(d.id, id);
  assert.equal(d.closing, "Tue Nov 3, 2026 3:30:00 PM (CST)");
  assert.ok(f.calls.some((c) => c.url === `${P}/Tender/Detail/${id}`));
  await assert.rejects(() => portal.bidDetail("RFP 999999"), /no bid found/);
});

test("route allowlist refuses register / terms / submit / question and every other portal route", () => {
  for (const [m, path] of [
    ["GET", `/Tender/Terms/${TID}`], ["POST", `/Tender/Terms/${TID}`], ["GET", `/Tender/SubmitQuestion/${TID}`], ["POST", `/Tender/SubmitQuestion/${TID}`],
    ["POST", `/Submission/PlanTakerSubmissionCreate/${TID}`], ["GET", `/Submission/ManageSubmissionsNew/${TID}`], ["POST", `/Vendor/Create/${NODE}`],
    ["GET", `/Vendor/Dashboard/${TID}`], ["POST", `/Tender/Detail/${TID}`], ["GET", `/Tender/Search/${NODE}`], ["POST", `/Tender/DownloadBidDocuments/${TID}`],
  ]) assert.throws(() => assertPortalRequest(m, `${P}${path}`), AllowlistError, `${m} ${path}`);
  assert.throws(() => assertPortalRequest("GET", `https://evil.example/Module/Tenders/en/Tender/Detail/${TID}`), AllowlistError);
  for (const [m, path] of [["GET", ""], ["GET", `/Tender/Detail/${TID}`], ["POST", `/Tender/Search/${NODE}`], ["GET", `/Tender/ContractAwards/${NODE}`], ["GET", `/Tender/DownloadBidDocuments/${TID}`], ["GET", `/Tender/PreviewDocuments/${TID}`], ["POST", `/Login/Index/${NODE}`]]) {
    assert.ok(assertPortalRequest(m, `${P}${path}`), `${m} ${path}`);
  }
});

test("a redirect into a forbidden route is refused before it is followed", async () => {
  const { f, portal } = portalWith((url) => url.endsWith("/en") ? jsonRes(fx("tenders-page.html")) : jsonRes("", { status: 302, headers: { location: `/Module/Tenders/en/Tender/Terms/${TID}` } }));
  await assert.rejects(() => portal.awards({ year: 2023 }), AllowlistError);
  assert.ok(!f.calls.some((c) => /Terms/.test(c.url)));
});

test("parseLoginForm collects the hidden fields incl. the token", () => {
  const f = parseLoginForm(fx("login-page.html"));
  assert.equal(f.__RequestVerificationToken, "FIXTURE-LOGIN-TOKEN");
  assert.equal(f.PromptForEmailResend, "False");
  assert.throws(() => parseLoginForm("<html></html>"), /login form not found/);
});

const ZIP = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(40)]);
function zipRes(body = ZIP) {
  return { ok: true, status: 200, headers: { get: () => "application/zip", getSetCookie: () => [] }, async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); }, async text() { return ""; } };
}
function docsHandler({ loginStatus = 302, signedInBounce = false } = {}) {
  const search = JSON.parse(fx("tenders-search.json"));
  return (url, init) => {
    if (url === `${P}`) return jsonRes(fx("tenders-page.html"), { headers: { "set-cookie-list": ["pub=1; Path=/"] } });
    if (url.includes("/Login/Index/") && init.method === "GET") return jsonRes(fx("login-page.html"), { headers: { "set-cookie-list": ["loginsess=L1; Path=/"] } });
    if (url.includes("/Login/Index/") && init.method === "POST") return loginStatus === 302 ? jsonRes("", { status: 302, headers: { location: `/Module/Tenders/en/Vendor/Dashboard/v1`, "set-cookie-list": ["auth=A1; HttpOnly"] } }) : jsonRes(fx("login-page.html"));
    if (url.includes("/Tender/Search/")) return jsonRes(search);
    if (url.includes("/Tender/DownloadBidDocuments/")) return signedInBounce ? jsonRes("", { status: 302, headers: { location: `/Module/Tenders/en/Login/Index/${NODE}?RedirectUrl=x` } }) : jsonRes("", { status: 302, headers: { location: `/Module/Tenders/en/Tender/PreviewDocuments/${TID}` } });
    if (url.includes("/Tender/PreviewDocuments/")) return zipRes();
    throw new Error("unexpected " + url);
  };
}

test("downloadDocs: login by form, follow to PreviewDocuments, save ZIP; password only in the login POST body", async () => {
  const dir = tmpDir();
  const { f, portal } = portalWith(docsHandler());
  const r = await portal.downloadDocs({ ref: "110326", outDir: join(dir, "out"), username: "me@example.com", password: "s3cret-PW" });
  assert.equal(r.bid_number, "110326");
  assert.match(r.file, /RFP-110326-documents\.zip$/);
  assert.equal(readFileSync(r.file).subarray(0, 2).toString(), "PK");
  const withPw = f.calls.filter((c) => JSON.stringify(c).includes("s3cret-PW"));
  assert.equal(withPw.length, 1);
  assert.equal(withPw[0].init.method, "POST");
  assert.match(withPw[0].url, /\/Login\/Index\//);
  assert.match(withPw[0].init.body, /__RequestVerificationToken=FIXTURE-LOGIN-TOKEN/);
  assert.match(withPw[0].init.body, /Username=me%40example\.com/);
  const dl = f.calls.find((c) => c.url.includes("DownloadBidDocuments"));
  assert.match(dl.init.headers.cookie, /auth=A1/);
  assert.ok(!f.calls.some((c) => /Terms|Submit|Question|Register/i.test(c.url)));
});

test("downloadDocs: failed login and bounced download fail cleanly without echoing the password", async () => {
  for (const opts of [{ loginStatus: 200 }, { signedInBounce: true }]) {
    const { portal } = portalWith(docsHandler(opts));
    await assert.rejects(() => portal.downloadDocs({ ref: "110326", outDir: join(tmpDir(), "o"), username: "u", password: "s3cret-PW" }), (e) => /login|sign-in/.test(e.message) && !e.message.includes("s3cret-PW"));
  }
  const { f, portal } = portalWith(docsHandler());
  await assert.rejects(() => portal.downloadDocs({ ref: "110326", outDir: "x", username: "", password: "" }), /own portal login/);
  assert.equal(f.calls.length, 0);
});

test("credentials never reach the on-disk cache", async () => {
  const cacheDir = tmpDir();
  const clock = fakeClock();
  const f = mockFetch(docsHandler());
  const http = createHttp({ fetchImpl: f, sleep: clock.sleep, now: clock.now, cacheDir });
  await createPortal(http).downloadDocs({ ref: "110326", outDir: join(tmpDir(), "o"), username: "me@example.com", password: "s3cret-PW" });
  for (const file of readdirSync(cacheDir)) {
    const body = readFileSync(join(cacheDir, file), "utf8");
    assert.ok(!body.includes("s3cret-PW") && !body.includes("me@example.com") && !body.includes("A1"), file);
  }
});

test("planned bids (upcoming RFPs): 'RFP - TBD - name' title, estimated issue date, no fake closing date", () => {
  const rows = parseBids(JSON.parse(fx("tenders-planned.json")));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, "Planned");
  assert.equal(rows[0].type, "RFP");
  assert.equal(rows[0].number, "TBD");
  assert.equal(rows[0].name, "Microgrids");
  assert.equal(rows[0].closing, "");
  assert.equal(rows[0].days_left, "");
  assert.equal(rows[0].planned_issue, "2026-11-05T11:00:00.000Z");
  assert.equal(rows[0].days_to_issue, 7);
});
