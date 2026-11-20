// Post the new-bids summary to a Microsoft Teams incoming webhook (a Workflows "When a Teams webhook request is
// received" URL, or a legacy connector URL). The URL is a secret: it is read from a flag or the environment, never
// stored, and never printed (not even in error messages).

export const MAX_LISTED = 10;
export const ENV_VAR = "TEXAS_BIDS_TEAMS_WEBHOOK";

export class TeamsError extends Error {}

const mdEscape = (s) => String(s).replace(/([\\`*_{}\[\]()#+!|<>~])/g, "\\$1");

function dueText(r) {
  if (!r.due) return "due date not listed";
  return `due ${r.due}${r.due_time ? ` ${r.due_time}` : ""}`;
}

/** Adaptive Card message in the shape Teams webhooks accept. */
export function buildPayload({ rows, baseline = false, keywords = [], total = rows.length, max = MAX_LISTED }) {
  const n = rows.length;
  const title = baseline
    ? `Texas bids: ${n} open solicitation${n === 1 ? " matches" : "s match"} your keywords (first check)`
    : `Texas bids: ${n} new solicitation${n === 1 ? " matches" : "s match"} your keywords`;
  const body = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
  ];
  if (keywords.length) body.push({ type: "TextBlock", text: `Keywords: ${keywords.map(mdEscape).join(", ")}`, isSubtle: true, spacing: "None", wrap: true });
  if (baseline) body.push({ type: "TextBlock", text: "This is the first check, so everything currently open is listed. From now on only new bids are sent.", isSubtle: true, wrap: true });
  for (const r of rows.slice(0, max)) {
    body.push({
      type: "TextBlock",
      separator: true,
      wrap: true,
      text: `**[${mdEscape(r.title || r.id)}](${r.url})**\n\n${[mdEscape(r.agency), `ID ${mdEscape(r.id)}`, `posted ${r.posted || "n/a"}`, dueText(r)].join(" | ")}`,
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
        body,
      },
    }],
  };
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
