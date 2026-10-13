// Offline readers for the desktop app's client-side caches. These are mirrors the app writes for itself;
// they lag the live host and must never be treated as authoritative for writes.
//
//   ~/Library/Application Support/Grok Bot/sand-client-persistence/<base32(key)>.blob
//     key = sand.client.slice.account.<accountId>.<slice>   (e.g. roster.last-roster, sidebar.last-sections,
//           transcript.replicas.<agentId>) or sand.client.slice.<slice> for account-independent slices.
//     value = JSON { schemaVersion, value }
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_SUPPORT, GROKBOT_HOME } from "./session.js";

export const PERSISTENCE_DIR = join(APP_SUPPORT, "sand-client-persistence");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function b32decode(s) {
  const clean = s.toLowerCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`bad base32 char ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out).toString("utf8");
}

export function b32encode(str) {
  const buf = Buffer.from(str, "utf8");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function listSlices() {
  if (!existsSync(PERSISTENCE_DIR)) return [];
  return readdirSync(PERSISTENCE_DIR)
    .filter((f) => f.endsWith(".blob"))
    .map((f) => {
      let key = null;
      try {
        key = b32decode(f.slice(0, -5));
      } catch {}
      const st = statSync(join(PERSISTENCE_DIR, f));
      return { file: f, key, size: st.size, modifiedAt: st.mtime.toISOString() };
    })
    .filter((s) => s.key)
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function parseSliceKey(key) {
  const m = key.match(/^sand\.client\.slice\.(?:account\.([^.]+)\.)?(.+)$/);
  if (!m) return null;
  return { accountId: m[1] ? decodeURIComponent(m[1]) : null, slice: m[2] };
}

export function readSlice(key) {
  const p = join(PERSISTENCE_DIR, b32encode(key) + ".blob");
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  return parsed?.value ?? parsed;
}

export function accountIds() {
  const ids = new Set();
  for (const s of listSlices()) {
    const k = parseSliceKey(s.key);
    if (k?.accountId) ids.add(k.accountId);
  }
  return [...ids];
}

function accountKey(slice, accountId) {
  const id = accountId ?? accountIds()[0];
  if (!id) return null;
  return `sand.client.slice.account.${encodeURIComponent(id).replace(/%7C/gi, "%7C")}.${slice}`;
}

export function cachedRoster(accountId) {
  const key = accountKey("roster.last-roster", accountId);
  const v = key ? readSlice(key) : null;
  return v?.rows ?? [];
}

export function cachedSections(accountId) {
  const key = accountKey("sidebar.last-sections", accountId);
  const v = key ? readSlice(key) : null;
  return v?.sections ?? [];
}

export function cachedTranscriptAgentIds(accountId) {
  const id = accountId ?? accountIds()[0];
  return listSlices()
    .map((s) => parseSliceKey(s.key))
    .filter((k) => k && k.accountId === id && k.slice.startsWith("transcript.replicas."))
    .map((k) => k.slice.slice("transcript.replicas.".length));
}

export function cachedTranscript(agentId, accountId) {
  const key = accountKey(`transcript.replicas.${agentId}`, accountId);
  return key ? readSlice(key) : null;
}

export function transcriptText(replica) {
  // Best-effort flatten of a transcript replica into [{seq, role, text}]
  const entries = replica?.entries ?? replica?.rows ?? replica?.items ?? (Array.isArray(replica) ? replica : []);
  const out = [];
  for (const e of entries) {
    const text = extractText(e);
    if (text) out.push({ id: e.id ?? e.entryId ?? null, seq: e.seq ?? null, kind: e.kind ?? e.type ?? null, role: e.role ?? e.author ?? e.authorKind ?? null, at: e.createdAt ?? e.at ?? e.timestamp ?? null, text });
  }
  return out;
}

function extractText(e) {
  if (!e || typeof e !== "object") return "";
  if (typeof e.text === "string") return e.text;
  if (typeof e.markdown === "string") return e.markdown;
  if (typeof e.content === "string") return e.content;
  if (Array.isArray(e.content)) return e.content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join(" ");
  if (e.message) return extractText(e.message);
  if (e.payload) return extractText(e.payload);
  return "";
}

export function daemonLogPath() {
  return join(GROKBOT_HOME, "local-exec-daemon.log");
}

export function desktopStatus() {
  const p = join(APP_SUPPORT, "desktop-status.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
