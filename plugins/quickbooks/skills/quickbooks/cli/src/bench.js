// `qbo bench`: time each read command N cold (tab reset to about:blank first, so the app reloads) and
// N warm (app already loaded) runs. Reports median and p95 in ms.
import { stats } from "./output.js";

export function benchCommands() {
  return [
    ["status", (q) => q.ensureReady()],
    ["company", (q) => q.company()],
    ["count customers", (q) => q.count("customers")],
    ...["customers", "vendors", "items", "accounts", "invoices", "estimates", "bills", "expenses", "payments", "sales-receipts"]
      .map((e) => [`list ${e}`, (q) => q.list(e, { limit: 100 })]),
    ["get accounts 1", (q) => q.query("select * from Account maxresults 1").then((r) => q.get("accounts", r.Account[0].Id))],
    ["query", (q) => q.query("select Id, Name from Account maxresults 5")],
    ["search", (q) => q.search("Cash")],
    ...["pandl", "balance-sheet", "cash-flow", "trial-balance", "general-ledger", "ar-aging", "ap-aging", "account-list"]
      .map((r) => [`report ${r}`, (q) => q.report(r)]),
    ["ui customers (DOM fallback)", (q) => q.ui("customers")],
    ["ui accounts (DOM fallback)", (q) => q.ui("accounts")],
  ];
}

/** `only` is a comma-separated list of substrings. A failed reset/reload counts as an error for that run
 *  instead of aborting the bench; if the browser connection itself closes, stop and return what was measured
 *  (results.aborted = reason). onRow(row, results) fires after each command so callers can save progress. */
export async function runBench(qbo, page, { runs = 5, only, log = () => {}, onRow = () => {} } = {}) {
  const filters = only ? String(only).split(",").map((x) => x.trim()).filter(Boolean) : [];
  const cmds = benchCommands().filter(([n]) => !filters.length || filters.some((f) => n.includes(f)));
  const results = [];
  const closed = (e) => /CDP connection closed|WebSocket is not open/i.test(String(e && e.message));
  const step = async (errors, fn) => {
    try { await fn(); return true; }
    catch (e) { errors.push(String(e.message).slice(0, 120)); if (closed(e)) throw e; return false; }
  };
  for (const [name, fn] of cmds) {
    const cold = [], warm = [], errors = [];
    try {
      for (let i = 0; i < runs; i++) {
        if (!(await step(errors, () => page.goto("about:blank")))) continue;
        const t = performance.now();
        if (await step(errors, () => fn(qbo))) cold.push(Math.round(performance.now() - t));
      }
      if (await step(errors, () => qbo.ensureReady())) {
        for (let i = 0; i < runs; i++) {
          const t = performance.now();
          if (await step(errors, () => fn(qbo))) warm.push(Math.round(performance.now() - t));
        }
      }
    } catch (e) {
      results.aborted = `browser connection closed during "${name}"`;
    }
    const row = { command: name, cold: stats(cold), warm: stats(warm), errors: errors.length, firstError: errors[0] || null };
    log(`${name}: cold median ${row.cold.median} ms p95 ${row.cold.p95} | warm median ${row.warm.median} ms p95 ${row.warm.p95}${errors.length ? " | errors " + errors.length + " (" + row.firstError + ")" : ""}`);
    results.push(row);
    onRow(row, results);
    if (results.aborted) { log(`bench stopped: ${results.aborted}`); break; }
  }
  return results;
}

export function benchMarkdown(results) {
  const lines = ["| Command | Cold median (ms) | Cold p95 (ms) | Warm median (ms) | Warm p95 (ms) | Errors |", "|---|---:|---:|---:|---:|---:|"];
  for (const r of results) lines.push(`| ${r.command} | ${r.cold.median ?? "-"} | ${r.cold.p95 ?? "-"} | ${r.warm.median ?? "-"} | ${r.warm.p95 ?? "-"} | ${r.errors} |`);
  return lines.join("\n");
}
