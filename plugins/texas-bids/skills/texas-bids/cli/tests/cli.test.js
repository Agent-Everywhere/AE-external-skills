import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { main, parseArgs } from "../src/cli.js";
import { esbdFetch, fixture, makeIo, mockFetch, res, tmpDir } from "./helpers.js";

const world = () => esbdFetch({ janitorial: fixture("open-janitorial.json"), tank: fixture("open-tank.json") });

test("parseArgs handles --flag value, --flag=value, booleans and unknown flags", () => {
  const { flags, positional } = parseArgs(["search", "--keywords", "a,b", "--limit=5", "--json"]);
  assert.deepEqual(flags, { keywords: "a,b", limit: "5", json: true });
  assert.deepEqual(positional, ["search"]);
  assert.throws(() => parseArgs(["search", "--bogus"]), /unknown option --bogus/);
  assert.throws(() => parseArgs(["search", "--keywords"]), /needs a value/);
  assert.throws(() => parseArgs(["search", "--keywords", "--json"]), /needs a value/);
});

test("--version and --help work without the network", async () => {
  const t = makeIo(mockFetch(() => { throw new Error("no network"); }));
  assert.equal(await main(["--version"], t.io), 0);
  assert.equal(t.out().trim(), "0.1.0");
  const h = makeIo(mockFetch(() => { throw new Error("no network"); }));
  assert.equal(await main(["--help"], h.io), 0);
  assert.match(h.out(), /texas-bids search/);
  const none = makeIo(mockFetch(() => { throw new Error("no network"); }));
  assert.equal(await main([], none.io), 2);
});

test("search prints every field, and --json is machine readable", async () => {
  const t = makeIo(world());
  assert.equal(await main(["search", "--keywords", "janitorial"], t.io), 0);
  assert.match(t.out(), /3 open solicitations match your keywords/);
  assert.match(t.out(), /FAC-01744-RFP \| UT MD Anderson Cancer Center \| posted 2026-11-12 \| due 2026-12-15 1:00 PM \| Posted/);
  assert.match(t.out(), /https:\/\/www\.txsmartbuy\.gov\/esbd\/FAC-01744-RFP/);
  const j = makeIo(world());
  assert.equal(await main(["search", "--keywords", "janitorial", "--json", "--limit", "2"], j.io), 0);
  const body = JSON.parse(j.out());
  assert.equal(body.count, 2);
  assert.equal(body.total, 3);
  assert.deepEqual(Object.keys(body.rows[0]).sort(), ["agency", "agency_number", "attachment_url", "class_codes", "due", "due_time", "id", "internal_id", "matched", "posted", "status", "title", "updated", "url"]);
});

test("usage errors exit 2 with a message, runtime errors exit 1", async () => {
  const a = makeIo(world());
  assert.equal(await main(["search"], a.io), 2);
  assert.match(a.err(), /--keywords is required/);
  const b = makeIo(world());
  assert.equal(await main(["search", "--keywords", "x", "--since", "yesterday"], b.io), 2);
  const c = makeIo(world());
  assert.equal(await main(["search", "--keywords", "x", "--status", "nope"], c.io), 2);
  const d = makeIo(mockFetch(() => res("", { status: 403 })));
  assert.equal(await main(["search", "--keywords", "x"], d.io), 1);
  assert.match(d.err(), /texas-bids: the Texas bid board answered HTTP 403/);
  const e = makeIo(world());
  assert.equal(await main(["watch", "--keywords", "x", "--limit", "3"], e.io), 2);
});

test("watch: first run reports everything as new and says so; second run reports zero new", async () => {
  const state = join(tmpDir(), "s.json");
  const first = makeIo(world());
  assert.equal(await main(["watch", "--keywords", "janitorial", "--state", state], first.io), 0);
  assert.match(first.out(), /First check: no earlier results are saved, so all 3 open solicitations/);
  assert.match(first.out(), /Parking Operations Janitorial Services/);
  const second = makeIo(world());
  assert.equal(await main(["watch", "--keywords", "janitorial", "--state", state], second.io), 0);
  assert.match(second.out(), /0 new solicitations since the last check \(3 open and matching in total\)/);
  assert.doesNotMatch(second.out(), /Parking Operations/);
  const js = makeIo(world());
  await main(["watch", "--keywords", "janitorial", "--state", state, "--json"], js.io);
  const body = JSON.parse(js.out());
  assert.equal(body.baseline, false);
  assert.equal(body.new_count, 0);
});

test("watch: a new keyword's matches show up as new on the next run", async () => {
  const state = join(tmpDir(), "s.json");
  await main(["watch", "--keywords", "janitorial", "--state", state], makeIo(world()).io);
  const t = makeIo(world());
  await main(["watch", "--keywords", "janitorial,tank", "--state", state, "--json"], t.io);
  const body = JSON.parse(t.out());
  assert.ok(body.new_count >= 1);
  assert.ok(body.new.every((r) => r.matched.includes("tank") && !r.matched.includes("janitorial")));
});

