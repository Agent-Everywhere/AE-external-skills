// Electron DevTools (CDP) driver for the running Grok Bot desktop app.
// The app must be launched with --remote-debugging-port. `ensureDebugApp` relaunches it that way.
// Inside the renderer, the preload exposes `window.desktop` (contextBridge). Useful surfaces:
//   desktop.agent.getSidebarSections() / setSidebarSections(sections)
//   desktop.agent.getPinnedAgents() / setPinnedAgents(ids)
//   desktop.cursorAccount.getStatus()
//   desktop.getBoxHostPhase()
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { APP_BUNDLE } from "./session.js";

const execFileP = promisify(execFile);
export const DEFAULT_CDP_PORT = Number(process.env.GROKBOT_CDP_PORT || 9340);
const APP_PROCESS_NAME = "Grok Bot";

export class CdpError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "CdpError";
    Object.assign(this, extra);
  }
}

export async function cdpVersion(port = DEFAULT_CDP_PORT, { timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function cdpTargets(port = DEFAULT_CDP_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new CdpError(`CDP /json returned ${res.status}`);
  return res.json();
}

export function appPids() {
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-x", APP_PROCESS_NAME], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export function appArgs(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export async function appState(port = DEFAULT_CDP_PORT) {
  const pids = appPids();
  const main = pids.find((p) => appArgs(p).includes(`${APP_BUNDLE}/Contents/MacOS/`)) ?? pids[0] ?? null;
  const args = main ? appArgs(main) : "";
  const m = args.match(/--remote-debugging-port=(\d+)/);
  const debugPort = m ? Number(m[1]) : null;
  const version = debugPort ? await cdpVersion(debugPort) : await cdpVersion(port);
  return { running: pids.length > 0, pid: main, debugPort: debugPort ?? (version ? port : null), cdpReachable: Boolean(version), version };
}

export async function quitApp({ timeoutMs = 20_000 } = {}) {
  if (appPids().length === 0) return true;
  await execFileP("/usr/bin/osascript", ["-e", `quit app "${APP_PROCESS_NAME}"`]).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appPids().length === 0) return true;
    await sleep(300);
  }
  return appPids().length === 0;
}

export async function launchApp({ debugPort = null, timeoutMs = 30_000 } = {}) {
  const args = ["-a", APP_BUNDLE];
  if (debugPort) args.push("--args", `--remote-debugging-port=${debugPort}`, `--remote-allow-origins=http://127.0.0.1:${debugPort}`);
  await execFileP("/usr/bin/open", args);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (debugPort) {
      if (await cdpVersion(debugPort)) return true;
    } else if (appPids().length > 0) return true;
    await sleep(400);
  }
  return false;
}

/** Make sure the app is running with a reachable debug port; relaunches only when needed or forced. */
export async function ensureDebugApp({ port = DEFAULT_CDP_PORT, restart = false } = {}) {
  const state = await appState(port);
  if (state.cdpReachable && !restart) return { ...state, relaunched: false };
  if (state.running) {
    const quit = await quitApp();
    if (!quit) throw new CdpError("Grok Bot did not quit within 20s; close it manually and retry.");
  }
  const ok = await launchApp({ debugPort: port });
  if (!ok) throw new CdpError(`Grok Bot did not expose CDP on port ${port} within 30s.`);
  return { ...(await appState(port)), relaunched: true };
}

export const DEFAULT_SEND_TIMEOUT_MS = 30_000;
/** Timeout for desktop calls known to be slow (restart/relaunch/update/sign-in style flows). */
export const SLOW_CALL_TIMEOUT_MS = 120_000;
const SLOW_DESKTOP_PATH = /(restart|relaunch|reload|quit|update|install|signin|signout|login|logout|authenticate|boxhost)/i;

export class Cdp {
  constructor(ws, { timeoutMs = DEFAULT_SEND_TIMEOUT_MS } = {}) {
    this.ws = ws;
    this.id = 0;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.settle(msg);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    };
    ws.onclose = () => this.rejectAll(new CdpError("CDP websocket closed"));
    ws.onerror = (e) => this.rejectAll(new CdpError(`CDP websocket error: ${e?.message ?? "error"}`));
  }

  /** Reject every in-flight call (socket closed/errored) and refuse new ones. */
  rejectAll(err) {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  static async connect({ port = DEFAULT_CDP_PORT, target = "page" } = {}) {
    const targets = await cdpTargets(port).catch((err) => {
      throw new CdpError(`Grok Bot is not exposing CDP on port ${port} (${err.message}). Run \`grokbot app restart --debug\`.`);
    });
    const t = targets.find((x) => x.type === target && /app\.asar\/dist\/renderer/.test(x.url)) ?? targets.find((x) => x.type === target);
    if (!t) throw new CdpError(`No ${target} target found on CDP port ${port}.`);
    if (typeof WebSocket === "undefined") throw new CdpError("CDP needs Node 22+ (global WebSocket); it only applies on the Mac that runs the desktop app.");
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new CdpError(`CDP websocket failed: ${e?.message ?? "error"}`));
    });
    const cdp = new Cdp(ws);
    cdp.target = t;
    return cdp;
  }

  send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new CdpError(`${method}: CDP websocket is closed`));
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { timer, reject, settle: (msg) => (msg.error ? reject(new CdpError(`${method}: ${msg.error.message}`)) : resolve(msg.result)) });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`${method}: ${err.message}`));
      }
    });
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, timeoutMs ? { timeoutMs } : {});
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new CdpError(`renderer threw: ${String(d).split("\n")[0]}`);
    }
    return r.result?.value;
  }

  /** Call a method on window.desktop by dotted path, e.g. "agent.getSidebarSections". */
  callDesktop(path, args = [], { timeoutMs } = {}) {
    const expr = `window.desktop.${path}(...${JSON.stringify(args)})`;
    // An explicit override wins; known-slow paths get the long timeout; everything else keeps the default.
    const t = timeoutMs ?? (SLOW_DESKTOP_PATH.test(path) ? Math.max(SLOW_CALL_TIMEOUT_MS, this.timeoutMs) : undefined);
    return this.evaluate(expr, { timeoutMs: t });
  }

  desktopKeys(path = "") {
    return this.evaluate(`Object.keys(window.desktop${path ? "." + path : ""})`);
  }

  bringToFront() {
    return this.send("Page.bringToFront");
  }

  pageText() {
    return this.evaluate("document.body.innerText");
  }

  async screenshot(path, { format = "png" } = {}) {
    const { writeFileSync } = await import("node:fs");
    const r = await this.send("Page.captureScreenshot", { format });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
