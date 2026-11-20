import test from "node:test";
import assert from "node:assert/strict";
import { MAX_LISTED, TeamsError, buildPayload, postToTeams } from "../src/teams.js";
import { parseListResponse } from "../src/esbd.js";
import { fixture, mockFetch, res } from "./helpers.js";

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

test("first-check payload says so, and a long list is capped", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ ...rows[0], id: `X${i}`, internal_id: `${i}`, url: `https://www.txsmartbuy.gov/esbd/X${i}` }));
  const p = buildPayload({ rows: many, baseline: true });
  const body = p.attachments[0].content.body;
  const text = body.map((b) => b.text).join("\n");
  assert.match(text, /25 open solicitations match your keywords \(first check\)/);
  assert.match(text, /From now on only new bids are sent/);
  assert.match(text, new RegExp(`\\.\\.\\.and ${25 - MAX_LISTED} more`));
  assert.equal(body.filter((b) => b.separator).length, MAX_LISTED);
  assert.ok(JSON.stringify(p).length < 28000, "stays under the Teams card size limit");
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
