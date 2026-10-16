// Local CDP relay for `qbo hold`. The AE cloud browser ends its lease when the CDP websocket that
// claimed it disconnects, so one process must keep that socket open. The relay holds the upstream
// socket and serves short-lived local clients (each `qbo` run) on 127.0.0.1, rewriting message ids so
// clients never collide. The upstream cdp_url never leaves this process.
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

export async function startRelay(upstreamUrl, { WebSocketImpl = WebSocket } = {}) {
  const up = new WebSocketImpl(upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { up.once("open", res); up.once("error", rej); });
  const token = randomBytes(16).toString("hex");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/" + token, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res) => wss.once("listening", res));
  let nextId = 0;
  const inflight = new Map(); // upstream id -> { client, id }
  const clients = new Set();
  wss.on("connection", (client) => {
    clients.add(client);
    client.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      const uid = ++nextId;
      inflight.set(uid, { client, id: m.id });
      m.id = uid;
      up.send(JSON.stringify(m));
    });
    client.on("close", () => {
      clients.delete(client);
      for (const [k, v] of inflight) if (v.client === client) inflight.delete(k);
    });
  });
  up.on("message", (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.id !== undefined) {
      const r = inflight.get(m.id);
      if (!r) return;
      inflight.delete(m.id);
      m.id = r.id;
      if (r.client.readyState === 1) r.client.send(JSON.stringify(m));
    } else {
      const s = JSON.stringify(m);
      for (const c of clients) if (c.readyState === 1) c.send(s);
    }
  });
  let closedResolve;
  const closed = new Promise((r) => { closedResolve = r; });
  up.on("close", () => { for (const c of clients) c.close(); wss.close(); closedResolve(); });
  return {
    url: `ws://127.0.0.1:${wss.address().port}/${token}`,
    closed,
    async close() { for (const c of clients) c.close(); await new Promise((r) => wss.close(r)); up.close(); },
  };
}
