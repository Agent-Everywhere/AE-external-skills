// Host gateway client. The Grok Bot "host" runs inside the user's cloud box and exposes
//   POST {baseUrl}/api/<command>   (JSON in, JSON out, Bearer gateway token + routing headers)
//   GET  {baseUrl}/health
//   GET  {baseUrl}/events          (server-sent events)
// Command names and shapes come from the desktop app's own bridge schemas (see docs/host-commands.md).
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_SECTION_IDS, normalizeSections } from "./sections.js";

export const userSections = (list) => list.filter((x) => !BUILTIN_SECTION_IDS.has(x.id));
export const sectionsKey = (list) => JSON.stringify(list.map((x) => [x.id, x.name, x.agentIds ?? []]));
// Mac-local file that remembers the user sections the Mac last pushed (or mirrored) to the app store: { at, key, conflictKey? }.
// It lives on the Mac, not in host settings: the live host silently drops unknown settings keys.
export const defaultSnapshotPath = () => process.env.GROKBOT_SECTIONS_SYNC_FILE || join(homedir(), ".grokbot", "sections-sync.json");
export function readSnapshotFile(path) {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v.key === "string" ? v : null;
  } catch {
    return null; // missing or unreadable: no snapshot
  }
}
export function writeSnapshotFile(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
const syncSnapshot = (sections) => ({ at: new Date().toISOString(), key: sectionsKey(userSections(normalizeSections(sections))) });
import { redact, redactValue } from "./session.js";

const cleanRules = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim() !== "") : []);
/** Auto-review rules -> { isEnabled, allowInstructions, blockInstructions, legacy? }. A legacy string is read as one allow rule per line (isEnabled null = unknown). */
export function normalizeAutoReview(raw) {
  if (typeof raw === "string") return { isEnabled: raw.trim() === "" ? null : true, allowInstructions: raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), blockInstructions: [], legacy: true };
  if (!raw || typeof raw !== "object") return { isEnabled: null, allowInstructions: [], blockInstructions: [] };
  return { isEnabled: typeof raw.isEnabled === "boolean" ? raw.isEnabled : null, allowInstructions: cleanRules(raw.allowInstructions), blockInstructions: cleanRules(raw.blockInstructions) };
}

export class GatewayError extends Error {
  constructor(message, extra = {}) {
    super(redact(message));
    this.name = "GatewayError";
    Object.assign(this, extra, extra.data !== undefined ? { data: redactValue(extra.data) } : {});
    this.exitCode = extra.status === 401 || extra.status === 403 ? 2 : 1;
  }
}

// undici reports every network failure as "fetch failed"; the useful part (ECONNRESET, ENOTFOUND, ...) is on err.cause.
function fetchFailure(err) {
  const c = err?.cause;
  const detail = c?.code ?? c?.message;
  return detail ? `${err.message} (${detail})` : err.message;
}

export class Gateway {
  // `runtime` (optional CursorClient-like): when set, sidebar sections are read/written on the Cursor control plane.
  constructor(session, { fetchImpl = fetch, timeoutMs = 60_000, runtime = null, snapshotPath = null } = {}) {
    if (!session?.baseUrl || !session?.token) throw new GatewayError("Gateway session is missing baseUrl or token.");
    this.session = { ...session, baseUrl: String(session.baseUrl).replace(/\/+$/, "") };
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.runtime = runtime;
    this.snapshotPath = snapshotPath ?? defaultSnapshotPath();
    this._sectionsBase = undefined; // raw server sections from the last getSections(); CAS base for setSections()
    this.pinsHostOnly = false; // true once setPinned() wrote only host settings (the app reads the Cursor store first)
    this.autoReviewHostOnly = false;
    this.hostOnly = false; // true once setSections() wrote only the host mirror (no runtime client): the app will not show it until a Mac syncs
    this.lastSectionsMirror = null; // outcome of the last host-settings mirror: { ok } | { ok:false, skipped?, reason }
    this._roster = null;
  }

  get baseUrl() {
    return this.session.baseUrl;
  }

