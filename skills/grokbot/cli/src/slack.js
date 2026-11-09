// Slack install-flow helpers (operator-only `grokbot slack ...`). Pure functions: outcome enums -> a verdict
// ({ok, status, message, exitCode}) so the CLI and the tests agree on what each server outcome means.
//
// Exit codes: 0 done (INSTALLED/REMOVED/UPDATED/UP_TO_DATE/STARTED/CLAIMED), 4 not finished but nothing is broken and a
// human step is needed (admin approval, pick a workspace, reconnect), 1 refused or failed (Slack rejected, rate limited,
// unsupported harness, not published, ...). 3/64/77 keep their usual meanings (no --yes / usage / policy).

/** "GROK_BOT_SLACK_INSTALL_OUTCOME_PENDING_ADMIN_APPROVAL" -> "PENDING_ADMIN_APPROVAL"; a missing (proto3 default) value is UNSPECIFIED. */
export function enumName(value) {
  if (value == null || value === "") return "UNSPECIFIED";
  return String(value).replace(/^.*?(?:OUTCOME|STATUS)_/, "");
}

const OK = new Set(["INSTALLED", "REMOVED", "UPDATED", "UP_TO_DATE", "STARTED", "CLAIMED"]);
const NEEDS_HUMAN = new Set(["PENDING_ADMIN_APPROVAL", "WORKSPACE_REQUIRED", "NOT_CONNECTED", "MANAGER_REAUTH_REQUIRED", "RECREATE_REQUIRED", "INSUFFICIENT_SCOPES", "THROTTLED", "WRONG_CURSOR_ACCOUNT"]);

const WHY = {
  PENDING_ADMIN_APPROVAL: "the workspace admin must approve the app request; re-run after approval (install is idempotent)",
  WORKSPACE_REQUIRED: "more than one Slack workspace is linked; pass --workspace <teamId> (see `grokbot slack workspaces`)",
  NOT_CONNECTED: "no Slack workspace is linked for this agent; run `grokbot slack connect <agent>` or `grokbot slack link-url`",
  MANAGER_REAUTH_REQUIRED: "the Slack manager authorization expired; reconnect with `grokbot slack link-url --reconnect <teamId>`",
  INSUFFICIENT_SCOPES: "the stored Slack authorization lacks scopes; reconnect with `grokbot slack link-url --reconnect <teamId>`",
  INSTALL_CONFLICT: "the agent already has a Slack app in another workspace; add --replace to swap it",
  RATELIMITED: "Slack rate-limited the request; retry later",
  SLACK_REJECTED: "Slack rejected the request",
  UNSUPPORTED_HARNESS: "this agent's harness does not support Slack",
  NOT_PUBLISHED: "the agent is not published, so it cannot get a Slack app",
  WORKSPACE_NOT_ALLOWED: "the workspace is not allowed for this account or team",
  RECREATE_REQUIRED: "the app cannot be updated in place; uninstall and install it again",
  THROTTLED: "reinstall is throttled; retry later",
  UP_TO_DATE: "nothing to update",
  INVALID: "the claim is invalid or already used",
  WRONG_CURSOR_ACCOUNT: "the Slack connection was started from a different Cursor account",
};

/**
 * Turn an Install/Reinstall/Uninstall/Connect/Claim response into { outcome, ok, needsHuman, exitCode, message, url?, details }.
 * Never throws on an unknown outcome name: it is reported as a failure with the raw name.
 */
export function summarizeSlackOutcome(verb, resp = {}) {
  const outcome = enumName(resp.outcome);
  // Verb-aware: an uninstall that finds nothing connected has reached the state it was asked for.
  const alreadyGone = verb === "uninstall" && outcome === "NOT_CONNECTED";
  const ok = OK.has(outcome) || alreadyGone;
  const needsHuman = !ok && NEEDS_HUMAN.has(outcome);
  const details = {};
  for (const k of ["slackTeamId", "workspaceName", "slackTeamName", "previousWorkspaceName", "slackError", "retryAfterSeconds", "approvalRequestFiled", "appRemoved", "previousAppForgotten", "retrying", "forgotten"]) {
    if (resp[k] !== undefined && resp[k] !== null && resp[k] !== false) details[k] = resp[k];
  }
  const workspaces = Array.isArray(resp.workspaces) ? resp.workspaces.map((w) => ({ slackTeamId: w.slackTeamId, name: w.slackTeamName ?? null })) : undefined;
  if (workspaces?.length) details.workspaces = workspaces;
  const url = resp.oauthAuthorizeUrl ?? resp.url ?? null;
  let message = `${verb}: ${outcome}`;
  if (resp.workspaceName || resp.slackTeamName) message += ` (${resp.workspaceName ?? resp.slackTeamName})`;
  if (alreadyGone) message += " - nothing was installed or connected, so there is nothing to remove";
  else if (WHY[outcome] && !(ok && outcome !== "UP_TO_DATE")) message += ` - ${WHY[outcome]}`;
  if (outcome === "UNSPECIFIED") message += " - the server returned no outcome";
  if (resp.slackError) message += `\n  slack error: ${resp.slackError}`;
  if (resp.retryAfterSeconds) message += `\n  retry after ${resp.retryAfterSeconds}s`;
  if (workspaces?.length) message += `\n  workspaces: ${workspaces.map((w) => `${w.slackTeamId}${w.name ? ` (${w.name})` : ""}`).join(", ")}`;
  if (url) message += `\n  open: ${url}`;
  return { outcome, ok, needsHuman, exitCode: ok ? 0 : needsHuman ? 4 : 1, message, url, details };
}