test("notify-teams posts new bids to the webhook, then stays quiet with nothing new unless --always", async () => {
  const state = join(tmpDir(), "s.json");
  const hook = mockFetch(() => res("", { status: 202 }));
  const url = "https://hooks.example.test/secret-path";
  const first = makeIo(world(), { teamsFetchImpl: hook });
  assert.equal(await main(["notify-teams", "--keywords", "janitorial", "--webhook", url, "--state", state], first.io), 0);
  assert.equal(hook.calls.length, 1);
  assert.equal(hook.calls[0].url, url);
  assert.match(JSON.stringify(hook.calls[0].body), /3 open solicitations match your keywords \(first check\)/);
  assert.match(first.out(), /Teams: posted 3 new bids/);
  assert.doesNotMatch(first.out() + first.err(), /secret-path/);

  const quiet = makeIo(world(), { teamsFetchImpl: hook });
  assert.equal(await main(["notify-teams", "--keywords", "janitorial", "--webhook", url, "--state", state], quiet.io), 0);
  assert.equal(hook.calls.length, 1, "nothing new, nothing posted");
  assert.match(quiet.out(), /nothing new, nothing posted/);

  const always = makeIo(world(), { teamsFetchImpl: hook });
  assert.equal(await main(["notify-teams", "--keywords", "janitorial", "--webhook", url, "--state", state, "--always"], always.io), 0);
  assert.equal(hook.calls.length, 2);
  assert.match(JSON.stringify(hook.calls[1].body), /0 new solicitations/);
});

test("watch reads the webhook from the environment and from --teams-webhook", async () => {
  const hook = mockFetch(() => res("", { status: 202 }));
  const s1 = join(tmpDir(), "s.json");
  const a = makeIo(world(), { teamsFetchImpl: hook, env: { TEXAS_BIDS_TEAMS_WEBHOOK: "https://hooks.example.test/env" } });
  assert.equal(await main(["watch", "--keywords", "janitorial", "--state", s1], a.io), 0);
  assert.equal(hook.calls[0].url, "https://hooks.example.test/env");
  const s2 = join(tmpDir(), "s.json");
  const b = makeIo(world(), { teamsFetchImpl: hook });
  assert.equal(await main(["watch", "--keywords", "janitorial", "--state", s2, "--teams-webhook", "https://hooks.example.test/flag"], b.io), 0);
  assert.equal(hook.calls[1].url, "https://hooks.example.test/flag");
});

test("a failed Teams post exits non-zero, leaves the state untouched, and the bids are reported again", async () => {
  const state = join(tmpDir(), "s.json");
  const bad = mockFetch(() => res("", { status: 404 }));
  const t = makeIo(world(), { teamsFetchImpl: bad });
  assert.equal(await main(["notify-teams", "--keywords", "janitorial", "--webhook", "https://hooks.example.test/x", "--state", state], t.io), 1);
  assert.match(t.err(), /Teams answered HTTP 404/);
  assert.match(t.out(), /State NOT saved/);
  await assert.rejects(readFile(state, "utf8"), /ENOENT/);
  const again = makeIo(world());
  await main(["watch", "--keywords", "janitorial", "--state", state, "--json"], again.io);
  const body = JSON.parse(again.out());
  assert.equal(body.baseline, true);
  assert.equal(body.new_count, 3);
});

test("--dry-run prints the Teams message, posts nothing and saves no state", async () => {
  const state = join(tmpDir(), "s.json");
  const hook = mockFetch(() => res("", { status: 202 }));
  const t = makeIo(world(), { teamsFetchImpl: hook });
  assert.equal(await main(["notify-teams", "--keywords", "janitorial", "--webhook", "https://hooks.example.test/x", "--state", state, "--dry-run"], t.io), 0);
  assert.equal(hook.calls.length, 0);
  assert.match(t.out(), /"AdaptiveCard"/);
  await assert.rejects(readFile(state, "utf8"), /ENOENT/);
});

test("notify-teams needs a webhook; --test posts a short test card", async () => {
  const none = makeIo(world());
  assert.equal(await main(["notify-teams", "--keywords", "x"], none.io), 2);
  assert.match(none.err(), /TEXAS_BIDS_TEAMS_WEBHOOK/);
  const hook = mockFetch(() => res("", { status: 202 }));
  const t = makeIo(world(), { teamsFetchImpl: hook });
  assert.equal(await main(["notify-teams", "--webhook", "https://hooks.example.test/x", "--test"], t.io), 0);
  assert.equal(hook.calls.length, 1);
  assert.match(JSON.stringify(hook.calls[0].body), /test message/);
});

test("doctor reports the open total", async () => {
  const t = makeIo(mockFetch(() => res(fixture("open-page1.json"))));
  assert.equal(await main(["doctor"], t.io), 0);
  assert.match(t.out(), /ok: the Texas bid board answered; 495 open solicitations/);
});
