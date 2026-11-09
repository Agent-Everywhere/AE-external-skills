// Cursor control-plane client: Connect-RPC (JSON) against aiserver.v1.GrokBotService on api2.cursor.sh.
// This is the layer *behind* the desktop app: server-side agent objects, sandbox lifecycle, templates,
// team agents. The live roster/transcripts live on the host gateway (gateway.js), not here.
import { randomUUID } from "node:crypto";
import { CURSOR_API, cursorHeaders, jwtClaims, redact, redactValue } from "./session.js";

export class CursorRpcError extends Error {
  constructor(message, extra = {}) {
    super(redact(message));
    this.name = "CursorRpcError";
    Object.assign(this, extra, extra.data !== undefined ? { data: redactValue(extra.data) } : {});
    this.exitCode = extra.status === 401 ? 2 : 1;
  }
}

export class CursorClient {
  constructor(auth, { fetchImpl = fetch, service = "aiserver.v1.GrokBotService", baseUrl = CURSOR_API } = {}) {
    if (!auth?.accessToken) throw new CursorRpcError("No Cursor access token available (sign in to Grok Bot first).");
    this.auth = auth;
    this.fetch = fetchImpl;
    this.service = service;
    this.baseUrl = baseUrl;
  }

  tokenInfo() {
    const claims = jwtClaims(this.auth.accessToken) ?? {};
    const expMs = claims.exp ? claims.exp * 1000 : null;
    return {
      accountScope: this.auth.accountScope,
      email: this.auth.profile?.email ?? null,
      name: this.auth.profile?.name ?? null,
      subject: claims.sub ?? null,
      issuer: claims.iss ?? null,
      audience: claims.aud ?? null,
      type: claims.type ?? null,
      expiresAt: expMs ? new Date(expMs).toISOString() : null,
      expired: expMs ? expMs < Date.now() : null,
      hasRefreshToken: Boolean(this.auth.refreshToken),
      teamId: this.auth.teamId ?? null,
    };
  }

  async rpc(method, body = {}, { service = this.service, headers = {}, signal } = {}) {
    const url = `${this.baseUrl}/${service}/${method}`;
    const extra = { ...headers };
    if (this.auth.teamId && !extra["x-cursor-team-id"]) extra["x-cursor-team-id"] = String(this.auth.teamId);
    const res = await this.fetch(url, { method: "POST", headers: cursorHeaders(this.auth.accessToken, extra), body: JSON.stringify(body ?? {}), ...(signal ? { signal } : {}) });
    const text = await res.text();
    let data;
    try {
      data = text === "" ? {} : JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const detail = data?.details?.[0]?.debug?.details?.detail ?? data?.message ?? data?.raw ?? res.statusText;
      throw new CursorRpcError(`${method} failed: ${res.status} ${data?.code ?? ""} ${String(detail).slice(0, 300)}`.trim(), { status: res.status, method, data });
    }
    return data;
  }

  // `truncated` mirrors ListGrokBotAgentsResponse.truncated: true means the page is not the whole roster, so absence from it proves nothing.
  async listAgents({ includeTeamAgents = true, role, signal } = {}) {
    const r = await this.rpc("ListGrokBotAgents", { includeTeamAgents, ...(role ? { role } : {}) }, signal ? { signal } : {});
    return { agents: r.agents ?? [], slackConnections: r.slackConnections ?? [], truncated: Boolean(r.truncated) };
  }

  // Read-only. Routines of server-hosted agents live here (the box gateway's listAllAutomations is empty for them).
  // Each row is {automationId, recordJson (JSON string with prompt/trigger/isEnabled/...), viewerPermissions}.
  async listAccountAutomations(agentIds) {
    const r = await this.rpc("ListGrokBotAccountAutomations", { agentIds });
    return r.agents ?? [];
  }

  async listAgentAutomations(agentId) {
    const r = await this.rpc("ListGrokBotAgentAutomations", { agentId });
    return r.automations ?? [];
  }

  // Read-only helpers for usage and per-agent backup. Usage lives on DashboardService, not GrokBotService.
  dashboard(method) {
    return this.rpc(method, {}, { service: "aiserver.v1.DashboardService" });
  }

  // allSettled: one failing read must not hide the others. `errors` maps RPC name -> message.
  async usage() {
    const calls = { status: "GetSandUsageStatus", period: "GetCurrentPeriodUsage", access: "GetSandAccessStatus", cycle: "GetMonthlyBillingCycle" };
    const settled = await Promise.allSettled(Object.values(calls).map((m) => this.dashboard(m)));
    const out = { errors: {} };
    Object.entries(calls).forEach(([key, method], i) => {
      const r = settled[i];
      if (r.status === "fulfilled") out[key] = r.value;
      else out.errors[method] = String(r.reason?.message ?? r.reason).replace(/^grokbot:\s*/, "").slice(0, 160);
    });
    if (Object.keys(out.errors).length === settled.length) throw new CursorRpcError(`usage unavailable: ${Object.values(out.errors)[0]}`);
    return out;
  }

