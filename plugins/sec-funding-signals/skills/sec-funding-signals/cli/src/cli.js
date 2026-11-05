// Argument parsing and command dispatch. Zero dependencies.
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createHttp, VERSION, userAgent } from "./http.js";
import { AllowlistError } from "./allowlist.js";
import { cacheDirFor, defaultConfigPath, loadConfig, resolveEmail, saveConfig } from "./config.js";
import { getPreset, presetNames, PRESETS } from "./presets.js";
import { loadProfile, ProfileError, resolveKeywords, saveProfile } from "./profile.js";
import { mergeJudgments, normalizeJudgments, runSearch, showFiling } from "./commands.js";
import { emit, writeOutputs } from "./output.js";
import { fetchFiling, parseSince, searchFilings } from "./edgar.js";

export { VERSION };

/** Replaceable in tests. */
export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: () => process.cwd(),
  env: process.env,
};

class UsageError extends Error {}

const GLOBAL = { string: ["format", "out", "limit", "email", "config"], bool: ["no-cache", "help", "version"] };
export const COMMANDS = {
  setup: { string: [], bool: [], usage: "setup --email <your email>   (saves your contact email, which the SEC requires in the User-Agent, to sec-funding-signals.config.json in this folder)" },
  doctor: { string: [], bool: [], usage: "doctor" },
  presets: { string: [], bool: [], usage: "presets   (list the example keyword presets)" },
  "profile init": { string: ["preset"], bool: [], usage: "profile init --out <profile.json> [--preset physical-ai|ai-data]   (write an example profile to edit; refuses to overwrite)" },
  "profile check": { string: [], bool: [], positional: 1, usage: "profile check <profile.json>   (validate a profile and show what a run would use)" },
  search: {
    string: ["keywords", "profile", "since", "until", "states", "min-amount", "max-amount", "sample", "max-per-keyword", "out-dir", "name"],
    bool: ["include-funds", "include-unknown-amount"],
    usage: "search (--keywords <file|preset|a,b,c> | --profile <profile.json>) --since <YYYY-MM-DD|30d|12w|6m> [--until <date>] [--states CA,TX] [--min-amount N] [--max-amount N] [--include-funds] [--include-unknown-amount] [--sample N] [--out-dir <dir> [--name <prefix>]]",
  },
  show: { string: ["cik"], bool: [], positional: 1, usage: "show <accession | cik/accession | EDGAR filing URL> [--cik <cik>]" },
  annotate: { string: ["in", "judgments", "out-dir", "name"], bool: [], usage: "annotate --in <search.json> --judgments <judgments.json> [--out-dir <dir>] [--name <prefix>]   (merge fit/fit_reason/evidence; fit \"no\" leaves the Apollo CSVs)" },
};

export function helpText() {
  return `sec-funding-signals ${VERSION}: find companies that just raised money, from SEC Form D filings on EDGAR (public data)

Usage: sec-funding-signals <command> [options]

Commands:
${Object.values(COMMANDS).map((c) => "  " + c.usage).join("\n")}

Global options:
  --format json|csv   output format (default json; csv is the full table)
  --out <file>        write output to a file instead of stdout
  --limit <n>         keep only the first n rows
  --email <address>   contact email for this run only (not saved); also SEC_FUNDING_CONTACT_EMAIL
  --config <file>     config file (default ./sec-funding-signals.config.json)
  --no-cache          refetch filings instead of using the local filing cache
  --help, --version
`;
}

export function parseArgs(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { words.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) { flags[name] = a.slice(eq + 1); continue; }
      const takes = GLOBAL.string.includes(name) || Object.values(COMMANDS).some((c) => c.string.includes(name));
      if (takes) {
        if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
        flags[name] = argv[++i];
      } else flags[name] = true;
    } else words.push(a);
  }
  return { words, flags };
}

function resolve(words) {
  const two = words.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { name: two, args: words.slice(2) };
  if (COMMANDS[words[0]]) return { name: words[0], args: words.slice(1) };
  return null;
}