/** Parse a resume-guard allowlist: one `agent | routine` per line (`#` comments, blanks ignored); a bare line is a routine id on any agent. */
export function parseAllowlist(text) {
  const entries = [];
  String(text)
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (!line) return;
      const bar = line.indexOf("|");
      if (bar < 0) entries.push({ line: i + 1, agent: null, routine: line });
      else {
        const agent = line.slice(0, bar).trim();
        const routine = line.slice(bar + 1).trim();
        if (!agent || !routine) throw new Error(`allowlist line ${i + 1}: expected "<agent> | <routine>" or a bare routine id`);
        entries.push({ line: i + 1, agent, routine });
      }
    });
  return entries;
}

// ---------------------------------------------------------------- Grok Bot app workspaces + connect --wait

/** Normalize GetGrokBotSlackInstallState.workspaces -> [{ slackTeamId, name, managerAuthUpdatedAtMs }] (ms as a number, 0 when absent). */
export function appWorkspaces(state = {}) {
  return (Array.isArray(state.workspaces) ? state.workspaces : [])
    .filter((w) => w?.slackTeamId)
    .map((w) => ({ slackTeamId: w.slackTeamId, name: w.slackTeamName ?? null, managerAuthUpdatedAtMs: Number(w.managerAuthUpdatedAtMs) || 0 }));
}

/** Union of the app workspaces across several install states, by team id (the newest managerAuthUpdatedAtMs wins). */
export function unionAppWorkspaces(states) {
  const byTeam = new Map();
  for (const st of states) {
    for (const w of appWorkspaces(st)) {
      const cur = byTeam.get(w.slackTeamId);
      if (!cur || w.managerAuthUpdatedAtMs > cur.managerAuthUpdatedAtMs) byTeam.set(w.slackTeamId, { ...w, name: w.name ?? cur?.name ?? null });
    }
  }
  return [...byTeam.values()];
}

/** Snapshot of an install state to diff against while waiting: team id -> managerAuthUpdatedAtMs, plus whether it was already CONNECTED. */
export function installBaseline(state = {}) {
  return { teams: new Map(appWorkspaces(state).map((w) => [w.slackTeamId, w.managerAuthUpdatedAtMs])), connected: enumName(state.status) === "CONNECTED" };
}

/**
 * Workspaces in `state` that are new relative to `baseline`: an unseen team (isNewTeam) or an already-known team whose
 * managerAuthUpdatedAtMs is newer than before (a re-authorization, but also anything else that bumps the timestamp).
 */
export function newWorkspaces(state, baseline) {
  return appWorkspaces(state)
    .map((w) => ({ ...w, isNewTeam: !baseline.teams.has(w.slackTeamId) }))
    .filter((w) => w.isNewTeam || w.managerAuthUpdatedAtMs > baseline.teams.get(w.slackTeamId));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One install-state read bounded by `ms`: aborts the request through an AbortSignal and also races it, for clients that ignore the signal. */
async function pollOnce(client, agentId, ms) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`GetGrokBotSlackInstallState timed out after ${ms}ms`));
    }, ms);
  });
  const read = Promise.resolve().then(() => client.getSlackInstallState(agentId, { signal: ctrl.signal }));
  read.catch(() => {});
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll GetGrokBotSlackInstallState until the connect shows up, then return { done, timedOut, state, newWorkspaces, connected }.
 * Done means: a workspace appeared (an unseen team id, or a newer managerAuthUpdatedAtMs), or the status turned CONNECTED
 * when it was not already. Narrowing options:
 *   targetTeam     only that team id ending up in the list counts (a typo or a not-yet-recorded team just keeps polling)
 *   requireNewTeam only an unseen team id counts (a bumped timestamp on a known workspace is ignored; used before an auto-install)
 * Transient read errors (network, 5xx, a request over `requestTimeoutMs`) are tolerated: `onError(err, n, max)` is called and
 * polling continues; `maxFailures` consecutive failures throw an Error with exitCode 1. `sleep`/`now` are injectable for tests;
 * the interval never overshoots the deadline.
 */
export async function waitForSlackWorkspace(client, agentId, baseline, { intervalMs = 5000, timeoutMs = 600000, requestTimeoutMs = 15000, maxFailures = 5, targetTeam, requireNewTeam = false, sleep = defaultSleep, now = Date.now, onPoll, onError } = {}) {
  const deadline = now() + timeoutMs;
  let failures = 0;
  let lastState = null;
  for (;;) {
    let state = null;
    try {
      state = await pollOnce(client, agentId, Math.max(1, Math.min(requestTimeoutMs, deadline - now())));
      failures = 0;
    } catch (e) {
      failures += 1;
      onError?.(e, failures, maxFailures);
      if (failures >= maxFailures) {
        const err = new Error(`connect --wait: ${failures} consecutive install-state reads failed (last: ${e.message}). The connect URL may still be valid: check \`grokbot slack status --agent ${agentId}\` and use \`grokbot slack install ${agentId} --yes\` once the workspace is recorded.`);
        err.exitCode = 1;
        throw err;
      }
    }
    if (state) {
      lastState = state;
      let fresh = newWorkspaces(state, baseline);
      if (targetTeam) fresh = fresh.filter((w) => w.slackTeamId === targetTeam);
      else if (requireNewTeam) fresh = fresh.filter((w) => w.isNewTeam);
      const connected = enumName(state.status) === "CONNECTED";
      if (fresh.length || (connected && !baseline.connected)) return { done: true, timedOut: false, state, newWorkspaces: fresh, connected };
    }
    const left = deadline - now();
    if (left <= 0) return { done: false, timedOut: true, state: lastState, newWorkspaces: [], connected: false };
    onPoll?.(left);
    await sleep(Math.min(intervalMs, left));
  }
}

/** Map `items` through async `fn` with at most `limit` in flight; results keep the input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}