  async listAgentSkills(agentId) {
    return (await this.rpc("ListGrokBotAgentSkills", { agentId })).skills ?? [];
  }

  // includeMcpConfig stays false: custom MCP config can carry env/credentials and is never exported.
  getAgentPlugins(agentId) {
    return this.rpc("GetGrokBotAgentPlugins", { agentId, includeMcpConfig: false });
  }

  getAgentAccess(agentId) {
    return this.rpc("GetGrokBotAgentAccess", { agentId });
  }

  /** One page of transcript entries, newest first; `beforeSeq` pages backwards. */
  async listTranscriptEntries(agentId, { limit = 200, beforeSeq } = {}) {
    const r = await this.rpc("ListGrokBotTranscriptEntries", { agentId, limit, ...(beforeSeq !== undefined ? { beforeSeq: String(beforeSeq) } : {}) });
    return r.entries ?? [];
  }

  // WRITE. Returns the agent's full automation rows after the change.
  async setAutomationEnabled(agentId, automationId, isEnabled) {
    return (await this.rpc("SetGrokBotAgentAutomationEnabled", { agentId, automationId, isEnabled })).automations ?? [];
  }

  deleteAgent(id) {
    return this.rpc("DeleteGrokBotAgent", { id });
  }

  updateAgent(id, patch) {
    return this.rpc("UpdateGrokBotAgent", { id, ...patch });
  }

  setVisibility(agentId, visibility) {
    return this.rpc("SetGrokBotAgentVisibility", { agentId, visibility });
  }

  listSessions(agentId) {
    return this.rpc("ListGrokBotAgentSessions", { agentId });
  }

  listTeamAgents() {
    return this.rpc("AdminListGrokBotTeamAgents", {});
  }

  listBoxes() {
    return this.rpc("ListSandBoxes", {});
  }

  runState() {
    return this.rpc("GetSandBoxRunState", {});
  }

  ensureSandBox() {
    return this.rpc("EnsureSandBox", {});
  }

  listTemplates() {
    return this.rpc("ListGrokBotTemplates", {});
  }

  listUserComputers() {
    return this.rpc("ListGrokBotUserComputers", {});
  }

  // Sidebar sections live in the per-user runtime settings on the control plane (the app no longer reads host settings).
  async getSidebarSections() {
    const r = await this.rpc("GetGrokBotUserRuntimeSettings", {});
    const sections = r?.settings?.sidebarSections?.sections;
    return Array.isArray(sections) ? sections : [];
  }

  // `base` is the optimistic-concurrency check (the sections we read before editing); omitted when not provided.
  async setSidebarSections(sections, base) {
    const body = { sidebarSections: { sections } };
    if (base !== undefined && base !== null) body.sidebarSectionsBase = { sections: base };
    const r = await this.rpc("UpdateGrokBotUserRuntimeSettings", body);
    const stored = r?.settings?.sidebarSections?.sections;
    if (!Array.isArray(stored)) throw new CursorRpcError("UpdateGrokBotUserRuntimeSettings returned no sidebarSections", { method: "UpdateGrokBotUserRuntimeSettings", data: r });
    return stored;
  }

  // Whole per-user runtime settings object (pins, sections, auto-review rules, main agent, ...). Read-only.
  async getRuntimeSettings() {
    const r = await this.rpc("GetGrokBotUserRuntimeSettings", {});
    return r?.settings ?? {};
  }

  // Pins moved from the host `pinnedAgentIds` setting to the runtime store in the 0.79 app: the app reads
  // settings.pinnedAgents.agentIds and only falls back to the host list when the server holds none (null here).
  async getPinnedAgents() {
    const pa = (await this.getRuntimeSettings()).pinnedAgents;
    if (!pa || typeof pa !== "object") return null; // the server holds no pins: the app then falls back to the host list
    return Array.isArray(pa.agentIds) ? pa.agentIds : []; // proto3 JSON omits an empty repeated field
  }

  // Proto3 JSON drops an empty `agentIds`, so a successful write of [] comes back as `pinnedAgents: {}` or without the
  // key. Only a reply with no `settings` at all is treated as "the server did not store it".
  async setPinnedAgents(ids) {
    const r = await this.rpc("UpdateGrokBotUserRuntimeSettings", { pinnedAgents: { agentIds: ids } });
    if (!r?.settings || typeof r.settings !== "object") throw new CursorRpcError("UpdateGrokBotUserRuntimeSettings returned no settings", { method: "UpdateGrokBotUserRuntimeSettings", data: r });
    const stored = r.settings.pinnedAgents?.agentIds;
    return Array.isArray(stored) ? stored : [];
  }

  // Auto-review rules are structured now: { isEnabled, allowInstructions[], blockInstructions[] } (+ server-derived
  // approvalMode fields on read). null when the server has none.
  async getAutoReview() {
    const v = (await this.getRuntimeSettings()).autoReviewInstructions;
    return v && typeof v === "object" ? v : null;
  }

