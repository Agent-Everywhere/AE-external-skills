// Minimal Chrome DevTools Protocol client (browser-level websocket, flattened target sessions).
// Works against local Chrome (--remote-debugging-port) and the AE cloud browser's cdp_url.
import WebSocket from "ws";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve a browser websocket URL from http://host:port, ws://... or wss://... */
export async function resolveWsUrl(cdpUrl, fetchImpl = globalThis.fetch) {
  if (/^wss?:\/\//.test(cdpUrl)) return cdpUrl;
  const base = cdpUrl.replace(/\/+$/, "");
  const res = await fetchImpl(base + "/json/version");
  if (!res.ok) throw new Error(`CDP endpoint answered HTTP ${res.status}`);
  const j = await res.json();
  if (!j.webSocketDebuggerUrl) throw new Error("CDP endpoint did not report webSocketDebuggerUrl");
  return j.webSocketDebuggerUrl;
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.on("message", (buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`CDP ${m.error.message}`));
        else resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners) fn(m);
      }
    });
    ws.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }
  static async connect(cdpUrl, { headers } = {}) {
    const url = await resolveWsUrl(cdpUrl);
    const ws = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId, timeoutMs = 60000) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(pred, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const off = this.on((m) => { if (pred(m)) { off(); clearTimeout(t); resolve(m); } });
      const t = setTimeout(() => { off(); reject(new Error("timeout waiting for CDP event")); }, timeoutMs);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** A page (tab) bound to a flattened CDP session. */
export class Page {
  constructor(cdp, targetId, sessionId) { this.cdp = cdp; this.targetId = targetId; this.sessionId = sessionId; }
  static async open(cdp, { reuse = true, matchUrl = /qbo\.intuit\.com/ } = {}) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page");
    let target = reuse ? (pages.find((t) => matchUrl.test(t.url)) || pages[0]) : null;
    let targetId = target?.targetId;
    if (!targetId) ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const p = new Page(cdp, targetId, sessionId);
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    return p;
  }
  send(method, params, timeoutMs) { return this.cdp.send(method, params, this.sessionId, timeoutMs); }
  async evaluate(expression, { timeoutMs = 60000 } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page error: ${d.exception?.description || d.text}`.slice(0, 500));
    }
    return r.result.value;
  }
  /** Run `async (params) => {...}` source in the page with params. */
  async run(fnSource, params = {}, opts) {
    return this.evaluate(`(${fnSource})(${JSON.stringify(params)})`, opts);
  }
  async url() { return this.evaluate("location.href"); }
  async goto(url, { timeoutMs = 45000 } = {}) {
    const loaded = this.cdp.waitFor((m) => m.sessionId === this.sessionId && m.method === "Page.loadEventFired", timeoutMs).catch(() => null);
    await this.send("Page.navigate", { url });
    await loaded;
  }
  async waitForFunction(expr, { timeoutMs = 30000, intervalMs = 250 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let v = null;
      try { v = await this.evaluate(expr, { timeoutMs: 10000 }); } catch { /* navigating */ }
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(intervalMs);
    }
  }
}
