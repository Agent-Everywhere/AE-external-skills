// Session discovery for Grok Bot (Cursor's "sand" desktop app).
//
// Three credential surfaces, all derived from the signed-in desktop app:
//   1. Host gateway descriptor  — ~/Library/Application Support/Grok Bot/gateway-descriptor.json
//      Electron safeStorage ciphertext (Chromium OSCrypt v10, AES-128-CBC, key = PBKDF2 of the
//      "Grok Bot Safe Storage" Keychain password). Decrypts to { baseUrl, token, headers, vncProxy }.
//   2. Cursor account tokens    — sand-secrets.json → "cursor-accounts" (plain JSON) whose per-account
//      values ("cursor-access-token", "cursor-refresh-token", "cursor-account-profile") are safeStorage
//      ciphertext, optionally prefixed "scoped:v1:<scope>:".
//   3. EnsureSandBox            — Cursor RPC that mints a fresh gateway url/token from the access token.
//      Used only when the descriptor is missing or stale.
//
// Nothing here ever prints a secret. Use redact() on anything user-facing.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_BUNDLE = process.env.GROKBOT_APP_BUNDLE || "/Applications/Grok Bot.app";
export const APP_SUPPORT =
  process.env.GROKBOT_APP_SUPPORT || join(homedir(), "Library/Application Support/Grok Bot");
export const GROKBOT_HOME = process.env.GROKBOT_HOME || join(homedir(), ".grokbot");
export const CURSOR_API = (process.env.GROKBOT_CURSOR_API || "https://api2.cursor.sh").replace(/\/$/, "");
export const KEYCHAIN_SERVICE = "Grok Bot Safe Storage";
const DESCRIPTOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // the app itself treats entries older than 7d as stale

export class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.exitCode = 2;
  }
}

let cachedKey = null;
export function readKeychainPassword() {
  if (process.env.GROKBOT_SAFE_STORAGE_PASSWORD) return process.env.GROKBOT_SAFE_STORAGE_PASSWORD;
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
  } catch (err) {
    throw new SessionError(
      "KEYCHAIN_DENIED",
      `Could not read the "${KEYCHAIN_SERVICE}" Keychain item (macOS asks for your Mac login password; choose "Always Allow").`,
    );
  }
}

export function safeStorageKey(password = null) {
  if (password == null && cachedKey) return cachedKey;
  const key = crypto.pbkdf2Sync(password ?? readKeychainPassword(), "saltysalt", 1003, 16, "sha1");
  if (password == null) cachedKey = key;
  return key;
}

export function decryptSafeStorage(ciphertextBase64, key = null) {
  const buf = Buffer.from(ciphertextBase64, "base64");
  const prefix = buf.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") {
    throw new SessionError("UNSUPPORTED_CIPHERTEXT", `Unsupported safeStorage prefix ${JSON.stringify(prefix)}`);
  }
  const decipher = crypto.createDecipheriv("aes-128-cbc", key ?? safeStorageKey(), Buffer.alloc(16, 32));
  return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString("utf8");
}

