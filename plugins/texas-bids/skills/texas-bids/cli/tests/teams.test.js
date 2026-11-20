import test from "node:test";
import assert from "node:assert/strict";
import { CARD_SIZE, MAX_CARD_BYTES, MAX_POSTED, TeamsError, buildPayloads, postToTeams, selectForTeams } from "../src/teams.js";
import { parseListResponse } from "../src/esbd.js";
import { fixture, mockFetch, res } from "./helpers.js";

const buildPayload = (o) => buildPayloads(o)[0];
const allText = (pls) => pls.flatMap((p) => p.attachments[0].content.body.map((b) => b.text)).join("\n");
const rows = parseListResponse(fixture("open-page1.json")).rows;
const URL_SECRET = "https://prod-00.westus.logic.azure.com/workflows/SECRETSECRET/triggers/manual/paths/invoke?sig=TOPSECRET";

test("payload is a Teams message carrying one Adaptive Card", () => {
  const p = buildPayload({ rows: rows.slice(0, 2), keywords: ["HVAC", "fuel"] });
  assert.equal(p.type, "message");
  assert.equal(p.attachments.length, 1);
  const a = p.attachments[0];
  assert.equal(a.contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(a.content.type, "AdaptiveCard");
  assert.equal(a.content.version, "1.4");
  const text = a.content.body.map((b) => b.text).join("\n");
  assert.match(text, /2 new solicitations match your keywords/);
  assert.match(text, /Keywords: HVAC, fuel/);
  assert.ok(text.includes("(https://www.txsmartbuy.gov/esbd/802-27-86722)"), "title links to the ESBD page");
  assert.match(text, /due 2026-12-07 2:00 PM/);
  assert.doesNotMatch(text, /first check/);
});

test("a single bid reads naturally", () => {
  const one = buildPayload({ rows: rows.slice(0, 1) }).attachments[0].content.body[0].text;
  assert.equal(one, "Texas bids: 1 new solicitation matches your keywords");
  const base = buildPayload({ rows: rows.slice(0, 1), baseline: true }).attachments[0].content.body[0].text;
  assert.equal(base, "Texas bids: 1 open solicitation matches your keywords (first check)");
});

test("first-check payload says so", () => {
  const p = buildPayload({ rows: rows.slice(0, 3), baseline: true });
  const text = p.attachments[0].content.body.map((b) => b.text).join("\n");
  assert.match(text, /3 open solicitations match your keywords \(first check\)/);
  assert.match(text, /From now on only new bids are sent/);
});

const many = (n) => Array.from({ length: n }, (_, i) => ({ ...rows[0], id: `X${i}`, internal_id: `${i}`, due: `2026-12-${String(1 + (i % 28)).padStart(2, "0")}`, url: `https://www.txsmartbuy.gov/esbd/X${i}` }));

test("every new bid is listed: 25 bids become 3 cards of at most 10, each under the size limit", () => {
  const pls = buildPayloads({ rows: many(25), keywords: ["a"] });
  assert.equal(pls.length, 3);
  const counts = pls.map((p) => p.attachments[0].content.body.filter((b) => b.separator).length);
  assert.deepEqual(counts, [CARD_SIZE, CARD_SIZE, 5]);
  const text = allText(pls);
  for (let i = 0; i < 25; i++) assert.ok(text.includes(`esbd/X${i})`), `X${i} missing`);
  assert.match(text, /25 new solicitations match your keywords/);
  assert.match(text, /continued \(11 to 20 of 25\)/);
  for (const p of pls) assert.ok(JSON.stringify(p).length < MAX_CARD_BYTES);
});

test("worst-case long titles still fit a card", () => {
  const long = Array.from({ length: 10 }, (_, i) => ({ ...rows[0], id: `L${i}`, title: "T".repeat(5000), agency: "A".repeat(5000) }));
  for (const p of buildPayloads({ rows: long })) assert.ok(JSON.stringify(p).length < MAX_CARD_BYTES);
});

test("more than 50 new bids: the 50 due soonest are listed, the rest are only counted in a summary card", () => {
  const all = many(120);
  const { listed, unlisted } = selectForTeams(all, "2026-11-20");
  assert.equal(listed.length, MAX_POSTED);
  assert.equal(unlisted.length, 70);
  const lastListedDue = listed.map((r) => r.due).sort().at(-1);
  assert.ok(unlisted.every((r) => r.due >= lastListedDue));
  const pls = buildPayloads({ rows: listed, unlisted: unlisted.length, baseline: true });
  assert.equal(pls.length, 5 + 1);
  const text = allText(pls);
  assert.match(text, /120 open solicitations match your keywords \(first check\)/);
  assert.match(text, /70 more are not listed here/);
  assert.match(text, /70 more new solicitations were NOT listed individually/);
  for (const r of unlisted) assert.ok(!text.includes(`${r.url})`));
});

test("selection puts bids already past their due date or without one last", () => {
  const rs = [{ ...rows[0], id: "past", due: "2026-01-01" }, { ...rows[0], id: "none", due: "" }, { ...rows[0], id: "soon", due: "2026-11-25" }];
  assert.deepEqual(selectForTeams(rs, "2026-11-20").listed.map((r) => r.id), ["soon", "past", "none"]);
});

test("markdown characters in a title cannot break the card text", () => {
  const p = buildPayload({ rows: [{ ...rows[0], title: "Fuel [Phase *2*] (bulk)" }] });
  const text = p.attachments[0].content.body.map((b) => b.text).join("\n");
  assert.ok(text.includes("Fuel \\[Phase \\*2\\*\\] \\(bulk\\)"));
});

test("postToTeams POSTs the JSON payload to the URL and accepts 202", async () => {
  const f = mockFetch(() => res("", { status: 202 }));
  const payload = buildPayload({ rows });
  assert.deepEqual(await postToTeams({ url: URL_SECRET, payload, fetchImpl: f }), { status: 202 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, URL_SECRET);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(f.calls[0].body, payload);
});

test("errors never contain the webhook URL", async () => {
  for (const status of [400, 401, 404, 500]) {
    const f = mockFetch(() => res("", { status }));
    await assert.rejects(postToTeams({ url: URL_SECRET, payload: {}, fetchImpl: f }), (e) => e instanceof TeamsError && e.message.includes(`HTTP ${status}`) && !e.message.includes("SECRET") && !e.message.includes("logic.azure"));
  }
  const boom = mockFetch(() => { throw new Error(`connect failed to ${URL_SECRET}`); });
  await assert.rejects(postToTeams({ url: URL_SECRET, payload: {}, fetchImpl: boom }), (e) => !e.message.includes("SECRET"));
  await assert.rejects(postToTeams({ url: "http://insecure.test/x", payload: {}, fetchImpl: boom }), /must start with https/);
  await assert.rejects(postToTeams({ url: "not a url", payload: {}, fetchImpl: boom }), /not a valid URL/);
});
