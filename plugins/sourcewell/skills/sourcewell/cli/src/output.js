// JSON or CSV output, to stdout or a file.
import { writeFile } from "node:fs/promises";

const cell = (v) => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(q).join(",")];
  for (const r of rows) lines.push(cols.map((c) => q(cell(r[c]))).join(","));
  return lines.join("\n") + "\n";
}

export function render(result, format = "json") {
  if (format === "csv") return toCsv(result.rows);
  if (format !== "json") throw new Error(`unknown --format ${JSON.stringify(format)}; use json or csv`);
  const body = { count: result.rows.length, ...(result.meta ? { meta: result.meta } : {}), rows: result.rows };
  return JSON.stringify(body, null, 2) + "\n";
}

/** Write to --out (returns a short note for stderr) or to stdout. */
export async function emit(result, { format = "json", out, stdout }) {
  const text = render(result, format);
  if (out) { await writeFile(out, text); return `wrote ${result.rows.length} rows to ${out}`; }
  stdout(text);
  return null;
}
