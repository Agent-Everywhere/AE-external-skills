// Argument parsing and command dispatch. Zero dependencies.
import { createHttp, VERSION, defaultCacheDir } from "./http.js";
import { createJsonApi, buildUrl } from "./jsonapi.js";
import { createPortal, PAGE_URL, parseTendersPage } from "./proportal.js";
import { createCommands } from "./commands.js";
import { emit } from "./output.js";
import { AllowlistError } from "./allowlist.js";
import { runWatch, WatchConfigError } from "./watch.js";
import { EXAMPLE_CONFIG } from "./watch-example.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export { VERSION };

/** Replaceable in tests. */
export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cacheDir: undefined,
  env: process.env,
  readStdin: async () => { let d = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) d += c; return d; },
};

class UsageError extends Error {}

const GLOBAL = { string: ["format", "out", "limit"], bool: ["no-cache", "full", "help", "version"] };
export const COMMANDS = {
  "contracts search": { string: ["q", "field", "expiring-within"], bool: [], usage: "contracts search --q <text> [--field description|keywords|title|number|brand] [--expiring-within <months>]" },
  "contracts vendor": { string: [], bool: [], positional: 1, usage: "contracts vendor <name>" },
  "solicitations list": { string: ["status"], bool: ["open"], usage: "solicitations list [--open] [--status Open|Pending|Awarded]" },
  "bids list": { string: ["status", "q"], bool: [], usage: "bids list [--status open|planned|closed|awarded|archived|all] [--q <keywords>]" },
  "bids detail": { string: [], bool: [], positional: 1, usage: "bids detail <tenderId|rfp-number>" },
  awards: { string: ["year", "rfp"], bool: [], usage: "awards --year YYYY [--rfp <number>]" },
  "docs download": { string: [], bool: ["password-stdin"], positional: 1, usage: "docs download <tenderId|rfp-number> --out <dir>   (needs SOURCEWELL_USER + SOURCEWELL_PASSWORD or --password-stdin)" },
  rebid: { string: [], bool: [], positional: 1, usage: "rebid <rfp-or-contract-number>" },
  "agencies list": { string: ["state", "type"], bool: [], usage: "agencies list [--state XX] [--type <text>]" },
  "categories list": { string: [], bool: [], usage: "categories list" },
  "states list": { string: [], bool: [], usage: "states list" },
  "watch run": { string: ["config", "state-dir"], bool: ["cache"], usage: "watch run --config <watch.json> --state-dir <dir> [--format md|json] [--out <file>] [--cache]   (daily alerts: diff against the last snapshot; bypasses the local cache unless --cache)" },
  "watch init": { string: [], bool: [], usage: "watch init --out <watch.json>   (write the example watch config to edit)" },
  doctor: { string: [], bool: [], usage: "doctor" },
};

export function helpText() {
  return `sourcewell ${VERSION}: read-only research of Sourcewell's public cooperative-purchasing data (unofficial)

Usage: sourcewell <command> [options]

Commands:
${Object.values(COMMANDS).map((c) => "  " + c.usage).join("\n")}

Global options:
  --format json|csv   output format (default json; watch run: md|json, default md)
  --out <file>        write output to a file instead of stdout
  --limit <n>         stop after n rows
  --full              include long text fields (contracts: products_services; bids: description)
  --no-cache          skip the 24h local cache (~/.cache/sourcewell)
  --help, --version
`;
}

export function parseArgs(argv) {
  const words = [];
  const flags = {};
  let i = 0;
  const rest = [];
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      flags[name] = eq > 0 ? a.slice(eq + 1) : null; // null = look at next token if option takes a value
      if (eq < 0) {
        const takes = GLOBAL.string.includes(name) || Object.values(COMMANDS).some((c) => c.string.includes(name));
        if (takes) {
          if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
          flags[name] = argv[++i];
        } else flags[name] = true;
      }
    } else words.push(a);
  }
  words.push(...rest);
  return { words, flags };
}

function resolve(words) {
  const two = words.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { name: two, args: words.slice(2) };
  if (COMMANDS[words[0]]) return { name: words[0], args: words.slice(1) };
  return null;
}

const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
};

