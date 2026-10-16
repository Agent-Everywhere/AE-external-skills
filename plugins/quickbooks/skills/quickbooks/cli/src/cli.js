import { Command, Option } from "commander";
import { writeFileSync } from "node:fs";
import { connect } from "./connect.js";
import { Qbo, WriteBlocked } from "./qbo.js";
import { API_REPORTS, ENTITIES } from "./entities.js";
import { BASE, FORMS, GATED, LISTS, PAGES, REPORTS, resolveOpen } from "./routes.js";
import { SNIPPETS } from "./snippets.js";
import { UsageError, printJson, redact, table } from "./output.js";
import { benchMarkdown, runBench } from "./bench.js";
import { sleep } from "./cdp.js";

export const VERSION = "0.1.0";

function root(cmd) { let c = cmd; while (c.parent) c = c.parent; return c.opts(); }
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

/** Test seam: replace how a session is opened. */
export const deps = { connect };

async function withQbo(cmd, fn) {
  const o = root(cmd);
  const session = await deps.connect({ runtime: o.runtime, cdpUrl: o.cdpUrl, base: o.base });
  try {
    const qbo = new Qbo(session.page, { log });
    if (o.realm) {
      await qbo.ensureReady();
      const c = await qbo.company();
      if (c.realm !== o.realm) throw Object.assign(new Error(`signed-in company ${c.realm} is not --realm ${o.realm}`), { exitCode: 4 });
    }
    return await fn(qbo, session);
  } finally { await session.close(); }
}

function out(cmd, value, human) {
  if (root(cmd).json) printJson(value);
  else process.stdout.write((typeof human === "function" ? human(value) : human ?? JSON.stringify(value, null, 2)) + "\n");
}

async function write(cmd, fn) {
  const yes = !!root(cmd).yes;
  try {
    const r = await fn(yes);
    out(cmd, { ok: true, applied: true, result: r }, (v) => `applied: ${JSON.stringify(summary(v.result))}`);
  } catch (e) {
    if (e instanceof WriteBlocked) {
      out(cmd, { ok: true, applied: false, dryRun: true, plan: e.plan }, (v) => `DRY RUN (nothing changed). Re-run with --yes to apply:\n${JSON.stringify(v.plan, null, 2)}`);
      return;
    }
    throw e;
  }
}

function summary(r) {
  if (!r || typeof r !== "object") return r;
  const keep = ["Id", "DisplayName", "Name", "DocNumber", "TxnDate", "TotalAmt", "Balance", "Active", "PrivateNote", "status", "deleted", "inactivated"];
  return Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k)));
}

