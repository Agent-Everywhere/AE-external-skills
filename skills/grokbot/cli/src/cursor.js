// Cursor control-plane client: Connect-RPC (JSON) against aiserver.v1.GrokBotService on api2.cursor.sh.
// This is the layer *behind* the desktop app: server-side agent objects, sandbox lifecycle, templates,
// team agents. The live roster/transcripts live on the host gateway (gateway.js), not here.
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

  async rpc(method, body = {}, { service = this.service, headers = {} } = {}) {
    const url = `${this.baseUrl}/${service}/${method}`;
    const extra = { ...headers };
    if (this.auth.teamId && !extra["x-cursor-team-id"]) extra["x-cursor-team-id"] = String(this.auth.teamId);
    const res = await this.fetch(url, { method: "POST", headers: cursorHeaders(this.auth.accessToken, extra), body: JSON.stringify(body ?? {}) });
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

  async listAgents({ includeTeamAgents = true, role } = {}) {
    const r = await this.rpc("ListGrokBotAgents", { includeTeamAgents, ...(role ? { role } : {}) });
    return { agents: r.agents ?? [], slackConnections: r.slackConnections ?? [] };
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

  runtimeCapabilities() {
    return this.rpc("GetGrokBotRuntimeCapabilities", {});
  }
}
