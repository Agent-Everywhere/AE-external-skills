import { Command, Option } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { CursorClient } from "./cursor.js";
import { Cdp, DEFAULT_CDP_PORT, MAX_TIMER_MS, appState, cdpTargets, ensureDebugApp, launchApp, quitApp, sleep } from "./cdp.js";
import { Gateway, normalizeAutoReview, sectionsKey, userSections } from "./gateway.js";
import * as local from "./local.js";
import { deleteRoutine, exportRoutines, listRoutines, matchAgents, resumeGuard, setRoutineSlackWorkspace, toggleRoutine } from "./routines.js";
import { enumName, installBaseline, mapLimit, parseAllowlist, summarizeSlackOutcome, unionAppWorkspaces, waitForSlackWorkspace } from "./slack.js";
import { exportAgents, exportTranscripts, formatUsage, summarizeUsage } from "./backup.js";
import { UsageError, pluralize, printJson, relTime, shortId, table } from "./output.js";
import { agentState, filterAgents, parseDuration, resolveAgent, resolveMany, sortAgents } from "./agents.js";
import * as S from "./sections.js";
import { boxGatewaySession, describeSessionSources, jwtClaims, loadCursorAuth, loadGatewayDescriptor, redact, resolveGatewaySession } from "./session.js";
import { createHash } from "node:crypto";
import { DENIED_FOR_AGENTS, audit, auditPath, enforce, resolvePolicy } from "./policy.js";

const VERSION = "0.1.0";

// ------------------------------------------------------------------ context helpers
let _gw = null;
/** Test hook: pin the Gateway the commands use (null resets). */
export function setGatewayForTests(gw) {
  _gw = gw;
}
async function gateway(opts) {
  if (_gw) return _gw;
  const session = await resolveGatewaySession({ accountScope: opts.account ?? null, prefer: opts.ensure ? "ensure" : "auto" });
  _gw = new Gateway(session, { runtime: runtimeClientFor(opts) });
  return _gw;
}
/**
 * The control-plane client a Gateway uses for sections, pins and auto-review (their primary store is the Cursor runtime
 * store). Null when the agent policy is active: an agent never writes with the Mac's Cursor token, even on a machine
 * where one happens to be readable (GROKBOT_POLICY=agent off-box); it edits host settings only. Also null when nobody
 * is signed in or the secret store is unreadable.
 */
export function runtimeClientFor(opts = {}, env = process.env) {
  if (resolvePolicy(env) === "agent") return null;
  try {
    const auth = loadCursorAuth({ accountScope: opts.account ?? null });
    return auth ? new CursorClient(auth) : null;
  } catch {
    return null; // unreadable secret store: fall back to host settings
  }
}
// Box gateway for the routines merge; routines are control-plane first, so a missing/failed session is a note, not an error.
async function optionalGateway(cmd) {
  try {
    return await gateway(cmd.optsWithGlobals());
  } catch (e) {
    process.stderr.write(`grokbot: gateway unavailable, listing control-plane routines only: ${e.message}\n`);
    return null;
  }
}
const localTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};
let _slackPollMs = null;
/** Test hook: override the `slack connect --wait` poll interval in ms (null resets to 5000). */
export function setSlackPollMsForTests(ms) {
  _slackPollMs = ms;
}
const SLACK_TEAM_ID = /^[TE][A-Z0-9]{5,}$/;
const SLACK_STATE_CONCURRENCY = 6;
let _cursorForTests = null;
/** Test hook: pin the CursorClient `cursor()` returns (null resets). */
export function setCursorForTests(c) {
  _cursorForTests = c;
}
function cursor(opts) {
  if (_cursorForTests) return _cursorForTests;
  const auth = loadCursorAuth({ accountScope: opts.account ?? null });
  if (!auth) throw new UsageError("No Cursor account found in the Grok Bot secret store. Sign in to Grok Bot first.");
  return new CursorClient(auth);
}
/**
 * The Cursor client for control-plane agent deletes and the roster check. Null under the agent policy (never the Mac's
 * token, even off-box) and when nobody is signed in.
 */
function controlPlaneClient(opts, env = process.env) {
  if (resolvePolicy(env) === "agent") return null;
  try {
    return cursor(opts);
  } catch {
    return null;
  }
}
/**
 * Send one message. Operator policy goes through the control plane (SendGrokBotUserMessage): since app 0.79 the host
 * gateway's sendPrompt rejects a Mac-side caller with 502 "A Sand box session may not make this request". Without a
 * Cursor sign-in, or under the agent policy (a box session, which is what the host accepts), it uses the gateway and turns
 * that 502 into a plain explanation. Returns { via, sentAt, ... } with the transport's own reply fields.
 */
