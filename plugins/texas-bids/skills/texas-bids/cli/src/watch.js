// Daily watch: run the same search, report only solicitations not seen in the state file, then update the state.
// The state is written only after everything that must happen with the new rows (such as a Teams post) succeeded, so a
// failed delivery is simply reported again on the next run.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const STATE_VERSION = 1;
const KEEP_DAYS = 120; // forget a solicitation 120 days after its due date once it no longer shows up in the results

export class StateError extends Error {}

const plain = (e) => (e && e.code ? `${e.code}` : "failed");

const keyOf = (r) => r.internal_id || r.id;

export async function loadState(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; // nothing there yet (a blocked folder is reported by ensureWritable)
    throw new StateError(`cannot read the state file ${path} (${plain(e)})`);
  }
  let s;
  try { s = JSON.parse(text); } catch { throw new StateError(`the state file ${path} is not valid JSON; move it aside and run again to start fresh`); }
  if (!s || typeof s !== "object" || s.version !== STATE_VERSION || typeof s.seen !== "object" || !s.seen) {
    throw new StateError(`the state file ${path} is not a texas-bids state file; move it aside and run again to start fresh`);
  }
  return s;
}

/** Fail early, before anything is posted: can a state file be written here? (creates the folder, writes and removes a temp file) */
export async function ensureWritable(path) {
  const probe = `${path}.${process.pid}.probe`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(probe, "");
    await unlink(probe);
  } catch (e) {
    throw new StateError(`cannot write the state file ${path} (${plain(e)}): check that the folder exists and is writable, or pass a different --state; nothing was posted`);
  }
}

/** Atomic write: a half-written state file would make the next run look like a first run. Errors are plain messages. */
export async function saveState(path, state) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
    await rename(tmp, path);
  } catch (e) {
    throw new StateError(`could not save the state file ${path} (${plain(e)}): the next run will report these bids again`);
  }
}

/** Split the current rows into new and already-seen, and build the next state. Pure. */
/** `mark` (default: all new rows) is what gets recorded as seen; new rows not in `mark` are reported again next run. */
export function diff({ prev, rows, today, mark }) {
  const baseline = !prev;
  const seen = prev ? prev.seen : {};
  const fresh = rows.filter((r) => !seen[keyOf(r)]);
  const next = {};
  const current = new Set(rows.map(keyOf));
  const cutoff = new Date(Date.parse(today) - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(seen)) {
    if (current.has(k) || !v.due || v.due >= cutoff) next[k] = v;
  }
  for (const r of mark || fresh) next[keyOf(r)] = { id: r.id, title: r.title.slice(0, 120), due: r.due, first_seen: today };
  return {
    baseline,
    fresh,
    state: { version: STATE_VERSION, updated: today, seen: next },
  };
}
