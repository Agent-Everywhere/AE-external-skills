// Daily watch: pull open/planned/recent bids, awards and contracts, diff against the last snapshot, report changes.
// Read-only: reuses the existing commands (no new endpoints). A snapshot is written only after every fetch succeeded.
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addMonths } from "./commands.js";

export const CHANGE_TYPES = [
  "NEW_BID", "STATUS_CHANGE", "CLOSING_SOON", "ADDENDUM", "PLAN_TAKERS_JUMP", "NEW_AWARD", "CONTRACT_EXPIRING", "COMPETITOR_CONTRACT",
];
const SNAPSHOT_VERSION = 1;
const KEEP_SNAPSHOTS = 30;
const RECENT_DAYS = 180; // closed/awarded bids older than this are ignored unless already tracked
const FINAL_DAYS = 3;
const BID_STATUSES = ["Open", "Planned", "Closed", "Awarded"];

export class WatchConfigError extends Error {}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const low = (s) => clean(s).toLowerCase();
const uniq = (a) => [...new Set(a)];

function strList(v, name, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new WatchConfigError(`config: "${name}" is required (a list of words to watch for)`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new WatchConfigError(`config: "${name}" must be a list of strings`);
  const out = uniq(v.map(clean).filter(Boolean));
  if (required && !out.length) throw new WatchConfigError(`config: "${name}" must not be empty`);
  return out;
}

export function normalizeConfig(raw, todayIso) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WatchConfigError("config must be a JSON object");
  const year = Number(todayIso.slice(0, 4));
  const posInt = (v, name, dflt) => {
    if (v === undefined) return dflt;
    if (!Number.isInteger(v) || v < 1) throw new WatchConfigError(`config: "${name}" must be a positive whole number`);
    return v;
  };
  let years = raw.award_years;
  if (years === undefined) years = [year, year - 1];
  if (!Array.isArray(years) || years.some((y) => !Number.isInteger(y) || y < 2000 || y > 2100)) throw new WatchConfigError('config: "award_years" must be a list of four-digit years');
  return {
    profile: clean(raw.profile),
    keywords: strList(raw.keywords, "keywords", { required: true }),
    exclude_keywords: strList(raw.exclude_keywords, "exclude_keywords"),
    contract_keywords: strList(raw.contract_keywords, "contract_keywords"),
    competitor_brands: strList(raw.competitor_brands, "competitor_brands"),
    closing_soon_days: posInt(raw.closing_soon_days, "closing_soon_days", 14),
    contract_expiring_months: posInt(raw.contract_expiring_months, "contract_expiring_months", 18),
    award_years: uniq(years),
  };
}

/** Case-insensitive substring matches of `terms` in `text`. */
const hits = (text, terms) => { const t = low(text); return terms.filter((w) => t.includes(w.toLowerCase())); };
const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
// exclude_keywords match whole words: a boundary before the term, and after it only a common inflection
// (s, es, ed, ing, ant(s), ancy, ation(s)). "fire" matches "fires" but not "firewall"; "bus" not "business";
// "consult" matches "consulting".
const excludeRe = (w) => new RegExp(`(?<![a-z0-9])${clean(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?:s|es|ed|ing|ings|ant|ants|ancy|ations?)?(?![a-z0-9])`);
const excluded = (text, cfg) => {
  const t = low(text);
  return (cfg._excludeRes ??= cfg.exclude_keywords.map(excludeRe)).some((re) => re.test(t));
};
/** A match that survives exclude_keywords. */
const matchOf = (text, terms, cfg) => {
  const m = hits(text, terms);
  return m.length && !excluded(text, cfg) ? m : [];
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const daysBetween = (isoA, isoB) => Math.round((Date.parse(isoB) - Date.parse(isoA)) / 86400000);
const addDays = (iso, d) => new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10);

function bidEntry(r, matched) {
  return {
    id: r.id, number: r.number, name: r.name, status: r.status, closing: r.closing || "", closing_local: r.closing_local || "",
    days_left: r.days_left === "" || r.days_left === undefined || r.days_left === null ? null : num(r.days_left),
    planned_issue: r.planned_issue || "", plan_takers: num(r.plan_takers), documents: num(r.documents), addendums: num(r.addendums),
    url: r.url, matched,
  };
}

