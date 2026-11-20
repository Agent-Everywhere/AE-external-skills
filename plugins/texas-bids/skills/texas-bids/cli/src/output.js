// Plain-text and JSON rendering for search and watch results.

const line = (s) => s + "\n";

export function renderRow(r, i) {
  const due = r.due ? `due ${r.due}${r.due_time ? ` ${r.due_time}` : ""}` : "due date not listed";
  return [
    `${i + 1}. ${r.title}`,
    `   ${r.id} | ${r.agency} | posted ${r.posted || "n/a"} | ${due} | ${r.status}`,
    `   ${r.url}`,
    ...(r.matched && r.matched.length ? [`   matched: ${r.matched.join(", ")}`] : []),
  ].join("\n") + "\n";
}

export function renderSearch(result, { status }) {
  const { rows, total, meta } = result;
  let out = line(`${total} ${status === "all" ? "" : status + " "}solicitation${total === 1 ? "" : "s"} match${total === 1 ? "es" : ""} your keywords${rows.length < total ? ` (showing ${rows.length})` : ""}.`);
  if (rows.length) out += "\n" + rows.map(renderRow).join("\n");
  if (meta && meta.truncated.length) out += line(`\nNote: very broad keyword, results cut off for: ${meta.truncated.join(", ")}. Use more specific keywords.`);
  return out;
}

export function renderWatch(w) {
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
  if (teams) out += line(`\nTeams: ${teams}`);
  out += line(`\nState saved to ${statePath}.`);
  return out;
}