  async setAutoReview({ isEnabled, allowInstructions, blockInstructions }) {
    const body = { autoReviewInstructions: { isEnabled: Boolean(isEnabled), allowInstructions, blockInstructions } };
    const r = await this.rpc("UpdateGrokBotUserRuntimeSettings", body);
    const stored = r?.settings?.autoReviewInstructions;
    if (!stored || typeof stored !== "object") throw new CursorRpcError("UpdateGrokBotUserRuntimeSettings returned no autoReviewInstructions", { method: "UpdateGrokBotUserRuntimeSettings", data: r });
    return stored;
  }

  // Read-only. The control plane holds todos/tasks for server-hosted agents; the box gateway returns [] for them.
  async listAgentTodos(agentId) {
    return (await this.rpc("ListGrokBotAgentTodos", { agentId })).todos ?? [];
  }

  async listAgentTasks(agentId, { includeRecentlyDone = false } = {}) {
    const r = await this.rpc("ListGrokBotAgentTasks", { agentId, ...(includeRecentlyDone ? { includeRecentlyDone: true } : {}) });
    return r ?? {};
  }

  // ---- Slack (operator-only; GrokBotService install flow + DashboardService workspace links). Writes are marked.
  // Dashboard requests here take no Cursor team id: the live account answers `{}`.
  dashboardRpc(method, body = {}) {
    return this.rpc(method, body, { service: "aiserver.v1.DashboardService" });
  }

  getSlackInstallState(agentId, { signal } = {}) {
    return this.rpc("GetGrokBotSlackInstallState", { agentId }, { signal });
  }

  async listSlackWorkspaces() {
    const r = await this.dashboardRpc("ListSlackLinkedWorkspaces");
    return { workspaces: r.workspaces ?? [], canLinkAnotherWorkspace: Boolean(r.canLinkAnotherWorkspace) };
  }

  getSlackUserSettings() {
    return this.dashboardRpc("GetSlackUserSettings");
  }

  // Mints an install attempt and returns the Slack OAuth URL (does not change the link state by itself).
  getSlackInstallUrl({ reconnectSlackTeamId } = {}) {
    return this.dashboardRpc("GetSlackInstallUrl", reconnectSlackTeamId ? { reconnectSlackTeamId } : {});
  }

  startSlackConnect(agentId) {
    return this.rpc("StartGrokBotSlackConnect", { agentId });
  }

  // WRITE: consumes a one-time claim and links the Slack workspace to this account.
  claimSlackConnect(claim) {
    return this.rpc("ClaimGrokBotSlackConnect", { claim });
  }

  // WRITE: creates/replaces the agent's Slack app in a workspace.
  installSlackApp(agentId, { slackTeamId, replaceExistingApp = false } = {}) {
    return this.rpc("InstallGrokBotSlackApp", { agentId, ...(slackTeamId ? { slackTeamId } : {}), ...(replaceExistingApp ? { replaceExistingApp: true } : {}) });
  }

  // WRITE: updates the agent's Slack app manifest.
  reinstallSlackApp(agentId) {
    return this.rpc("ReinstallGrokBotSlackApp", { agentId });
  }

  // WRITE: removes the agent's Slack app from its workspace (forgetIfUnreachable drops the record even if Slack cannot be reached).
  uninstallSlackApp(agentId, { forgetIfUnreachable = false } = {}) {
    return this.rpc("UninstallGrokBotSlackApp", { agentId, ...(forgetIfUnreachable ? { forgetIfUnreachable: true } : {}) });
  }

  // WRITE: unlinks one Slack workspace from the account (every Slack-delivered routine for it stops).
  unlinkSlackAccess(slackTeamId) {
    return this.dashboardRpc("UnlinkSlackAccess", { slackTeamId });
  }

  // WRITE: points one routine at a linked Slack workspace. Returns the refreshed workspace list.
  async setAutomationSlackWorkspace(automationId, slackTeamId) {
    const r = await this.dashboardRpc("SetSandAutomationSlackWorkspace", { automationId, slackTeamId });
    return r.workspaces ?? [];
  }

  // WRITE: deletes a control-plane routine (the box gateway's deleteAgentAutomation is a silent no-op for these).
  // Returns the agent's remaining automation rows.
  async deleteAutomation(agentId, automationId, timeZone) {
    return (await this.rpc("DeleteGrokBotAgentAutomation", { agentId, automationId, ...(timeZone ? { timeZone } : {}) })).automations ?? [];
  }

  // WRITE: sends a user message to an agent through the control plane. Since app 0.79 the host gateway's `sendPrompt`
  // answers 502 "A Sand box session may not make this request on this endpoint" to a Mac-side caller. Reply:
  // { dispatched, mode (e.g. ACCEPTED_TEMPORAL), workflowId?, delivery?, refusal? }.
  async sendUserMessage(agentId, text, { messageId = randomUUID(), sentAtMs = Date.now(), replyToId } = {}) {
    const body = { agentId, messageId, text, sentAtMs: String(sentAtMs), ...(replyToId ? { replyToId } : {}) };
    const r = await this.rpc("SendGrokBotUserMessage", body);
    return { ...r, messageId, sentAtMs };
  }

  runtimeCapabilities() {
    return this.rpc("GetGrokBotRuntimeCapabilities", {});
  }
}
