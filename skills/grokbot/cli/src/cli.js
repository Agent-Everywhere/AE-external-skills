import { Command, Option } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { CursorClient } from "./cursor.js";
import { Cdp, DEFAULT_CDP_PORT, appState, cdpTargets, ensureDebugApp, launchApp, quitApp, sleep } from "./cdp.js";
import { Gateway } from "./gateway.js";
import * as local from "./local.js";
import { UsageError, pluralize, printJson, relTime, shortId, table } from "./output.js";
import { agentState, filterAgents, parseDuration, resolveAgent, resolveMany, sortAgents } from "./agents.js";
import * as S from "./sections.js";
import { boxGatewaySession, describeSessionSources, jwtClaims, loadCursorAuth, loadGatewayDescriptor, redact, resolveGatewaySession } from "./session.js";
import { DENIED_FOR_AGENTS, auditPath, enforce, resolvePolicy } from "./policy.js";

const VERSION = "0.1.0";

// ------------------------------------------------------------------ context helpers
let _gw = null;
async function gateway(opts) {
  if (_gw) return _gw;
  const session = await resolveGatewaySession({ accountScope: opts.account ?? null, prefer: opts.ensure ? "ensure" : "auto" });
  _gw = new Gateway(session);
  return _gw;
}
function cursor(opts) {
  const auth = loadCursorAuth({ accountScope: opts.account ?? null });
  if (!auth) throw new UsageError("No Cursor account found in the Grok Bot secret store. Sign in to Grok Bot first.");
  return new CursorClient(auth);
}
function globalOpts(cmd) {
  let c = cmd;
  while (c.parent) c = c.parent;
  return c.opts();
}
function out(cmd, value, human) {
  if (globalOpts(cmd).json) printJson(value);
  else process.stdout.write(typeof human === "function" ? human(value) : human ?? String(value) + "\n");
}
function readLines(file) {
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

const selectionOptions = (cmd) =>
  cmd
    .option("--name <glob>", "name glob, case-insensitive (e.g. 'test-*')")
    .option("--match <text>", "substring in name/description/title")
    .option("--regex <re>", "name regex")
    .option("--hidden", "only agents hidden from the sidebar")
    .option("--all", "include hidden agents")
    .option("--groups", "only group chats")
    .option("--no-groups", "exclude group chats")
    .option("--running", "only agents mid-turn")
    .option("--idle", "only agents not mid-turn")
    .option("--unread", "only agents with unread messages")
    .option("--awaiting", "only agents awaiting a user response")
    .option("--idle-for <dur>", "no activity for at least <dur> (30m, 12h, 7d, 2w)")
    .option("--created-before <dur>", "created more than <dur> ago")
    .option("--created-after <dur>", "created within the last <dur>")
    .option("--section <ref>", "in section (id or name), or 'none' for unsectioned")
    .option("--ids-file <file>", "file with one agent id/name per line");

export function selectionFromOpts(o, sections) {
  const f = {
    name: o.name,
    match: o.match,
    regex: o.regex,
    hidden: o.hidden ? true : undefined,
    includeHidden: Boolean(o.all || o.hidden),
    groups: o.groups === true ? true : o.groups === false ? false : undefined,
    running: o.running,
    idle: o.idle,
    unread: o.unread,
    awaiting: o.awaiting,
    idleFor: o.idleFor ? parseDuration(o.idleFor) : undefined,
    createdBefore: o.createdBefore ? parseDuration(o.createdBefore) : undefined,
    createdAfter: o.createdAfter ? parseDuration(o.createdAfter) : undefined,
  };
  if (o.section !== undefined) f.section = o.section === "none" ? "none" : S.requireSection(sections, o.section).id;
  return f;
}
export function hasSelectionFlags(o) {
  return ["name", "match", "regex", "hidden", "running", "idle", "unread", "awaiting", "idleFor", "createdBefore", "createdAfter", "section", "idsFile"].some((k) => o[k] !== undefined && o[k] !== false) || o.groups !== undefined;
}

/** Resolve positional refs and/or selection flags into concrete roster rows. */
async function selectAgents(gw, refs, o, { requireSome = true } = {}) {
  const roster = await gw.listAgents({ fresh: true });
  const sections = o.section !== undefined ? await gw.getSections() : [];
  const allRefs = [...(refs ?? []), ...(o.idsFile ? readLines(o.idsFile) : [])];
  let rows;
  if (allRefs.length > 0) {
    rows = resolveMany(roster, allRefs);
    if (hasSelectionFlags({ ...o, idsFile: undefined })) {
      const keep = new Set(filterAgents(roster, { ...selectionFromOpts(o, sections), includeHidden: true }, sections).map((a) => a.id));
      rows = rows.filter((a) => keep.has(a.id));
    }
  } else if (hasSelectionFlags(o)) {
    rows = filterAgents(roster, selectionFromOpts(o, sections), sections);
  } else {
    throw new UsageError("Give agent refs (id, id prefix, or name) or selection flags like --name/--match/--section/--idle-for.");
  }
  if (requireSome && rows.length === 0) throw new UsageError("No agents matched.");
  return { rows, roster, sections };
}

function agentTable(rows, sections = []) {
  const byAgent = S.sectionIdByAgent(sections);
  const secName = new Map(sections.map((s) => [s.id, s.name]));
  return table(rows, [
    { key: "id", label: "id", format: (v) => shortId(v) },
    { key: "name", label: "name", max: 34 },
    { label: "state", get: agentState },
    { label: "unread", get: (a) => (a.unreadCount ? String(a.unreadCount) : a.hasUnread ? "•" : "") },
    { label: "active", get: (a) => relTime(a.lastActivityAt ?? a.updatedAt) },
    { label: "created", get: (a) => relTime(a.createdAt) },
    { label: "section", get: (a) => secName.get(byAgent.get(a.id)) ?? "" },
    { label: "flags", get: (a) => [a.isGroup && "group", a.isHiddenFromSidebar && "hidden", a.awaitingUserResponse && "awaiting"].filter(Boolean).join(",") },
    { key: "lastMessagePreview", label: "last message", max: 48 },
  ]);
}

export async function confirmDestructive(cmd, rows, o, { verb, noun = "agent", requireCount = true }) {
  const g = globalOpts(cmd);
  if (!g.json) process.stdout.write(agentTable(rows));
  const summary = `${verb} ${pluralize(rows.length, noun)}`;
  if (o.dryRun) {
    out(cmd, { dryRun: true, count: rows.length, ids: rows.map((r) => r.id) }, `dry run: would ${summary}. Re-run with --yes${requireCount && rows.length > 1 ? ` --confirm-count ${rows.length}` : ""}.\n`);
    return false;
  }
  if (!o.yes) {
    const err = new UsageError(`Refusing to ${summary} without --yes${requireCount && rows.length > 1 ? ` --confirm-count ${rows.length}` : ""}.`);
    err.exitCode = 3;
    throw err;
  }
  if (requireCount && rows.length > 1 && Number(o.confirmCount) !== rows.length) {
    const err = new UsageError(`${rows.length} targets matched; pass --confirm-count ${rows.length} to confirm the exact count.`);
    err.exitCode = 3;
    throw err;
  }
  return true;
}

function tailEntries(data) {
  const entries = Array.isArray(data) ? data : data?.entries ?? data?.rows ?? data?.items ?? data?.transcript ?? [];
  return Array.isArray(entries) ? entries : [];
}
function formatEntry(e) {
  const flat = local.transcriptText({ entries: [e] })[0];
  const when = e.createdAt ?? e.at ?? e.timestamp ?? e.createdAtMs;
  const who = e.role ?? e.author ?? e.authorKind ?? e.kind ?? e.type ?? "?";
  const text = flat?.text ?? "";
  return `${when ? new Date(Number(when)).toISOString().slice(11, 19) : "        "} ${String(who).padEnd(10)} ${text.replace(/\s+/g, " ").slice(0, 400)}`;
}

async function writeSections(cmd, gw, before, after, label) {
  const saved = await gw.setSections(S.normalizeSections(after));
  const diff = S.sectionsDiff(before, saved);
  out(cmd, { ok: true, sections: saved, changes: diff }, `${label}\n${diff.map((d) => "  " + d).join("\n")}${diff.length ? "\n" : ""}`);
  await nudgeRenderer();
}
async function nudgeRenderer() {
  // The desktop app re-reads host settings on window focus/reconnect; a CDP bringToFront is the cheapest nudge.
  try {
    const st = await appState();
    if (!st.cdpReachable) return;
    const cdp = await Cdp.connect({ port: st.debugPort });
    await cdp.callDesktop("agent.getSidebarSections").catch(() => {});
    cdp.close();
  } catch {}
}

// ------------------------------------------------------------------ program
export function buildProgram() {
  const program = new Command("grokbot")
    .description("Operate Cursor's Grok Bot desktop app: agents, sections, pins, transcripts, host gateway, Cursor RPC, Electron CDP.")
    .version(VERSION)
    .option("--json", "machine-readable output")
    .option("--account <scope>", "Cursor account scope (when more than one is signed in)")
    .option("--ensure", "skip the app's cached gateway descriptor and mint a session via EnsureSandBox")
    .showHelpAfterError();
  // Policy gate: runs before every leaf action. Inside a Grok Bot box (or GROKBOT_POLICY=agent) the
  // destructive / low-level command families are refused and every invocation is audited.
  program.hook("preAction", (_thisCommand, actionCommand) => {
    enforce(actionCommand, process.argv.slice(2));
  });

  program
    .command("policy")
    .description("Show the active execution policy (operator or agent) and what the agent policy denies")
    .action((_, cmd) => {
      const policy = resolvePolicy();
      const box = boxGatewaySession();
      out(cmd, { policy, insideBox: Boolean(box), boxGateway: box?.path ?? null, denied: DENIED_FOR_AGENTS, auditLog: auditPath() }, () =>
        `policy    ${policy}${box ? `  (box gateway ${box.path})` : ""}\naudit log ${auditPath()}\n${policy === "agent" ? "denied    " + DENIED_FOR_AGENTS.join(", ") + "\n" : "denied    (nothing; operator mode)\n"}`);
    });

  // ---- doctor / status
  program
    .command("doctor")
    .description("Check every control surface: app, Keychain, gateway descriptor, host health, Cursor token, CDP")
    .action(async (_, cmd) => {
      const report = { policy: resolvePolicy(), sources: describeSessionSources(), app: await appState(), gateway: null, host: null, cursor: null };
      try {
        const box = boxGatewaySession();
        const desc = box ?? loadGatewayDescriptor();
        report.gateway = desc ? { source: desc.source, host: new URL(desc.baseUrl).host, savedAt: desc.savedAtMs ? new Date(desc.savedAtMs).toISOString() : null, headers: Object.keys(desc.headers), entries: desc.entryCount ?? null, path: desc.path ?? null } : { source: null, error: "no descriptor" };
        const gw = new Gateway(desc ?? (await resolveGatewaySession()));
        const [health, status, count] = await Promise.all([gw.health(), gw.hostStatus(), gw.countAgents()]);
        report.host = { ok: health.ok, pid: health.pid, busy: health.isBusy, activeAgentId: health.activeAgentId, hostVersion: status.hostVersion, updateAvailable: status.hostUpdateAvailable, capabilities: status.capabilities, agents: count };
      } catch (err) {
        report.host = { error: redact(err.message) };
      }
      // The `cursor` command family is denied under agent policy (control-plane access is a
      // Mac/operator surface); doctor must not become a sibling path to the same data.
      if (report.policy === "agent") {
        report.cursor = { skipped: "cursor control-plane is not available under the agent policy" };
      } else {
        try {
          const c = cursor(cmd.optsWithGlobals());
          report.cursor = c.tokenInfo();
          const st = await c.runState();
          report.cursor.boxState = st.state;
          report.cursor.imageUpdateAvailable = st.imageUpdateAvailable ?? null;
        } catch (err) {
          report.cursor = { error: redact(err.message) };
        }
      }
      out(cmd, report, () => {
        const L = [];
        L.push(`policy     ${report.policy}${report.gateway?.source === "box" ? `  (inside box via ${report.gateway.path})` : ""}`);
        L.push(`app        ${report.app.running ? `running pid ${report.app.pid}` : "not running"} v${report.sources.appVersion ?? "?"}  cdp ${report.app.cdpReachable ? `on :${report.app.debugPort}` : "off (grokbot app restart --debug)"}`);
        L.push(`keychain   ${report.gateway?.source ? "ok" : "no descriptor"}  descriptor ${report.gateway?.entries ?? 0} entr${report.gateway?.entries === 1 ? "y" : "ies"} saved ${report.gateway?.savedAt ?? "?"}`);
        L.push(report.host?.error ? `host       ERROR ${report.host.error}` : `host       ${report.gateway?.host}  ok=${report.host.ok} busy=${report.host.busy} version=${report.host.hostVersion}${report.host.updateAvailable ? " (update available)" : ""} agents=${report.host.agents}`);
        L.push(
          report.cursor?.skipped
            ? `cursor     skipped (${report.cursor.skipped})`
            : report.cursor?.error
              ? `cursor     ERROR ${report.cursor.error}`
              : `cursor     ${report.cursor.email ?? report.cursor.subject}  token exp ${report.cursor.expiresAt}${report.cursor.expired ? " EXPIRED" : ""}  box ${report.cursor.boxState}`,
        );
        return L.join("\n") + "\n";
      });
    });

  program
    .command("status")
    .description("Host health plus roster counts")
    .action(async (_, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const [health, roster, sections] = await Promise.all([gw.health(), gw.listAgents({ fresh: true }), gw.getSections()]);
      const running = roster.filter((a) => a.isRunningTurn || a.isRunning);
      const unread = roster.filter((a) => a.hasUnread || a.unreadCount > 0);
      const hidden = roster.filter((a) => a.isHiddenFromSidebar);
      const groups = roster.filter((a) => a.isGroup);
      const liveIds = new Set(roster.map((a) => a.id));
      const memberIds = [...S.sectionIdByAgent(sections).keys()];
      const sectioned = memberIds.filter((id) => liveIds.has(id)).length;
      const staleMemberships = memberIds.length - sectioned;
      const summary = { host: { ok: health.ok, busy: health.isBusy, activeAgentId: health.activeAgentId, startedAt: new Date(health.startedAt).toISOString() }, agents: roster.length, groups: groups.length, running: running.length, unread: unread.length, hidden: hidden.length, sections: sections.length, sectioned, staleMemberships, unsectioned: roster.length - sectioned, runningAgents: running.map((a) => ({ id: a.id, name: a.name })) };
      out(cmd, summary, () => `host ok=${health.ok} busy=${health.isBusy} up ${relTime(health.startedAt)}\nagents ${roster.length} (${groups.length} groups, ${hidden.length} hidden) · running ${running.length} · unread ${unread.length}\nsections ${sections.length} · sectioned ${sectioned} · unsectioned ${roster.length - sectioned}${staleMemberships ? ` · ${staleMemberships} stale membership(s) (grokbot sections prune)` : ""}\n${running.map((a) => `  running: ${a.name} (${shortId(a.id)})`).join("\n")}${running.length ? "\n" : ""}`);
    });

  // ---- agents
  const agents = program.command("agents").alias("a").description("List, inspect, create, edit, hide, and delete agents (chats)");

  selectionOptions(agents.command("list").alias("ls").description("List agents (hidden excluded unless --all/--hidden)"))
    .option("--sort <by>", "activity|created|name|unread", "activity")
    .option("--limit <n>", "max rows")
    .option("--ids", "print ids only")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const [roster, sections] = await Promise.all([gw.listAgents({ fresh: true }), gw.getSections()]);
      let rows = sortAgents(filterAgents(roster, selectionFromOpts(o, sections), sections), o.sort);
      if (o.idsFile) {
        const keep = new Set(resolveMany(roster, readLines(o.idsFile)).map((a) => a.id));
        rows = rows.filter((a) => keep.has(a.id));
      }
      if (o.limit) rows = rows.slice(0, Number(o.limit));
      if (o.ids) return process.stdout.write(rows.map((a) => a.id).join("\n") + (rows.length ? "\n" : ""));
      out(cmd, rows, () => agentTable(rows, sections) + `${rows.length} of ${roster.length}\n`);
    });

  agents
    .command("get <ref>")
    .description("Show one agent's full roster row")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const sections = await gw.getSections();
      const sec = sections.find((s) => s.agentIds.includes(a.id));
      out(cmd, { ...a, section: sec ? { id: sec.id, name: sec.name } : null }, () => {
        const skip = new Set(["avatarDataUrl", "pushMessageContent"]);
        return Object.entries({ ...a, section: sec?.name ?? null }).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`.slice(0, 300)).join("\n") + "\n";
      });
    });

  agents
    .command("search <query>")
    .description("Host-side search across agents (names, descriptions, transcripts)")
    .option("--limit <n>", "max results", "50")
    .action(async (query, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const r = await gw.searchAgents(query, Number(o.limit));
      out(cmd, r, () => JSON.stringify(r, null, 2) + "\n");
    });

  agents
    .command("create <name>")
    .description("Create a new agent (chat)")
    .option("-d, --description <text>", "instructions / description", "")
    .option("--title <text>")
    .option("--purpose <text>")
    .option("--shape <shape>", "avatar shape")
    .option("--color <color>", "avatar color")
    .option("--section <ref>", "put the new agent into this section")
    .option("--no-intro", "suppress the introduction message")
    .option("--kickstart", "ask the agent to start working immediately")
    .action(async (name, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const created = await gw.createAgent({ name, description: o.description, title: o.title, purpose: o.purpose, avatarShape: o.shape, avatarColor: o.color, isIntroductionSuppressed: o.intro === false ? true : undefined, isKickstartRequested: o.kickstart || undefined });
      const id = created?.id ?? created?.agentId ?? created?.agent?.id;
      if (o.section && id) {
        const before = await gw.getSections();
        await gw.setSections(S.assignAgents(before, o.section, [id]));
      }
      out(cmd, created, `created ${name} ${id ?? ""}${o.section ? ` → section ${o.section}` : ""}\n`);
    });

  agents
    .command("rename <ref> <name>")
    .description("Rename an agent")
    .action(async (ref, name, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      await gw.updateAgent(a.id, { name, description: a.description ?? "" });
      out(cmd, { id: a.id, from: a.name, to: name }, `renamed ${shortId(a.id)} "${a.name}" → "${name}"\n`);
    });

  agents
    .command("update <ref>")
    .description("Update profile fields")
    .option("--name <text>")
    .option("-d, --description <text>")
    .option("--title <text>")
    .option("--shape <shape>")
    .option("--color <color>")
    .option("--notify <on|off>", "notifications enabled")
    .option("--notify-updates <on|off>", "notify on agent updates")
    .action(async (ref, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const profile = { name: o.name ?? a.name, description: o.description ?? a.description ?? "" };
      if (o.title !== undefined) profile.title = o.title;
      if (o.shape !== undefined) profile.avatarShape = o.shape;
      if (o.color !== undefined) profile.avatarColor = o.color;
      if (o.name !== undefined || o.description !== undefined || o.title !== undefined || o.shape !== undefined || o.color !== undefined) await gw.updateAgent(a.id, profile);
      if (o.notify) await gw.setNotifications(a.id, o.notify === "on");
      if (o.notifyUpdates) await gw.setNotifyOnUpdates(a.id, o.notifyUpdates === "on");
      out(cmd, { id: a.id, profile }, `updated ${a.name} (${shortId(a.id)})\n`);
    });

  for (const [verb, flag] of [["hide", true], ["unhide", false]]) {
    selectionOptions(agents.command(`${verb} [refs...]`).description(`${verb === "hide" ? "Hide" : "Unhide"} agents ${verb === "hide" ? "from" : "in"} the sidebar`)).action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const { rows } = await selectAgents(gw, refs, { ...o, all: true });
      for (const a of rows) await gw.setHidden(a.id, flag);
      out(cmd, { ok: true, ids: rows.map((a) => a.id) }, `${verb}: ${rows.map((a) => a.name).join(", ")}\n`);
    });
  }
  for (const [verb, flag] of [["read", false], ["unread", true]]) {
    selectionOptions(agents.command(`${verb} [refs...]`).description(`Mark agents ${verb}`)).action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const { rows } = await selectAgents(gw, refs, o);
      for (const a of rows) await gw.setUnread(a.id, flag);
      out(cmd, { ok: true, ids: rows.map((a) => a.id) }, `marked ${verb}: ${rows.length}\n`);
    });
  }

  agents
    .command("duplicate <ref>")
    .description("Clone an agent (profile, settings, memory store; conversation cleared)")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const r = await gw.duplicateAgent(a.id);
      out(cmd, r, `duplicated ${a.name} → ${r?.id ?? JSON.stringify(r)}\n`);
    });

  agents
    .command("interrupt <ref>")
    .description("Interrupt the agent's current run")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const r = await gw.interrupt(a.id);
      out(cmd, r ?? { ok: true }, `interrupted ${a.name}\n`);
    });

  selectionOptions(agents.command("delete [refs...]").alias("rm").description("Delete agents. Prints the exact targets; needs --yes (and --confirm-count N for more than one)"))
    .option("--dry-run", "list targets and exit")
    .option("--yes", "actually delete")
    .option("--confirm-count <n>", "must equal the number of matched targets when deleting more than one")
    .option("--batch <n>", "ids per deleteAgents call", "25")
    .option("--allow-empty", "allow the delete to empty the whole roster")
    .action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const { rows, sections } = await selectAgents(gw, refs, { ...o, all: true });
      if (!(await confirmDestructive(cmd, rows, o, { verb: "delete" }))) return;
      const ids = rows.map((a) => a.id);
      const batch = Math.max(1, Number(o.batch));
      const results = [];
      for (let i = 0; i < ids.length; i += batch) {
        const slice = ids.slice(i, i + batch);
        const r = await gw.deleteAgents(slice, { allowEmptyRoster: Boolean(o.allowEmpty) });
        results.push(r);
        process.stderr.write(`deleted ${Math.min(i + batch, ids.length)}/${ids.length}\n`);
      }
      // Drop only the deleted ids from sections; other stale memberships are left for `sections prune`.
      const current = sections.length ? sections : await gw.getSections();
      const deletedSet = new Set(ids);
      const touched = current.some((s) => s.agentIds.some((id) => deletedSet.has(id)));
      if (touched) await gw.setSections(S.assignAgents(current, null, ids));
      out(cmd, { ok: true, deleted: ids, results, sectionsUpdated: touched }, `deleted ${pluralize(ids.length, "agent")}${touched ? " (removed from sections)" : ""}\n`);
    });

  agents
    .command("send <ref> <prompt...>")
    .description("Send a message to an agent")
    .option("--reply-to <entryId>")
    .option("--wait", "wait for the turn to finish and print the tail")
    .option("--timeout <sec>", "max seconds to wait", "300")
    .action(async (ref, promptParts, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const prompt = promptParts.join(" ");
      const r = await gw.sendPrompt(a.id, prompt, { replyToId: o.replyTo });
      if (!o.wait) return out(cmd, r, `sent to ${a.name} (${shortId(a.id)}) accepted=${r?.accepted ?? "?"} nonce=${r.clientNonce}\n`);
      const deadline = Date.now() + Number(o.timeout) * 1000;
      let sawRunning = false;
      while (Date.now() < deadline) {
        await sleep(1500);
        const row = (await gw.listAgents({ fresh: true })).find((x) => x.id === a.id);
        const busy = row?.isRunningTurn || row?.isComposingMessage;
        if (busy) sawRunning = true;
        if (sawRunning && !busy) break;
        // Never saw the agent start within 20s: give up waiting rather than spin to the timeout.
        if (!sawRunning && Date.now() - r.sentAt > 20_000) break;
      }
      const tail = tailEntries(await gw.transcriptTail(a.id, 6));
      out(cmd, { sent: r, tail }, tail.map(formatEntry).join("\n") + "\n");
    });

  agents
    .command("tail <ref>")
    .description("Print the last N transcript entries")
    .option("-n, --limit <n>", "entries", "30")
    .option("--raw", "print raw entries")
    .action(async (ref, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      const data = await gw.transcriptTail(a.id, Number(o.limit));
      const entries = tailEntries(data);
      if (o.raw || globalOpts(cmd).json) return printJson(data);
      process.stdout.write(`# ${a.name} (${shortId(a.id)}) — ${entries.length} entries\n` + entries.map(formatEntry).join("\n") + "\n");
    });

  agents
    .command("thread <ref> <rootId>")
    .description("Print a reply thread")
    .action(async (ref, rootId, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      printJson(await gw.thread(a.id, rootId));
    });

  agents
    .command("outline <ref>")
    .description("Conversation outline (host-generated)")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      printJson(await gw.conversationOutline(a.id));
    });

  agents
    .command("memories <ref>")
    .description("List the agent's memories")
    .action(async (ref, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const a = resolveAgent(await gw.listAgents({ fresh: true }), ref);
      printJson(await gw.memories(a.id));
    });

  // ---- sections
  const sections = program.command("sections").alias("s").description("Sidebar sections (stored in host settings; the app refreshes on focus)");

  sections
    .command("list")
    .alias("ls")
    .description("List sections with member counts")
    .option("--members", "list member agents under each section")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const [secs, roster] = await Promise.all([gw.getSections(), o.members || globalOpts(cmd).json ? gw.listAgents({ fresh: true }) : []]);
      const byId = new Map(roster.map((a) => [a.id, a]));
      const enriched = secs.map((s, i) => ({ position: i, ...s, members: s.agentIds.map((id) => ({ id, name: byId.get(id)?.name ?? null, missing: roster.length ? !byId.has(id) : undefined })) }));
      const unsectioned = roster.length ? roster.filter((a) => !S.sectionIdByAgent(secs).has(a.id) && !a.isHiddenFromSidebar).length : null;
      out(cmd, { sections: enriched, unsectioned }, () => {
        let t = table(enriched, [{ key: "position", label: "#" }, { key: "id", label: "id" }, { key: "name", label: "name", max: 40 }, { label: "agents", get: (s) => String(s.agentIds.length) }]);
        if (o.members) for (const s of enriched) t += `\n${s.name}\n` + s.members.map((m) => `  ${shortId(m.id)}  ${m.name ?? "(missing agent)"}`).join("\n") + "\n";
        if (unsectioned != null) t += `\nunsectioned visible agents: ${unsectioned}\n`;
        return t;
      });
    });

  sections
    .command("create <name> [refs...]")
    .description("Create a section, optionally moving agents into it")
    .option("--position <n>", "insert at position (0 = top)")
    .action(async (name, refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const ids = refs.length ? resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id) : [];
      const { sections: after, section } = S.createSection(before, name, ids, { position: o.position != null ? Number(o.position) : null });
      await writeSections(cmd, gw, before, after, `created section "${section.name}" (${section.id})`);
    });

  sections
    .command("rename <section> <name>")
    .description("Rename a section")
    .action(async (ref, name, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const { sections: after } = S.renameSection(before, ref, name);
      await writeSections(cmd, gw, before, after, "renamed");
    });

  sections
    .command("delete <section>")
    .alias("rm")
    .description("Delete a section (its agents become unsectioned; nothing is deleted from the roster)")
    .option("--yes", "confirm")
    .action(async (ref, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const { sections: after, section } = S.deleteSection(before, ref);
      if (!o.yes) {
        const err = new UsageError(`Would delete section "${section.name}" releasing ${section.agentIds.length} agents. Re-run with --yes.`);
        err.exitCode = 3;
        throw err;
      }
      await writeSections(cmd, gw, before, after, `deleted section "${section.name}"`);
    });

  // Bulk membership changes driven by selection flags (not explicit refs) show the targets first and need --yes.
  async function gateSelection(cmd, rows, refs, o, verb) {
    if (refs.length > 0 && !o.dryRun) return true;
    return confirmDestructive(cmd, rows, o, { verb, requireCount: false });
  }

  selectionOptions(sections.command("move <section> [refs...]").alias("assign").description("Move agents into a section (refs or selection flags)"))
    .option("--dry-run", "list targets and exit")
    .option("--yes", "confirm when selecting by flags")
    .action(async (ref, refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const target = S.requireSection(before, ref);
      const { rows } = await selectAgents(gw, refs, { ...o, all: true });
      if (!(await gateSelection(cmd, rows, refs, o, `move to "${target.name}"`))) return;
      const after = S.assignAgents(before, target.id, rows.map((a) => a.id));
      await writeSections(cmd, gw, before, after, `moved ${pluralize(rows.length, "agent")} → "${target.name}"`);
    });

  selectionOptions(sections.command("unassign [refs...]").description("Remove agents from whatever section they are in"))
    .option("--dry-run", "list targets and exit")
    .option("--yes", "confirm when selecting by flags")
    .action(async (refs, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      const { rows } = await selectAgents(gw, refs, { ...o, all: true });
      if (!(await gateSelection(cmd, rows, refs, o, "unassign"))) return;
      const after = S.assignAgents(before, null, rows.map((a) => a.id));
      await writeSections(cmd, gw, before, after, `unassigned ${pluralize(rows.length, "agent")}`);
    });

  sections
    .command("reorder <section> <position>")
    .description("Move a section to a position (0 = top)")
    .action(async (ref, pos, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      await writeSections(cmd, gw, before, S.moveSection(before, ref, Number(pos)), "reordered");
    });

  sections
    .command("sort")
    .description("Sort sections")
    .option("--by <name|size>", "sort key", "name")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const before = await gw.getSections();
      await writeSections(cmd, gw, before, S.sortSections(before, { by: o.by }), `sorted by ${o.by}`);
    });

  sections
    .command("prune")
    .description("Drop memberships whose agent no longer exists")
    .option("--drop-empty", "also delete sections left empty")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const [before, roster] = await Promise.all([gw.getSections(), gw.listAgents({ fresh: true })]);
      const { sections: after, removed, droppedSections } = S.pruneSections(before, roster.map((a) => a.id), { dropEmpty: o.dropEmpty });
      if (removed === 0 && droppedSections.length === 0) return out(cmd, { ok: true, removed: 0 }, "nothing to prune\n");
      await writeSections(cmd, gw, before, after, `pruned ${removed} dead membership(s)${droppedSections.length ? `, dropped ${droppedSections.length} empty section(s)` : ""}`);
    });

  sections
    .command("export")
    .description("Print sections JSON (pipe to a file for backup)")
    .action(async (_, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      printJson(await gw.getSections());
    });

  sections
    .command("import <file>")
    .description("Replace all sections from a JSON file (array of {id,name,agentIds})")
    .option("--yes", "confirm replacement")
    .action(async (file, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const next = S.normalizeSections(JSON.parse(readFileSync(file, "utf8")));
      const before = await gw.getSections();
      if (!o.yes) {
        const err = new UsageError(`Would replace ${before.length} sections with ${next.length}. Changes:\n${S.sectionsDiff(before, next).map((d) => "  " + d).join("\n")}\nRe-run with --yes.`);
        err.exitCode = 3;
        throw err;
      }
      await writeSections(cmd, gw, before, next, `imported ${next.length} sections`);
    });

  // ---- pins
  const pins = program.command("pins").description("Pinned agents (host settings)");
  pins.command("list").alias("ls").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const [ids, roster] = await Promise.all([gw.getPinned(), gw.listAgents({ fresh: true })]);
    const byId = new Map(roster.map((a) => [a.id, a]));
    const rows = ids.map((id) => ({ id, name: byId.get(id)?.name ?? "(missing)" }));
    out(cmd, rows, () => table(rows, [{ key: "id", label: "id", format: shortId }, { key: "name", label: "name" }]));
  });
  pins.command("add <refs...>").action(async (refs, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const ids = resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id);
    const cur = await gw.getPinned();
    const next = [...cur, ...ids.filter((id) => !cur.includes(id))];
    await gw.setPinned(next);
    out(cmd, { pinned: next }, `pinned ${ids.length}; total ${next.length}\n`);
  });
  pins.command("remove <refs...>").alias("rm").action(async (refs, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const ids = new Set(resolveMany(await gw.listAgents({ fresh: true }), refs).map((a) => a.id));
    const next = (await gw.getPinned()).filter((id) => !ids.has(id));
    await gw.setPinned(next);
    out(cmd, { pinned: next }, `unpinned; total ${next.length}\n`);
  });
  pins.command("clear").option("--yes").action(async (o, cmd) => {
    if (!o.yes) throw new UsageError("Re-run with --yes to clear all pins.");
    const gw = await gateway(cmd.optsWithGlobals());
    await gw.setPinned([]);
    out(cmd, { pinned: [] }, "cleared pins\n");
  });

  // ---- settings
  const settings = program.command("settings").description("Raw host settings (sections, pins, default model, notifications, ...)");
  settings.command("get [key]").action(async (key, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const s = await gw.getHostSettings();
    printJson(key ? s?.[key] : s);
  });
  settings.command("set <key> <json>").description("Patch one host setting with a JSON value").action(async (key, json, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const value = JSON.parse(json);
    const r = await gw.setHostSettings({ [key]: value });
    printJson(r?.[key] ?? r);
  });

  // ---- groups
  const groups = program.command("groups").description("Group chats (rooms of agents)");
  groups
    .command("create <name> <members...>")
    .option("-d, --description <text>")
    .action(async (name, members, o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      const ids = resolveMany(await gw.listAgents({ fresh: true }), members).map((a) => a.id);
      const r = await gw.createGroup({ name, description: o.description, memberAgentIds: ids });
      out(cmd, r, `created group ${name}: ${JSON.stringify(r)}\n`);
    });
  groups.command("members <group> <members...>").description("Replace a group's member list").action(async (group, members, _, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    const roster = await gw.listAgents({ fresh: true });
    const g = resolveAgent(roster, group);
    const ids = resolveMany(roster, members).map((a) => a.id);
    const r = await gw.setGroupMembers(g.id, ids);
    out(cmd, r ?? { ok: true }, `group ${g.name} members: ${ids.length}\n`);
  });

  // ---- automations
  program.command("automations").description("List all automations (cron / listeners) across agents").action(async (_, cmd) => {
    const gw = await gateway(cmd.optsWithGlobals());
    printJson(await gw.listAutomations());
  });

  // ---- events
  program
    .command("events")
    .description("Stream host events (server-sent events) until Ctrl-C")
    .option("--max <n>", "stop after n events")
    .action(async (o, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      let n = 0;
      for await (const evt of gw.events()) {
        n++;
        if (globalOpts(cmd).json) printJson({ event: evt.event, id: evt.id, data: evt.json ?? evt.data });
        else process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${evt.event} ${redact(evt.data).slice(0, 300)}\n`);
        if (o.max && n >= Number(o.max)) break;
      }
    });

  // ---- raw gateway
  program
    .command("gw <command> [json]")
    .description("Raw host gateway call: POST /api/<command> with a JSON body")
    .action(async (command, json, _, cmd) => {
      const gw = await gateway(cmd.optsWithGlobals());
      printJson(await gw.call(command, json ? JSON.parse(json) : {}));
    });

  // ---- cursor control plane
  const cur = program.command("cursor").description("Cursor control plane (api2.cursor.sh, GrokBotService): server-side agents, box lifecycle");
  cur.command("whoami").action(async (_, cmd) => {
    const c = cursor(cmd.optsWithGlobals());
    const info = c.tokenInfo();
    out(cmd, info, () => Object.entries(info).map(([k, v]) => `${k.padEnd(16)} ${v}`).join("\n") + "\n");
  });
  cur
    .command("agents")
    .description("Server-side GrokBotAgent objects (named agents / definitions), not the box roster")
    .option("--no-team", "exclude team agents")
    .action(async (o, cmd) => {
      const c = cursor(cmd.optsWithGlobals());
      const { agents, slackConnections } = await c.listAgents({ includeTeamAgents: o.team !== false });
      out(cmd, { agents, slackConnections }, () => table(agents, [{ key: "id", label: "id", format: shortId }, { key: "name", label: "name", max: 34 }, { key: "kind", label: "kind" }, { key: "harness", label: "harness" }, { key: "visibility", label: "visibility" }, { label: "created", get: (a) => relTime(Number(a.createdAtMs)) }, { key: "agentId", label: "agentId", format: shortId }]) + `${agents.length} agents, ${slackConnections.length} slack connections\n`);
    });
  cur.command("delete-agent <id>").description("Delete a server-side GrokBotAgent (control-plane object)").option("--yes").action(async (id, o, cmd) => {
    if (!o.yes) throw new UsageError("Re-run with --yes.");
    printJson(await cursor(cmd.optsWithGlobals()).deleteAgent(id));
  });
  cur.command("visibility <agentId> <owner|team>").action(async (agentId, vis, _, cmd) => {
    printJson(await cursor(cmd.optsWithGlobals()).setVisibility(agentId, vis));
  });
  cur.command("sessions <agentId>").action(async (agentId, _, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listSessions(agentId)));
  cur.command("boxes").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listBoxes()));
  cur.command("state").description("Sandbox run state").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).runState()));
  cur.command("templates").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listTemplates()));
  cur.command("computers").description("User computers registered for local exec").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).listUserComputers()));
  cur.command("capabilities").action(async (_, cmd) => printJson(await cursor(cmd.optsWithGlobals()).runtimeCapabilities()));
  cur.command("ensure-sandbox").description("Mint a fresh gateway session (prints host only, never the token)").action(async (_, cmd) => {
    const r = await cursor(cmd.optsWithGlobals()).ensureSandBox();
    printJson({ ...r, gatewayToken: r.gatewayToken ? "<redacted>" : undefined, gatewayHeaders: r.gatewayHeaders ? Object.keys(r.gatewayHeaders) : undefined });
  });
  cur
    .command("rpc <method> [json]")
    .description("Raw Connect-RPC call against aiserver.v1.GrokBotService (or --service)")
    .option("--service <name>", "e.g. aiserver.v1.DashboardService")
    .action(async (method, json, o, cmd) => {
      printJson(await cursor(cmd.optsWithGlobals()).rpc(method, json ? JSON.parse(json) : {}, { service: o.service }));
    });

  // ---- cdp
  const cdp = program.command("cdp").description("Drive the running desktop app over Chrome DevTools Protocol");
  cdp.option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT));
  const cdpPort = async (cmd) => {
    const explicit = cmd.parent.getOptionValueSource("port") === "cli" ? Number(cmd.parent.opts().port) : null;
    if (explicit) return explicit;
    const st = await appState(DEFAULT_CDP_PORT);
    return st.debugPort ?? DEFAULT_CDP_PORT;
  };
  cdp.command("status").action(async (_, cmd) => {
    const st = await appState(await cdpPort(cmd));
    out(cmd, st, () => `running=${st.running} pid=${st.pid} debugPort=${st.debugPort} cdp=${st.cdpReachable}${st.version ? ` ${st.version.Browser}` : ""}\n`);
  });
  cdp.command("targets").action(async (_, cmd) => printJson(await cdpTargets(await cdpPort(cmd))));
  cdp
    .command("eval <expression>")
    .description("Evaluate JS in the renderer (promises awaited)")
    .action(async (expr, _, cmd) => {
      const c = await Cdp.connect({ port: await cdpPort(cmd) });
      try {
        printJson(await c.evaluate(expr));
      } finally {
        c.close();
      }
    });
  cdp
    .command("desktop <path> [jsonArgs]")
    .description("Call window.desktop.<path>(...args), e.g. agent.getSidebarSections")
    .action(async (path, jsonArgs, _, cmd) => {
      const c = await Cdp.connect({ port: await cdpPort(cmd) });
      try {
        printJson(await c.callDesktop(path, jsonArgs ? JSON.parse(jsonArgs) : []));
      } finally {
        c.close();
      }
    });
  cdp.command("keys [path]").description("List window.desktop keys (or a nested namespace)").action(async (path, _, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      printJson(await c.desktopKeys(path ?? ""));
    } finally {
      c.close();
    }
  });
  cdp.command("text").description("Dump the rendered page text (what the user sees)").action(async (_, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      process.stdout.write((await c.pageText()) + "\n");
    } finally {
      c.close();
    }
  });
  cdp.command("screenshot <file>").action(async (file, _, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      await c.bringToFront();
      await sleep(300);
      process.stdout.write((await c.screenshot(file)) + "\n");
    } finally {
      c.close();
    }
  });
  cdp.command("focus").description("Bring the app window to front (also makes the app re-read host settings)").action(async (_, cmd) => {
    const c = await Cdp.connect({ port: await cdpPort(cmd) });
    try {
      await c.bringToFront();
    } finally {
      c.close();
    }
  });

  // ---- app lifecycle
  const app = program.command("app").description("Desktop app lifecycle");
  app.command("status").action(async (_, cmd) => {
    const st = await appState();
    const ds = local.desktopStatus();
    out(cmd, { ...st, desktopStatus: ds }, () => `running=${st.running} pid=${st.pid} debugPort=${st.debugPort ?? "-"} cdp=${st.cdpReachable} signedIn=${ds?.signedIn ?? "?"} appVersion=${ds?.appVersion ?? "?"}\n`);
  });
  app
    .command("restart")
    .description("Quit and relaunch the app")
    .option("--debug", "relaunch with the CDP port enabled")
    .option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT))
    .action(async (o, cmd) => {
      let st;
      if (o.debug) {
        st = await ensureDebugApp({ port: Number(o.port), restart: true });
      } else {
        // Plain relaunch: no DevTools port is exposed unless asked for.
        if (!(await quitApp())) throw new UsageError("Grok Bot did not quit within 20s; close it manually and retry.");
        await launchApp();
        st = await appState();
      }
      out(cmd, st, `relaunched pid=${st.pid} cdp=${st.cdpReachable ? `:${st.debugPort}` : "off"}\n`);
    });
  app.command("quit").action(async (_, cmd) => {
    const ok = await quitApp();
    out(cmd, { quit: ok }, ok ? "quit\n" : "did not quit within 20s\n");
  });
  app
    .command("open")
    .option("--debug", "launch with the CDP port enabled")
    .option("--port <n>", "CDP port", String(DEFAULT_CDP_PORT))
    .action(async (o, cmd) => {
      if (o.debug) return out(cmd, await ensureDebugApp({ port: Number(o.port) }), "open (debug)\n");
      await launchApp();
      out(cmd, await appState(), "open\n");
    });
  app.command("daemon-log").description("Tail the local-exec daemon log").option("-n <lines>", "lines", "40").action(async (o) => {
    const lines = readFileSync(local.daemonLogPath(), "utf8").trimEnd().split("\n");
    process.stdout.write(lines.slice(-Number(o.n)).join("\n") + "\n");
  });

  // ---- local caches (offline)
  const loc = program.command("local").description("Read the app's offline caches (roster, sections, transcripts). Never authoritative for writes.");
  loc.command("slices").action(async (_, cmd) => {
    const rows = local.listSlices().map((s) => ({ ...s, ...(local.parseSliceKey(s.key) ?? {}) }));
    out(cmd, rows, () => table(rows, [{ key: "slice", label: "slice", max: 70 }, { key: "size", label: "bytes" }, { key: "modifiedAt", label: "modified" }]));
  });
  loc.command("roster").action(async (_, cmd) => {
    const rows = local.cachedRoster();
    out(cmd, rows, () => agentTable(rows, local.cachedSections()) + `${rows.length} cached rows\n`);
  });
  loc.command("sections").action(async () => printJson(local.cachedSections()));
  loc.command("transcripts").description("Agent ids with a cached transcript replica").action(async () => process.stdout.write(local.cachedTranscriptAgentIds().join("\n") + "\n"));
  loc.command("transcript <agentId>").option("--raw").action(async (id, o) => {
    const rep = local.cachedTranscript(id);
    if (!rep) throw new UsageError(`No cached transcript for ${id}`);
    if (o.raw) return printJson(rep);
    process.stdout.write(local.transcriptText(rep).map((e) => `${e.role ?? e.kind ?? "?"}: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") + "\n");
  });
  loc.command("search <query>").description("Grep cached transcripts").action(async (q, _, cmd) => {
    const needle = q.toLowerCase();
    const roster = new Map(local.cachedRoster().map((a) => [a.id, a.name]));
    const hits = [];
    for (const id of local.cachedTranscriptAgentIds()) {
      const rep = local.cachedTranscript(id);
      for (const e of local.transcriptText(rep)) if (e.text.toLowerCase().includes(needle)) hits.push({ agentId: id, agent: roster.get(id) ?? null, role: e.role, text: e.text.replace(/\s+/g, " ").slice(0, 200) });
    }
    out(cmd, hits, () => table(hits, [{ key: "agentId", label: "agent", format: shortId }, { key: "agent", label: "name", max: 24 }, { key: "role", label: "role" }, { key: "text", label: "text", max: 100 }]) + `${hits.length} hits\n`);
  });

  return program;
}

export async function run(argv) {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err?.code === "commander.helpDisplayed" || err?.code === "commander.version" || err?.code === "commander.help") return;
    if (err?.code?.startsWith?.("commander.")) {
      process.exitCode = err.exitCode ?? 64;
      return;
    }
    throw err;
  }
}