const posInt = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
};
const amount = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(/[$,_]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a number of dollars`);
  return n;
};
const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
const today = () => new Date(deps.now()).toISOString().slice(0, 10);

async function doctor({ email, source, http }) {
  const checks = [];
  const run = async (name, fn) => {
    const t = Date.now();
    try { checks.push({ check: name, ok: true, detail: await fn(), ms: Date.now() - t }); }
    catch (e) { checks.push({ check: name, ok: false, detail: e.message, ms: Date.now() - t }); }
  };
  await run("node", async () => { const major = Number(process.versions.node.split(".")[0]); if (major < 20) throw new Error(`Node ${process.versions.node}: need 20+`); return process.versions.node; });
  await run("user-agent", async () => {
    if (!email) throw new Error("no contact email set: run `setup --email <your email>` (the SEC requires one in the User-Agent)");
    return `"${userAgent(email)}" (from ${source})`;
  });
  if (!email) return { rows: checks };
  let first = null;
  await run("efts.sec.gov (full-text search)", async () => {
    const t = today();
    const { hits } = await searchFilings(http, { keywords: ["a"], startdt: parseSince("14d", t), enddt: t, maxPerKeyword: 1 });
    if (!hits.length) throw new Error("search returned no Form D filings for the last 14 days");
    first = hits[0];
    return `reachable (${hits.length} filing(s) returned)`;
  });
  await run("www.sec.gov (filing documents)", async () => {
    if (!first) throw new Error("skipped: search failed");
    const row = await fetchFiling(http, first);
    return `reachable (parsed ${row.accession})`;
  });
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
    for (const k of Object.keys(flags)) {
      if (!GLOBAL.string.includes(k) && !GLOBAL.bool.includes(k) && !spec.string.includes(k) && !spec.bool.includes(k)) throw new UsageError(`unknown option --${k} for "${cmd.name}". Usage: ${spec.usage}`);
    }
    if (cmd.args.length !== (spec.positional || 0)) throw new UsageError(`usage: ${spec.usage}`);
    const limit = posInt(flags.limit, "limit");
    const configPath = flags.config || defaultConfigPath(deps.cwd());

    // ----- commands that make no network request -----
    if (cmd.name === "setup") {
      if (!flags.email) throw new UsageError("setup needs --email <your email address>");
      await saveConfig(configPath, { email: flags.email });
      deps.stderr(`saved your contact email to ${configPath}\nRequests will identify as: ${userAgent(flags.email)}\n`);
      return;
    }
    if (cmd.name === "presets") {
      await emit({ rows: presetNames().map((n) => ({ preset: n, keywords: PRESETS[n].keywords })) }, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
      return;
    }
    if (cmd.name === "profile init") {
      if (!flags.out) throw new UsageError("profile init needs --out <profile.json>");
      const name = flags.preset || "physical-ai";
      const p = getPreset(name);
      if (!p) throw new UsageError(`unknown preset "${name}" (presets: ${presetNames().join(", ")})`);
      await saveProfile(flags.out, p);
      deps.stderr(`wrote example profile "${name}" to ${flags.out}: fill in offer, icp, excludes and qualify_rules\n`);
      return;
    }
    if (cmd.name === "profile check") {
      const { profile, warnings } = await loadProfile(cmd.args[0]);
      await emit({ rows: [{ ok: true, keywords: profile.keywords, states: profile.states || [], min_amount: profile.min_amount ?? null, max_amount: profile.max_amount ?? null, excludes: profile.excludes || {}, buyer_titles: profile.buyer_titles || [], warnings }] }, { format: "json", out: flags.out, stdout: deps.stdout });
      return;
    }
    if (cmd.name === "annotate") {
      if (!flags.in || !flags.judgments) throw new UsageError("annotate needs --in <search.json> and --judgments <judgments.json>");
      let result;
      try { result = JSON.parse(await readFile(flags.in, "utf8")); } catch (e) { throw new UsageError(`could not read ${flags.in}: ${e.message}`); }
      if (!result || !Array.isArray(result.rows)) throw new UsageError(`${flags.in} is not a search result (no rows)`);
      let judgments;
      try { judgments = JSON.parse(await readFile(flags.judgments, "utf8")); } catch (e) { throw new UsageError(`could not read ${flags.judgments}: ${e.message}`); }
      const merged = mergeJudgments(result.rows, normalizeJudgments(judgments));
      result.meta = { ...(result.meta || {}), fit_counts: merged.counts, left_out_of_apollo_csvs: merged.counts.no };
      const dir = flags["out-dir"] || dirname(flags.in);
      const name = flags.name || basename(flags.in).replace(/\.json$/i, "");
      const { files, counts } = await writeOutputs(dir, name, result);
      deps.stdout(JSON.stringify({ files, counts, fit_counts: merged.counts }, null, 2) + "\n");
      return;
    }

    // ----- commands that talk to EDGAR -----
    const config = await loadConfig(configPath);
    const resolved = resolveEmail({ flag: flags.email, env: deps.env, config });
    if (!resolved && cmd.name !== "doctor") throw new UsageError("no contact email set. The SEC requires one in the User-Agent: ask the user for THEIR email, then run `setup --email <it>` in their working folder.");
    const http = resolved ? createHttp({ email: resolved.email, fetchImpl: deps.fetch, sleep: deps.sleep, now: deps.now, cacheDir: cacheDirFor(configPath), noCache: !!flags["no-cache"] }) : null;

    if (cmd.name === "doctor") {
      const result = await doctor({ email: resolved && resolved.email, source: resolved && resolved.source, http });
      await emit(result, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
      if (result.rows.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }
    if (cmd.name === "show") {
      const result = await showFiling({ http, ref: cmd.args[0], cik: flags.cik });
      await emit(result, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
      return;
    }

    // search
    let profile = null;
    if (flags.profile) {
      const loaded = await loadProfile(flags.profile);
      profile = loaded.profile;
      for (const w of loaded.warnings) deps.stderr(`profile warning: ${w}\n`);
    }
    let keywords;
    try { keywords = flags.keywords ? await resolveKeywords(flags.keywords, { presets: PRESETS }) : profile ? profile.keywords : null; }
    catch (e) { throw new UsageError(e.message); }
    if (!keywords) throw new UsageError("search needs --keywords <file|preset|a,b,c> or --profile <profile.json>");
    if (!flags.since) throw new UsageError("search needs --since <YYYY-MM-DD|30d|12w|6m>");
    const states = flags.states ? list(flags.states) : (profile && profile.states) || [];
    if (states.some((s) => !/^[A-Za-z]{2}$/.test(s))) throw new UsageError("--states takes two-letter codes, e.g. CA,TX");
    let n = 0;
    const result = await runSearch({
      http, today: today(), keywords, since: flags.since, until: flags.until, states,
      minAmount: flags["min-amount"] !== undefined ? amount(flags["min-amount"], "min-amount") : profile && profile.min_amount,
      maxAmount: flags["max-amount"] !== undefined ? amount(flags["max-amount"], "max-amount") : profile && profile.max_amount,
      includeFunds: !!flags["include-funds"], includeUnknownAmount: !!flags["include-unknown-amount"],
      excludes: (profile && profile.excludes) || {}, sample: posInt(flags.sample, "sample"), maxPerKeyword: posInt(flags["max-per-keyword"], "max-per-keyword") || 500,
      onProgress: (m) => { if (++n % 10 === 1) deps.stderr(m + "\n"); },
    });
    if (limit) result.rows = result.rows.slice(0, limit);
    if (profile) result.meta.profile = { name: profile.name || null, offer: profile.offer || "", buyer_titles: profile.buyer_titles || [] };

    if (flags["out-dir"]) {
      const name = flags.name || `sec-funding-${today()}`;
      const { files, counts } = await writeOutputs(flags["out-dir"], name, result);
      deps.stdout(JSON.stringify({ files, counts, meta: result.meta }, null, 2) + "\n");
    } else {
      const note = await emit(result, { format: flags.format || "json", out: flags.out, stdout: deps.stdout });
      if (note) deps.stderr(note + "\n");
    }
    if (!result.meta.complete) {
      deps.stderr(`sec-funding-signals: ${result.meta.fetch_errors.length} filing(s) could not be fetched; results are PARTIAL (see meta.fetch_errors). Run again.\n`);
      process.exitCode = 3;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ProfileError) { deps.stderr(`sec-funding-signals: ${e.message}\n`); process.exitCode = 2; }
    else if (e instanceof AllowlistError) { deps.stderr(`sec-funding-signals: refused: ${e.message}\n`); process.exitCode = 2; }
    else { deps.stderr(`sec-funding-signals: ${e.message}\n`); process.exitCode = 1; }
  }
}

if (typeof process !== "undefined" && process.stdout && process.stdout.on) process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e; process.exit(0); });