/** "RFP #010626 - Name" / "042126 - Name" rows come with an empty number in the awards report: recover it. */
function awardIdentity(a) {
  let number = clean(a.number);
  let name = clean(a.name);
  if (!number) {
    const m = name.match(/^(?:[A-Za-z]{2,5}\s*#?\s*)?([A-Za-z]{0,3}-?\d{5,6})\s*[-–—:]\s*(.*)$/);
    if (m) { number = m[1]; name = clean(m[2]); }
  }
  return { number, name };
}

// One record per contract number (case and spacing ignored), whichever query found it.
const contractKey = (c) => clean(c.contract_number).toUpperCase() || `${c.vendor}|${c.end_date}`;

/** Pull everything the watch needs. Throws on any fetch failure (nothing is recorded). */
export async function collect({ commands, cfg, today, prev }) {
  const bids = {};
  const seenIds = new Set();
  const awardRows = {};
  const cutoff = addDays(today, -RECENT_DAYS);
  for (const status of BID_STATUSES) {
    const { rows } = await commands.bidsList({ status, full: true });
    for (const r of rows) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      const matched = matchOf(`${r.name} ${r.description || ""}`, cfg.keywords, cfg);
      if (!matched.length) continue;
      const open = r.status === "Open" || r.status === "Planned";
      if (!open && !(prev && prev.bids[r.id]) && (r.closing || "").slice(0, 10) < cutoff) continue;
      bids[r.id] = bidEntry(r, matched);
    }
  }

  const matchingNumbers = new Set(Object.values(bids).map((b) => b.number.toLowerCase()).filter((n) => n && n !== "tbd"));
  const awards = {};
  for (const year of cfg.award_years) {
    const { rows } = await commands.awardsList({ year });
    awardRows[year] = rows.length;
    for (const a of rows) {
      const { number, name } = awardIdentity(a);
      if (!a.awardees.length) continue;
      const byName = matchOf(name, cfg.keywords, cfg).length > 0;
      const byNumber = number && matchingNumbers.has(number.toLowerCase());
      if (!byName && !byNumber) continue;
      awards[`${year}:${number || name}`] = { year: Number(year), number, name, awardees: a.awardees, bidder_count: a.bidder_count };
    }
  }

  const raw = new Map();
  for (const kw of cfg.contract_keywords) {
    const { rows } = await commands.contractsSearch({ q: kw });
    for (const c of rows) raw.set(contractKey(c), c);
  }
  for (const brand of cfg.competitor_brands) {
    const { rows } = await commands.contractsVendor({ name: brand });
    for (const c of rows) raw.set(contractKey(c), c);
  }
  const contracts = {};
  const brandRes = cfg.competitor_brands.map((b) => [b, wordRe(b)]);
  for (const [key, c] of raw) {
    const text = `${c.description} ${c.keywords} ${c.vendor}`;
    const kw = hits(text, cfg.contract_keywords);
    const brand = (brandRes.find(([, re]) => re.test(low(c.vendor))) || [])[0] || null;
    if ((!kw.length && !brand) || excluded(c.description, cfg)) continue; // excludes look at the description only, not keywords or vendor
    contracts[key] = {
      contract_number: c.contract_number, vendor: c.vendor, end_date: c.end_date, description: c.description.slice(0, 240),
      brand, matched: kw,
    };
  }
  return { bids, awards, contracts, fetchedIds: seenIds, meta: { bids_fetched: seenIds.size, award_rows: awardRows } };
}

/** A section that had rows last time and none now is a degraded upstream, not "everything went away". */
export function assertNotDegraded(prev, cur) {
  const pm = prev && prev.meta;
  if (!pm) return;
  if (pm.bids_fetched > 0 && cur.meta.bids_fetched === 0) throw new Error(`degraded upstream: the bid lists came back empty (the previous run saw ${pm.bids_fetched}); nothing was recorded`);
  for (const [year, n] of Object.entries(pm.award_rows || {})) {
    if (n > 0 && cur.meta.award_rows[year] === 0) throw new Error(`degraded upstream: the ${year} awards report came back empty (the previous run saw ${n} RFPs); nothing was recorded`);
  }
}

/** Compare a fresh pull with the previous snapshot. Fills in alert state on `cur`; returns the change list. */
export function diff({ prev, cur, cfg, today, fetchedIds = new Set() }) {
  const baseline = !prev;
  const changes = [];
  if (prev) {
    // A tracked bid that is no longer in the fetched statuses is carried forward with its state (alerts, counts), reported
    // once as "no longer listed", and forgotten after a year. A bid still fetched but no longer matching the config is dropped quietly.
    for (const p of Object.values(prev.bids)) {
      if (cur.bids[p.id] || fetchedIds.has(p.id)) continue;
      if (p.missing_since && daysBetween(p.missing_since, today) > 365) continue;
      cur.bids[p.id] = p.missing_since ? p : { ...p, missing_since: today };
      if (!p.missing_since) changes.push({ type: "STATUS_CHANGE", number: p.number, name: p.name, status: p.status, closing: p.closing_local || p.closing, days_left: p.days_left, planned_issue: p.planned_issue, url: p.url, id: p.id, from: p.status, to: "no longer listed" });
    }
  }
  const horizon = addMonths(today, cfg.contract_expiring_months);
  const thresholds = uniq([cfg.closing_soon_days, FINAL_DAYS]).sort((a, b) => b - a);
  const bidFields = (b) => ({ number: b.number, name: b.name, status: b.status, closing: b.closing_local || b.closing, days_left: b.days_left, planned_issue: b.planned_issue, url: b.url, id: b.id });

  for (const b of Object.values(cur.bids)) {
    if (b.missing_since) continue; // carried forward above
    const p = prev && prev.bids[b.id];
    const isOpen = b.status === "Open" || b.status === "Planned";
    const crossed = b.status === "Open" && b.days_left !== null && b.days_left >= 0 ? thresholds.filter((t) => b.days_left <= t) : [];
    const before = (p && p.alerted) || [];
    b.alerted = uniq([...before, ...crossed]).sort((x, y) => y - x);
    if (baseline) { if (isOpen) changes.push({ type: "NEW_BID", ...bidFields(b), matched: b.matched }); continue; }

    if (!p) {
      if (isOpen) changes.push({ type: "NEW_BID", ...bidFields(b), matched: b.matched });
    } else {
      if (p.status !== b.status) changes.push({ type: "STATUS_CHANGE", ...bidFields(b), from: p.status, to: b.status });
      if (b.addendums > p.addendums || b.documents > p.documents) {
        changes.push({
          type: "ADDENDUM", ...bidFields(b), addendums: b.addendums, documents: b.documents,
          addendums_delta: Math.max(0, b.addendums - p.addendums), documents_delta: Math.max(0, b.documents - p.documents),
        });
      }
      if (b.plan_takers > p.plan_takers) changes.push({ type: "PLAN_TAKERS_JUMP", ...bidFields(b), plan_takers: b.plan_takers, from: p.plan_takers, delta: b.plan_takers - p.plan_takers });
    }
    const fresh = crossed.filter((t) => !before.includes(t));
    if (fresh.length) changes.push({ type: "CLOSING_SOON", ...bidFields(b), threshold: Math.min(...fresh), final: Math.min(...fresh) <= FINAL_DAYS });
  }

  if (!baseline) {
    for (const [key, a] of Object.entries(cur.awards)) {
      if (prev.awards[key]) continue;
      const bid = Object.values(cur.bids).find((b) => a.number && b.number.toLowerCase() === a.number.toLowerCase());
      changes.push({ type: "NEW_AWARD", number: a.number, name: a.name, year: a.year, awardees: a.awardees, bidder_count: a.bidder_count, ...(bid ? { url: bid.url } : {}) });
    }
  }

  for (const [key, c] of Object.entries(cur.contracts)) {
    const p = prev && prev.contracts[key];
    const inWindow = c.end_date >= today && c.end_date <= horizon;
    c.expiring_reported = !!((p && p.expiring_reported) || inWindow);
    const row = { contract_number: c.contract_number, vendor: c.vendor, end_date: c.end_date, description: c.description };
    if (inWindow && !(p && p.expiring_reported)) {
      changes.push({ type: "CONTRACT_EXPIRING", ...row, months_left: Math.max(0, Math.round(daysBetween(today, c.end_date) / 30.4)), note: "upcoming re-bid signal" });
    }
    if (c.brand && !p) changes.push({ type: "COMPETITOR_CONTRACT", ...row, brand: c.brand });
  }

  const order = (t) => CHANGE_TYPES.indexOf(t);
  const dated = (c) => (c.type === "CONTRACT_EXPIRING" || c.type === "COMPETITOR_CONTRACT" ? c.end_date : "");
  return changes.map((c, i) => [c, i]).sort((a, b) => order(a[0].type) - order(b[0].type) || dated(a[0]).localeCompare(dated(b[0])) || a[1] - b[1]).map(([c]) => c);
}

export function summarize(changes) {
  const by_type = {};
  for (const t of CHANGE_TYPES) { const n = changes.filter((c) => c.type === t).length; if (n) by_type[t] = n; }
  return { total: changes.length, by_type };
}

const TITLES = {
  NEW_BID: "New bids", STATUS_CHANGE: "Status changes", CLOSING_SOON: "Closing soon", ADDENDUM: "New addenda or documents",
  PLAN_TAKERS_JUMP: "Plan-taker jumps", NEW_AWARD: "New awards", CONTRACT_EXPIRING: "Contracts expiring (upcoming re-bids)",
  COMPETITOR_CONTRACT: "Competitor contracts",
};
const LABELS = {
  NEW_BID: ["new bid", "new bids"], STATUS_CHANGE: ["status change", "status changes"], CLOSING_SOON: ["closing soon", "closing soon"],
  ADDENDUM: ["addendum update", "addendum updates"], PLAN_TAKERS_JUMP: ["plan-taker jump", "plan-taker jumps"], NEW_AWARD: ["new award", "new awards"],
  CONTRACT_EXPIRING: ["expiring contract", "expiring contracts"], COMPETITOR_CONTRACT: ["competitor contract", "competitor contracts"],
};
const BASELINE_TITLES = { NEW_BID: "Open and planned bids matching your watch", CONTRACT_EXPIRING: "Contracts expiring (upcoming re-bids)", COMPETITOR_CONTRACT: "Competitor contracts" };
const link = (c) => (c.url ? `[${c.number && c.number !== "TBD" ? `${c.number} ` : ""}${c.name}](${c.url})` : `${c.number ? c.number + " " : ""}${c.name}`);
const when = (c) => (c.status === "Planned" ? `planned issue ${String(c.planned_issue).slice(0, 10) || "TBD"}` : c.closing ? `closes ${c.closing}${c.days_left !== null && c.days_left !== undefined ? ` (${c.days_left}d)` : ""}` : "");

const LINE = {
  NEW_BID: (c) => `${link(c)} [${c.status}] ${when(c)}`.trim(),
  STATUS_CHANGE: (c) => `${link(c)}: ${c.from} -> ${c.to}`,
  CLOSING_SOON: (c) => `${link(c)}: ${c.days_left} day${c.days_left === 1 ? "" : "s"} left${c.final ? " (final)" : ""}, closes ${c.closing}`,
  ADDENDUM: (c) => `${link(c)}: ${[c.addendums_delta && `+${c.addendums_delta} addendum${c.addendums_delta === 1 ? "" : "s"} (${c.addendums})`, c.documents_delta && `+${c.documents_delta} document${c.documents_delta === 1 ? "" : "s"} (${c.documents})`].filter(Boolean).join(", ")}`,
  PLAN_TAKERS_JUMP: (c) => `${link(c)}: plan takers ${c.from} -> ${c.plan_takers} (+${c.delta})`,
  NEW_AWARD: (c) => `${c.url ? link(c) : `${c.number ? c.number + " " : ""}${c.name}`} (${c.year}): awarded to ${c.awardees.join("; ")}`,
  CONTRACT_EXPIRING: (c) => `${c.vendor} ${c.contract_number}: ends ${c.end_date} (~${c.months_left} mo)${c.description ? `: ${c.description.slice(0, 100)}` : ""}`,
  COMPETITOR_CONTRACT: (c) => `${c.brand}: ${c.vendor} ${c.contract_number}, ends ${c.end_date}${c.description ? `: ${c.description.slice(0, 100)}` : ""}`,
};

export function renderMd(result, cfg) {
  const { date, baseline, changes, summary } = result;
  const L = [`# Sourcewell watch: ${date}${cfg.profile ? ` (${cfg.profile})` : ""}`, ""];
  if (!changes.length) {
    L.push(baseline ? "Baseline run: nothing matched your watch yet." : "Nothing new today.", "");
    return L.join("\n");
  }
  const counts = Object.entries(summary.by_type).map(([t, n]) => `${n} ${LABELS[t][n === 1 ? 0 : 1]}`);
  L.push(baseline ? "**Baseline run: current landscape** (changes will be reported from tomorrow)" : `**${summary.total} change${summary.total === 1 ? "" : "s"}**`, counts.join(" | "), "");
  for (const t of CHANGE_TYPES) {
    const rows = changes.filter((c) => c.type === t);
    if (!rows.length) continue;
    L.push(`## ${(baseline ? BASELINE_TITLES[t] : TITLES[t])} (${rows.length})`);
    for (const c of rows) L.push(`- ${LINE[t](c)}`);
    L.push("");
  }
  return L.join("\n");
}

export function render(result, cfg, format) {
  if (format === "json") return JSON.stringify(result, null, 2) + "\n";
  if (format === "md") return renderMd(result, cfg);
  throw new WatchConfigError(`watch --format must be md or json (got ${JSON.stringify(format)})`);
}

// ---- state dir ----

async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { await writeFile(tmp, text); await rename(tmp, file); }
  catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}