export function encryptSafeStorage(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(plaintext, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

// ---------------------------------------------------------------- gateway descriptor

export function descriptorPath() {
  return join(APP_SUPPORT, "gateway-descriptor.json");
}

export function parseDescriptorFile(json, { accountScope = null, decrypt = decryptSafeStorage } = {}) {
  const wrapped = typeof json === "string" ? JSON.parse(json) : json;
  let entries;
  if (wrapped.version === 2) {
    entries = Object.entries(wrapped.entries ?? {}).filter(([, v]) => v && typeof v.encrypted === "string");
  } else if (typeof wrapped.encrypted === "string") {
    entries = [["default", { encrypted: wrapped.encrypted, savedAtMs: 0 }]];
  } else {
    entries = [];
  }
  if (accountScope) entries = entries.filter(([scope]) => scope === accountScope);
  if (entries.length === 0) return null;
  entries.sort((a, b) => (b[1].savedAtMs ?? 0) - (a[1].savedAtMs ?? 0));
  const [scope, entry] = entries[0];
  const desc = JSON.parse(decrypt(entry.encrypted));
  if (!desc.baseUrl || !desc.token) {
    throw new SessionError("INCOMPLETE_DESCRIPTOR", "Decrypted gateway descriptor is missing baseUrl or token.");
  }
  return {
    source: "descriptor",
    accountScope: scope,
    savedAtMs: entry.savedAtMs ?? null,
    entryCount: Object.keys(wrapped.entries ?? {}).length || 1,
    baseUrl: String(desc.baseUrl).replace(/\/$/, ""),
    token: String(desc.token),
    headers: normalizeHeaders(desc.headers),
    vncProxy: desc.vncProxy ?? null,
  };
}

export function loadGatewayDescriptor(opts = {}) {
  const p = descriptorPath();
  if (!existsSync(p)) return null;
  return parseDescriptorFile(readFileSync(p, "utf8"), opts);
}

export function normalizeHeaders(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v != null && v !== "") out[String(k).toLowerCase()] = String(v);
  return out;
}

// ---------------------------------------------------------------- Cursor account tokens

function unscope(value) {
  if (!value.startsWith("scoped:v1:")) return value;
  const i = value.indexOf(":", "scoped:v1:".length);
  return i < 0 ? value : value.slice(i + 1);
}

export function readSecretValue(value, key = null) {
  if (value == null) return null;
  if (value.startsWith("plaintext:v1:")) return Buffer.from(value.slice("plaintext:v1:".length), "base64").toString("utf8");
  return decryptSafeStorage(unscope(value), key);
}

export function secretsPath() {
  return join(APP_SUPPORT, "sand-secrets.json");
}

export function loadCursorAuth({ accountScope = null, key = null } = {}) {
  const p = secretsPath();
  if (!existsSync(p)) return null;
  const secrets = JSON.parse(readFileSync(p, "utf8"));
  const record = secrets["cursor-accounts"] ? JSON.parse(secrets["cursor-accounts"]) : { active: null, accounts: {} };
  const scope = accountScope ?? record.active ?? null;
  const acct = scope ? record.accounts?.[scope] ?? null : null;
  const accessToken = readSecretValue(acct?.["cursor-access-token"] ?? secrets["cursor-access-token"] ?? null, key);
  if (!accessToken) return null;
  const refreshToken = readSecretValue(acct?.["cursor-refresh-token"] ?? secrets["cursor-refresh-token"] ?? null, key);
  const profileRaw = readSecretValue(acct?.["cursor-account-profile"] ?? null, key);
  let profile = {};
  try {
    profile = profileRaw ? JSON.parse(profileRaw) : {};
  } catch {
    profile = {};
  }
  const optional = (v) => {
    try {
      return readSecretValue(v, key);
    } catch {
      return null;
    }
  };
  const teamId = optional(secrets["cursor-selected-team-id"] ?? null);
  return {
    accountScope: scope,
    accounts: Object.keys(record.accounts ?? {}),
    accessToken,
    refreshToken,
    profile,
    teamId: teamId ? Number(teamId) || null : null,
    machineId: optional(secrets["cursor-machine-id"] ?? null),
  };
}

export function jwtClaims(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Cursor RPC + EnsureSandBox

let cachedAppVersion;
export function appVersion() {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  try {
    cachedAppVersion =
      execFileSync("/usr/bin/defaults", ["read", join(APP_BUNDLE, "Contents/Info"), "CFBundleShortVersionString"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    cachedAppVersion = null;
  }
  return cachedAppVersion;
}

export function cursorHeaders(accessToken, extra = {}) {
  return {
    "content-type": "application/json",
    "connect-protocol-version": "1",
    authorization: `Bearer ${accessToken}`,
    "x-cursor-client-type": "sand",
    "x-cursor-client-version": process.env.GROKBOT_CLIENT_VERSION || appVersion() || "0.47.0",
    "x-sand-box-namespace": process.env.SAND_BOX_NAMESPACE || "prod",
    ...extra,
  };
}

export async function ensureSandBox(auth, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${CURSOR_API}/aiserver.v1.GrokBotService/EnsureSandBox`, {
    method: "POST",
    headers: cursorHeaders(auth.accessToken),
    body: "{}",
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new SessionError("ENSURE_SANDBOX_FAILED", `EnsureSandBox ${res.status}: ${body.message ?? body.raw ?? res.statusText}`);
  }
  const baseUrl = body.gatewayUrl ?? body.gateway_url;
  const token = body.gatewayToken ?? body.gateway_token;
  if (!baseUrl || !token) {
    throw new SessionError("ENSURE_SANDBOX_EMPTY", "EnsureSandBox returned no gateway url/token.");
  }
  let headers = normalizeHeaders(body.gatewayHeaders ?? body.gateway_headers);
  const net = body.anyrunNetworkToken ?? body.anyrun_network_token ?? body.networkToken;
  if (Object.keys(headers).length === 0 && net) headers = { "x-anyrun-network-token": String(net) };
  return { source: "ensure-sandbox", accountScope: auth.accountScope, baseUrl: String(baseUrl).replace(/\/$/, ""), token: String(token), headers };
}

// Inside a Grok Bot box (the agent's own cloud computer) the host writes its gateway descriptor
// as plain JSON: {scheme, host, port, token, pid, startedAt}. No Keychain, no Mac needed.
// Computed at call time (not module load) so env overrides set after import — e.g. by tests — take effect.
export function boxGatewayCandidates(env = process.env) {
  return [
    env.SAND_DATA_ROOT ? join(env.SAND_DATA_ROOT, "gateway.json") : null,
    env.GROKBOT_BOX_GATEWAY_JSON || null,
    "/home/box/agent-data/gateway.json",
    "/home/box/sand-data/gateway.json",
    join(homedir(), "agent-data/gateway.json"),
    join(homedir(), "sand-data/gateway.json"),
  ].filter(Boolean);
}

export function boxGatewaySession(env = process.env) {
  for (const p of boxGatewayCandidates(env)) {
    if (!existsSync(p)) continue;
    let d;
    try {
      d = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (!d?.token || !d?.port) continue;
    const scheme = d.scheme || "http";
    // the host may bind 0.0.0.0; always talk to loopback
    return { source: "box", accountScope: null, baseUrl: `${scheme}://127.0.0.1:${d.port}`, token: String(d.token), headers: {}, path: p };
  }
  return null;
}

export function isInsideBox(env = process.env) {
  return boxGatewaySession(env) != null;
}

export function envGatewaySession() {
  const url = process.env.GROKBOT_GATEWAY_URL;
  const token = process.env.GROKBOT_GATEWAY_TOKEN;
  if (!url || !token) return null;
  let headers = {};
  if (process.env.GROKBOT_GATEWAY_HEADERS) headers = normalizeHeaders(JSON.parse(process.env.GROKBOT_GATEWAY_HEADERS));
  return { source: "env", accountScope: null, baseUrl: url.replace(/\/$/, ""), token, headers };
}

/** Resolve a host-gateway session: env override → app descriptor → EnsureSandBox via Cursor token. */
export async function resolveGatewaySession({ accountScope = null, prefer = "auto", fetchImpl = fetch } = {}) {
  const fromEnv = envGatewaySession();
  if (fromEnv) return fromEnv;
  const fromBox = boxGatewaySession();
  if (fromBox) return fromBox;
  if (prefer !== "ensure") {
    const desc = loadGatewayDescriptor({ accountScope });
    if (desc) {
      const fresh = desc.savedAtMs == null || Date.now() - desc.savedAtMs < DESCRIPTOR_MAX_AGE_MS;
      if (fresh || prefer === "descriptor") return desc;
    }
  }
  const auth = loadCursorAuth({ accountScope });
  if (auth?.accessToken) return ensureSandBox(auth, { fetchImpl });
  throw new SessionError(
    "NO_SESSION",
    "No Grok Bot session found. On a Mac: open Grok Bot and sign in once. Inside a box: /home/box/agent-data/gateway.json must exist. Or set GROKBOT_GATEWAY_URL + GROKBOT_GATEWAY_TOKEN.",
  );
}

export function describeSessionSources() {
  const out = { appBundle: existsSync(APP_BUNDLE), appVersion: appVersion(), descriptor: null, secrets: null, home: null };
  const dp = descriptorPath();
  if (existsSync(dp)) {
    const st = statSync(dp);
    let wrapped = null;
    try {
      wrapped = JSON.parse(readFileSync(dp, "utf8"));
    } catch {}
    out.descriptor = { path: dp, modifiedAt: st.mtime.toISOString(), version: wrapped?.version ?? null, entries: wrapped?.entries ? Object.keys(wrapped.entries).length : wrapped?.encrypted ? 1 : 0 };
  }
  const sp = secretsPath();
  if (existsSync(sp)) {
    let keys = [];
    try {
      keys = Object.keys(JSON.parse(readFileSync(sp, "utf8")));
    } catch {}
    out.secrets = { path: sp, keys };
  }
  if (existsSync(GROKBOT_HOME)) out.home = GROKBOT_HOME;
  return out;
}

// Any JSON key that *contains* one of these fragments is treated as secret (case-insensitive), so
// cursor-access-token, x-anyrun-network-token, gateway_token, refreshToken, … are all covered.
const SECRET_FRAGMENTS = "token|secret|password|credential|authorization|api[-_]?key|cookie";
const SECRET_KEY_RE = new RegExp(`"([^"]*(?:${SECRET_FRAGMENTS})[^"]*)"\\s*:\\s*"[^"]*"`, "gi");
export function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer <redacted>")
    .replace(SECRET_KEY_RE, '"$1":"<redacted>"')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt-redacted>");
}

/** Deep-copy a value with secret-looking keys replaced, for attaching server bodies to errors. */
export function redactValue(value) {
  const re = new RegExp(SECRET_FRAGMENTS, "i");
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, re.test(k) ? "<redacted>" : walk(x)]));
    if (typeof v === "string") return redact(v);
    return v;
  };
  return walk(value);
}
