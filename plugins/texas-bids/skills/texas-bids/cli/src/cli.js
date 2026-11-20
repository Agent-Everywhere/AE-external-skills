// texas-bids: read-only check of the Texas ESBD bid board.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EsbdError, STATUS_NAMES, SERVICE_URL, search, splitList, parseListResponse } from "./esbd.js";
import { createHttp, HttpError, VERSION } from "./http.js";
import { renderSearch, renderWatch } from "./output.js";
import { ENV_VAR, TeamsError, buildPayloads, postToTeams, selectForTeams } from "./teams.js";
import { StateError, diff, ensureWritable, loadState, saveState } from "./watch.js";

const HELP = `texas-bids ${VERSION}: check the Texas state bid board (ESBD) for open solicitations. Read-only.

Usage:
  texas-bids search  --keywords "fuel,generator" [--status open] [--since YYYY-MM-DD] [--limit N] [--json]
  texas-bids watch   --keywords "fuel,generator" [--state FILE] [--json] [--teams-webhook URL] [--always]
  texas-bids notify-teams --keywords "..." --webhook URL [--state FILE] [--always] [--dry-run]
  texas-bids notify-teams --webhook URL --test
  texas-bids doctor

Options:
  --keywords LIST       comma-separated; a solicitation matches if it matches ANY keyword (case-insensitive)
  --status NAME         search only: ${STATUS_NAMES.join(" | ")} | all   (default open)
  --since YYYY-MM-DD    only solicitations posted on or after this date
  --limit N             search only: show at most N rows (default 50; 0 = all)
  --exclude LIST        drop solicitations whose title contains any of these words
  --agency LIST         keep only agencies whose name or number contains any of these
  --exclude-agency LIST drop agencies whose name or number contains any of these
  --state FILE          watch: where seen solicitations are remembered (default ~/.texas-bids/state.json)
  --teams-webhook URL   watch: also post new bids to a Microsoft Teams webhook
  --webhook URL         notify-teams: the Teams webhook URL
                        Prefer the environment variable ${ENV_VAR}: a flag value shows up in shell history and process lists.
  --always              post to Teams even when there is nothing new
  --dry-run             watch/notify-teams: print the Teams message, post nothing, save no state
  --json                machine-readable output
`;

const VALUE_FLAGS = new Set(["keywords", "status", "since", "limit", "exclude", "agency", "exclude-agency", "state", "teams-webhook", "webhook"]);
const BOOL_FLAGS = new Set(["json", "always", "dry-run", "test", "help", "version"]);

export class UsageError extends Error {}

