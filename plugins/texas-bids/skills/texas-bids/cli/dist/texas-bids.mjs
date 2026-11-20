#!/usr/bin/env node

// src/cli.js
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// src/esbd.js
var BASE = "https://www.txsmartbuy.gov";
var SERVICE_URL = `${BASE}/app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Service.ss`;
var PER_PAGE = 24;
var MAX_PAGES = 40;
var STATUS_CODES = { open: "1", awarded: "2", cancelled: "3", closed: "5", "no-award": "11" };
var STATUS_NAMES = Object.keys(STATUS_CODES);
var EsbdError = class extends Error {
};
var clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
function usDateToIso(s) {
  const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
function isoToUsDate(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new EsbdError(`date must look like YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  return `${m[2]}/${m[3]}/${m[1]}`;
}
function agencyLabel(name, number) {
  const n = clean(name);
  const suffix = ` - ${clean(number)}`;
  return number && n.endsWith(suffix) ? n.slice(0, -suffix.length) : n;
}
function normalizeLine(l) {
  const id = clean(l.solicitationId);
  return {
    id,
    internal_id: clean(l.internalid),
    title: clean(l.title),
    agency: agencyLabel(l.agencyName, l.agencyNumber),
    agency_number: clean(l.agencyNumber),
    status: clean(l.statusName),
    posted: usDateToIso(l.postingDate),
    due: usDateToIso(l.responseDue),
    due_time: clean(l.responseTime),
    updated: clean(l.lastModified),
    class_codes: String(l.nigpCodes ?? "").split(";").map(clean).filter(Boolean),
    attachment_url: clean(l.url),
    url: `${BASE}/esbd/${encodeURIComponent(id)}`
  };
}
function parseListResponse(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new EsbdError("unexpected reply from the Texas bid board (not an object)");
  if (json.errorCode) throw new EsbdError(`the Texas bid board refused the request: ${json.errorCode}${json.errorMessage ? ` (${json.errorMessage})` : ""}`);
  if (!Array.isArray(json.lines)) throw new EsbdError("unexpected reply from the Texas bid board (no result list): the site layout may have changed");
  const total = Number(json.totalRecordsFound);
  return {
    rows: json.lines.map(normalizeLine),
    page: Number(json.page) || 1,
    perPage: Number(json.recordsPerPage) || PER_PAGE,
    total: Number.isFinite(total) ? total : json.lines.length
  };
}
async function fetchAll({ http, keyword, status = "open", since }) {
  const code = STATUS_CODES[status];
  if (!code) throw new EsbdError(`unknown status ${JSON.stringify(status)}; use ${STATUS_NAMES.join(", ")} or all`);
  const rows = [];
  let total = 0;
  let truncated = false;
  for (let page = 1; ; page++) {
    const body = { keyword, status: code, page };
    if (since) body.startDate = isoToUsDate(since);
    const r = parseListResponse(await http.postJson(SERVICE_URL, body));
    total = r.total;
    rows.push(...r.rows);
    if (!r.rows.length || page * r.perPage >= r.total) break;
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
  }
  return { rows, total, truncated };
}
var words = (s) => String(s || "").split(",").map(clean).filter(Boolean);
var splitList = words;
var has = (text, term) => clean(text).toLowerCase().includes(term.toLowerCase());
async function search({ http, keywords, status = "open", since, limit, exclude = [], agencies = [], excludeAgencies = [] }) {
  const kws = [...new Set(keywords.map(clean).filter(Boolean))];
  if (!kws.length) throw new EsbdError('give at least one keyword, for example --keywords "janitorial,HVAC,fuel"');
  if (since) isoToUsDate(since);
  const statuses = status === "all" ? STATUS_NAMES : [status];
  const merged = /* @__PURE__ */ new Map();
  const meta = { truncated: [], per_keyword: {} };
  for (const kw of kws) {
    meta.per_keyword[kw] = 0;
    for (const st of statuses) {
      const r = await fetchAll({ http, keyword: kw, status: st, since });
      if (r.truncated) meta.truncated.push(`${kw} (${st})`);
      meta.per_keyword[kw] += r.rows.length;
      for (const row of r.rows) {
        const key = row.internal_id || row.id;
        const prev = merged.get(key);
        if (prev) {
          if (!prev.matched.includes(kw)) prev.matched.push(kw);
        } else merged.set(key, { ...row, matched: [kw] });
      }
    }
  }
  let rows = [...merged.values()];
  if (since) rows = rows.filter((r) => !r.posted || r.posted >= since);
  if (exclude.length) rows = rows.filter((r) => !exclude.some((t) => has(r.title, t)));
  if (agencies.length) rows = rows.filter((r) => agencies.some((t) => has(r.agency, t) || has(r.agency_number, t)));
  if (excludeAgencies.length) rows = rows.filter((r) => !excludeAgencies.some((t) => has(r.agency, t) || has(r.agency_number, t)));
  rows.sort((a, b) => b.posted.localeCompare(a.posted) || a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
  const total = rows.length;
  if (limit && rows.length > limit) rows = rows.slice(0, limit);
  return { rows, total, meta };
}

// src/http.js
var VERSION = "0.1.0";
var USER_AGENT = `texas-bids-cli/${VERSION} (read-only public bid board check; +https://github.com/Agent-Everywhere/AE-external-skills)`;
var HttpError = class extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
};
var realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function createHttp({
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => Date.now(),
  minIntervalMs = 750,
  timeoutMs = 45e3,
  maxRetries = 2,
  backoffMs = 2e3
} = {}) {
  let last = -Infinity;
  let chain = Promise.resolve();
  const stats = { requests: 0, retries: 0 };
  function slot() {
    const p = chain.then(async () => {
      const wait = last + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    chain = p.catch(() => {
    });
    return p;
  }
  async function postJson(url, body) {
    let attempt = 0;
    for (; ; ) {
      await slot();
      stats.requests++;
      let res = null;
      let err = null;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "user-agent": USER_AGENT, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      } catch (e) {
        err = e;
      }
      const retryable = err || res.status === 429 || res.status >= 500;
      if (retryable) {
        if (attempt >= maxRetries) {
          if (err) {
            const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
            throw new HttpError(timedOut ? `no answer from the Texas bid board after ${Math.round(timeoutMs / 1e3)}s (${attempt + 1} attempts)` : `network error after ${attempt + 1} attempts: ${err.message}`, 0, url);
          }
          throw new HttpError(`the Texas bid board answered HTTP ${res.status} after ${attempt + 1} attempts`, res.status, url);
        }
        attempt++;
        stats.retries++;
        let delay = backoffMs * 2 ** (attempt - 1);
        const ra = res && res.headers && res.headers.get && res.headers.get("retry-after");
        if (ra && Number.isFinite(Number(ra))) delay = Math.max(delay, Number(ra) * 1e3);
        await sleep(delay);
        continue;
      }
      if (res.status >= 300 && res.status < 400) throw new HttpError(`unexpected redirect (HTTP ${res.status}); the bid board may have moved`, res.status, url);
      if (!res.ok) throw new HttpError(`the Texas bid board answered HTTP ${res.status}`, res.status, url);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        if (attempt >= maxRetries) throw new HttpError(`the Texas bid board sent a reply that is not JSON (${text.length} bytes)${text.length === 0 ? ": it is probably overloaded, try again in a few minutes" : ""}`, res.status, url);
        attempt++;
        stats.retries++;
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
  }
  return { postJson, stats };
}

// src/output.js
var line = (s) => s + "\n";
function renderRow(r, i) {
  const due = r.due ? `due ${r.due}${r.due_time ? ` ${r.due_time}` : ""}` : "due date not listed";
  return [
    `${i + 1}. ${r.title}`,
    `   ${r.id} | ${r.agency} | posted ${r.posted || "n/a"} | ${due} | ${r.status}`,
    `   ${r.url}`,
    ...r.matched && r.matched.length ? [`   matched: ${r.matched.join(", ")}`] : []
  ].join("\n") + "\n";
}
function renderSearch(result, { status }) {
  const { rows, total, meta } = result;
  let out = line(`${total} ${status === "all" ? "" : status + " "}solicitation${total === 1 ? "" : "s"} match${total === 1 ? "es" : ""} your keywords${rows.length < total ? ` (showing ${rows.length})` : ""}.`);
  if (rows.length) out += "\n" + rows.map(renderRow).join("\n");
  if (meta && meta.truncated.length) out += line(`
Note: very broad keyword, results cut off for: ${meta.truncated.join(", ")}. Use more specific keywords.`);
  return out;
}
function renderWatch(w) {
  const { baseline, fresh, totalMatching, statePath, teams } = w;
  let out = "";
  if (baseline) {
    out += line(`First check: no earlier results are saved, so all ${fresh.length} open solicitation${fresh.length === 1 ? "" : "s"} matching your keywords are reported as new. From the next run only new ones are listed.`);
  } else if (!fresh.length) {
    out += line(`0 new solicitations since the last check (${totalMatching} open and matching in total).`);
  } else {
    out += line(`${fresh.length} new solicitation${fresh.length === 1 ? "" : "s"} since the last check (${totalMatching} open and matching in total).`);
  }
  if (fresh.length) out += "\n" + fresh.map(renderRow).join("\n");
  if (teams) out += line(`
Teams: ${teams}`);
  out += line(`
State saved to ${statePath}.`);
  return out;
}

// src/teams.js
var MAX_LISTED = 10;
var ENV_VAR = "TEXAS_BIDS_TEAMS_WEBHOOK";
var TeamsError = class extends Error {
};
var mdEscape = (s) => String(s).replace(/([\\`*_{}\[\]()#+!|<>~])/g, "\\$1");
function dueText(r) {
  if (!r.due) return "due date not listed";
  return `due ${r.due}${r.due_time ? ` ${r.due_time}` : ""}`;
}
function buildPayload({ rows, baseline = false, keywords = [], total = rows.length, max = MAX_LISTED }) {
  const n = rows.length;
  const title = baseline ? `Texas bids: ${n} open solicitation${n === 1 ? " matches" : "s match"} your keywords (first check)` : `Texas bids: ${n} new solicitation${n === 1 ? " matches" : "s match"} your keywords`;
  const body = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true }
  ];
  if (keywords.length) body.push({ type: "TextBlock", text: `Keywords: ${keywords.map(mdEscape).join(", ")}`, isSubtle: true, spacing: "None", wrap: true });
  if (baseline) body.push({ type: "TextBlock", text: "This is the first check, so everything currently open is listed. From now on only new bids are sent.", isSubtle: true, wrap: true });
  for (const r of rows.slice(0, max)) {
    body.push({
      type: "TextBlock",
      separator: true,
      wrap: true,
      text: `**[${mdEscape(r.title || r.id)}](${r.url})**

${[mdEscape(r.agency), `ID ${mdEscape(r.id)}`, `posted ${r.posted || "n/a"}`, dueText(r)].join(" | ")}`
    });
  }
  if (n > max) body.push({ type: "TextBlock", text: `...and ${n - max} more. Run the check in Claude to see the full list.`, isSubtle: true, wrap: true });
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        msteams: { width: "Full" },
        body
      }
    }]
  };
}
async function postToTeams({ url, payload, fetchImpl = globalThis.fetch, timeoutMs = 2e4 }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new TeamsError("the Teams webhook value is not a valid URL");
  }
  if (u.protocol !== "https:") throw new TeamsError("the Teams webhook URL must start with https://");
  let res;
  try {
    res = await fetchImpl(u.toString(), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    throw new TeamsError(`could not reach Teams: ${e.name === "TimeoutError" ? "timed out" : "network error"}`);
  }
  if (res.status < 200 || res.status >= 300) {
    let hint = "";
    if (res.status === 400 || res.status === 404) hint = ": the webhook URL may be wrong, or the flow was deleted or turned off";
    if (res.status === 401 || res.status === 403) hint = ": Teams refused the URL; recreate the webhook";
    throw new TeamsError(`Teams answered HTTP ${res.status}${hint}`);
  }
  return { status: res.status };
}

// src/watch.js
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
var STATE_VERSION = 1;
var KEEP_DAYS = 120;
var StateError = class extends Error {
};
var keyOf = (r) => r.internal_id || r.id;
async function loadState(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new StateError(`cannot read the state file ${path}: ${e.message}`);
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    throw new StateError(`the state file ${path} is not valid JSON; move it aside and run again to start fresh`);
  }
  if (!s || typeof s !== "object" || s.version !== STATE_VERSION || typeof s.seen !== "object" || !s.seen) {
    throw new StateError(`the state file ${path} is not a texas-bids state file; move it aside and run again to start fresh`);
  }
  return s;
}
async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
  await rename(tmp, path);
}
function diff({ prev, rows, today }) {
  const baseline = !prev;
  const seen = prev ? prev.seen : {};
  const fresh = rows.filter((r) => !seen[keyOf(r)]);
  const next = {};
  const current = new Set(rows.map(keyOf));
  const cutoff = new Date(Date.parse(today) - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(seen)) {
    if (current.has(k) || !v.due || v.due >= cutoff) next[k] = v;
  }
  for (const r of fresh) next[keyOf(r)] = { id: r.id, title: r.title.slice(0, 120), due: r.due, first_seen: today };
  return {
    baseline,
    fresh,
    state: { version: STATE_VERSION, updated: today, seen: next }
  };
}

// src/cli.js
var HELP = `texas-bids ${VERSION}: check the Texas state bid board (ESBD) for open solicitations. Read-only.

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
  --teams-webhook URL   watch: also post new bids to a Microsoft Teams webhook (or set ${ENV_VAR})
  --webhook URL         notify-teams: the Teams webhook URL (or set ${ENV_VAR})
  --always              post to Teams even when there is nothing new
  --dry-run             watch/notify-teams: print the Teams message, post nothing, save no state
  --json                machine-readable output
`;
var VALUE_FLAGS = /* @__PURE__ */ new Set(["keywords", "status", "since", "limit", "exclude", "agency", "exclude-agency", "state", "teams-webhook", "webhook"]);
var BOOL_FLAGS = /* @__PURE__ */ new Set(["json", "always", "dry-run", "test", "help", "version"]);
var UsageError = class extends Error {
};
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option --${name} (see --help)`);
    let v = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (v === void 0 || eq === -1 && v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    flags[name] = v;
  }
  return { flags, positional };
}
var isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
function needKeywords(flags) {
  const keywords = splitList(flags.keywords);
  if (!keywords.length) throw new UsageError('--keywords is required, for example --keywords "janitorial,HVAC,fuel"');
  return keywords;
}
function validateSince(since) {
  if (since !== void 0 && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new UsageError("--since must look like YYYY-MM-DD");
}
function filters(flags) {
  return { exclude: splitList(flags.exclude), agencies: splitList(flags.agency), excludeAgencies: splitList(flags["exclude-agency"]) };
}
async function main(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  const env = io.env || process.env;
  const now = io.now || (() => Date.now());
  const http = io.http || createHttp({ fetchImpl: io.fetchImpl, sleep: io.sleep, now, ...io.minIntervalMs !== void 0 ? { minIntervalMs: io.minIntervalMs } : {}, ...io.backoffMs !== void 0 ? { backoffMs: io.backoffMs } : {} });
  try {
    const { flags, positional } = parseArgs(argv);
    if (flags.version) {
      stdout(VERSION + "\n");
      return 0;
    }
    const cmd = positional[0];
    if (flags.help || !cmd || cmd === "help") {
      stdout(HELP);
      return cmd || flags.help ? 0 : 2;
    }
    if (positional.length > 1) throw new UsageError(`unexpected argument ${JSON.stringify(positional[1])}`);
    if (cmd === "doctor") {
      const r = parseListResponse(await http.postJson(SERVICE_URL, { keyword: "", status: "1", page: 1 }));
      stdout(`ok: the Texas bid board answered; ${r.total} open solicitations in total (node ${process.versions.node}).
`);
      return 0;
    }
    if (cmd === "search") {
      const keywords = needKeywords(flags);
      validateSince(flags.since);
      const status = flags.status || "open";
      if (status !== "all" && !STATUS_NAMES.includes(status)) throw new UsageError(`--status must be one of ${STATUS_NAMES.join(", ")}, all`);
      const limit = flags.limit === void 0 ? 50 : Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 0) throw new UsageError("--limit must be a whole number (0 = no limit)");
      const result = await search({ http, keywords, status, since: flags.since, limit: limit || void 0, ...filters(flags) });
      if (flags.json) stdout(JSON.stringify({ count: result.rows.length, total: result.total, status, keywords, ...result.meta.truncated.length ? { truncated: result.meta.truncated } : {}, rows: result.rows }, null, 2) + "\n");
      else stdout(renderSearch(result, { status }));
      return 0;
    }
    if (cmd === "watch" || cmd === "notify-teams") {
      const isNotify = cmd === "notify-teams";
      const webhook = (isNotify ? flags.webhook || flags["teams-webhook"] : flags["teams-webhook"] || flags.webhook) || env[ENV_VAR] || "";
      if (isNotify && !webhook) throw new UsageError(`notify-teams needs a Teams webhook URL: pass --webhook URL or set ${ENV_VAR}`);
      if (flags.status !== void 0 && flags.status !== "open") throw new UsageError("watch only follows open solicitations; --status is not used");
      if (flags.limit !== void 0) throw new UsageError("--limit is not used by watch (it must see every solicitation to know which are new)");
      if (isNotify && flags.test) {
        const payload2 = { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", wrap: true, text: "Texas bids: test message. If you can read this, the daily bid alert can post here." }] } }] };
        if (flags["dry-run"]) {
          stdout(JSON.stringify(payload2, null, 2) + "\n");
          return 0;
        }
        await postToTeams({ url: webhook, payload: payload2, fetchImpl: io.teamsFetchImpl || io.fetchImpl });
        stdout("Teams accepted the test message.\n");
        return 0;
      }
      const keywords = needKeywords(flags);
      validateSince(flags.since);
      const statePath = resolve(flags.state || join(homedir(), ".texas-bids", "state.json"));
      const prev = await loadState(statePath);
      const result = await search({ http, keywords, status: "open", since: flags.since, ...filters(flags) });
      const today = isoDay(now());
      const { baseline, fresh, state } = diff({ prev, rows: result.rows, today });
      let teams = "";
      const wantPost = webhook && (fresh.length > 0 || flags.always);
      const payload = wantPost || flags["dry-run"] && webhook ? buildPayload({ rows: fresh, baseline, keywords, total: result.total }) : null;
      if (flags["dry-run"]) {
        if (payload) stdout(JSON.stringify(payload, null, 2) + "\n");
        else stdout("dry run: no Teams webhook given, nothing to show.\n");
        stdout(`dry run: ${fresh.length} new${baseline ? " (first check)" : ""}; no message posted, no state saved.
`);
        return 0;
      }
      let teamsError = null;
      if (wantPost) {
        try {
          await postToTeams({ url: webhook, payload, fetchImpl: io.teamsFetchImpl || io.fetchImpl });
          teams = `posted ${fresh.length} new bid${fresh.length === 1 ? "" : "s"} to the webhook.`;
        } catch (e) {
          teamsError = e;
        }
      } else if (webhook) teams = "nothing new, nothing posted.";
      if (teamsError) {
        if (flags.json) stdout(JSON.stringify({ baseline, new_count: fresh.length, total_matching: result.total, new: fresh, teams: "failed", state_saved: false }, null, 2) + "\n");
        else stdout(renderWatch({ baseline, fresh, totalMatching: result.total, statePath, teams: "FAILED (see error)" }).replace(/\nState saved to .*\n$/, "\nState NOT saved, so these bids will be reported again next run.\n"));
        throw teamsError;
      }
      await saveState(statePath, state);
      if (flags.json) stdout(JSON.stringify({ baseline, new_count: fresh.length, total_matching: result.total, new: fresh, ...webhook ? { teams: wantPost ? "posted" : "skipped" } : {}, state: statePath }, null, 2) + "\n");
      else stdout(renderWatch({ baseline, fresh, totalMatching: result.total, statePath, teams }));
      return 0;
    }
    throw new UsageError(`unknown command ${JSON.stringify(cmd)} (see --help)`);
  } catch (e) {
    if (e instanceof UsageError) {
      stderr(`texas-bids: ${e.message}
`);
      return 2;
    }
    if (e instanceof EsbdError || e instanceof HttpError || e instanceof StateError || e instanceof TeamsError) {
      stderr(`texas-bids: ${e.message}
`);
      return 1;
    }
    stderr(`texas-bids: unexpected error: ${e && e.stack ? e.stack : e}
`);
    return 1;
  }
}

// bin/texas-bids.js
process.exitCode = await main(process.argv.slice(2));