async function doctor(http) {
  const checks = [];
  const run = async (name, fn) => {
    const t = Date.now();
    try { const detail = await fn(); checks.push({ check: name, ok: true, detail, ms: Date.now() - t }); }
    catch (e) { checks.push({ check: name, ok: false, detail: e.message, ms: Date.now() - t }); }
  };
  await run("node", async () => { const major = Number(process.versions.node.split(".")[0]); if (major < 20) throw new Error(`Node ${process.versions.node}: need 20+`); return process.versions.node; });
  await run("jsonapi", async () => {
    const doc = await http.getJson(buildUrl({ resource: "taxonomy_term/states", limit: 1 }));
    if (!doc.data || !doc.data.length) throw new Error("no rows returned");
    return "public API reachable";
  });
  await run("bid portal", async () => {
    const res = await http.request(PAGE_URL, { method: "GET", headers: { accept: "text/html" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    parseTendersPage(await res.text());
    return "bid list reachable";
  });
  await run("cache dir", async () => http.cacheDir);
  return { rows: checks };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { words, flags } = parseArgs(argv);
    if (flags.version) { deps.stdout(VERSION + "\n"); return; }
    if (flags.help || !words.length || words[0] === "help") { deps.stdout(helpText()); return; }
    const cmd = resolve(words);
    if (!cmd) throw new UsageError(`unknown command: ${words.join(" ")}\n\n${helpText()}`);
    const spec = COMMANDS[cmd.name];
    for (const k of ["user", "username", "password", "pass"]) {
      if (k in flags) throw new UsageError(`--${k} is not accepted: credentials are never passed on the command line. Set SOURCEWELL_USER and SOURCEWELL_PASSWORD (or use --password-stdin).`);
    }
    for (const k of Object.keys(flags)) {
      if (!GLOBAL.string.includes(k) && !GLOBAL.bool.includes(k) && !spec.string.includes(k) && !spec.bool.includes(k)) throw new UsageError(`unknown option --${k} for "${cmd.name}". Usage: ${spec.usage}`);
    }
    const positional = spec.positional || 0;
    if (cmd.args.length !== positional) throw new UsageError(`usage: ${spec.usage}`);

    const http = createHttp({ fetchImpl: deps.fetch, sleep: deps.sleep, now: deps.now, cacheDir: deps.cacheDir || defaultCacheDir(), noCache: !!flags["no-cache"] || (cmd.name === "watch run" && !flags.cache) });
    const api = createJsonApi(http);
    const portal = createPortal(http);
    const today = () => new Date(deps.now()).toISOString().slice(0, 10);
    const c = createCommands({ api, portal, today });
    const limit = num(flags.limit, "limit");
    const full = !!flags.full;

    if (cmd.name === "watch init") {
      const text = JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n";
      if (!flags.out) { deps.stdout(text); return; }
      if (existsSync(flags.out)) throw new UsageError(`${flags.out} already exists: not overwriting your config (pick another --out or delete it)`);
      await writeFile(flags.out, text);
      deps.stderr(`wrote example watch config to ${flags.out}: edit the keyword lists, then run: watch run --config ${flags.out} --state-dir <dir>\n`);
      return;
    }
    if (cmd.name === "watch run") {
      const format = flags.format || "md";
      if (format !== "md" && format !== "json") throw new UsageError("watch run --format must be md or json");
      let out;
      // Deliver (write and verify --out, then print) before runWatch records the snapshot: if delivery fails nothing is committed.
      const deliver = async (text) => {
        if (flags.out) {
          await writeFile(flags.out, text);
          if ((await readFile(flags.out, "utf8")) !== text) throw new Error(`could not verify the digest written to ${flags.out}`);
          deps.stderr(`wrote digest to ${flags.out}\n`);
        }
        deps.stdout(text);
      };
      try { out = await runWatch({ commands: c, today, configPath: flags.config, stateDir: flags["state-dir"], format, deliver }); }
      catch (e) { if (e instanceof WatchConfigError) throw new UsageError(e.message); throw e; }
      return;
    }

    let result;
    switch (cmd.name) {
      case "contracts search": result = await c.contractsSearch({ q: flags.q, field: flags.field, expiringWithin: flags["expiring-within"], limit, full }); break;
      case "contracts vendor": result = await c.contractsVendor({ name: cmd.args[0], limit, full }); break;
      case "solicitations list": result = await c.solicitationsList({ open: !!flags.open, status: flags.status, limit }); break;
      case "bids list": result = await c.bidsList({ status: flags.status, q: flags.q, full }); if (limit) result.rows = result.rows.slice(0, limit); break;
      case "bids detail": result = await c.bidsDetail({ ref: cmd.args[0] }); break;
      case "awards": result = await c.awardsList({ year: flags.year, rfp: flags.rfp }); if (limit) result.rows = result.rows.slice(0, limit); break;
      case "docs download": {
        // credentials: environment (or password on stdin) only; never a flag, never printed, never cached
        const username = deps.env.SOURCEWELL_USER;
        const password = flags["password-stdin"] ? (await deps.readStdin()).replace(/\r?\n$/, "") : deps.env.SOURCEWELL_PASSWORD;
        if (!username || !password) throw new UsageError("docs download needs your own portal login: set SOURCEWELL_USER and SOURCEWELL_PASSWORD (or pipe the password with --password-stdin)");
        result = await c.docsDownload({ ref: cmd.args[0], outDir: flags.out, username, password });
        flags.out = undefined;
        break;
      }
      case "rebid": result = await c.rebid({ ref: cmd.args[0], limit }); break;
      case "agencies list": result = await c.agenciesList({ state: flags.state, type: flags.type, limit }); break;
      case "categories list": result = await c.termsList("taxonomy_term/category", { limit }); break;
      case "states list": result = await c.termsList("taxonomy_term/states", { limit }); break;
      case "doctor": result = await doctor(http); break;
    }
    const note = await emit(result, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
    if (note) deps.stderr(note + "\n");
    if (result.meta && result.meta.note && !flags.out && (flags.format || "json") === "csv") deps.stderr(`${result.meta.title}: ${result.meta.note}\n`);
    if (cmd.name === "doctor" && result.rows.some((r) => !r.ok)) process.exitCode = 1;
  } catch (e) {
    if (e instanceof UsageError) { deps.stderr(`sourcewell: ${e.message}\n`); process.exitCode = 2; }
    else if (e instanceof AllowlistError) { deps.stderr(`sourcewell: refused: ${e.message}\n`); process.exitCode = 2; }
    else { deps.stderr(`sourcewell: ${e.message}\n`); process.exitCode = 1; }
  }
}

if (typeof process !== "undefined" && process.stdout && process.stdout.on) process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e; process.exit(0); });