export function buildProgram() {
  const program = new Command("qbo")
    .description("Operate QuickBooks Online through a signed-in browser (AE cloud browser or local Chrome over CDP).\nRead-only by default; writes need --yes.")
    .version(VERSION)
    .option("--json", "machine-readable JSON output")
    .option("--yes", "apply a write (without it, writes only print what they would do)")
    .addOption(new Option("--runtime <kind>", "browser runtime").choices(["cdp", "agent-browser"]))
    .option("--cdp-url <url>", "Chrome DevTools URL (default $QBO_CDP_URL or http://127.0.0.1:9222)")
    .option("--base <url>", "AE browser connector base URL for agent-browser (claim from env AB_CLAIM)")
    .option("--realm <id>", "refuse to run unless the signed-in company has this realm id");

  program.command("doctor").description("check Node, browser connection, sign-in, company and API access")
    .action(async (_o, cmd) => {
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail });
      add("node", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node);
      let session;
      try {
        session = await deps.connect({ runtime: root(cmd).runtime, cdpUrl: root(cmd).cdpUrl, base: root(cmd).base });
        add("browser", true, session.runtime);
        const qbo = new Qbo(session.page);
        try {
          const s = await qbo.ensureReady();
          add("signed_in", true, s.url);
          const t = performance.now();
          const c = await qbo.company();
          add("api", true, `${Math.round(performance.now() - t)} ms`);
          add("company", true, `${c.name} (realm ${c.realm})`);
        } catch (e) { add("signed_in", false, e.message); }
      } catch (e) { add("browser", false, redact(e.message)); }
      finally { if (session) await session.close(); }
      const ok = checks.every((c) => c.ok);
      out(cmd, { ok, checks }, () => checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(10)} ${c.detail ?? ""}`).join("\n"));
      if (!ok) process.exitCode = 1;
    });

  program.command("status").description("signed-in state of the QuickBooks tab")
    .action((_o, cmd) => withQbo(cmd, async (q) => out(cmd, await q.ensureReady(), (s) => `${s.state}  ${s.url}`)));

  program.command("company").description("company info (name, realm, plan, currency)")
    .action((_o, cmd) => withQbo(cmd, async (q) => out(cmd, await q.company(), (c) => table([c]))));

  program.command("routes").description("verified QuickBooks routes, entities and reports (offline)")
    .action((_o, cmd) => {
      const v = {
        lists: Object.fromEntries(Object.entries(LISTS).map(([k, r]) => [k, BASE + r.path])),
        reportPages: Object.fromEntries(Object.entries(REPORTS).map(([k, r]) => [k, r.path ? BASE + r.path : `search "${r.search}" -> ${r.pick}`])),
        forms: Object.fromEntries(Object.entries(FORMS).map(([k, p]) => [k, BASE + p])),
        pages: Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, BASE + p])),
        gated: GATED, entities: Object.keys(ENTITIES), apiReports: API_REPORTS,
      };
      out(cmd, v, () => Object.entries(v).map(([k, m]) => `${k}:\n` + (Array.isArray(m) ? "  " + m.join(", ") : Object.entries(m).map(([a, b]) => `  ${a.padEnd(18)} ${typeof b === "string" ? b : JSON.stringify(b)}`).join("\n"))).join("\n"));
    });

  program.command("open <name>").description("navigate the tab to a verified page (list, form, report page, or /app/... path)")
    .action((name, _o, cmd) => withQbo(cmd, async (q, s) => {
      const path = resolveOpen(name);
      if (!path) throw new UsageError(`unknown page "${name}" (see: qbo routes)`);
      await q.ensureReady();
      const t = performance.now();
      await s.page.goto(BASE + path);
      out(cmd, { url: (await s.page.url()).split("?")[0], ms: Math.round(performance.now() - t) }, (v) => `${v.url}  (${v.ms} ms)`);
    }));

  program.command("list <entity>").description(`list records: ${Object.keys(ENTITIES).join(", ")}`)
    .option("--where <sql>", "QBO query filter, e.g. \"Active = true\"")
    .option("--limit <n>", "max rows (<= 1000)", (v) => parseInt(v, 10), 100)
    .option("--offset <n>", "skip rows", (v) => parseInt(v, 10), 0)
    .option("--order <field>", "orderby, e.g. \"TxnDate DESC\"")
    .option("--full", "return full records instead of the default columns")
    .option("--via <how>", "api (default) or ui (DOM fallback for list pages)", "api")
    .action((entity, o, cmd) => withQbo(cmd, async (q) => {
      if (o.via === "ui") return out(cmd, await q.ui(entity));
      const r = await q.list(entity, { where: o.where, limit: o.limit, offset: o.offset, orderBy: o.order, all: o.full });
      out(cmd, r, (v) => `${v.entity}: ${v.count} row(s)\n` + table(v.rows));
    }));

  program.command("count <entity>").description("count records")
    .action((entity, _o, cmd) => withQbo(cmd, async (q) => out(cmd, { entity, count: await q.count(entity) }, (v) => String(v.count))));

  program.command("get <entity> <id>").description("one record in full")
    .action((entity, id, _o, cmd) => withQbo(cmd, async (q) => out(cmd, await q.get(entity, id))));

  program.command("query <sql>").description("raw read-only QBO query, e.g. \"select * from Invoice where Balance > '0'\"")
    .action((sql, _o, cmd) => withQbo(cmd, async (q) => {
      if (!/^\s*select\s/i.test(sql)) throw new UsageError("query only runs SELECT statements");
      out(cmd, await q.query(sql));
    }));

  program.command("search <text>").description("find contacts, items, accounts by name and transactions by number")
    .option("--via <how>", "api (default) or ui (the app's Advanced transactions search page)", "api")
    .action((text, o, cmd) => withQbo(cmd, async (q) => {
      if (o.via === "ui") return out(cmd, await q.uiSearch(text));
      const hits = await q.search(text);
      out(cmd, { text, hits }, (v) => table(v.hits));
    }));

  program.command("report <name>").description(`run a report: ${Object.keys(API_REPORTS).join(", ")}`)
    .option("--from <date>", "start date YYYY-MM-DD").option("--to <date>", "end date YYYY-MM-DD")
    .option("--macro <m>", "date macro, e.g. \"This Fiscal Year\", \"Last Month\"")
    .addOption(new Option("--method <m>", "accounting method").choices(["cash", "accrual"]))
    .option("--csv <file>", "also write the rows to a CSV file")
    .action((name, o, cmd) => withQbo(cmd, async (q) => {
      const r = await q.report(name, { from: o.from, to: o.to, method: o.method, macro: o.macro });
      if (o.csv) {
        const esc = (v) => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? "");
        writeFileSync(o.csv, [r.columns, ...r.rows].map((row) => row.map(esc).join(",")).join("\n") + "\n");
      }
      out(cmd, r, (v) => `${v.title} ${v.start || ""}..${v.end || ""} ${v.basis || ""}${v.noData ? "  (no data)" : ""}\n` +
        table(v.rows.map((row) => Object.fromEntries(v.columns.map((c, i) => [c || `col${i}`, row[i]]))), v.columns.map((c, i) => c || `col${i}`)));
    }));

  const create = program.command("create").description("create records (dry run unless --yes)");
  create.command("customer").requiredOption("--name <displayName>").option("--email <e>").option("--phone <p>").option("--company <c>")
    .action((o, cmd) => withQbo(cmd, (q) => write(cmd, (yes) => q.createCustomer(o, yes))));
  create.command("invoice").requiredOption("--customer <nameOrId>").requiredOption("--amount <n>").option("--item <nameOrId>")
    .option("--description <d>").option("--date <d>").option("--due <d>")
    .action((o, cmd) => withQbo(cmd, (q) => write(cmd, (yes) => q.createInvoice(o, yes))));
  create.command("expense").requiredOption("--amount <n>").option("--account <bankOrCard>", "paid from (default: first bank account)")
    .option("--category <expenseAccount>", "expense account (default: first expense account)").option("--payee <vendor>").option("--date <d>").option("--memo <m>")
    .addOption(new Option("--payment-type <t>").choices(["Cash", "Check", "CreditCard"]).default("Cash"))
    .action((o, cmd) => withQbo(cmd, (q) => write(cmd, (yes) => q.createExpense(o, yes))));

  program.command("void <entity> <id>").description("void an invoice, sales receipt or payment (dry run unless --yes)")
    .action((entity, id, _o, cmd) => withQbo(cmd, (q) => write(cmd, (yes) => q.voidTxn(entity, id, yes))));
  program.command("delete <entity> <id>").description("delete a transaction, or make a customer/vendor/item/account inactive (dry run unless --yes)")
    .action((entity, id, _o, cmd) => withQbo(cmd, (q) => write(cmd, (yes) => q.remove(entity, id, yes))));

  program.command("ui <page>").description("DOM fallback: open a verified list page and read its tables / empty state")
    .action((page, _o, cmd) => withQbo(cmd, async (q) => out(cmd, await q.ui(resolveOpen(page) && LISTS[page] ? page : (resolveOpen(page) || page)))));

  program.command("discover <paths...>").description("record the app's network calls (host, path, GraphQL operation) while visiting /app/... paths")
    .option("--wait <ms>", "settle time per page", (v) => parseInt(v, 10), 7000)
    .action((paths, o, cmd) => withQbo(cmd, async (q, s) => {
      await q.ensureReady();
      await s.page.send("Network.enable");
      const calls = []; let cur = "";
      const noise = /logging\.|rum\.|eventbus|ixp-ff|experimentassignment|variabilityengine|personalization|ivid|uxfabric|clickstream/;
      const off = s.cdp.on((m) => {
        if (m.method !== "Network.requestWillBeSent" || m.sessionId !== s.page.sessionId) return;
        const r = m.params.request;
        if (!/XHR|Fetch/.test(m.params.type || "") || noise.test(r.url)) return;
        let op = ""; try { const b = JSON.parse(r.postData || "{}"); op = b.operationName || (b.query || "").replace(/\s+/g, " ").slice(0, 60); } catch { /* not json */ }
        const u = new URL(r.url);
        calls.push({ page: cur, method: r.method, host: u.host, path: u.pathname.replace(/\/\d{6,}\//g, "/<realm>/"), op });
      });
      for (const p of paths) { cur = p; await s.page.goto(BASE + p); await sleep(o.wait); }
      off();
      out(cmd, { calls }, (v) => table(v.calls));
    }));

  program.command("emit <snippet>").description("print a page snippet as a paste-ready async IIFE for a browser JS tool (offline)")
    .option("--params <json>", "snippet params", "{}")
    .action((name, o) => {
      const src = SNIPPETS[name.endsWith(".js") ? name : name + ".js"];
      if (!src) throw new UsageError(`unknown snippet ${name}: ${Object.keys(SNIPPETS).join(", ")}`);
      JSON.parse(o.params);
      process.stdout.write(`(${src.trim().replace(/^\/\/.*\n/gm, "")})(${o.params})\n`);
    });

  program.command("bench").description("time every read command: N cold and N warm runs, median and p95")
    .option("--runs <n>", "runs per mode", (v) => parseInt(v, 10), 5)
    .option("--only <substr>", "only commands containing this text")
    .option("--md <file>", "write a Markdown table")
    .action((o, cmd) => withQbo(cmd, async (q, s) => {
      const results = await runBench(q, s.page, { runs: o.runs, only: o.only, log });
      if (o.md) writeFileSync(o.md, benchMarkdown(results) + "\n");
      out(cmd, { runs: o.runs, results }, () => benchMarkdown(results));
    }));

  return program;
}

export async function main(argv = process.argv) {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") return 0;
    if (e.code?.startsWith?.("commander.")) return (process.exitCode = 2);
    const msg = redact(e.message || String(e));
    if (process.argv.includes("--json")) printJson({ ok: false, error: msg, exitCode: e.exitCode ?? 1 });
    else process.stderr.write(`qbo: ${msg}\n`);
    process.exitCode = e.exitCode ?? 1;
  }
  return process.exitCode ?? 0;
}
