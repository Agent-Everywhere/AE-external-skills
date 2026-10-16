// Browser connection: local Chrome over CDP, or the AE cloud browser (one-use claim -> cdp_url + heartbeat).
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { Cdp, Page } from "./cdp.js";

export class ConnectError extends Error {
  constructor(message, code = 6) { super(message); this.exitCode = code; }
}

async function postJson(base, path, body, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(base.replace(/\/+$/, "") + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; e.body = text.slice(0, 200); throw e; }
  return text ? JSON.parse(text) : {};
}

/** Claim the AE cloud browser. Returns { cdpUrl, sessionId, heartbeatToken }. */
export async function claimAgentBrowser({ base, claim, fetchImpl }) {
  if (!base || !claim) throw new ConnectError("agent-browser needs --base and a claim (env AB_CLAIM)", 2);
  let r;
  try { r = await postJson(base, "/browser/claim", { claim }, fetchImpl); }
  catch (e) { throw new ConnectError(e.status ? `claim rejected (HTTP ${e.status}): claims are one-use and expire in 60s; open a fresh session` : `claim request failed: ${e.message}`); }
  if (!r || !r.cdp_url || !r.heartbeat_token || !r.session_id) throw new ConnectError("claim response missing cdp_url / heartbeat_token / session_id");
  return { cdpUrl: r.cdp_url, sessionId: r.session_id, heartbeatToken: r.heartbeat_token };
}

/** Heartbeat every 25s (the connector requires <= 60s). Returns { stop(), report(signedIn) }. */
export function startHeartbeat({ base, sessionId, heartbeatToken, fetchImpl, intervalMs = 25000 }) {
  let stage = "running";
  const beat = () => postJson(base, "/browser/heartbeat", { session_id: sessionId, heartbeat_token: heartbeatToken, stage, rows: 0 }, fetchImpl).catch(() => {});
  beat();
  const t = setInterval(beat, intervalMs);
  t.unref?.();
  return {
    report: (signedIn) => postJson(base, "/browser/auth", { session_id: sessionId, heartbeat_token: heartbeatToken, signed_in: !!signedIn }, fetchImpl).catch(() => {}),
    stop: async () => { clearInterval(t); stage = "done"; await beat(); },
  };
}

/** Write a held session (cdp_url + heartbeat token) to a 0600 file so later qbo runs can reuse one claim. */
export function writeSessionFile(path, { base, cdpUrl, sessionId, heartbeatToken }) {
  writeFileSync(path, JSON.stringify({ base, cdp_url: cdpUrl, session_id: sessionId, heartbeat_token: heartbeatToken }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Read a session file written by `qbo hold`. */
export function readSessionFile(path) {
  let j;
  try { j = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new ConnectError(`could not read session file ${path}: ${e.code || e.message} (start one with \`qbo hold\`)`, 2); }
  if (!j.cdp_url || !j.session_id) throw new ConnectError(`session file ${path} is missing cdp_url / session_id`, 2);
  return { base: j.base, cdpUrl: j.cdp_url, sessionId: j.session_id, heartbeatToken: j.heartbeat_token };
}

/** Connect per options; returns { cdp, page, heartbeat, close() }. Secrets are never logged.
 *  agent-browser: with a session file (from `qbo hold`) attach to the held browser; else claim AB_CLAIM. */
export async function connect(opts = {}) {
  const runtime = opts.runtime || (opts.base || process.env.AB_CLAIM || opts.sessionFile || process.env.QBO_SESSION_FILE ? "agent-browser" : "cdp");
  let cdpUrl = opts.cdpUrl || process.env.QBO_CDP_URL || "http://127.0.0.1:9222";
  let heartbeat = null;
  const sessionFile = opts.sessionFile || process.env.QBO_SESSION_FILE;
  if (runtime === "agent-browser" && sessionFile) {
    const c = readSessionFile(sessionFile);
    cdpUrl = c.cdpUrl;
    // `qbo hold` owns the heartbeat; this run only reports auth.
    const base = opts.base || c.base;
    heartbeat = { report: (signedIn) => base && c.heartbeatToken ? postJson(base, "/browser/auth", { session_id: c.sessionId, heartbeat_token: c.heartbeatToken, signed_in: !!signedIn }).catch(() => {}) : Promise.resolve(), stop: async () => {} };
  } else if (runtime === "agent-browser") {
    const c = await claimAgentBrowser({ base: opts.base || process.env.AB_BASE, claim: opts.claim || process.env.AB_CLAIM });
    cdpUrl = c.cdpUrl;
    heartbeat = startHeartbeat({ base: opts.base || process.env.AB_BASE, ...c });
  }
  let cdp;
  try { cdp = await Cdp.connect(cdpUrl); }
  catch (e) { throw new ConnectError(`could not reach the browser over CDP (${runtime}): ${String(e.message).replace(/wss?:\/\/\S+/g, "<cdp>")}`); }
  const page = await Page.open(cdp, { reuse: true, matchUrl: /qbo\.intuit\.com/ });
  return {
    runtime, cdp, page, heartbeat,
    async close() { if (heartbeat) await heartbeat.stop(); cdp.close(); },
  };
}
