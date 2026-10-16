export class UsageError extends Error { constructor(m) { super(m); this.exitCode = 2; } }

export function printJson(v) { process.stdout.write(JSON.stringify(v, null, 2) + "\n"); }

export function table(rows, cols) {
  if (!rows.length) return "(none)";
  cols = cols || Object.keys(rows[0]);
  const s = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const w = cols.map((c) => Math.min(40, Math.max(c.length, ...rows.map((r) => s(r[c]).length))));
  const line = (vals) => vals.map((v, i) => s(v).slice(0, w[i]).padEnd(w[i])).join("  ").trimEnd();
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
}

export function stats(times) {
  const a = [...times].sort((x, y) => x - y);
  if (!a.length) return { n: 0, median: null, p95: null, min: null, max: null };
  const q = (p) => { const i = (a.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return Math.round(a[lo] + (a[hi] - a[lo]) * (i - lo)); };
  return { n: a.length, median: q(0.5), p95: q(0.95), min: a[0], max: a[a.length - 1] };
}

/** Redact anything that looks like a websocket URL, API key or long token. */
export function redact(s) {
  return String(s).replace(/wss?:\/\/\S+/g, "<cdp-url>").replace(/intuit_apikey=[^,\s]+/g, "intuit_apikey=<redacted>").replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted>");
}