/** A token from the command line, safe to show in an error: anything that looks like a URL or a secret is hidden. */
export function safe(v) {
  const t = String(v);
  return /[a-z][a-z0-9+.-]*:|\/\/|[?=&@%]/i.test(t) || t.length > 30 ? "[hidden]" : t;
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { flags.help = true; continue; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOL_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option --${safe(name)} (see --help)`);
    let v = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (v === undefined || (eq === -1 && v.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
    flags[name] = v;
  }
  return { flags, positional };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function needKeywords(flags) {
  const keywords = splitList(flags.keywords);
  if (!keywords.length) throw new UsageError('--keywords is required, for example --keywords "janitorial,HVAC,fuel"');
  return keywords;
}

function validateSince(since) {
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new UsageError("--since must look like YYYY-MM-DD");
}

function filters(flags) {
  return { exclude: splitList(flags.exclude), agencies: splitList(flags.agency), excludeAgencies: splitList(flags["exclude-agency"]) };
}

export async function main(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  const env = io.env || process.env;
  const now = io.now || (() => Date.now());
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const http = io.http || createHttp({ fetchImpl: io.fetchImpl, sleep: io.sleep, now, ...(io.minIntervalMs !== undefined ? { minIntervalMs: io.minIntervalMs } : {}), ...(io.backoffMs !== undefined ? { backoffMs: io.backoffMs } : {}) });
  try {
    const { flags, positional } = parseArgs(argv);
    if (flags.version) { stdout(VERSION + "\n"); return 0; }
    const cmd = positional[0];
    if (flags.help || !cmd || cmd === "help") { stdout(HELP); return cmd || flags.help ? 0 : 2; }
    if (positional.length > 1) throw new UsageError("unexpected extra argument (a value without its --option, or keywords that need quotes); see --help");

    if (cmd === "doctor") {
      const r = parseListResponse(await http.postJson(SERVICE_URL, { keyword: "", status: "1", page: 1 }));
      stdout(`ok: the Texas bid board answered; ${r.total} open solicitations in total (node ${process.versions.node}).\n`);
      return 0;
    }

    if (cmd === "search") {
      const keywords = needKeywords(flags);
      validateSince(flags.since);
      const status = flags.status || "open";
      if (status !== "all" && !STATUS_NAMES.includes(status)) throw new UsageError(`--status must be one of ${STATUS_NAMES.join(", ")}, all`);
      const limit = flags.limit === undefined ? 50 : Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 0) throw new UsageError("--limit must be a whole number (0 = no limit)");
      const result = await search({ http, keywords, status, since: flags.since, limit: limit || undefined, ...filters(flags) });
      if (flags.json) stdout(JSON.stringify({ count: result.rows.length, total: result.total, status, keywords, warnings: result.meta.warnings, rows: result.rows }, null, 2) + "\n");
      else stdout(renderSearch(result, { status }));
      return 0;
    }

    if (cmd === "watch" || cmd === "notify-teams") {
      const isNotify = cmd === "notify-teams";
      const webhook = (isNotify ? flags.webhook || flags["teams-webhook"] : flags["teams-webhook"] || flags.webhook) || env[ENV_VAR] || "";
      if (isNotify && !webhook) throw new UsageError(`notify-teams needs a Teams webhook URL: pass --webhook URL or set ${ENV_VAR}`);
      if (flags.status !== undefined && flags.status !== "open") throw new UsageError("watch only follows open solicitations; --status is not used");
      if (flags.limit !== undefined) throw new UsageError("--limit is not used by watch (it must see every solicitation to know which are new)");

      if (isNotify && flags.test) {
        const payload = { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", wrap: true, text: "Texas bids: test message. If you can read this, the daily bid alert can post here." }] } }] };
        if (flags["dry-run"]) { stdout(JSON.stringify(payload, null, 2) + "\n"); return 0; }
        await postToTeams({ url: webhook, payload, fetchImpl: io.teamsFetchImpl || io.fetchImpl });
        stdout("Teams accepted the test message.\n");
        return 0;
      }

      const keywords = needKeywords(flags);
      validateSince(flags.since);
      const statePath = resolve(flags.state || join(homedir(), ".texas-bids", "state.json"));
      const dry = !!flags["dry-run"];
      const prev = await loadState(statePath);
      if (!dry) await ensureWritable(statePath); // before anything is posted
      const result = await search({ http, keywords, status: "open", since: flags.since, ...filters(flags) });
      const warnings = result.meta.warnings;
      const today = isoDay(now());
      const first = diff({ prev, rows: result.rows, today });
      const { baseline, fresh } = first;

      const wantPost = !!webhook && (fresh.length > 0 || !!flags.always);
      // With Teams, only the bids actually listed in a card are marked as seen; the rest are reported again next run.
      const sel = wantPost ? selectForTeams(fresh, today) : { listed: fresh, unlisted: [] };
      const payloads = wantPost ? buildPayloads({ rows: sel.listed, unlisted: sel.unlisted.length, baseline, keywords }) : [];
      const { state } = diff({ prev, rows: result.rows, today, mark: sel.listed });

      if (dry) {
        if (payloads.length) stdout(JSON.stringify(payloads, null, 2) + "\n");
        else stdout("dry run: nothing would be posted to Teams.\n");
        for (const m of warnings) stdout(m + "\n");
        stdout(`dry run: ${fresh.length} new${baseline ? " (first check)" : ""}${payloads.length ? `, ${payloads.length} Teams card${payloads.length === 1 ? "" : "s"}` : ""}; nothing posted, no state saved.\n`);
        return 0;
      }

      let teams = "";
      let teamsError = null;
      if (wantPost) {
        let sent = 0;
        try {
          for (const pl of payloads) {
            if (sent) await sleep(1000);
            await postToTeams({ url: webhook, payload: pl, fetchImpl: io.teamsFetchImpl || io.fetchImpl });
            sent++;
          }
          teams = `posted ${sel.listed.length} bid${sel.listed.length === 1 ? "" : "s"} in ${payloads.length} message${payloads.length === 1 ? "" : "s"}${sel.unlisted.length ? `, plus a note that ${sel.unlisted.length} more were not listed` : ""}.`;
        } catch (e) { teamsError = e; teams = `FAILED after ${sent} of ${payloads.length} message${payloads.length === 1 ? "" : "s"} (see error)`; }
      } else if (webhook) teams = "nothing new, nothing posted.";
      const base = { baseline, fresh, totalMatching: result.total, statePath, teams, warnings, deferred: sel.unlisted.length };

      if (teamsError) {
        // Nothing is recorded: the same bids are reported again on the next run (cards already delivered may repeat).
        if (flags.json) stdout(JSON.stringify({ baseline, new_count: fresh.length, total_matching: result.total, new: fresh, warnings, teams: "failed", state_saved: false }, null, 2) + "\n");
        else stdout(renderWatch({ ...base, stateSaved: false }));
        throw teamsError;
      }
      await saveState(statePath, state);
      if (flags.json) stdout(JSON.stringify({ baseline, new_count: fresh.length, total_matching: result.total, new: fresh, warnings, ...(webhook ? { teams: wantPost ? "posted" : "skipped", teams_not_listed: sel.unlisted.length } : {}), state: statePath }, null, 2) + "\n");
      else stdout(renderWatch(base));
      return 0;
    }

    throw new UsageError(`unknown command ${safe(cmd)} (see --help)`);
  } catch (e) {
    if (e instanceof UsageError) { stderr(`texas-bids: ${e.message}\n`); return 2; }
    if (e instanceof EsbdError || e instanceof HttpError || e instanceof StateError || e instanceof TeamsError) { stderr(`texas-bids: ${e.message}\n`); return 1; }
    stderr(`texas-bids: unexpected error: ${e && e.stack ? e.stack : e}\n`);
    return 1;
  }
}
