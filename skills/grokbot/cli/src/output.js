// Output helpers: tables, JSON, id lists, relative times. No secrets pass through here unredacted.
import { redact } from "./session.js";

export function printJson(value, { redactSecrets = true } = {}) {
  const text = JSON.stringify(value, null, 2);
  process.stdout.write((redactSecrets ? redact(text) : text) + "\n");
}

export function table(rows, columns, { maxWidth = process.stdout.columns || 160 } = {}) {
  if (rows.length === 0) return "(none)\n";
  const cols = columns.map((c) => (typeof c === "string" ? { key: c, label: c } : c));
  const cells = rows.map((r) => cols.map((c) => fmtCell(c.get ? c.get(r) : r[c.key], c)));
  const widths = cols.map((c, i) => Math.min(c.max ?? 60, Math.max(c.label.length, ...cells.map((row) => row[i].length))));
  const line = (arr) => arr.map((v, i) => pad(v, widths[i])).join("  ").trimEnd();
  const out = [line(cols.map((c) => c.label)), line(widths.map((w) => "-".repeat(w)))];
  for (const row of cells) out.push(line(row));
  return out.map((l) => (l.length > maxWidth ? l.slice(0, maxWidth - 1) + "…" : l)).join("\n") + "\n";
}

function pad(v, w) {
  if (v.length > w) return v.slice(0, Math.max(0, w - 1)) + "…";
  return v.padEnd(w);
}

function fmtCell(v, col) {
  if (v == null) return "";
  if (col.format) return String(col.format(v));
  if (typeof v === "boolean") return v ? "yes" : "";
  if (Array.isArray(v)) return v.join(",");
  return String(v).replace(/\s+/g, " ");
}

export function relTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - Number(ms);
  const abs = Math.abs(diff);
  const units = [
    [60_000, "s", 1000],
    [3_600_000, "m", 60_000],
    [86_400_000, "h", 3_600_000],
    [7 * 86_400_000, "d", 86_400_000],
    [Infinity, "w", 7 * 86_400_000],
  ];
  for (const [limit, label, div] of units) {
    if (abs < limit) return `${Math.floor(abs / div)}${label}${diff < 0 ? " ahead" : ""}`;
  }
  return "";
}

export function shortId(id, n = 8) {
  return id ? String(id).slice(0, n) : "";
}

export function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 64;
  }
}
