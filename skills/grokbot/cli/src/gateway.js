// Host gateway client. The Grok Bot "host" runs inside the user's cloud box and exposes
//   POST {baseUrl}/api/<command>   (JSON in, JSON out, Bearer gateway token + routing headers)
//   GET  {baseUrl}/health
//   GET  {baseUrl}/events          (server-sent events)
// Command names and shapes come from the desktop app's own bridge schemas (see docs/host-commands.md).
import { randomUUID } from "node:crypto";
import { redact, redactValue } from "./session.js";

export class GatewayError extends Error {
  constructor(message, extra = {}) {
    super(redact(message));
    this.name = "GatewayError";
    Object.assign(this, extra, extra.data !== undefined ? { data: redactValue(extra.data) } : {});
    this.exitCode = extra.status === 401 || extra.status === 403 ? 2 : 1;
  }
}

export class Gateway {
  constructor(session, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
    if (!session?.baseUrl || !session?.token) throw new GatewayError("Gateway session is missing baseUrl or token.");
    this.session = { ...session, baseUrl: String(session.baseUrl).replace(/\/+$/, "") };
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
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
      throw new GatewayError(`${command}: ${err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err.message}`, { command });
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

  async health() {
    const res = await this.fetch(`${this.baseUrl}/health`, { headers: this.headers() });
    const text = await res.text();
    if (!res.ok) throw new GatewayError(`health failed: ${res.status} ${text.slice(0, 200)}`, { status: res.status });
    return JSON.parse(text);
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

  deleteAgent(id) {
    this._roster = null;
    return this.call("deleteAgent", { id });
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

  setNotifications(id, isEnabled) {
    this._roster = null;
    return this.call("setAgentNotificationsEnabled", { id, isEnabled: Boolean(isEnabled) });
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

  memories(id) {
    return this.call("getAgentMemories", { id });
  }

  // ------------------------------------------------------------ host settings (sections, pins, models)
  getHostSettings() {
    return this.call("getHostSettings");
  }

  async setHostSettings(patch) {
    return this.call("setHostSettings", patch);
  }

  async getSections() {
    const s = await this.getHostSettings();
    return Array.isArray(s?.sidebarSections) ? s.sidebarSections : [];
  }

  async setSections(sections) {
    const r = await this.setHostSettings({ sidebarSections: sections });
    return Array.isArray(r?.sidebarSections) ? r.sidebarSections : sections;
  }

  async getPinned() {
    const s = await this.getHostSettings();
    return Array.isArray(s?.pinnedAgentIds) ? s.pinnedAgentIds : [];
  }

  async setPinned(ids) {
    const r = await this.setHostSettings({ pinnedAgentIds: ids });
    return Array.isArray(r?.pinnedAgentIds) ? r.pinnedAgentIds : ids;
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