async function loadLatest(stateDir) {
  let text;
  try { text = await readFile(join(stateDir, "latest.json"), "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  let snap;
  try { snap = JSON.parse(text); } catch { throw new Error(`${join(stateDir, "latest.json")} is not valid JSON: fix or delete it (deleting re-runs the baseline)`); }
  if (!snap || snap.version !== SNAPSHOT_VERSION || !snap.bids || !snap.awards || !snap.contracts) throw new Error(`${join(stateDir, "latest.json")} is not a watch snapshot this version understands: delete it to re-run the baseline`);
  return snap;
}

async function pruneSnapshots(stateDir) {
  const files = (await readdir(stateDir)).filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_SNAPSHOTS))) await unlink(join(stateDir, f)).catch(() => {});
}

export async function loadConfig(path, todayIso) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (e) { throw new WatchConfigError(`cannot read config ${path}: ${e.code === "ENOENT" ? "file not found (create one with: watch init --out watch.json)" : e.message}`); }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new WatchConfigError(`config ${path} is not valid JSON: ${e.message}`); }
  return normalizeConfig(raw, todayIso);
}

/** One daily run. Writes the snapshot only after a complete, successful pull. */
export async function runWatch({ commands, today, configPath, stateDir, format = "md", deliver }) {
  if (!configPath) throw new WatchConfigError("watch run needs --config <watch.json>");
  if (!stateDir) throw new WatchConfigError("watch run needs --state-dir <dir>");
  if (format !== "md" && format !== "json") throw new WatchConfigError(`watch --format must be md or json (got ${JSON.stringify(format)})`);
  const date = today();
  const cfg = await loadConfig(configPath, date);
  const prev = await loadLatest(stateDir);
  const { fetchedIds, ...cur } = await collect({ commands, cfg, today: date, prev });
  assertNotDegraded(prev, cur);
  const changes = diff({ prev, cur, cfg, today: date, fetchedIds });
  const snapshot = { version: SNAPSHOT_VERSION, date, ...cur };
  const result = { date, baseline: !prev, changes, summary: summarize(changes) };
  const text = render(result, cfg, format);
  // Deliver first (write and verify --out, print), commit state last: a digest that could not be delivered is reported again next run.
  if (deliver) await deliver(text);
  await mkdir(stateDir, { recursive: true });
  const body = JSON.stringify(snapshot, null, 1) + "\n";
  await atomicWrite(join(stateDir, `snapshot-${date}.json`), body);
  await atomicWrite(join(stateDir, "latest.json"), body);
  await pruneSnapshots(stateDir);
  return { text, result };
}