export async function sendMessage(opts, gw, agent, prompt, { replyToId } = {}, { cursorClient } = {}) {
  let c = cursorClient ?? null;
  if (!c && resolvePolicy() !== "agent") {
    try {
      c = cursor(opts);
    } catch {
      c = null; // not signed in: fall back to the gateway
    }
  }
  if (c) {
    const sentAt = Date.now();
    const r = await c.sendUserMessage(agent.id, prompt, { sentAtMs: sentAt, replyToId });
    if (r.dispatched === false || r.refusal) {
      const err = new Error(`send refused by the control plane: ${enumName(r.refusal) !== "UNSPECIFIED" ? enumName(r.refusal) : "dispatched=false"}`);
      err.exitCode = 1;
      throw err;
    }
    return { via: "control-plane", dispatched: r.dispatched, mode: r.mode ? String(r.mode).replace(/^.*?MODE_/, "") : null, workflowId: r.workflowId ?? null, messageId: r.messageId, sentAt };
  }
  try {
    return { via: "gateway", ...(await gw.sendPrompt(agent.id, prompt, { replyToId })) };
  } catch (e) {
    if (e?.status === 502 && /may not make this request/i.test(e.message)) {
      const err = new Error(`${e.message}\nThe host (app 0.79+) only accepts sendPrompt from a session it considers the agent's own; ${resolvePolicy() === "agent" ? "an operator can send from the Mac (`grokbot agents send`), which uses the control plane" : "sign in to Grok Bot so grokbot can send through the control plane"}.`);
      err.exitCode = 1;
      throw err;
    }
    throw e;
  }
}
function globalOpts(cmd) {
  let c = cmd;
  while (c.parent) c = c.parent;
  return c.opts();
}
function out(cmd, value, human) {
  if (globalOpts(cmd).json) printJson(value);
  else process.stdout.write(typeof human === "function" ? human(value) : human ?? String(value) + "\n");
}
function readLines(file) {
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

const selectionOptions = (cmd) =>
  cmd
    .option("--name <glob>", "name glob, case-insensitive (e.g. 'test-*')")
    .option("--match <text>", "substring in name/description/title")
    .option("--regex <re>", "name regex")
    .option("--hidden", "only agents hidden from the sidebar")
    .option("--all", "include hidden agents")
    .option("--groups", "only group chats")
    .option("--no-groups", "exclude group chats")
    .option("--running", "only agents mid-turn")
    .option("--idle", "only agents not mid-turn")
    .option("--unread", "only agents with unread messages")
    .option("--awaiting", "only agents awaiting a user response")
    .option("--idle-for <dur>", "no activity for at least <dur> (30m, 12h, 7d, 2w)")
    .option("--created-before <dur>", "created more than <dur> ago")
    .option("--created-after <dur>", "created within the last <dur>")
    .option("--section <ref>", "in section (id or name), or 'none' for unsectioned")
    .option("--ids-file <file>", "file with one agent id/name per line");

export function selectionFromOpts(o, sections) {
  const f = {
    name: o.name,
    match: o.match,
    regex: o.regex,
    hidden: o.hidden ? true : undefined,
    includeHidden: Boolean(o.all || o.hidden),
    groups: o.groups === true ? true : o.groups === false ? false : undefined,
    running: o.running,
    idle: o.idle,
    unread: o.unread,
    awaiting: o.awaiting,
    idleFor: o.idleFor ? parseDuration(o.idleFor) : undefined,
    createdBefore: o.createdBefore ? parseDuration(o.createdBefore) : undefined,
    createdAfter: o.createdAfter ? parseDuration(o.createdAfter) : undefined,
  };
  if (o.section !== undefined) f.section = o.section === "none" ? "none" : S.requireSection(sections, o.section).id;
  return f;
}
export function hasSelectionFlags(o) {
  return ["name", "match", "regex", "hidden", "running", "idle", "unread", "awaiting", "idleFor", "createdBefore", "createdAfter", "section", "idsFile"].some((k) => o[k] !== undefined && o[k] !== false) || o.groups !== undefined;
}

/** Resolve positional refs and/or selection flags into concrete roster rows. */
async function selectAgents(gw, refs, o, { requireSome = true, strict = false } = {}) {
  const roster = await gw.listAgents({ fresh: true });
  const sections = o.section !== undefined ? await gw.getSections() : [];
  const allRefs = [...(refs ?? []), ...(o.idsFile ? readLines(o.idsFile) : [])];
  let rows;
  if (allRefs.length > 0) {
    rows = resolveMany(roster, allRefs, { strict });
    if (hasSelectionFlags({ ...o, idsFile: undefined })) {
      const keep = new Set(filterAgents(roster, { ...selectionFromOpts(o, sections), includeHidden: true }, sections).map((a) => a.id));
      rows = rows.filter((a) => keep.has(a.id));
    }
  } else if (hasSelectionFlags(o)) {
    rows = filterAgents(roster, selectionFromOpts(o, sections), sections);
  } else {
    throw new UsageError("Give agent refs (id, id prefix, or name) or selection flags like --name/--match/--section/--idle-for.");
  }
  if (requireSome && rows.length === 0) throw new UsageError("No agents matched.");
  return { rows, roster, sections };
}

const CONTROL_PLANE_LIST_TIMEOUT_MS = 5000;
/**
 * One control-plane roster read for absence checks. `complete` is true only when the read was not truncated and returned at
 * least one agent; anything else (empty, truncated) cannot prove an agent is gone. Same scope as the delete (includeTeamAgents).
 */
async function readControlPlaneRoster(c, { timeoutMs } = {}) {
  const r = await c.listAgents(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {});
  const live = new Set((r.agents ?? []).map((a) => a.agentId).filter(Boolean));
  return { live, truncated: Boolean(r.truncated), complete: !r.truncated && live.size > 0 };
}

/** Host roster ids that the control plane does not list (a stale mirror of a deleted agent). Empty unless the read is complete. */
async function staleHostAgentIds(opts, roster) {
  const c = controlPlaneClient(opts);
  if (!c) return new Set();
  try {
    const { live, complete } = await readControlPlaneRoster(c, { timeoutMs: CONTROL_PLANE_LIST_TIMEOUT_MS });
    if (!complete) return new Set(); // empty or truncated reads are not proof that an agent is gone
    return new Set(roster.filter((a) => !live.has(a.id)).map((a) => a.id));
  } catch {
    return new Set();
  }
}

function agentTable(rows, sections = []) {
  const byAgent = S.sectionIdByAgent(sections);
  const secName = new Map(sections.map((s) => [s.id, s.name]));
  return table(rows, [
    { key: "id", label: "id", format: (v) => shortId(v) },
    { key: "name", label: "name", max: 34 },
    { label: "state", get: agentState },
    { label: "unread", get: (a) => (a.unreadCount ? String(a.unreadCount) : a.hasUnread ? "•" : "") },
    { label: "active", get: (a) => relTime(a.lastActivityAt ?? a.updatedAt) },
    { label: "created", get: (a) => relTime(a.createdAt) },
    { label: "section", get: (a) => secName.get(byAgent.get(a.id)) ?? "" },
    { label: "flags", get: (a) => [a.isGroup && "group", a.isHiddenFromSidebar && "hidden", a.awaitingUserResponse && "awaiting", a.deletedOnControlPlane && "(deleted?)"].filter(Boolean).join(",") },
    { key: "lastMessagePreview", label: "last message", max: 48 },
  ]);
}

export async function confirmDestructive(cmd, rows, o, { verb, noun = "agent", requireCount = true }) {
  const g = globalOpts(cmd);
  if (!g.json) process.stdout.write(agentTable(rows));
  const summary = `${verb} ${pluralize(rows.length, noun)}`;
  if (o.dryRun) {
    out(cmd, { dryRun: true, count: rows.length, ids: rows.map((r) => r.id) }, `dry run: would ${summary}. Re-run with --yes${requireCount && rows.length > 1 ? ` --confirm-count ${rows.length}` : ""}.\n`);
    return false;
  }
  if (!o.yes) {
    const err = new UsageError(`Refusing to ${summary} without --yes${requireCount && rows.length > 1 ? ` --confirm-count ${rows.length}` : ""}.`);
    err.exitCode = 3;
    throw err;
  }
  if (requireCount && rows.length > 1 && Number(o.confirmCount) !== rows.length) {
    const err = new UsageError(`${rows.length} targets matched; pass --confirm-count ${rows.length} to confirm the exact count.`);
    err.exitCode = 3;
    throw err;
  }
  return true;
}

/** How many transcript entries `send --wait` scans for the reply (a long turn can emit many tool entries). */
export const WAIT_TRANSCRIPT_WINDOW = 200;
const FALLBACK_TAIL = 20;
function entryTime(e) {
  const t = Number(e?.createdAt ?? e?.at ?? e?.timestamp ?? e?.createdAtMs);
  return Number.isFinite(t) && t > 0 ? t : null;
}
function entryText(e) {
  return local.transcriptText({ entries: [e] })[0]?.text ?? "";
}
function isUserEntry(e) {
  const who = String(e?.role ?? e?.author ?? e?.authorKind ?? e?.kind ?? e?.type ?? "").toLowerCase();
  return who === "" || who === "user" || who === "human";
}
const SENT_SLACK_MS = 2000;
/**
 * Entries from the sent message onward. Anchors on the sent message itself: the entry id returned by send or the clientNonce
 * (both clock-independent), else the last user entry whose text equals the prompt. A prompt-text match must be no older than
 * the send (sentAt minus 2s slack) or carry no timestamp, so the same prompt sent earlier never anchors on the old turn.
 * Falls back to timestamps (2s slack) and then to the last few entries. Untimestamped entries after the anchor are kept.
 */
export function entriesSince(entries, sentAt, sent = {}) {
  const { nonce, prompt, entryIds = [] } = sent;
  const want = typeof prompt === "string" ? prompt.trim() : "";
  const ids = entryIds.filter(Boolean).map(String);
  let anchor = -1;
  for (let i = entries.length - 1; i >= 0 && anchor < 0; i--) {
    const e = entries[i];
    if (ids.length && e?.id != null && ids.includes(String(e.id))) anchor = i;
    else if (typeof nonce === "string" && nonce.length >= 8 && JSON.stringify(e ?? null).includes(nonce)) anchor = i;
    else if (want && isUserEntry(e) && entryText(e).trim() === want && (entryTime(e) === null || entryTime(e) >= sentAt - SENT_SLACK_MS)) anchor = i;
  }
  if (anchor >= 0) return entries.slice(anchor);
  if (entries.some((e) => entryTime(e) !== null)) {
    const since = entries.filter((e) => (entryTime(e) ?? 0) >= sentAt - SENT_SLACK_MS);
    if (since.length) return since;
  }
  return entries.slice(-FALLBACK_TAIL);
}
/** Parse a `--timeout <sec>` option for cdp calls into milliseconds (undefined when not given). */
function cdpTimeoutMs(o) {
  if (o?.timeout === undefined) return undefined;
  const sec = Number(o.timeout);
  if (!(Number.isFinite(sec) && sec > 0)) throw new UsageError(`--timeout must be a positive number of seconds (got "${o.timeout}").`);
  const ms = Math.round(sec * 1000);
  if (ms > MAX_TIMER_MS) throw new UsageError(`--timeout is too large (max ${Math.floor(MAX_TIMER_MS / 1000)} seconds; got "${o.timeout}").`);
  return ms;
}

function tailEntries(data) {
  const entries = Array.isArray(data) ? data : data?.entries ?? data?.rows ?? data?.items ?? data?.transcript ?? [];
  return Array.isArray(entries) ? entries : [];
}
function formatEntry(e) {
  const flat = local.transcriptText({ entries: [e] })[0];
  const when = e.createdAt ?? e.at ?? e.timestamp ?? e.createdAtMs;
  const who = e.role ?? e.author ?? e.authorKind ?? e.kind ?? e.type ?? "?";
  const text = flat?.text ?? "";
  return `${when ? new Date(Number(when)).toISOString().slice(11, 19) : "        "} ${String(who).padEnd(10)} ${text.replace(/\s+/g, " ").slice(0, 400)}`;
}

const PINS_HOST_ONLY_NOTE =
  "grokbot: note: wrote the host pins setting only (no Cursor sign-in here). The 0.79+ app reads pins from the Cursor runtime store first and ignores this list while it holds any, so the app may not show the change; pin from the Mac (`grokbot pins add`) or the app UI.\n";

const HOST_ONLY_NOTE =
  "grokbot: note: wrote the host mirror only (no Cursor sign-in here). The app shows it after the Mac runs `grokbot sections sync` (auto-sync runs every 2 min). Check with `grokbot sections verify`.\n";

/** Compare the app store and the host mirror: { runtime, host, drift, snapshot, mirrorMatchesSnapshot, diff, inSync, state }; inSync/mirrorMatchesSnapshot are null (state "unknown") with no runtime and no snapshot. */
export function describeSectionStores(stores) {
  const hostUser = userSections(stores.host);
  const snapshot = stores.snapshot ?? null;
  // No app store and no reachable snapshot (a box): sync state is unknown, not pending.
  const unknown = !stores.runtime && !snapshot;
  const mirrorMatchesSnapshot = unknown ? null : snapshot ? sectionsKey(hostUser) === snapshot.key : hostUser.length === 0;
  const diff = stores.runtime ? S.sectionsDiff(userSections(stores.runtime), hostUser) : null;
  const inSync = unknown ? null : stores.runtime ? stores.drift === false : mirrorMatchesSnapshot;
  const state = inSync === null ? "unknown" : inSync ? "in-sync" : "pending";
  return { runtime: stores.runtime, host: stores.host, drift: stores.drift, snapshot, mirrorMatchesSnapshot, diff, inSync, state };
}

/** --dry-run always previews (even with --auto/--yes); otherwise --auto and --yes apply, and a bare `sync` previews. */
export function sectionsSyncMode(o) {
  return o.dryRun || (!o.auto && !o.yes) ? "preview" : "apply";
}

function renderSectionStores(d) {
  const col = (list) => (list.length ? userSections(list).map((s, i) => `  ${i + 1}. ${s.name} (${pluralize(s.agentIds.length, "agent")})`).join("\n") : "  (none)") + "\n";
  let t = "";
  if (d.runtime) t += `app store (Cursor runtime):\n${col(d.runtime)}`;
  t += `host mirror:\n${col(d.host)}`;
  if (d.runtime) {
    t += d.drift ? `DRIFT (app -> host mirror):\n${d.diff.map((x) => "  " + x).join("\n")}${d.diff.length ? "\n" : "  (same sections, different order)\n"}` : "in sync\n";
  } else if (d.state === "unknown") {
    t += "app store not reachable from here; sync state unknown (the Mac auto-syncs every 2 min; check there with `grokbot sections verify`)\n";
  } else {
    t += `app store not reachable from here; host mirror shown; last Mac sync ${d.snapshot?.at ?? "never"}; mirror matches last sync: ${d.mirrorMatchesSnapshot ? "yes" : "no"}\n`;
  }
  return t;
}

async function showSectionStores(cmd, gw, { setExit }) {
  const d = describeSectionStores(await gw.sectionStores());
  out(cmd, { ...d, inSync: d.inSync }, renderSectionStores(d));
  if (setExit && d.inSync === false) process.exitCode = 1;
}

async function writeSections(cmd, gw, before, after, label) {
  const saved = await gw.setSections(S.normalizeSections(after));
  const diff = S.sectionsDiff(before, saved);
  const hostOnly = gw.hostOnly === true;
  out(cmd, { ok: true, sections: saved, changes: diff, ...(hostOnly ? { store: "host-mirror", pendingSync: true } : {}) }, `${label}\n${diff.map((d) => "  " + d).join("\n")}${diff.length ? "\n" : ""}`);
  if (hostOnly) process.stderr.write(HOST_ONLY_NOTE);
  await nudgeRenderer();
}
/** Test seam: the renderer-nudge dependencies. */
export const nudgeDeps = { appState, connect: (o) => Cdp.connect(o) };
async function nudgeRenderer() {
  // Under the agent policy `cdp` is denied, so the nudge (a CDP call) must not run either.
  if (resolvePolicy() === "agent") return;
  // The desktop app re-reads its sidebar sections (Cursor runtime settings) on window focus/reconnect; asking the
  // renderer for main.getHostSidebarSections over CDP is the cheapest nudge.
  try {
    const st = await nudgeDeps.appState();
    if (!st.cdpReachable) return;
    const cdp = await nudgeDeps.connect({ port: st.debugPort });
    await cdp.sidebarSections().catch(() => {});
    cdp.close();
  } catch {}
}

// ------------------------------------------------------------------ program
export function buildProgram() {
  const program = new Command("grokbot")
    .description("Operate Cursor's Grok Bot desktop app: agents, sections, pins, transcripts, host gateway, Cursor RPC, Electron CDP.")
    .version(VERSION)
    .option("--json", "machine-readable output")
    .option("--account <scope>", "Cursor account scope (when more than one is signed in)")
    .option("--ensure", "skip the app's cached gateway descriptor and mint a session via EnsureSandBox")
    .showHelpAfterError();
  // Policy gate: runs before every leaf action. Inside a Grok Bot box (or GROKBOT_POLICY=agent) the
  // destructive / low-level command families are refused and every invocation is audited.
  program.hook("preAction", (_thisCommand, actionCommand) => {
    enforce(actionCommand, process.argv.slice(2));
  });

  program
    .command("policy")
    .description("Show the active execution policy (operator or agent) and what the agent policy denies")
    .action((_, cmd) => {
      const policy = resolvePolicy();
      const box = boxGatewaySession();
      out(cmd, { policy, insideBox: Boolean(box), boxGateway: box?.path ?? null, denied: DENIED_FOR_AGENTS, auditLog: auditPath() }, () =>
        `policy    ${policy}${box ? `  (box gateway ${box.path})` : ""}\naudit log ${auditPath()}\n${policy === "agent" ? "denied    " + DENIED_FOR_AGENTS.join(", ") + "\n" : "denied    (nothing; operator mode)\n"}`);
    });

  // ---- doctor / status
  program
    .command("doctor")
    .description("Check every control surface: app, Keychain, gateway descriptor, host health, Cursor token, CDP")
    .action(async (_, cmd) => {
      const report = { policy: resolvePolicy(), sources: describeSessionSources(), app: await appState(), gateway: null, host: null, cursor: null };
      // Descriptor and host are checked separately: a descriptor/Keychain failure must not blank the host line (the host
      // is still reachable through EnsureSandBox), and a host failure must not hide that the descriptor decrypted fine.
      let desc = null;
      try {
        desc = boxGatewaySession() ?? loadGatewayDescriptor();
        report.gateway = desc
          ? { source: desc.source, host: new URL(desc.baseUrl).host, savedAt: desc.savedAtMs ? new Date(desc.savedAtMs).toISOString() : null, headers: Object.keys(desc.headers), entries: desc.entryCount ?? null, fileVersion: desc.fileVersion ?? null, path: desc.path ?? null }
          : { source: null, error: "no descriptor" };
      } catch (err) {
        report.gateway = { source: null, error: redact(err.message), code: err.code ?? null };
      }
      try {
        const session = desc ?? (await resolveGatewaySession());
        if (!desc) report.gateway = { ...report.gateway, fallback: { source: session.source, host: new URL(session.baseUrl).host } };
        const gw = new Gateway(session);
        const [health, status, count] = await Promise.all([gw.health(), gw.hostStatus(), gw.countAgents()]);
        report.host = { ok: health.ok, pid: health.pid, busy: health.isBusy, activeAgentId: health.activeAgentId, hostVersion: status.hostVersion, updateAvailable: status.hostUpdateAvailable, capabilities: status.capabilities, agents: count };
      } catch (err) {
        report.host = { error: redact(err.message) };
      }
      // The `cursor` command family is denied under agent policy (control-plane access is a
      // Mac/operator surface); doctor must not become a sibling path to the same data.
      if (report.policy === "agent") {
        report.cursor = { skipped: "cursor control-plane is not available under the agent policy" };
      } else {
        try {
          const c = cursor(cmd.optsWithGlobals());
          report.cursor = c.tokenInfo();
          const st = await c.runState();
          report.cursor.boxState = st.state;
          report.cursor.imageUpdateAvailable = st.imageUpdateAvailable ?? null;
        } catch (err) {
          report.cursor = { error: redact(err.message) };
        }
      }
      out(cmd, report, () => {
        const L = [];
        L.push(`policy     ${report.policy}${report.gateway?.source === "box" ? `  (inside box via ${report.gateway.path})` : ""}`);
        L.push(`app        ${report.app.running ? `running pid ${report.app.pid}` : "not running"} v${report.sources.appVersion ?? "?"}  cdp ${report.app.cdpReachable ? `on :${report.app.debugPort}` : "off (grokbot app restart --debug)"}`);
        const g = report.gateway ?? {};
        L.push(
          `keychain   ${g.source ? "ok" : g.code ? `ERROR ${g.error}` : "n/a (no gateway-descriptor.json; the app has not cached one)"}${g.source ? `  descriptor ${g.source === "box" ? g.path : `v${g.fileVersion ?? "?"}, ${g.entries ?? 0} entr${g.entries === 1 ? "y" : "ies"}, saved ${g.savedAt ?? "?"}`}` : g.fallback ? `  (host resolved via ${g.fallback.source})` : ""}`,
        );
        const hostName = g.host ?? g.fallback?.host ?? "(unresolved)";
        L.push(report.host?.error ? `host       ${hostName}  ERROR ${report.host.error}` : `host       ${hostName}  ok=${report.host.ok} busy=${report.host.busy} version=${report.host.hostVersion}${report.host.updateAvailable ? " (update available)" : ""} agents=${report.host.agents}`);
        L.push(
          report.cursor?.skipped
            ? `cursor     skipped (${report.cursor.skipped})`
            : report.cursor?.error
              ? `cursor     ERROR ${report.cursor.error}`
              : `cursor     ${report.cursor.email ?? report.cursor.subject}  token exp ${report.cursor.expiresAt}${report.cursor.expired ? " EXPIRED" : ""}  box ${report.cursor.boxState}`,
        );
        return L.join("\n") + "\n";
      });
    });

  program
    .command("status")
    .description("Host health plus roster counts")
    .action(async (_, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const [health, roster, sections] = await Promise.all([gw.health(), gw.listAgents({ fresh: true }), gw.getSections()]);
      const running = roster.filter((a) => a.isRunningTurn || a.isRunning);
      const unread = roster.filter((a) => a.hasUnread || a.unreadCount > 0);
      const hidden = roster.filter((a) => a.isHiddenFromSidebar);
      const groups = roster.filter((a) => a.isGroup);
      const liveIds = new Set(roster.map((a) => a.id));
      const memberIds = [...S.sectionIdByAgent(sections).keys()];
      const sectioned = memberIds.filter((id) => liveIds.has(id)).length;
      const staleMemberships = memberIds.length - sectioned;
      const summary = { host: { ok: health.ok, busy: health.isBusy, activeAgentId: health.activeAgentId, startedAt: new Date(health.startedAt).toISOString() }, agents: roster.length, groups: groups.length, running: running.length, unread: unread.length, hidden: hidden.length, sections: sections.length, sectioned, staleMemberships, unsectioned: roster.length - sectioned, runningAgents: running.map((a) => ({ id: a.id, name: a.name })) };
      out(cmd, summary, () => `host ok=${health.ok} busy=${health.isBusy} up ${relTime(health.startedAt)}\nagents ${roster.length} (${groups.length} groups, ${hidden.length} hidden) · running ${running.length} · unread ${unread.length}\nsections ${sections.length} · sectioned ${sectioned} · unsectioned ${roster.length - sectioned}${staleMemberships ? ` · ${staleMemberships} stale membership(s) (grokbot sections prune)` : ""}\n${running.map((a) => `  running: ${a.name} (${shortId(a.id)})`).join("\n")}${running.length ? "\n" : ""}`);
    });

  // ---- agents
  const agents = program.command("agents").alias("a").description("List, inspect, create, edit, hide, and delete agents (chats)");

  selectionOptions(agents.command("list").alias("ls").description("List agents (hidden excluded unless --all/--hidden)"))
    .option("--sort <by>", "activity|created|name|unread", "activity")
    .option("--limit <n>", "max rows")
    .option("--ids", "print ids only")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const [roster, sections] = await Promise.all([gw.listAgents({ fresh: true }), gw.getSections()]);
      // The host mirror lags control-plane deletes by minutes. Mark roster rows the control plane no longer lists so a deleted
      // agent is not presented as live. Best effort: no Cursor sign-in, agent policy, or a failed/empty read means no marks.
      const gone = await staleHostAgentIds(cmd.optsWithGlobals(), roster);
      let rows = sortAgents(filterAgents(roster, selectionFromOpts(o, sections), sections), o.sort).map((a) => (gone.has(a.id) ? { ...a, deletedOnControlPlane: true } : a));
      if (o.idsFile) {
        const keep = new Set(resolveMany(roster, readLines(o.idsFile)).map((a) => a.id));
        rows = rows.filter((a) => keep.has(a.id));
      }
      if (o.limit) rows = rows.slice(0, Number(o.limit));
      if (o.ids) return process.stdout.write(rows.map((a) => a.id).join("\n") + (rows.length ? "\n" : ""));
      out(cmd, rows, () => agentTable(rows, sections) + `${rows.length} of ${roster.length}\n` + (rows.some((a) => a.deletedOnControlPlane) ? "(deleted?) = not on the Cursor control plane; the host roster is a stale mirror of a deleted agent\n" : ""));
    });

  agents
    .command("get <ref>")
    .description("Show one agent's full roster row")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const sections = await gw.getSections();
      const sec = sections.find((s) => s.agentIds.includes(a.id));
      out(cmd, { ...a, section: sec ? { id: sec.id, name: sec.name } : null }, () => {
        const skip = new Set(["avatarDataUrl", "pushMessageContent"]);
        return Object.entries({ ...a, section: sec?.name ?? null }).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`.slice(0, 300)).join("\n") + "\n";
      });
    });

  agents
    .command("search <query>")
    .description("Host-side search across agents (names, descriptions, transcripts)")
    .option("--limit <n>", "max results", "50")
    .option("--agent <ref>", "search only inside this agent's conversation (host searchConversation)")
    .action(async (query, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const r = o.agent
        ? await gw.searchConversation(resolveAgent(await gw.listAgents({ fresh: true }), o.agent).id, query, Number(o.limit))
        : await gw.searchAgents(query, Number(o.limit));
      out(cmd, r, () => JSON.stringify(r, null, 2) + "\n");
    });

  agents
    .command("create <name>")
    .description("Create a new agent (chat)")
    .option("-d, --description <text>", "instructions / description", "")
    .option("--title <text>")
    .option("--purpose <text>")
    .option("--shape <shape>", "avatar shape")
    .option("--color <color>", "avatar color")
    .option("--section <ref>", "put the new agent into this section")
    .option("--no-intro", "suppress the introduction message")
    .option("--kickstart", "ask the agent to start working immediately")
    .action(async (name, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      // Validate the target section before creating anything, so a bad --section cannot leave an orphan agent.
      const sectionName = o.section ? S.requireSection(await gw.getSections(), o.section).name : null;
      const created = await gw.createAgent({ name, description: o.description, title: o.title, purpose: o.purpose, avatarShape: o.shape, avatarColor: o.color, isIntroductionSuppressed: o.intro === false ? true : undefined, isKickstartRequested: o.kickstart || undefined });
      const id = created?.id ?? created?.agentId ?? created?.agent?.id;
      if (o.section && !id) {
        out(cmd, created, `created ${name} (no id in the create response)\n`);
        throw new Error(`Agent "${name}" was created but the response had no id, so it was NOT placed in section "${sectionName}". Find it with \`grokbot agents list\` and use \`grokbot sections move\`.`);
      }
      if (o.section && id) {
        const before = await gw.getSections();
        await gw.setSections(S.assignAgents(before, o.section, [id]));
      }
      out(cmd, created, `created ${name} ${id ?? ""}${sectionName ? ` → section ${sectionName}` : ""}\n`);
    });

  agents
    .command("rename <ref> <name>")
    .description("Rename an agent")
    .action(async (ref, name, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      await gw.updateAgent(a.id, { name, description: a.description ?? "" });
      out(cmd, { id: a.id, from: a.name, to: name }, `renamed ${shortId(a.id)} "${a.name}" → "${name}"\n`);
    });

  agents
    .command("update <ref>")
    .description("Update profile fields")
    .option("--name <text>")
    .option("-d, --description <text>")
    .option("--title <text>")
    .option("--shape <shape>")
    .option("--color <color>")
    .option("--notify-updates <on|off>", "notify on agent updates")
    .option("--notify <on|off>", "removed in app 0.79 (use --notify-updates)")
    .action(async (ref, o, cmd) => {
      if (o.notify !== undefined) throw new UsageError("--notify was removed in app 0.79: the host no longer has setAgentNotificationsEnabled. Use --notify-updates <on|off>.");
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const profile = { name: o.name ?? a.name, description: o.description ?? a.description ?? "" };
      if (o.title !== undefined) profile.title = o.title;
      if (o.shape !== undefined) profile.avatarShape = o.shape;
      if (o.color !== undefined) profile.avatarColor = o.color;
      if (o.name !== undefined || o.description !== undefined || o.title !== undefined || o.shape !== undefined || o.color !== undefined) await gw.updateAgent(a.id, profile);
      if (o.notifyUpdates) await gw.setNotifyOnUpdates(a.id, o.notifyUpdates === "on");
      out(cmd, { id: a.id, profile }, `updated ${a.name} (${shortId(a.id)})\n`);
    });

  for (const [verb, flag] of [["hide", true], ["unhide", false]]) {
    selectionOptions(agents.command(`${verb} [refs...]`).description(`${verb === "hide" ? "Hide" : "Unhide"} agents ${verb === "hide" ? "from" : "in"} the sidebar`)).action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const { rows } = await selectAgents(gw, refs, { ...o, all: true });
      for (const a of rows) await gw.setHidden(a.id, flag);
      out(cmd, { ok: true, ids: rows.map((a) => a.id) }, `${verb}: ${rows.map((a) => a.name).join(", ")}\n`);
    });
  }
  for (const [verb, flag] of [["read", false], ["unread", true]]) {
    selectionOptions(agents.command(`${verb} [refs...]`).description(`Mark agents ${verb}`)).action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const { rows } = await selectAgents(gw, refs, o);
      for (const a of rows) await gw.setUnread(a.id, flag);
      out(cmd, { ok: true, ids: rows.map((a) => a.id) }, `marked ${verb}: ${rows.length}\n`);
    });
  }

  agents
    .command("duplicate <ref>")
    .description("Clone an agent (profile, settings, memory store; conversation cleared)")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const r = await gw.duplicateAgent(a.id);
      out(cmd, r, `duplicated ${a.name} → ${r?.id ?? JSON.stringify(r)}\n`);
    });

  agents
    .command("interrupt <ref>")
    .description("Interrupt the agent's current run")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const r = await gw.interrupt(a.id);
      out(cmd, r ?? { ok: true }, `interrupted ${a.name}\n`);
    });

  selectionOptions(agents.command("delete [refs...]").alias("rm").description("Delete agents (full id or exact name only; no prefix matching) via the Cursor control plane (needs the owner's sign-in), verified against ListGrokBotAgents. Prints the exact targets; needs --yes (and --confirm-count N for more than one)"))
    .option("--dry-run", "list targets and exit")
    .option("--yes", "actually delete")
    .option("--confirm-count <n>", "must equal the number of matched targets when deleting more than one")
    .option("--batch <n>", "ids per host deleteAgents call when mirroring (control-plane deletes are one RPC per agent)", "25")
    .option("--allow-empty", "allow the host mirror delete to empty the whole roster")
    .action(async (refs, o, cmd) => {
      const opts = cmd.optsWithGlobals();
      const gw = await gateway(opts);
      const { rows, roster } = await selectAgents(gw, refs, { ...o, all: true }, { strict: true });
      if (!(await confirmDestructive(cmd, rows, o, { verb: "delete" }))) return;
      // Since app 0.79 the host's deleteAgents is a silent no-op for server-hosted agents; the control plane owns the delete.
      const c = controlPlaneClient(opts);
      if (!c) {
        const agentPolicy = resolvePolicy() === "agent";
        const err = new UsageError(`Deleting agents needs the owner's Cursor sign-in (control-plane DeleteGrokBotAgent); ${agentPolicy ? "the agent policy has no Cursor client" : "no Cursor account is signed in here"}. The host cannot delete them. Nothing was deleted; an operator runs this from the Mac.`);
        err.exitCode = agentPolicy ? 77 : 1;
        throw err;
      }
      const ids = rows.map((a) => a.id);
      if (!o.allowEmpty && roster.length > 0 && ids.length >= roster.length) {
        const err = new UsageError(`This would delete every agent on the roster (${ids.length}). Pass --allow-empty to confirm. Nothing was deleted.`);
        err.exitCode = 3;
        throw err;
      }
      const rpcErrors = {};
      const attempted = [];
      let aborted = null;
      for (const [i, id] of ids.entries()) {
        try {
          await c.deleteAgent(id);
          attempted.push(id);
        } catch (e) {
          rpcErrors[id] = redact(e.message);
          // Auth failure or rate limit: every remaining call would fail the same way.
          if ([401, 403, 429].includes(e?.status)) {
            aborted = e.status;
            for (const rest of ids.slice(i + 1)) rpcErrors[rest] = `not attempted (stopped after HTTP ${e.status})`;
            process.stderr.write(`grokbot: stopping: DeleteGrokBotAgent returned HTTP ${e.status}\n`);
            break;
          }
        }
        process.stderr.write(`delete requested ${i + 1}/${ids.length}\n`);
      }
      // Trust the control plane's roster, not the RPC reply: report deleted only for ids whose delete RPC succeeded and that are
      // gone from a complete, non-empty read. An empty/truncated/failed read, or an id whose RPC failed, never counts.
      let present;
      let unverified = null;
      try {
        const r = await readControlPlaneRoster(c);
        present = r.live;
        if (r.truncated) unverified = "ListGrokBotAgents was truncated";
        else if (r.live.size === 0) unverified = "ListGrokBotAgents returned no agents";
      } catch (e) {
        unverified = `ListGrokBotAgents failed: ${redact(e.message)}`;
      }
      if (unverified) {
        const err = new Error(`could not verify the delete: ${unverified}. Nothing was mirrored on the host; re-check with \`grokbot cursor agents\` before retrying.${aborted ? ` (The delete loop stopped early on HTTP ${aborted}.)` : ""}`);
        err.exitCode = 1;
        throw err;
      }
      const deleted = attempted.filter((id) => !present.has(id));
      const stillPresent = ids.filter((id) => present.has(id));
      const failed = ids.filter((id) => !deleted.includes(id) && !present.has(id));
      let hostMirror = { removed: false };
      let sectionsUpdated = false;
      if (deleted.length) {
        // Best effort: the host's bulk deleteAgents is the only mirror-removal command (docs/host-commands.md); it may be a no-op,
        // and the app's roster catches up on its own, so a failure here is a note, not an error.
        try {
          const batch = Math.max(1, Number(o.batch));
          for (let i = 0; i < deleted.length; i += batch) await gw.deleteAgents(deleted.slice(i, i + batch), { allowEmptyRoster: Boolean(o.allowEmpty) });
          hostMirror = { removed: true };
        } catch (e) {
          hostMirror = { removed: false, error: redact(e.message) };
        }
        // Drop only the deleted ids from sections; other stale memberships are left for `sections prune`.
        try {
          // Refetch: a snapshot taken before the delete can be stale by now, and writing it back would clobber concurrent section edits.
          const current = await gw.getSections();
          const deletedSet = new Set(deleted);
          sectionsUpdated = current.some((s) => s.agentIds.some((id) => deletedSet.has(id)));
          if (sectionsUpdated) await gw.setSections(S.assignAgents(current, null, deleted));
        } catch (e) {
          hostMirror = { ...hostMirror, sectionsError: redact(e.message) };
        }
      }
      const name = new Map(rows.map((a) => [a.id, a.name]));
      if (stillPresent.length || failed.length) process.exitCode = 1;
      out(
        cmd,
        { ok: stillPresent.length === 0 && failed.length === 0, deleted, stillPresent: stillPresent.map((id) => ({ id, name: name.get(id) ?? null, ...(rpcErrors[id] ? { error: rpcErrors[id] } : {}) })), failed: failed.map((id) => ({ id, name: name.get(id) ?? null, error: rpcErrors[id] ?? "delete not confirmed" })), hostMirror, sectionsUpdated },
        () =>
          `deleted ${deleted.length}/${ids.length} (verified gone from the control plane)${sectionsUpdated ? " (removed from sections)" : ""}\n` +
          (deleted.length ? (hostMirror.removed ? "host mirror: deleteAgents sent; the host roster may still list them for a few minutes (`agents list` marks them (deleted?))\n" : `host mirror: not removed${hostMirror.error ? ` (${hostMirror.error})` : ""}; \`agents list\` marks them (deleted?) until the host catches up\n`) : "") +
          stillPresent.map((id) => `still present: ${name.get(id) ?? id} (${shortId(id)})${rpcErrors[id] ? ` - ${rpcErrors[id]}` : ""}\n`).join("") +
          failed.map((id) => `not deleted: ${name.get(id) ?? id} (${shortId(id)}) - ${rpcErrors[id] ?? "delete not confirmed"}\n`).join(""),
      );
    });

  agents
    .command("send <ref> <prompt...>")
    .description("Send a message to an agent (operator: control-plane SendGrokBotUserMessage; agent policy: host sendPrompt)")
    .option("--reply-to <entryId>")
    .option("--wait", "wait for the turn to finish and print the tail")
    .option("--timeout <sec>", "max seconds to wait", "300")
    .action(async (ref, promptParts, o, cmd) => {
      const opts = cmd.optsWithGlobals();
      const timeoutSec = Number(o.timeout);
      if (o.wait && !(Number.isFinite(timeoutSec) && timeoutSec > 0)) throw new UsageError(`--timeout must be a positive number of seconds (got "${o.timeout}").`);
      const gw = await gateway(opts);
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const prompt = promptParts.join(" ");
      const r = await sendMessage(opts, gw, a, prompt, { replyToId: o.replyTo });
      if (!o.wait) return out(cmd, r, `sent to ${a.name} (${shortId(a.id)}) via ${r.via} ${r.via === "control-plane" ? `dispatched=${r.dispatched} mode=${r.mode ?? "?"}` : `accepted=${r?.accepted ?? "?"}`} id=${r.clientNonce ?? r.messageId}\n`);
      const deadline = Date.now() + timeoutSec * 1000;
      let sawRunning = false;
      while (Date.now() < deadline) {
        await sleep(1500);
        const row = (await gw.listAgents({ fresh: true })).find((x) => x.id === a.id);
        const busy = row?.isRunningTurn || row?.isComposingMessage;
        if (busy) sawRunning = true;
        if (sawRunning && !busy) break;
        // Never saw the agent start within 20s: give up waiting rather than spin to the timeout.
        if (!sawRunning && Date.now() - r.sentAt > 20_000) break;
      }
      const tail = entriesSince(tailEntries(await gw.transcriptTail(a.id, WAIT_TRANSCRIPT_WINDOW)), r.sentAt, {
        nonce: r.clientNonce,
        prompt,
        entryIds: [r.entryId, r.messageId, r.userEntryId],
      });
      out(cmd, { sent: r, tail }, tail.map(formatEntry).join("\n") + "\n");
    });

  agents
    .command("tail <ref>")
    .description("Print the last N transcript entries")
    .option("-n, --limit <n>", "entries", "30")
    .option("--raw", "print raw entries")
    .action(async (ref, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const data = await gw.transcriptTail(a.id, Number(o.limit));
      const entries = tailEntries(data);
      if (o.raw || globalOpts(cmd).json) return printJson(data);
      process.stdout.write(`# ${a.name} (${shortId(a.id)}) — ${entries.length} entries\n` + entries.map(formatEntry).join("\n") + "\n");
    });

  agents
    .command("thread <ref> <rootId>")
    .description("Print a reply thread")
    .action(async (ref, rootId, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      printJson(await gw.thread(a.id, rootId));
    });

  agents
    .command("outline <ref>")
    .description("Conversation outline (host-generated)")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      printJson(await gw.conversationOutline(a.id));
    });

  // Todos and tasks. The control plane holds them for server-hosted agents (the box gateway returns [] for those), so an
  // operator reads the Cursor RPC first; under the agent policy (no Cursor auth, `cursor` family denied) the host gateway is used.
  const workList = async (cmd, ref, { rpc, host }) => {
    const opts = cmd.optsWithGlobals();
    const gw = await gateway(opts);
    const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
    if (resolvePolicy() !== "agent") {
      try {
        return { agent: a, source: "cursor", data: await rpc(cursor(opts), a.id) };
      } catch (e) {
        process.stderr.write(`grokbot: note: control-plane read failed (${redact(e.message)}); using the host gateway\n`);
      }
    }
    return { agent: a, source: "host", data: await host(gw, a.id) };
  };
  agents
    .command("todos <ref>")
    .description("The agent's todo list (control plane for operators, host gateway under the agent policy)")
    .action(async (ref, _, cmd) => {
      const r = await workList(cmd, ref, { rpc: (c, id) => c.listAgentTodos(id), host: (gw, id) => gw.todos(id) });
      const todos = Array.isArray(r.data) ? r.data : r.data?.todos ?? [];
      out(cmd, { agentId: r.agent.id, source: r.source, todos }, () =>
        table(todos, [{ key: "id", label: "id", max: 24 }, { get: (t) => String(t.status ?? "").replace(/^TODO_STATUS_/, "").toLowerCase(), label: "status" }, { key: "content", label: "content", max: 90 }]),
      );
    });
  agents
    .command("tasks <ref>")
    .description("The agent's tasks, async tasks, and subagents (read-only)")
    .option("--done", "include recently completed tasks (control plane only)")
    .action(async (ref, o, cmd) => {
      const r = await workList(cmd, ref, { rpc: (c, id) => c.listAgentTasks(id, { includeRecentlyDone: o.done }), host: (gw, id) => gw.tasks(id) });
      const gw = await gateway(cmd.optsWithGlobals());
      const [asyncTasks, subagents] = await Promise.all([gw.asyncTasks(r.agent.id).catch((e) => ({ error: redact(e.message) })), gw.subagents(r.agent.id).catch((e) => ({ error: redact(e.message) }))]);
      const result = { agentId: r.agent.id, source: r.source, tasks: r.data, asyncTasks, subagents };
      out(cmd, result, () => JSON.stringify(result, null, 2) + "\n");
    });

  // ---- sections
  const sections = program.command("sections").alias("s").description("Sidebar sections (stored in Cursor runtime settings, mirrored to host settings; the app refreshes on focus)");

  sections
    .command("list")
    .alias("ls")
    .description("List sections with member counts")
    .option("--members", "list member agents under each section")
    .option("--stores", "show the app store and the host mirror side by side, with drift")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      if (o.stores) return showSectionStores(cmd, gw, { setExit: false });
      const [secs, roster] = await Promise.all([gw.getSections(), o.members || globalOpts(cmd).json ? gw.listAgents({ fresh: true }) : []]);
      const byId = new Map(roster.map((a) => [a.id, a]));
      const enriched = secs.map((s, i) => ({ position: i, ...s, members: s.agentIds.map((id) => ({ id, name: byId.get(id)?.name ?? null, missing: roster.length ? !byId.has(id) : undefined })) }));
      const unsectioned = roster.length ? roster.filter((a) => !S.sectionIdByAgent(secs).has(a.id) && !a.isHiddenFromSidebar).length : null;
      out(cmd, { sections: enriched, unsectioned }, () => {
        let t = table(enriched, [{ key: "position", label: "#" }, { key: "id", label: "id" }, { key: "name", label: "name", max: 40 }, { label: "agents", get: (s) => String(s.agentIds.length) }]);
        if (o.members) for (const s of enriched) t += `\n${s.name}\n` + s.members.map((m) => `  ${shortId(m.id)}  ${m.name ?? "(missing agent)"}`).join("\n") + "\n";
        if (unsectioned != null) t += `\nunsectioned visible agents: ${unsectioned}\n`;
        return t;
      });
    });

  sections
    .command("create <name> [refs...]")
    .description("Create a section, optionally moving agents into it")
    .option("--position <n>", "insert at position (0 = top)")
    .action(async (name, refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const ids = refs.length ? resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id) : [];
      const { sections: after, section } = S.createSection(before, name, ids, { position: o.position != null ? Number(o.position) : null });
      await writeSections(cmd, gw, before, after, `created section "${section.name}" (${section.id})`);
    });

  sections
    .command("rename <section> <name>")
    .description("Rename a section")
    .action(async (ref, name, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const { sections: after } = S.renameSection(before, ref, name);
      await writeSections(cmd, gw, before, after, "renamed");
    });

  sections
    .command("delete <section>")
    .alias("rm")
    .description("Delete a section (its agents become unsectioned; nothing is deleted from the roster)")
    .option("--yes", "confirm")
    .action(async (ref, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const { sections: after, section } = S.deleteSection(before, ref);
      if (!o.yes) {
        const err = new UsageError(`Would delete section "${section.name}" releasing ${section.agentIds.length} agents. Re-run with --yes.`);
        err.exitCode = 3;
        throw err;
      }
      await writeSections(cmd, gw, before, after, `deleted section "${section.name}"`);
    });

  // Bulk membership changes driven by selection flags (not explicit refs) show the targets first and need --yes.
  async function gateSelection(cmd, rows, refs, o, verb) {
    if (refs.length > 0 && !o.dryRun) return true;
    return confirmDestructive(cmd, rows, o, { verb, requireCount: false });
  }

  selectionOptions(sections.command("move <section> [refs...]").alias("assign").description("Move agents into a section (refs or selection flags)"))
    .option("--dry-run", "list targets and exit")
    .option("--yes", "confirm when selecting by flags")
    .action(async (ref, refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const target = S.requireSection(before, ref);
      const { rows } = await selectAgents(gw, refs, { ...o, all: true });
      if (!(await gateSelection(cmd, rows, refs, o, `move to "${target.name}"`))) return;
      const after = S.assignAgents(before, target.id, rows.map((a) => a.id));
      await writeSections(cmd, gw, before, after, `moved ${pluralize(rows.length, "agent")} → "${target.name}"`);
    });

  selectionOptions(sections.command("unassign [refs...]").description("Remove agents from whatever section they are in"))
    .option("--dry-run", "list targets and exit")
    .option("--yes", "confirm when selecting by flags")
    .action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const { rows } = await selectAgents(gw, refs, { ...o, all: true });
      if (!(await gateSelection(cmd, rows, refs, o, "unassign"))) return;
      const after = S.assignAgents(before, null, rows.map((a) => a.id));
      await writeSections(cmd, gw, before, after, `unassigned ${pluralize(rows.length, "agent")}`);
    });

  sections
    .command("reorder <section> <position>")
    .description("Move a section to a position (0 = top)")
    .action(async (ref, pos, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      await writeSections(cmd, gw, before, S.moveSection(before, ref, Number(pos)), "reordered");
    });

  sections
    .command("sort")
    .description("Sort sections")
    .option("--by <name|size>", "sort key", "name")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      await writeSections(cmd, gw, before, S.sortSections(before, { by: o.by }), `sorted by ${o.by}`);
    });

  sections
    .command("prune")
    .description("Drop memberships whose agent no longer exists")
    .option("--drop-empty", "also delete sections left empty")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const [before, roster] = await Promise.all([gw.getSections(), gw.listAgents({ fresh: true })]);
      const { sections: after, removed, droppedSections } = S.pruneSections(before, roster.map((a) => a.id), { dropEmpty: o.dropEmpty });
      if (removed === 0 && droppedSections.length === 0) return out(cmd, { ok: true, removed: 0 }, "nothing to prune\n");
      await writeSections(cmd, gw, before, after, `pruned ${removed} dead membership(s)${droppedSections.length ? `, dropped ${droppedSections.length} empty section(s)` : ""}`);
    });

  sections
    .command("export")
    .description("Print sections JSON (pipe to a file for backup)")
    .action(async (_, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      printJson(await gw.getSections());
    });

  sections
    .command("import <file>")
    .description("Replace all sections from a JSON file (array of {id,name,agentIds})")
    .option("--yes", "confirm replacement")
    .action(async (file, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const next = S.normalizeSections(JSON.parse(readFileSync(file, "utf8")));
      const before = await gw.getSections();
      if (!o.yes) {
        const err = new UsageError(`Would replace ${before.length} sections with ${next.length}. Changes:\n${S.sectionsDiff(before, next).map((d) => "  " + d).join("\n")}\nRe-run with --yes.`);
        err.exitCode = 3;
        throw err;
      }
      await writeSections(cmd, gw, before, next, `imported ${next.length} sections`);
    });

  sections
    .command("verify")
    .description("Compare the app's section store with the host mirror (exit 1 on drift)")
    .action(async (_, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      await showSectionStores(cmd, gw, { setExit: true });
    });

  sections
    .command("sync")
    .description("Push the host mirror (what box agents wrote) into the app's store. Needs Cursor sign-in (Mac).")
    .option("--yes", "apply without the preview gate")
    .option("--auto", "non-interactive for launchd: never force, quiet when nothing to do")
    .option("--force", "push even if the app changed since the last sync (overwrites app-side edits)")
    .option("--dry-run", "show the diff and exit 3 without writing")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      if (sectionsSyncMode(o) === "preview") {
        const stores = await gw.sectionStores();
        if (!stores.runtime) throw new UsageError("sections sync needs Cursor sign-in (no app store reachable from here).");
        if (stores.drift === false) return out(cmd, { ok: true, changed: false }, "in sync, nothing to do\n");
        const err = new UsageError(`Would replace the app's ${userSections(stores.runtime).length} section(s) with the host mirror's ${userSections(stores.host).length}. Changes:\n${S.sectionsDiff(userSections(stores.runtime), userSections(stores.host)).map((d) => "  " + d).join("\n")}\nRe-run with --yes${stores.snapshot ? "" : " --force (no sync snapshot yet, so sync refuses without --force)"}.`);
        err.exitCode = 3;
        throw err;
      }
      let r;
      try {
        r = await gw.syncHostToRuntime({ force: o.auto ? false : !!o.force, auto: !!o.auto });
      } catch (e) {
        if (o.auto && e?.reason === "empty-host") return; // nothing staged: quiet no-op for the scheduler
        if (o.auto && e?.reason === "no-snapshot") {
          process.stderr.write(`grokbot: note: sections sync --auto skipped: no sync snapshot yet. Review with \`grokbot sections sync --dry-run\`, then run \`grokbot sections sync --yes --force\` once.\n`);
          return;
        }
        throw e;
      }
      if (!r.changed) {
        if (o.auto && r.reason === "conflict") {
          // App wins: nothing written, exit 0. Logged once per distinct runtime/host pair (see Gateway.syncHostToRuntime).
          if (r.newConflict) {
            const diff = S.sectionsDiff(r.runtime, r.host);
            process.stderr.write(`${new Date().toISOString()} grokbot: sections sync --auto: conflict, kept the app copy (host mirror not pushed). Diff app -> host:\n${diff.map((d) => "  " + d).join("\n")}\n`);
          }
          return;
        }
        if (!o.auto) out(cmd, { ok: true, changed: false, ...(r.reason ? { reason: r.reason } : {}) }, r.reason === "host-unchanged" ? "nothing staged in the host mirror; the app store has its own edits and was left alone\n" : "in sync, nothing to do\n");
        return;
      }
      const diff = S.sectionsDiff(userSections(r.before), userSections(r.after));
      out(cmd, { ok: true, changed: true, snapshotWritten: r.snapshotWritten, changes: diff }, `synced host mirror to the app store\n${diff.map((d) => "  " + d).join("\n")}${diff.length ? "\n" : ""}`);
      await nudgeRenderer();
    });

  // ---- pins
  const pins = program.command("pins").description("Pinned agents (Cursor runtime store, like the app; host setting only as the box-side mirror)");
  const pinsNote = (gw) => {
    if (gw.pinsHostOnly) process.stderr.write(PINS_HOST_ONLY_NOTE);
  };
  pins.command("list").alias("ls").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const [ids, roster] = await Promise.all([gw.getPinned(), gw.listAgents({ fresh: true })]);
    const byId = new Map(roster.map((a) => [a.id, a]));
    const rows = ids.map((id) => ({ id, name: byId.get(id)?.name ?? "(missing)" }));
    out(cmd, rows, () => table(rows, [{ key: "id", label: "id", format: shortId }, { key: "name", label: "name" }]));
  });
  pins.command("add <refs...>").action(async (refs, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const ids = resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id);
    const cur = await gw.getPinned();
    const next = [...cur, ...ids.filter((id) => !cur.includes(id))];
    await gw.setPinned(next);
    out(cmd, { pinned: next, ...(gw.pinsHostOnly ? { store: "host-setting", appVisible: false } : {}) }, `pinned ${ids.length}; total ${next.length}\n`);
    pinsNote(gw);
  });
  pins.command("remove <refs...>").alias("rm").action(async (refs, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const ids = new Set(resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id));
    const next = (await gw.getPinned()).filter((id) => !ids.has(id));
    await gw.setPinned(next);
    out(cmd, { pinned: next, ...(gw.pinsHostOnly ? { store: "host-setting", appVisible: false } : {}) }, `unpinned; total ${next.length}\n`);
    pinsNote(gw);
  });
  pins.command("clear").option("--yes").action(async (o, cmd) => {
    if (!o.yes) throw new UsageError("Re-run with --yes to clear all pins.");
    const gw = await gateway(cmd.optsWithGlobals());
    await gw.setPinned([]);
    out(cmd, { pinned: [], ...(gw.pinsHostOnly ? { store: "host-setting", appVisible: false } : {}) }, "cleared pins\n");
    pinsNote(gw);
  });

  // ---- settings
  const settings = program.command("settings").description("Raw host settings (sections, pins, default model, notifications, ...)");
  settings.command("get [key]").action(async (key, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const s = await gw.getHostSettings();
    printJson(key ? s?.[key] : s);
  });
  settings.command("set <key> <json>").description("Patch one host setting with a JSON value").action(async (key, json, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const value = JSON.parse(json);
    const r = await gw.setHostSettings({ [key]: value });
    printJson(r?.[key] ?? r);
  });

  // ---- auto-review (narrow, agent-allowed alternative to the denied raw `settings set`)
  // App 0.79+ stores the rules as { isEnabled, allowInstructions[], blockInstructions[] } (Cursor runtime store, mirrored
  // to the host `autoReviewInstructions` setting). One rule per line on the CLI; --list picks allow (default) or block.
  const autoReview = program.command("auto-review").description("Grok Bot auto-review rules (allow/block lists); allowed for agents");
  const ruleKey = (o) => {
    const list = (o.list ?? "allow").toLowerCase();
    if (list !== "allow" && list !== "block") throw new UsageError('--list must be "allow" or "block".');
    return list === "allow" ? "allowInstructions" : "blockInstructions";
  };
  const parseRules = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Audit what was written (hash + length of the new value, never the value) under every policy, including operator on the Mac.
  const auditAutoReviewWrite = (path, value, list) =>
    audit({ policy: resolvePolicy(), path, event: "auto-review-write", list, sha256: createHash("sha256").update(value).digest("hex"), length: value.length });
  const autoReviewOut = (cmd, v) =>
    out(cmd, v, () => {
      const L = [`enabled   ${v.isEnabled === null ? "unknown" : v.isEnabled ? "yes" : "no"}`];
      for (const [label, rules] of [["allow", v.allowInstructions], ["block", v.blockInstructions]]) {
        L.push(`${label} (${rules.length})${rules.length ? "" : "  (none)"}`);
        for (const r of rules) L.push(`  ${r}`);
      }
      return L.join("\n") + "\n";
    });
  // Refuse to guess: a legacy free-form host string is never silently converted to lists, and an unknown enabled state is
  // only set when the caller says so (--enable). Returns the isEnabled value to write.
  const guardAutoReview = (cur, o) => {
    if (cur.legacy) throw new UsageError("The host auto-review value is in the legacy string form (pre-0.79); refusing to overwrite it with lists. Update the app, or clear it deliberately with `grokbot settings set autoReviewInstructions '{\"isEnabled\":true,\"allowInstructions\":[],\"blockInstructions\":[]}'` as an operator.");
    if (o.enable) return true;
    if (cur.isEnabled === null) throw new UsageError("Auto-review enabled/disabled is unknown here (no value stored yet); pass --enable to turn it on while writing, or set it in the app first.");
    return cur.isEnabled;
  };
  const autoReviewWrite = async (cmd, gw, next, path, hashed, list) => {
    const saved = await gw.setAutoReview(next);
    auditAutoReviewWrite(path, hashed, list);
    if (gw.autoReviewHostOnly) process.stderr.write("grokbot: note: wrote the host auto-review setting only (no Cursor sign-in here); the app picks it up when it reconciles host settings.\n");
    autoReviewOut(cmd, saved);
  };
  autoReview.command("get").description("Print the current auto-review rules").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    autoReviewOut(cmd, await gw.getAutoReview());
  });
  autoReview
    .command("set [text]")
    .description("Replace one rule list, one rule per line (text argument, --file <path>, or --stdin; exactly one). Emptying it needs --clear")
    .option("--list <allow|block>", "which list to replace", "allow")
    .option("--file <path>", "read the rules from a file")
    .option("--stdin", "read the rules from stdin")
    .option("--clear", "empty the list (takes no other source)")
    .option("--enable", "also turn auto-review on (required when its state is unknown)")
    .action(async (text, o, cmd) => {
      const key = ruleKey(o);
      const sources = [text !== undefined, o.file !== undefined, Boolean(o.stdin)].filter(Boolean).length;
      let rules;
      if (o.clear) {
        if (sources !== 0) throw new UsageError("--clear takes no text, --file, or --stdin source.");
        rules = [];
      } else {
        if (sources !== 1) throw new UsageError("Give exactly one source: a [text] argument, --file <path>, or --stdin (or --clear to empty the list).");
        const raw = o.file !== undefined ? readFileSync(o.file, "utf8") : o.stdin ? readFileSync(0, "utf8") : text;
        rules = parseRules(raw);
        if (rules.length === 0) throw new UsageError("Refusing to set an empty rule list. Pass --clear to empty it deliberately.");
      }
      const gw = await gateway(cmd.optsWithGlobals());
      const cur = await gw.getAutoReview();
      const isEnabled = guardAutoReview(cur, o);
      process.stderr.write(`previous ${o.list ?? "allow"} rules: ${cur[key].length}\n`);
      await autoReviewWrite(cmd, gw, { ...cur, isEnabled, [key]: rules }, "auto-review set", JSON.stringify(rules), key === "allowInstructions" ? "allow" : "block");
    });
  autoReview
    .command("append <text>")
    .description("Add one rule to a list; no-op if it is already there. Single-writer: read-modify-write, not atomic")
    .option("--list <allow|block>", "which list to add to", "allow")
    .option("--enable", "also turn auto-review on (required when its state is unknown)")
    .action(async (text, o, cmd) => {
      const key = ruleKey(o);
      const rule = text.trim();
      if (rule === "" || /[\r\n]/.test(rule)) throw new UsageError("A rule must be one non-empty line.");
      const gw = await gateway(cmd.optsWithGlobals());
      const cur = await gw.getAutoReview();
      if (cur[key].includes(rule)) return autoReviewOut(cmd, cur);
      const isEnabled = guardAutoReview(cur, o);
      const rules = [...cur[key], rule];
      await autoReviewWrite(cmd, gw, { ...cur, isEnabled, [key]: rules }, "auto-review append", JSON.stringify(rules), key === "allowInstructions" ? "allow" : "block");
    });

  // ---- groups
  const groups = program.command("groups").description("Group chats (rooms of agents)");
  groups
    .command("create <name> <members...>")
    .option("-d, --description <text>")
    .action(async (name, members, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const ids = resolveMany(await gw.listAgents({ fresh: true }), members).map((a) => a.id);
      const r = await gw.createGroup({ name, description: o.description, memberAgentIds: ids });
      out(cmd, r, `created group ${name}: ${JSON.stringify(r)}\n`);
    });
  groups.command("members <group> <members...>").description("Replace a group's member list").action(async (group, members, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const roster = await gw.listAgents({ fresh: true });
    const g = resolveAgent(roster, group);
    const ids = resolveMany(roster, members).map((a) => a.id);
    const r = await gw.setGroupMembers(g.id, ids);
    out(cmd, r ?? { ok: true }, `group ${g.name} members: ${ids.length}\n`);
  });

  // ---- usage (read-only; allowed under the agent policy)
  program.command("usage").description("Grok Bot usage: allowance window, reset time (PT), included spend, personal cap").action(async (_, cmd) => {
    const u = summarizeUsage(await cursor(cmd.optsWithGlobals()).usage());
    out(cmd, u, formatUsage);
  });

  // ---- backup exports (read-only)
  agents
    .command("export <dir>")
    .description("Back up every server-hosted agent: profile, skills, plugins, access (one JSON each) + account workflows; never secrets")
    .action(async (dir, _, cmd) => {
      const opts = cmd.optsWithGlobals();
      const r = await exportAgents(dir, { cursor: cursor(opts), gateway: await optionalGateway(cmd) });
      const skipped = r.files.filter((f) => f.skipped.length).length;
      out(cmd, { dir, ...r }, () => `${pluralize(r.files.length, "agent profile")} (${skipped} with skipped sections), ${r.workflows.written} workflows (${r.workflows.listed ?? 0} listed) -> ${dir}\n`);
    });
  const transcripts = program.command("transcripts").description("Server-side transcripts (control plane)");
  transcripts
    .command("export <dir>")
    .description("Write one JSONL per agent (all entries, ascending seq) via ListGrokBotTranscriptEntries paging")
    .option("--agent <ref>", "only this agent (uuid/prefix or name substring)")
    .option("--since <seq>", "only entries with seq greater than this", "0")
    .action(async (dir, o, cmd) => {
      const files = await exportTranscripts(dir, { cursor: cursor(cmd.optsWithGlobals()), agent: o.agent, since: o.since });
      out(cmd, { dir, files }, () => files.map((f) => `${String(f.entries).padStart(6)}  ${f.name}  ${f.file ?? "(no new entries; file untouched)"}\n`).join("") + `${(() => { const n = files.reduce((s, f) => s + f.entries, 0); return `${n} entr${n === 1 ? "y" : "ies"}`; })()} in ${pluralize(files.length, "file")} -> ${dir}\n`);
    });

  // ---- automations (routines): read-only, from the Cursor control plane
  const autos = program
    .command("automations")
    .description("List routines (prompt, trigger/schedule, enabled, owning agent) across agents; read-only")
    .option("--agent <ref>", "only this agent (uuid/prefix or name substring)")
    .action(async (o, cmd) => {
      const { routines, errors } = await listRoutines(cursor(cmd.optsWithGlobals()), { agent: o.agent, gateway: await optionalGateway(cmd) });
      if (errors.length) process.exitCode = 1;
      out(cmd, routines, () =>
        table(routines, [
          { key: "agentName", label: "agent", max: 26 },
          { key: "name", label: "routine", max: 34 },
          { key: "enabled", label: "on" },
          { key: "trigger", label: "trigger" },
          { key: "schedule", label: "schedule", max: 44 },
          { label: "prompt", get: (r) => (r.malformed ? "UNPARSEABLE" : `${r.prompt.length} chars`) },
        ]) + `${pluralize(routines.length, "routine")}\n`,
      );
    });
  autos
    .command("export <dir>")
    .description("Write one markdown file per agent (verbatim prompts, schedule, enabled) into <dir>")
    .option("--agent <ref>", "only this agent (uuid/prefix or name substring)")
    .action(async (dir, o, cmd) => {
      const listing = await listRoutines(cursor(cmd.optsWithGlobals()), { agent: o.agent, gateway: await optionalGateway(cmd) });
      if (listing.errors.length) process.exitCode = 1;
      const files = exportRoutines(dir, listing);
      out(cmd, { dir, routines: listing.routines.length, files }, () => files.map((f) => `${String(f.count).padStart(3)}  ${f.name}  ${f.file}\n`).join("") + `${pluralize(listing.routines.length, "routine")} in ${pluralize(files.length, "file")} -> ${dir}\n`);
    });

  for (const [verb, enabled] of [["enable", true], ["disable", false]]) {
    autos
      .command(`${verb} <agent> <automation>`)
      .description(`${verb === "enable" ? "Enable" : "Disable"} one routine (WRITE; prints the target, needs --yes). <automation> = id or name`)
      .option("--yes", "confirm the change")
      .action(async (agentRef, automation, o, cmd) => {
        const { target, ...result } = await toggleRoutine(cursor(cmd.optsWithGlobals()), agentRef, automation, enabled, { yes: o.yes });
        out(cmd, result, `${target}\n`);
      });
  }

  autos
    .command("slack-workspace <agent> <automation> <teamId>")
    .description("Point one routine at a linked Slack workspace (WRITE; operator-only; prints the target, needs --yes)")
    .option("--yes", "confirm the change")
    .action(async (agentRef, automation, teamId, o, cmd) => {
      const { target, ...result } = await setRoutineSlackWorkspace(cursor(cmd.optsWithGlobals()), agentRef, automation, teamId, { yes: o.yes });
      out(cmd, result, `${target}\n`);
    });
  autos
    .command("delete <agent> <automation>")
    .alias("rm")
    .description("Delete one control-plane routine (WRITE, irreversible; prints the target, needs --yes). The host's deleteAgentAutomation is a silent no-op for these")
    .option("--yes", "confirm the deletion")
    .action(async (agentRef, automation, o, cmd) => {
      const { target, ...result } = await deleteRoutine(cursor(cmd.optsWithGlobals()), agentRef, automation, { yes: o.yes, timeZone: localTimeZone() });
      out(cmd, result, `${target}\n`);
    });
  autos
    .command("resume-guard")
    .description("Re-enable allowlisted routines that got disabled (WRITE; the allowlist is the consent; launchd-friendly: quiet when nothing changed, exit 1 on any error)")
    .requiredOption("--allow <file>", 'allowlist: one "<agent> | <routine id or name>" per line, or a bare routine id; # comments')
    .option("--dry-run", "list what would be re-enabled, write nothing")
    .action(async (o, cmd) => {
      const entries = parseAllowlist(readFileSync(o.allow, "utf8"));
      if (entries.length === 0) throw new UsageError(`${o.allow} has no entries; refusing to run an empty allowlist.`);
      const r = await resumeGuard(cursor(cmd.optsWithGlobals()), entries, { dryRun: o.dryRun });
      if (r.errors) process.exitCode = 1;
      const ts = new Date().toISOString();
      out(cmd, { at: ts, dryRun: Boolean(o.dryRun), resumed: r.resumed, errors: r.errors, results: r.results.map(({ entry, ...x }) => ({ ...x, line: entry.line })) }, () => {
        const label = (x) => (x.automationId ? `${x.agentName ?? x.agentId} / ${x.name} (${x.automationId})` : `allowlist line ${x.entry.line}`);
        const lines = r.results
          .filter((x) => !["enabled", "duplicate"].includes(x.status))
          .map((x) => `${ts} grokbot: resume-guard: ${x.status} ${label(x)}${x.error ? `: ${x.error}` : ""}`);
        return lines.length ? lines.join("\n") + "\n" : "";
      });
    });

  // ---- slack (operator-only: the agent policy denies the whole family)
  const slack = program.command("slack").description("Slack for agents and routines: link status, workspaces, install/reinstall/uninstall (operator-only; writes need --yes)");
  const slackAgent = async (c, ref) => {
    const found = matchAgents((await c.listAgents()).agents.filter((a) => a.agentId), ref);
    if (found.length !== 1) throw new UsageError(`"${ref}" matches ${found.length} agents (${found.map((a) => a.name ?? a.agentId).join(", ")}); use a more specific ref.`);
    return found[0];
  };
  const needYes = (o, what) => {
    if (o.yes) return;
    const err = new UsageError(`${what}\nRe-run with --yes to apply.`);
    err.exitCode = 3;
    throw err;
  };
  const slackVerdict = (cmd, verb, resp, extra = {}) => {
    const v = summarizeSlackOutcome(verb, resp);
    if (v.exitCode) process.exitCode = v.exitCode;
    out(cmd, { ...extra, outcome: v.outcome, ok: v.ok, needsHuman: v.needsHuman, ...(v.url ? { url: v.url } : {}), ...v.details }, v.message + "\n");
  };
  slack
    .command("status")
    .description("Slack link state per agent (ListGrokBotAgents.slackConnections + GetGrokBotSlackInstallState); read-only")
    .option("--agent <ref>", "only this agent (uuid/prefix or name substring)")
    .action(async (o, cmd) => {
      const c = cursor(cmd.optsWithGlobals());
      const { agents, slackConnections } = await c.listAgents();
      const names = new Map(agents.map((a) => [a.agentId, a.name ?? null]));
      let ids = o.agent ? matchAgents(agents.filter((a) => a.agentId), o.agent).map((a) => a.agentId) : slackConnections.map((x) => x.agentId);
      ids = [...new Set(ids)];
      const conn = new Map(slackConnections.map((x) => [x.agentId, x]));
      const rows = await Promise.all(
        ids.map(async (agentId) => {
          const row = { agentId, name: names.get(agentId) ?? null, pendingAdminApproval: Boolean(conn.get(agentId)?.pendingAdminApproval), connection: conn.has(agentId) };
          try {
            const st = await c.getSlackInstallState(agentId);
            Object.assign(row, {
              status: enumName(st.status),
              slackTeamId: st.slackTeamId ?? null,
              workspace: st.workspaceName ?? null,
              needsManifestUpdate: Boolean(st.needsManifestUpdate),
              pendingReinstallApproval: Boolean(st.pendingReinstallApproval),
              appUnreachable: Boolean(st.appUnreachable),
              removedInSlack: Boolean(st.removedInSlack),
              approvalRequestFiled: Boolean(st.approvalRequestFiled),
              ...(o.agent && st.workspaces?.length ? { workspaces: st.workspaces.map((w) => ({ slackTeamId: w.slackTeamId, name: w.slackTeamName ?? null })) } : {}),
              ...(o.agent && st.oauthAuthorizeUrl ? { oauthAuthorizeUrl: st.oauthAuthorizeUrl } : {}),
            });
          } catch (e) {
            row.error = redact(e.message);
            process.exitCode = 1;
          }
          return row;
        }),
      );
      out(cmd, rows, () =>
        table(rows, [
          { key: "name", label: "agent", max: 26 },
          { key: "status", label: "status" },
          { key: "workspace", label: "workspace", max: 24 },
          { label: "flags", get: (r) => [r.pendingAdminApproval && "pending-admin", r.needsManifestUpdate && "manifest-update", r.pendingReinstallApproval && "reinstall-approval", r.appUnreachable && "unreachable", r.removedInSlack && "removed-in-slack", r.error && "ERROR"].filter(Boolean).join(",") },
        ]) + `${pluralize(rows.length, "agent")}\n`,
      );
    });
  slack
    .command("workspaces")
    .description("Slack workspaces: the Grok Bot app links (GetGrokBotSlackInstallState, per agent) and the routine-trigger link (DashboardService); read-only")
    .option("--agent <ref>", "app workspaces for only this agent (exactly one match; uuid/prefix or name substring)")
    .action(async (o, cmd) => {
      const c = cursor(cmd.optsWithGlobals());
      const errors = [];
      let agents = [];
      try {
        agents = (await c.listAgents()).agents.filter((a) => a.agentId);
      } catch (e) {
        errors.push({ agentId: null, error: `ListGrokBotAgents failed: ${redact(e.message)}` });
        process.exitCode = 1;
      }
      let ids = agents.map((a) => a.agentId);
      if (o.agent && agents.length) {
        const found = matchAgents(agents, o.agent);
        if (found.length !== 1) throw new UsageError(`"${o.agent}" matches ${found.length} agents (${found.map((a) => a.name ?? a.agentId).join(", ")}); use a more specific ref.`);
        ids = [found[0].agentId];
      }
      ids = [...new Set(ids)];
      const states = await mapLimit(ids, SLACK_STATE_CONCURRENCY, async (agentId) => {
        try {
          return await c.getSlackInstallState(agentId);
        } catch (e) {
          errors.push({ agentId, error: redact(e.message) });
          process.exitCode = 1;
          return null;
        }
      });
      const appRows = unionAppWorkspaces(states.filter(Boolean)).map((w) => ({ slackTeamId: w.slackTeamId, name: w.name, managerAuthUpdatedAt: w.managerAuthUpdatedAtMs ? new Date(w.managerAuthUpdatedAtMs).toISOString() : null }));
      const [ws, settings] = await Promise.all([c.listSlackWorkspaces(), c.getSlackUserSettings()]);
      const rows = ws.workspaces.map((w) => ({ slackTeamId: w.slackTeamId, name: w.displayName ?? null, status: enumName(w.status), linkedAt: w.linkedAtMs ? new Date(Number(w.linkedAtMs)).toISOString() : null, routines: w.sandAutomationCount ?? 0, routinesTruncated: Boolean(w.sandAutomationCountTruncated) }));
      out(cmd, { appWorkspaces: appRows, ...(errors.length ? { appWorkspaceErrors: errors } : {}), workspaces: rows, canLinkAnotherWorkspace: ws.canLinkAnotherWorkspace, settings }, () => {
        const appTable = appRows.length ? table(appRows, [{ key: "slackTeamId", label: "team" }, { key: "name", label: "name", max: 28 }, { key: "managerAuthUpdatedAt", label: "manager auth updated" }]) : "(none)\n";
        const routineTable = rows.length ? table(rows, [{ key: "slackTeamId", label: "team" }, { key: "name", label: "name", max: 28 }, { key: "status", label: "status" }, { key: "linkedAt", label: "linked" }, { label: "routines", get: (r) => `${r.routines}${r.routinesTruncated ? "+" : ""}` }]) : "(none)\n";
        return (
          `Grok Bot app workspaces (per-agent app link; ${o.agent ? "selected agent" : `${pluralize(ids.length, "agent")} checked`}):\n${appTable}` +
          errors.map((e) => `  ERROR${e.agentId ? ` ${e.agentId}` : ""}: ${e.error}\n`).join("") +
          `\nRoutine-trigger link (DashboardService; a separate link used by \`automations slack-workspace\`):\n${routineTable}` +
          `can link another workspace: ${ws.canLinkAnotherWorkspace ? "yes" : "no"}   slack auth: ${settings.hasSlackAuth ? "yes" : "no"}${settings.slackCursorTeamLocked ? "   cursor team locked" : ""}\n`
        );
      });
    });
  slack
    .command("link-url")
    .description("Print a Slack OAuth URL to link a workspace (or --reconnect <teamId> to refresh one). Opens nothing; mints an install attempt")
    .option("--reconnect <teamId>", "reconnect this already-linked workspace")
    .action(async (o, cmd) => {
      const r = await cursor(cmd.optsWithGlobals()).getSlackInstallUrl({ reconnectSlackTeamId: o.reconnect });
      out(cmd, { url: r.url, source: r.source ? enumName(r.source) : null, attemptId: r.attemptId ?? null }, `${r.url}\n`);
    });
  slack
    .command("connect <agent>")
    .description("Start the Slack connect flow for an agent and print the URL to open; --wait polls until the workspace is recorded, --install then installs the app (needs --yes)")
    .option("--wait [secs]", "poll the install state every 5s until a new workspace appears or the agent is CONNECTED (default timeout 600s; exit 4 on timeout)")
    .option("--install", "after the wait, install the app into the new workspace (implies --wait; needs --yes)")
    .option("--workspace <teamId>", "with --install: the workspace to install into (required when more than one new workspace appears; if it is already recorded the connect and wait are skipped)")
    .option("--yes", "confirm the install (with --install)")
    .action(async (ref, o, cmd) => {
      let timeoutMs = 600000;
      if (typeof o.wait === "string") {
        const secs = Number(o.wait);
        if (!Number.isFinite(secs) || secs <= 0) throw new UsageError(`--wait expects a positive number of seconds, got "${o.wait}".`);
        timeoutMs = secs * 1000;
      }
      if (o.workspace && !o.install) throw new UsageError("--workspace on `slack connect` only applies with --install.");
      if (o.workspace && !SLACK_TEAM_ID.test(o.workspace)) throw new UsageError(`--workspace "${o.workspace}" is not a Slack team id (expected something like T0123ABCD).`);
      const wait = Boolean(o.wait || o.install);
      const json = Boolean(globalOpts(cmd).json);
      // With --json stdout carries exactly one JSON document at the end, so everything a waiting human needs goes to stderr.
      const say = (t) => (json ? process.stderr : process.stdout).write(t);
      const c = cursor(cmd.optsWithGlobals());
      const a = await slackAgent(c, ref);
      const who = `${a.name ?? a.agentId} (${a.agentId})`;
      if (o.install) needYes(o, `Connect Slack for ${who}, wait for the workspace, then install the Slack app${o.workspace ? ` in workspace ${o.workspace}` : ""}.`);
      const baseline = wait ? installBaseline(await c.getSlackInstallState(a.agentId)) : null;
      const result = { agentId: a.agentId, name: a.name ?? null };
      const finish = (extra = {}) => {
        if (json) out(cmd, { ...result, ...extra }, "");
      };
      const install = async (team) => {
        const iv = summarizeSlackOutcome("install", await c.installSlackApp(a.agentId, { slackTeamId: team }));
        if (iv.exitCode) process.exitCode = iv.exitCode;
        if (!json) process.stdout.write(iv.message + "\n");
        finish({ install: { slackTeamId: team, outcome: iv.outcome, ok: iv.ok, needsHuman: iv.needsHuman, ...(iv.url ? { url: iv.url } : {}), ...iv.details } });
      };

      // A workspace the user named that is already recorded: there is nothing to wait for (re-running after a timeout lands here).
      if (o.install && o.workspace && baseline.teams.has(o.workspace)) {
        say(`workspace ${o.workspace} is already recorded; skipping the connect URL and the wait.\n`);
        result.waited = { skipped: "workspace already recorded" };
        return install(o.workspace);
      }

      const v = summarizeSlackOutcome("connect", await c.startSlackConnect(a.agentId));
      Object.assign(result, { outcome: v.outcome, ok: v.ok, needsHuman: v.needsHuman, ...(v.url ? { url: v.url } : {}), ...v.details });
      const note = "Open the URL in a browser signed in to both Slack and cursor.com; the server records the workspace when you finish.";
      if (v.url) result.note = note;
      if (wait || !json) say(v.message + "\n" + (v.url ? note + "\n" : ""));
      if (v.exitCode) process.exitCode = v.exitCode;
      if (!v.ok || !wait) return finish();

      say(`waiting up to ${Math.round(timeoutMs / 1000)}s for the workspace to be recorded...\n`);
      const w = await waitForSlackWorkspace(c, a.agentId, baseline, {
        timeoutMs,
        intervalMs: _slackPollMs ?? 5000,
        targetTeam: o.workspace,
        // Before an auto-install only an unseen team id counts: a bumped timestamp on a known workspace must not pick the target.
        requireNewTeam: Boolean(o.install && !o.workspace),
        onError: (e, n, max) => process.stderr.write(`poll failed (${n}/${max}): ${redact(e.message)}\n`),
      });
      if (w.timedOut) {
        process.exitCode = 4;
        const retry = o.install ? ` or \`grokbot slack install ${a.agentId} --yes\`` : "";
        say(`connect --wait: timed out after ${Math.round(timeoutMs / 1000)}s; no new workspace was recorded. Finish the URL above, then run \`grokbot slack status --agent ${a.agentId}\`${retry}.\n`);
        return finish({ waited: { timedOut: true }, exitCode: 4 });
      }
      const fresh = w.newWorkspaces.map((x) => ({ slackTeamId: x.slackTeamId, name: x.name }));
      const statusName = enumName(w.state.status);
      const seen = fresh.length ? fresh.map((x) => `${x.slackTeamId}${x.name ? ` (${x.name})` : ""}`).join(", ") : `${w.state.slackTeamId ?? "?"}${w.state.workspaceName ? ` (${w.state.workspaceName})` : ""}`;
      result.waited = { timedOut: false, status: statusName, newWorkspaces: fresh };
      if (!json) process.stdout.write(`workspace recorded: ${seen}   status: ${statusName}\n`);
      if (!o.install) return finish();
      // The agent turned CONNECTED while we waited: the server finished the install itself, so another install would be redundant.
      if (statusName === "CONNECTED" && !baseline.connected) {
        if (!json) process.stdout.write("install: skipped - the agent became CONNECTED, so the server already completed the install\n");
        return finish({ install: { skipped: "became CONNECTED during the wait" } });
      }
      let team = o.workspace;
      if (!team) {
        if (fresh.length !== 1) {
          process.exitCode = 4;
          if (!json) process.stdout.write(`install: ${fresh.length} new workspaces appeared (${seen}); re-run with --workspace <teamId> (or \`grokbot slack install ${a.agentId} --workspace <teamId> --yes\`).\n`);
          return finish({ install: { outcome: "WORKSPACE_REQUIRED", needsHuman: true, workspaces: fresh }, exitCode: 4 });
        }
        team = fresh[0].slackTeamId;
      }
      return install(team);
    });
  slack
    .command("claim <claim>")
    .description("Finish a Slack connect with its one-time claim token (WRITE; needs --yes). Rarely needed: the server records the workspace when the OAuth URL is completed, so use `connect --wait` instead")
    .option("--yes", "confirm the claim")
    .action(async (claim, o, cmd) => {
      needYes(o, "Claim a Slack connect: this links the Slack workspace to the signed-in Cursor account and consumes the claim.");
      slackVerdict(cmd, "claim", await cursor(cmd.optsWithGlobals()).claimSlackConnect(claim));
    });
  for (const verb of ["install", "reinstall", "uninstall"]) {
    const cmdDef = slack
      .command(`${verb} <agent>`)
      .description(
        { install: "Install the agent's Slack app into a workspace (WRITE; needs --yes)", reinstall: "Update the agent's Slack app manifest in place (WRITE; needs --yes)", uninstall: "Remove the agent's Slack app (WRITE; the agent stops answering in Slack; needs --yes)" }[verb],
      )
      .option("--yes", "confirm the change");
    if (verb === "install") cmdDef.option("--workspace <teamId>", "Slack team id (required when several workspaces are linked)").option("--replace", "replace an existing app in another workspace");
    if (verb === "uninstall") cmdDef.option("--forget", "drop the record even if Slack cannot be reached (forgetIfUnreachable)");
    cmdDef.action(async (ref, o, cmd) => {
      const c = cursor(cmd.optsWithGlobals());
      const a = await slackAgent(c, ref);
      const who = `${a.name ?? a.agentId} (${a.agentId})`;
      needYes(
        o,
        verb === "install"
          ? `Install the Slack app for ${who}${o.workspace ? ` in workspace ${o.workspace}` : ""}${o.replace ? ", replacing any existing app" : ""}.`
          : verb === "reinstall"
            ? `Reinstall (update the manifest of) the Slack app for ${who}.`
            : `Uninstall the Slack app for ${who}${o.forget ? " and forget it even if Slack is unreachable" : ""}.`,
      );
      const resp =
        verb === "install"
          ? await c.installSlackApp(a.agentId, { slackTeamId: o.workspace, replaceExistingApp: o.replace })
          : verb === "reinstall"
            ? await c.reinstallSlackApp(a.agentId)
            : await c.uninstallSlackApp(a.agentId, { forgetIfUnreachable: o.forget });
      slackVerdict(cmd, verb, resp, { agentId: a.agentId, name: a.name ?? null });
    });
  }
  slack
    .command("unlink <teamId>")
    .description("Unlink a Slack workspace from the account (WRITE; every Slack-delivered routine and app for it stops; needs --yes)")
    .option("--yes", "confirm the change")
    .action(async (teamId, o, cmd) => {
      const c = cursor(cmd.optsWithGlobals());
      const { workspaces } = await c.listSlackWorkspaces();
      const w = workspaces.find((x) => x.slackTeamId === teamId);
      if (!w) throw new UsageError(`Slack workspace "${teamId}" is not linked. Linked: ${workspaces.map((x) => x.slackTeamId).join(", ") || "(none)"}.`);
      needYes(o, `Unlink Slack workspace ${teamId}${w.displayName ? ` (${w.displayName})` : ""}: ${w.sandAutomationCount ?? 0}${w.sandAutomationCountTruncated ? "+" : ""} routine(s) use it.`);
      const r = await c.unlinkSlackAccess(teamId);
      if (!r.success) process.exitCode = 1;
      out(cmd, { slackTeamId: teamId, success: Boolean(r.success) }, r.success ? `unlinked ${teamId}\n` : `unlink ${teamId}: the server did not confirm success\n`);
    });

  // ---- events
  program
    .command("events")
    .description("Stream host events (server-sent events) until Ctrl-C")
    .option("--max <n>", "stop after n events")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      let n = 0;
      for await (const evt of gw.events()) {
        n++;
        if (globalOpts(cmd).json) printJson({ event: evt.event, id: evt.id, data: evt.json ?? evt.data });
        else process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${evt.event} ${redact(evt.data).slice(0, 300)}\n`);
        if (o.max && n >= Number(o.max)) break;
      }
    });

  // ---- raw gateway
  program
    .command("gw <command> [json]")
    .description("Raw host gateway call: POST /api/<command> with a JSON body")
    .action(async (command, json, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      printJson(await gw.call(command, json ? JSON.parse(json) : {}));
    });

  // ---- cursor control plane
  const cur = program.command("cursor").description("Cursor control plane (api2.cursor.sh, GrokBotService): server-side agents, box lifecycle");
  cur.command("whoami").action(async (_, cmd) => {
    const c = cursor(cmd.optsWithGlobals());
    const info = c.tokenInfo();
    out(cmd, info, () => Object.entries(info).map(([k, v]) => `${k.padEnd(16)} ${v}`).join("\n") + "\n");
  });
  cur
    .command("agents")
    .description("Server-side GrokBotAgent objects (named agents / definitions), not the box roster")
    .option("--no-team", "exclude team agents")
    .action(async (o, cmd) => {
      const c = cursor(cmd.optsWithGlobals());
      const { agents, slackConnections } = await c.listAgents({ includeTeamAgents: o.team !== false });
      out(cmd, { agents, slackConnections }, () => table(agents, [{ key: "id", label: "id", format: shortId }, { key: "name", label: "name", max: 34 }, { key: "kind", label: "kind" }, { key: "harness", label: "harness" }, { key: "visibility", label: "visibility" }, { label: "created", get: (a) => relTime(Number(a.createdAtMs)) }, { key: "agentId", label: "agentId", format: shortId }]) + `${agents.length} agents, ${slackConnections.length} slack connections\n`);
    });
  cur.command("delete-agent <id>").description("Delete a server-side GrokBotAgent (control-plane object)").option("--yes").action(async (id, o, cmd) => {
    if (!o.yes) throw new UsageError("Re-run with --yes.");
    printJson(await cursor(cmd.optsWithGlobals()).deleteAgent(id));
  });
  cur.command("visibility <agentId> <owner|team>").action(async (agentId, vis, _, cmd) => {
    printJson(await cursor(cmd.optsWithGlobals()).setVisibility(agentId, vis));
  });
  cur.command("sessions <agentId>").action(async (agentId, _, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listSessions(agentId)));
  cur.command("boxes").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listBoxes()));
  cur.command("state").description("Sandbox run state").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).runState()));
  cur.command("templates").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listTemplates()));
  cur.command("computers").description("User computers registered for local exec").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listUserComputers()));
  cur.command("capabilities").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).runtimeCapabilities()));
  cur
    .command("settings")
    .description("Per-user runtime settings (pins, sections, auto-review rules, main agent id, terms); read-only. Use `pins`/`sections`/`auto-review` to edit")
    .action(async (_, cmd) => {
      printJson(await cursor(cmd.optsWithGlobals()).getRuntimeSettings());
    });
  cur.command("ensure-sandbox").description("Mint a fresh gateway session (prints host only, never the token)").action(async (_, cmd) => {
    const r = await cursor(cmd.optsWithGlobals()).ensureSandBox();
    printJson({ ...r, gatewayToken: r.gatewayToken ? "<redacted>" : undefined, gatewayHeaders: r.gatewayHeaders ? Object.keys(r.gatewayHeaders) : undefined });
  });
  cur
    .command("rpc <method> [json]")
    .description("Raw Connect-RPC call against aiserver.v1.GrokBotService (or --service)")
    .option("--service <name>", "e.g. aiserver.v1.DashboardService")
    .action(async (method, json, o, cmd) => {
      printJson(await cursor(cmd.optsWithGlobals()).rpc(method, json ? JSON.parse(json) : {}, { service: o.service }));
    });

  // ---- cdp
  const cdp = program.command("cdp").description("Drive the running desktop app over Chrome DevTools Protocol");
  cdp.option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT));
  const cdpPort = async (cmd) => {
    const explicit = cmd.parent.getOptionValueSource("port") === "cli" ? Number(cmd.parent.opts().port) : null;
    if (explicit) return explicit;
    const st = await appState(DEFAULT_CDP_PORT);
    return st.debugPort ?? DEFAULT_CDP_PORT;
  };
  cdp.command("status").action(async (_, cmd) => {
    const st = await appState(await cdpPort(cmd));
    out(cmd, st, () => `running=${st.running} pid=${st.pid} debugPort=${st.debugPort} cdp=${st.cdpReachable}${st.version ? ` ${st.version.Browser}` : ""}\n`);
  });
  cdp.command("targets").action(async (_, cmd) => printJson(await cdpTargets(await cdpPort(cmd))));
  cdp
    .command("eval <expression>")
    .description("Evaluate JS in the renderer (promises awaited)")
    .option("--timeout <sec>", "per-call timeout in seconds (default 30)")
    .action(async (expr, o, cmd) => {
      const timeoutMs = cdpTimeoutMs(o);
      const c = await Cdp.connect({ port: await cdpPort(cmd) });
      try {
        printJson(await c.evaluate(expr, { timeoutMs }));
      } finally {
        c.close();
      }
    });
  cdp
    .command("desktop <path> [jsonArgs]")
    .description("Call window.desktop.<path>(...args), e.g. main.getHostSidebarSections '[{}]' (app 0.79+: everything lives under main.*)")
    .option("--timeout <sec>", "per-call timeout in seconds (default 30; known-slow calls get 120)")
    .action(async (path, jsonArgs, o, cmd) => {
      const timeoutMs = cdpTimeoutMs(o);
      const c = await Cdp.connect({ port: await cdpPort(cmd) });
      try {
        printJson(await c.callDesktop(path, jsonArgs ? JSON.parse(jsonArgs) : [], { timeoutMs }));
      } finally {
        c.close();
      }
    });
  cdp.command("keys [path]").description("List window.desktop keys (or a nested namespace)").action(async (path, _, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      printJson(await c.desktopKeys(path ?? ""));
    } finally {
      c.close();
    }
  });
  cdp.command("text").description("Dump the rendered page text (what the user sees)").action(async (_, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      process.stdout.write((await c.pageText()) + "\n");
    } finally {
      c.close();
    }
  });
  cdp.command("screenshot <file>").action(async (file, _, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      await c.bringToFront();
      await sleep(300);
      process.stdout.write((await c.screenshot(file)) + "\n");
    } finally {
      c.close();
    }
  });
  cdp.command("focus").description("Bring the app window to front (also makes the app re-read its sidebar sections)").action(async (_, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      await c.bringToFront();
    } finally {
      c.close();
    }
  });

  // ---- app lifecycle
  const app = program.command("app").description("Desktop app lifecycle");
  app.command("status").action(async (_, cmd) => {
    const st = await appState();
    const ds = local.desktopStatus();
    out(cmd, { ...st, desktopStatus: ds }, () => `running=${st.running} pid=${st.pid} debugPort=${st.debugPort ?? "-"} cdp=${st.cdpReachable} signedIn=${ds?.signedIn ?? "?"} appVersion=${ds?.appVersion ?? "?"}\n`);
  });
  app
    .command("restart")
    .description("Quit and relaunch the app")
    .option("--debug", "relaunch with the CDP port enabled")
    .option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT))
    .action(async (o, cmd) => {
      let st;
      if (o.debug) {
        st = await ensureDebugApp({ port: Number(o.port), restart: true });
      } else {
        // Plain relaunch: no DevTools port is exposed unless asked for.
        if (!(await quitApp())) throw new UsageError("Grok Bot did not quit within 20s; close it manually and retry.");
        await launchApp();
        st = await appState();
      }
      out(cmd, st, `relaunched pid=${st.pid} cdp=${st.cdpReachable ? `:${st.debugPort}` : "off"}\n`);
    });
  app.command("quit").action(async (_, cmd) => {
    const ok = await quitApp();
    out(cmd, { quit: ok }, ok ? "quit\n" : "did not quit within 20s\n");
  });
  app
    .command("open")
    .option("--debug", "launch with the CDP port enabled")
    .option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT))
    .action(async (o, cmd) => {
      if (o.debug) return out(cmd, await ensureDebugApp({ port: Number(o.port) }), "open (debug)\n");
      await launchApp();
      out(cmd, await appState(), "open\n");
    });
  app.command("daemon-log").description("Tail the local-exec daemon log").option("-n <lines>", "lines", "40").action(async (o) => {
    const lines = readFileSync(local.daemonLogPath(), "utf8").trimEnd().split("\n");
    process.stdout.write(lines.slice(-Number(o.n)).join("\n") + "\n");
  });

  // ---- local caches (offline)
  const loc = program.command("local").description("Read the app's offline caches (roster, sections, transcripts). Never authoritative for writes.");
  loc.command("slices").action(async (_, cmd) => {
    const rows = local.listSlices().map((s) => ({ ...s, ...(local.parseSliceKey(s.key) ?? {}) }));
    out(cmd, rows, () => table(rows, [{ key: "slice", label: "slice", max: 70 }, { key: "size", label: "bytes" }, { key: "modifiedAt", label: "modified" }]));
  });
  loc.command("roster").action(async (_, cmd) => {
    const rows = local.cachedRoster();
    out(cmd, rows, () => agentTable(rows, local.cachedSections()) + `${rows.length} cached rows\n`);
  });
  loc.command("sections").action(async () => printJson(local.cachedSections()));
  loc.command("transcripts").description("Agent ids with a cached transcript replica").action(async () => process.stdout.write(local.cachedTranscriptAgentIds().join("\n") + "\n"));
  loc.command("transcript <agentId>").option("--raw").action(async (id, o) => {
    const rep = local.cachedTranscript(id);
    if (!rep) throw new UsageError(`No cached transcript for ${id}`);
    if (o.raw) return printJson(rep);
    process.stdout.write(local.transcriptText(rep).map((e) => `${e.role ?? e.kind ?? "?"}: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") + "\n");
  });
  loc.command("search <query>").description("Grep cached transcripts").action(async (q, _, cmd) => {
    const needle = q.toLowerCase();
    const roster = new Map(local.cachedRoster().map((a) => [a.id, a.name]));
    const hits = [];
    for (const id of local.cachedTranscriptAgentIds()) {
      const rep = local.cachedTranscript(id);
      for (const e of local.transcriptText(rep)) if (e.text.toLowerCase().includes(needle)) hits.push({ agentId: id, agent: roster.get(id) ?? null, role: e.role, text: e.text.replace(/\s+/g, " ").slice(0, 200) });
    }
    out(cmd, hits, () => table(hits, [{ key: "agentId", label: "agent", format: shortId }, { key: "agent", label: "name", max: 24 }, { key: "role", label: "role" }, { key: "text", label: "text", max: 100 }]) + `${hits.length} hits\n`);
  });

  return program;
}

export async function run(argv) {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err?.code === "commander.helpDisplayed" || err?.code === "commander.version" || err?.code === "commander.help") return;
    if (err?.code?.startsWith?.("commander.")) {
      process.exitCode = err.exitCode ?? 64;
      return;
    }
    throw err;
  }
}