  headers(extra = {}) {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.session.token}`,
      ...(this.session.headers ?? {}),
      ...extra,
    };
  }

  async call(command, body = {}, { timeoutMs = this.timeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/api/${command}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new GatewayError(`${command}: ${err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : fetchFailure(err)}`, { command });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const detail = data?.message ?? data?.error ?? data?.raw ?? res.statusText;
      throw new GatewayError(`${command} failed: ${res.status} ${String(detail).slice(0, 400)}`, { status: res.status, command, data });
    }
    return data;
  }

  async health({ timeoutMs = this.timeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}/health`, { headers: this.headers(), signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new GatewayError(`health failed: ${res.status} ${text.slice(0, 200)}`, { status: res.status });
      return JSON.parse(text);
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(`health: ${err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : fetchFailure(err)}`, { command: "health" });
    } finally {
      clearTimeout(timer);
    }
  }

  hostStatus() {
    return this.call("getHostStatus");
  }

  // ------------------------------------------------------------ roster
  async listAgents({ fresh = false } = {}) {
    if (!fresh && this._roster) return this._roster;
    const data = await this.call("listAgents", {});
    const rows = Array.isArray(data) ? data : data?.agents ?? data?.rows ?? [];
    this._roster = rows;
    return rows;
  }

  countAgents() {
    return this.call("countAgents");
  }

  searchAgents(query, limit = 50) {
    return this.call("searchAgents", { query, limit });
  }

  createAgent({ name, description = "", title, purpose, avatarShape, avatarColor, isIntroductionSuppressed, isKickstartRequested } = {}) {
    const body = { name, description };
    if (title !== undefined) body.title = title;
    if (purpose !== undefined) body.purpose = purpose;
    if (avatarShape !== undefined) body.avatarShape = avatarShape;
    if (avatarColor !== undefined) body.avatarColor = avatarColor;
    if (isIntroductionSuppressed !== undefined) body.isIntroductionSuppressed = isIntroductionSuppressed;
    if (isKickstartRequested !== undefined) body.isKickstartRequested = isKickstartRequested;
    this._roster = null;
    return this.call("createAgent", body);
  }

  updateAgent(id, profile) {
    this._roster = null;
    return this.call("updateAgent", { id, profile });
  }

  deleteAgents(ids, { allowEmptyRoster = false } = {}) {
    this._roster = null;
    return this.call("deleteAgents", { ids, ...(allowEmptyRoster ? { allowEmptyRoster: true } : {}) });
  }

  duplicateAgent(id) {
    this._roster = null;
    return this.call("duplicateAgent", { id });
  }

  setHidden(id, isHidden) {
    this._roster = null;
    return this.call("setAgentHiddenFromSidebar", { id, isHidden: Boolean(isHidden) });
  }

  setUnread(id, isUnread) {
    this._roster = null;
    return this.call("setAgentUnread", { id, isUnread: Boolean(isUnread) });
  }

  setNotifyOnUpdates(id, isEnabled) {
    this._roster = null;
    return this.call("setAgentNotifyOnUpdates", { id, isEnabled: Boolean(isEnabled) });
  }

  interrupt(id, sessionId) {
    return this.call("interruptAgentRun", { id, ...(sessionId ? { sessionId } : {}) });
  }

  kickstart(id) {
    return this.call("kickstartAgent", { id });
  }

  createGroup({ name, description, memberAgentIds }) {
    this._roster = null;
    return this.call("createGroup", { name, ...(description !== undefined ? { description } : {}), memberAgentIds, clientNonce: randomUUID() });
  }

  setGroupMembers(id, memberAgentIds) {
    this._roster = null;
    return this.call("setGroupMembers", { id, memberAgentIds });
  }

  // ------------------------------------------------------------ conversation
  sendPrompt(agentId, prompt, extra = {}) {
    const body = { agentId, prompt, clientNonce: extra.clientNonce ?? randomUUID() };
    if (extra.replyToId) body.replyToId = extra.replyToId;
    if (extra.richText) body.richText = extra.richText;
    if (extra.attachmentPaths) body.attachmentPaths = extra.attachmentPaths;
    const sentAt = Date.now();
    return this.call("sendPrompt", body).then((r) => ({ ...(r ?? {}), clientNonce: body.clientNonce, sentAt }));
  }

  promptAcceptanceStatus(clientNonce) {
    return this.call("promptAcceptanceStatus", { clientNonce });
  }

  transcriptTail(id, limit = 50) {
    return this.call("getAgentTranscriptTail", { id, limit });
  }

  transcriptPage(id, { beforeSeq, limit = 100 } = {}) {
    return this.call("getAgentTranscriptPage", { id, limit, ...(beforeSeq != null ? { beforeSeq } : {}) });
  }

  thread(id, rootId) {
    return this.call("getAgentThread", { id, rootId });
  }

  conversationOutline(id) {
    return this.call("getConversationOutline", { id });
  }

  subagents(id) {
    return this.call("getSubagents", { id });
  }

  asyncTasks(id) {
    return this.call("getAsyncTasks", { id });
  }

  searchMedia(query, limit = 50) {
    return this.call("searchMedia", { query, limit });
  }

  // Per-agent work lists. The host argument names differ per command (checked live against host 00b0aa1).
  todos(id) {
    return this.call("getAgentTodos", { id });
  }

  tasks(agentId) {
    return this.call("getAgentTasks", { agentId });
  }

  searchConversation(agentId, query, limit = 50) {
    return this.call("searchConversation", { agentId, query, limit });
  }

  // ------------------------------------------------------------ host settings (sections, pins, models)
  getHostSettings() {
    return this.call("getHostSettings");
  }

  async setHostSettings(patch) {
    return this.call("setHostSettings", patch);
  }

  async getSections() {
    if (this.runtime) {
      // Remember the raw server list: it is the optimistic-concurrency base for the next setSections().
      const raw = await this.runtime.getSidebarSections();
      this._sectionsBase = raw;
      const got = normalizeSections(raw);
      if (userSections(got).length === 0) await this._warnIfHostHoldsLayout();
      return got;
    }
    const s = await this.getHostSettings();
    return normalizeSections(s?.sidebarSections);
  }

  async setSections(sections) {
    if (this.runtime) {
      const base = this._sectionsBase !== undefined ? this._sectionsBase : await this.runtime.getSidebarSections();
      const stored = await this.runtime.setSidebarSections(sections, base);
      this._sectionsBase = stored;
      // Mirror what the server actually stored (it may amend the request, e.g. re-adding the protected bucket),
      // not what we asked for: otherwise host != server forever after and the divergence guard skips every mirror.
      await this._mirrorSections(Array.isArray(stored) ? stored : sections, base);
      return normalizeSections(stored);
    }
    this.hostOnly = true;
    const r = await this.setHostSettings({ sidebarSections: sections });
    return normalizeSections(Array.isArray(r?.sidebarSections) ? r.sidebarSections : sections);
  }

  // Both stores side by side. The app reads the runtime store; agents in the box can only write the host mirror
  // (they hold no Cursor auth), so the two can drift until a Mac runs syncHostToRuntime(). `runtime`/`drift` are null
  // when there is no runtime client; `snapshot` is what the last sync/mirror pushed ({ at, key }) or null.
  async sectionStores() {
    const hs = await this.getHostSettings();
    const host = normalizeSections(hs?.sidebarSections);
    const snapshot = readSnapshotFile(this.snapshotPath);
    if (!this.runtime) return { runtime: null, host, drift: null, snapshot };
    const runtime = normalizeSections(await this.runtime.getSidebarSections());
    return { runtime, host, drift: sectionsKey(userSections(runtime)) !== sectionsKey(userSections(host)), snapshot };
  }

  // Mac-side: push the host mirror (what agents wrote) into the app store. Never wipes the app from an empty mirror, and
  // refuses (unless force) when both sides moved since the last sync: the app has edits the mirror does not know about.
  // `auto` (launchd): a real conflict is not an error. The app copy is kept, nothing is written, and the result is
  // { changed:false, reason:"conflict", newConflict, runtime, host }; newConflict is true only the first time this exact
  // runtime/host pair is seen (recorded as `conflictKey` in the snapshot file), so the caller logs it once.
  async syncHostToRuntime({ force = false, auto = false } = {}) {
    if (!this.runtime) throw new GatewayError("sections sync needs Cursor sign-in (no app store reachable from here).", { reason: "no-runtime" });
    const rawRuntime = await this.runtime.getSidebarSections();
    const runtimeAll = normalizeSections(rawRuntime);
    const hs = await this.getHostSettings();
    const hostAll = normalizeSections(hs?.sidebarSections);
    const snapshot = readSnapshotFile(this.snapshotPath);
    const hostUser = userSections(hostAll);
    const hostKey = sectionsKey(hostUser);
    const runtimeKey = sectionsKey(userSections(runtimeAll));
    if (hostUser.length === 0) {
      throw new GatewayError("Refusing to sync: the host mirror has no sections (an empty mirror would wipe the app's layout).", { reason: "empty-host" });
    }
    if (hostKey === runtimeKey) {
      if (snapshot?.key !== hostKey || snapshot?.conflictKey) writeSnapshotFile(this.snapshotPath, syncSnapshot(hostUser));
      return { ok: true, changed: false, before: runtimeAll, after: runtimeAll };
    }
    if (!force) {
      if (!snapshot) {
        throw new GatewayError(
          "Refusing to sync: no sync snapshot exists, so there is no way to tell whether the app has edits the host mirror lacks. Review the diff (`grokbot sections sync --dry-run`), then re-run with --force.",
          { reason: "no-snapshot" },
        );
      }
      // Host equals the last sync: nothing staged by agents. The stores differ only because the app moved; never overwrite it.
      if (hostKey === snapshot.key) return { ok: true, changed: false, reason: "host-unchanged", before: runtimeAll, after: runtimeAll };
      if (runtimeKey !== snapshot.key) {
        if (auto) {
          const conflictKey = JSON.stringify([hostKey, runtimeKey]);
          const newConflict = snapshot.conflictKey !== conflictKey;
          if (newConflict) {
            try {
              writeSnapshotFile(this.snapshotPath, { ...snapshot, conflictKey });
            } catch (e) {
              process.stderr.write(`grokbot: warning: could not record the sync conflict: ${e?.message ?? e}\n`);
            }
          }
          return { ok: true, changed: false, reason: "conflict", newConflict, runtime: userSections(runtimeAll), host: hostUser, before: runtimeAll, after: runtimeAll };
        }
        throw new GatewayError(
          "Refusing to sync: both the app and the host mirror changed since the last sync (app-side edits would be overwritten). Re-run with --force to push the mirror anyway.",
          { reason: "conflict" },
        );
      }
    }
    const next = [...hostUser];
    const bucketIdx = runtimeAll.findIndex((x) => BUILTIN_SECTION_IDS.has(x.id));
    if (bucketIdx >= 0) next.splice(Math.min(bucketIdx, next.length), 0, runtimeAll[bucketIdx]);
    const stored = await this.runtime.setSidebarSections(next, rawRuntime);
    this._sectionsBase = stored;
    const after = normalizeSections(Array.isArray(stored) ? stored : next);
    // The app write already happened; a failed snapshot write must not turn that into an error, but it must not be silent:
    // without the snapshot the next sync cannot tell this push from an app-side edit.
    let snapshotWritten = true;
    try {
      writeSnapshotFile(this.snapshotPath, syncSnapshot(after));
    } catch (e) {
      snapshotWritten = false;
      process.stderr.write(`grokbot: warning: pushed to the app store but could not record the sync snapshot: ${e?.message ?? e}\n`);
    }
    return { ok: true, changed: true, snapshotWritten, before: runtimeAll, after };
  }

  // Read path: the server list is what the app shows, so report it honestly, but say so on stderr when it is empty
  // while host settings still hold a layout (e.g. a machine whose sections never reached the server), so an
  // empty `sections list` / `sections export` is never mistaken for "no layout anywhere". Host read errors are ignored.
  async _warnIfHostHoldsLayout() {
    try {
      const host = userSections(normalizeSections((await this.getHostSettings())?.sidebarSections));
      if (host.length > 0) {
        process.stderr.write(
          `grokbot: warning: server sections are empty while host settings hold ${host.length}; ` +
            `see \`grokbot settings get sidebarSections\`\n`,
        );
      }
    } catch {
      /* host unreachable: nothing to compare against */
    }
  }

  // Best-effort mirror for older hosts/apps that still read host settings. Never fails setSections, but never
  // silent either: the outcome is recorded in this.lastSectionsMirror, and skips and failures warn on stderr.
  // Skipped whenever the host holds a non-empty layout that differs from the server layout we edited (`base`):
  // the host copy has diverged, and overwriting it would destroy the only copy of that layout. This holds on every
  // later command too, not just the first edit after an empty server list.
  async _mirrorSections(sections, base) {
    try {
      const host = userSections(normalizeSections((await this.getHostSettings())?.sidebarSections));
      if (host.length > 0 && sectionsKey(host) !== sectionsKey(userSections(normalizeSections(base)))) {
        const reason = `host settings hold ${host.length} section(s) that differ from the server list`;
        this.lastSectionsMirror = { ok: false, skipped: true, reason };
        process.stderr.write(`grokbot: warning: ${reason}; host mirror skipped (see \`grokbot settings get sidebarSections\`)\n`);
        return;
      }
      await this.setHostSettings({ sidebarSections: sections });
      this.lastSectionsMirror = { ok: true };
      // Record the snapshot (only once the host write landed) so a later `sections sync --auto` does not see a false app-side edit.
      try {
        writeSnapshotFile(this.snapshotPath, syncSnapshot(sections));
      } catch (e) {
        this.lastSectionsMirror = { ok: true, snapshotWritten: false };
        process.stderr.write(`grokbot: warning: host mirror written but could not record the sync snapshot: ${e?.message ?? e}\n`);
      }
    } catch (e) {
      const reason = e?.message ?? String(e);
      this.lastSectionsMirror = { ok: false, reason };
      process.stderr.write(`grokbot: warning: host sections mirror failed: ${reason}\n`);
    }
  }

  // Pins: the app (0.79+) reads/writes the Cursor runtime store (settings.pinnedAgents) and only falls back to the host
  // `pinnedAgentIds` setting when the server holds none. Host settings are a stale mirror, so read the runtime first.
  async getPinned() {
    if (this.runtime) {
      const ids = await this.runtime.getPinnedAgents();
      if (ids) return ids;
    }
    const s = await this.getHostSettings();
    return Array.isArray(s?.pinnedAgentIds) ? s.pinnedAgentIds : [];
  }

  async setPinned(ids) {
    if (this.runtime) {
      const stored = await this.runtime.setPinnedAgents(ids);
      // Always mirror to host settings, [] included. After an emptying write the app falls back to the host list when the
      // server holds none, so a stale host list would silently bring the old pins back: that failure is not best-effort.
      try {
        await this.setHostSettings({ pinnedAgentIds: stored });
      } catch (e) {
        const why = e?.message ?? String(e);
        if (stored.length === 0) {
          throw new GatewayError(`pins were cleared in the Cursor store, but mirroring the empty list to host settings failed (${why}); the app falls back to the stale host list until it is cleared there too`, { reason: "pins-mirror-failed" });
        }
        process.stderr.write(`grokbot: warning: host pins mirror failed: ${why}\n`);
      }
      return stored;
    }
    this.pinsHostOnly = true;
    const r = await this.setHostSettings({ pinnedAgentIds: ids });
    return Array.isArray(r?.pinnedAgentIds) ? r.pinnedAgentIds : ids;
  }

  // Auto-review rules: structured { isEnabled, allowInstructions[], blockInstructions[] } in both the runtime store and
  // host settings (0.79+; the 0.47 host setting was a free-form string, which normalizeAutoReview still reads).
  async getAutoReview() {
    if (this.runtime) {
      const v = await this.runtime.getAutoReview();
      if (v) return normalizeAutoReview(v);
    }
    return normalizeAutoReview((await this.getHostSettings())?.autoReviewInstructions);
  }

  async setAutoReview(value) {
    const body = { isEnabled: value.isEnabled, allowInstructions: value.allowInstructions, blockInstructions: value.blockInstructions };
    if (this.runtime) {
      const stored = normalizeAutoReview(await this.runtime.setAutoReview(body));
      try {
        await this.setHostSettings({ autoReviewInstructions: body });
      } catch (e) {
        process.stderr.write(`grokbot: warning: host auto-review mirror failed: ${e?.message ?? e}\n`);
      }
      return stored;
    }
    this.autoReviewHostOnly = true;
    const r = await this.setHostSettings({ autoReviewInstructions: body });
    return normalizeAutoReview(r?.autoReviewInstructions ?? body);
  }

  // ------------------------------------------------------------ automations / misc
  listAutomations() {
    return this.call("listAllAutomations");
  }

  agentAutomations(id) {
    return this.call("getAgentAutomations", { id });
  }

  // ------------------------------------------------------------ events (SSE)
  async *events({ signal } = {}) {
    const res = await this.fetch(`${this.baseUrl}/events`, { headers: this.headers({ accept: "text/event-stream" }), signal });
    if (!res.ok) throw new GatewayError(`events failed: ${res.status}`, { status: res.status });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseSse(chunk);
        if (evt) yield evt;
      }
    }
  }
}

export function parseSse(chunk) {
  const evt = { event: "message", data: "", id: null };
  let any = false;
  for (const line of chunk.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    any = true;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") evt.event = value;
    else if (field === "data") evt.data += (evt.data ? "\n" : "") + value;
    else if (field === "id") evt.id = value;
  }
  if (!any) return null;
  try {
    evt.json = JSON.parse(evt.data);
  } catch {
    evt.json = null;
  }
  return evt;
}
