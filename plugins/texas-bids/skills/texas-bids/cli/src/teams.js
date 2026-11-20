// Post the new-bids summary to a Microsoft Teams incoming webhook (a Workflows "When a Teams webhook request is
// received" URL, or a legacy connector URL). The URL is a secret: it is read from a flag or the environment, never
// stored, and never printed (not even in error messages).

export const ENV_VAR = "TEXAS_BIDS_TEAMS_WEBHOOK";

export class TeamsError extends Error {}

const mdEscape = (s) => String(s).replace(/([\\`*_{}\[\]()#+!|<>~])/g, "\\$1");

function dueText(r) {
  if (!r.due) return "due date not listed";
  return `due ${r.due}${r.due_time ? ` ${r.due_time}` : ""}`;
}

export const CARD_SIZE = 10;        // bids per card
export const MAX_POSTED = 50;       // bids listed individually in one run; the rest get one summary card
export const MAX_CARD_BYTES = 28000; // Teams card size limit

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 3) + "..." : String(s));

const card = (body) => ({
  type: "message",
  attachments: [{
    contentType: "application/vnd.microsoft.card.adaptive",
    contentUrl: null,
    content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", msteams: { width: "Full" }, body },
  }],
});

/**
 * Which new bids get listed individually. Up to MAX_POSTED, the ones whose response is due soonest first (a bid whose
 * due date is already past, or not listed, goes last). The rest are only counted in a summary card, and the caller must
 * NOT mark them as seen, so they are listed in a later run.
 */
export function selectForTeams(rows, today, max = MAX_POSTED) {
  const rank = (r) => (r.due && r.due >= today ? 0 : 1);
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || (a.due || "9999").localeCompare(b.due || "9999") || a.id.localeCompare(b.id));
  return { listed: ordered.slice(0, max), unlisted: ordered.slice(max) };
}

/**
 * Teams messages (each one Adaptive Card): every bid in `rows` is listed, CARD_SIZE per card, then one summary card
 * when `unlisted` bids exist. `rows` is empty only for an "--always" no-news message.
 */
export function buildPayloads({ rows, unlisted = 0, baseline = false, keywords = [], chunk = CARD_SIZE }) {
  const total = rows.length + unlisted;
  const heading = baseline
    ? `Texas bids: ${total} open solicitation${total === 1 ? " matches" : "s match"} your keywords (first check)`
    : `Texas bids: ${total} new solicitation${total === 1 ? " matches" : "s match"} your keywords`;
  const pages = Math.max(1, Math.ceil(rows.length / chunk));
  const payloads = [];
  for (let p = 0; p < pages; p++) {
    const part = rows.slice(p * chunk, (p + 1) * chunk);
    const body = [];
    if (p === 0) {
      body.push({ type: "TextBlock", text: heading, weight: "Bolder", size: "Medium", wrap: true });
      if (keywords.length) body.push({ type: "TextBlock", text: `Keywords: ${keywords.map(mdEscape).join(", ")}`, isSubtle: true, spacing: "None", wrap: true });
      if (unlisted) body.push({ type: "TextBlock", text: `Listing the ${rows.length} due soonest. ${unlisted} more are not listed here; they will be listed in the next checks.`, isSubtle: true, wrap: true });
      if (baseline) body.push({ type: "TextBlock", text: "This is the first check, so everything currently open is listed. From now on only new bids are sent.", isSubtle: true, wrap: true });
    } else {
      body.push({ type: "TextBlock", text: `Texas bids, continued (${p * chunk + 1} to ${p * chunk + part.length} of ${rows.length})`, weight: "Bolder", wrap: true });
    }
    for (const r of part) {
      body.push({
        type: "TextBlock",
        separator: true,
        wrap: true,
        text: `**[${mdEscape(clip(r.title || r.id, 200))}](${r.url})**\n\n${[mdEscape(clip(r.agency, 100)), `ID ${mdEscape(clip(r.id, 60))}`, `posted ${r.posted || "n/a"}`, dueText(r)].join(" | ")}`,
      });
    }
    payloads.push(card(body));
  }
  if (unlisted) {
    payloads.push(card([
      { type: "TextBlock", text: `Texas bids: ${unlisted} more new solicitation${unlisted === 1 ? " was" : "s were"} NOT listed individually`, weight: "Bolder", wrap: true },
      { type: "TextBlock", text: "Only the 50 due soonest are listed per check. The others stay unreported and are listed in the next checks, or ask Claude to search for them now.", wrap: true },
    ]));
  }
  for (const pl of payloads) {
    if (JSON.stringify(pl).length > MAX_CARD_BYTES) throw new TeamsError("internal error: a Teams card would exceed the size limit");
  }
  return payloads;
}

/** POST the payload. Throws TeamsError (never containing the URL) unless Teams accepted it (any 2xx; Workflows answers 202). */
export async function postToTeams({ url, payload, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
  let u;
  try { u = new URL(url); } catch { throw new TeamsError("the Teams webhook value is not a valid URL"); }
  if (u.protocol !== "https:") throw new TeamsError("the Teams webhook URL must start with https://");
  let res;
  try {
    res = await fetchImpl(u.toString(), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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
