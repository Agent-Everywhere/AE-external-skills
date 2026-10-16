import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { startRelay } from "../src/relay.js";
import { writeSessionFile, readSessionFile, ConnectError } from "../src/connect.js";
import { Cdp } from "../src/cdp.js";

test("relay serves sequential clients over one upstream socket and rewrites ids", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => upstream.once("listening", r));
  let upConns = 0; const seenIds = [];
  upstream.on("connection", (ws) => {
    upConns++;
    ws.on("message", (b) => { const m = JSON.parse(b); seenIds.push(m.id); ws.send(JSON.stringify({ id: m.id, result: { echo: m.method } })); ws.send(JSON.stringify({ method: "Evt.x" })); });
  });
  const relay = await startRelay(`ws://127.0.0.1:${upstream.address().port}`);
  assert.match(relay.url, /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
  for (let i = 0; i < 2; i++) {
    const c = await Cdp.connect(relay.url);
    const evt = c.waitFor ? c.waitFor((m) => m.method === "Evt.x", 2000) : null;
    assert.deepEqual(await c.send("A.b"), { echo: "A.b" }); // client id 1 both times
    if (evt) await evt;
    c.close();
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(upConns, 1);
  assert.deepEqual(seenIds, [1, 2]); // upstream ids never collide
  await assert.rejects(new Promise((res, rej) => { const w = new WebSocket(relay.url.replace(/\/[0-9a-f]+$/, "/wrong")); w.once("open", res); w.once("error", rej); }));
  await relay.close();
  await relay.closed;
  upstream.close();
});

test("session file is 0600 and round-trips; bad files fail clearly", () => {
  const dir = mkdtempSync(join(tmpdir(), "qbo-"));
  const p = join(dir, "s.json");
  writeSessionFile(p, { base: "https://b", cdpUrl: "ws://127.0.0.1:1/t", sessionId: "s", heartbeatToken: "h" });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(readSessionFile(p), { base: "https://b", cdpUrl: "ws://127.0.0.1:1/t", sessionId: "s", heartbeatToken: "h" });
  assert.throws(() => readSessionFile(join(dir, "missing.json")), ConnectError);
});
