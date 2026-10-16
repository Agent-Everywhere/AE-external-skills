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

export async function runBench(qbo, page, { runs = 5, only, log = () => {} } = {}) {
  const cmds = benchCommands().filter(([n]) => !only || n.includes(only));
  const results = [];
  for (const [name, fn] of cmds) {
    const cold = [], warm = [], errors = [];
    for (let i = 0; i < runs; i++) {
      await page.goto("about:blank");
      const t = performance.now();
      try { await fn(qbo); cold.push(Math.round(performance.now() - t)); } catch (e) { errors.push(String(e.message).slice(0, 120)); }
    }
    await qbo.ensureReady();
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      try { await fn(qbo); warm.push(Math.round(performance.now() - t)); } catch (e) { errors.push(String(e.message).slice(0, 120)); }
    }
    const row = { command: name, cold: stats(cold), warm: stats(warm), errors: errors.length, firstError: errors[0] || null };
    log(`${name}: cold median ${row.cold.median} ms p95 ${row.cold.p95} | warm median ${row.warm.median} ms p95 ${row.warm.p95}${errors.length ? " | errors " + errors.length : ""}`);
    results.push(row);
  }
  return results;
}

export function benchMarkdown(results) {
  const lines = ["| Command | Cold median (ms) | Cold p95 (ms) | Warm median (ms) | Warm p95 (ms) | Errors |", "|---|---:|---:|---:|---:|---:|"];
  for (const r of results) lines.push(`| ${r.command} | ${r.cold.median ?? "-"} | ${r.cold.p95 ?? "-"} | ${r.warm.median ?? "-"} | ${r.warm.p95 ?? "-"} | ${r.errors} |`);
  return lines.join("\n");
}
