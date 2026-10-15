---
name: salesnav-tam-tracker
description: >-
  Break a Sales Navigator master search that is over the viewable cap into sub-lists (state, then
  headcount band, then metro), pull each one, dedupe across them and track coverage in a CSV. Use for
  "pull the whole TAM", "split this search", "what is left to pull", "how much of the market have
  we covered", "resume the TAM pull". Pulls only what the user asks for.
---

# Sales Nav TAM: tracker

**Engine path.** Run this at the top of every shell call (it sets `ENGINE`; quote every path, it may contain
spaces). `ENGINE` is `${CLAUDE_PLUGIN_ROOT}/skills/sales-navigator` when that variable is set (Cowork leaves it
empty), else the Cowork copy `/mnt/skills/plugin-files/sales-navigator/skills/sales-navigator`, else the `sales-navigator` folder next to this skill's folder,
else the first `sales-navigator/scripts/doctor.py` found under `/mnt/skills` or `~/.claude/plugins`. Each step runs
only if `$ENGINE/scripts/doctor.py` is still missing. Replace the angle-bracket part with the absolute folder
you read this SKILL.md from; never guess it. If none resolves, stop and tell the user.

```sh
ENGINE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/sales-navigator}"
[ -f "$ENGINE/scripts/doctor.py" ] || ENGINE="/mnt/skills/plugin-files/sales-navigator/skills/sales-navigator"
[ -f "$ENGINE/scripts/doctor.py" ] || ENGINE="<absolute folder of this SKILL.md>/../sales-navigator"
[ -f "$ENGINE/scripts/doctor.py" ] || { ENGINE="$(find -L /mnt/skills "$HOME/.claude/plugins" -maxdepth 8 -path '*sales-navigator/scripts/doctor.py' 2>/dev/null | head -1)"; ENGINE="${ENGINE%/scripts/doctor.py}"; }
```

Snippets (`count.js` and the rest) live in `$ENGINE/page/`; run one with `python3 "$ENGINE/runtime/session.py" --emit <snippet>.js --params '{...}' --compact`.

**Job.** Cover a market bigger than one search can show (1,000 accounts, 2,500 leads) with sub-lists
that each fit under the cap, and keep a checklist so any later task knows what is counted, pulled and next.

## Flow

0. Run `python3 "$ENGINE/scripts/doctor.py"`. **If doctor fails or the engine can't be found, stop and tell
   the user. Never fall back to driving the Sales Navigator UI by hand (clicking filters, scrolling
   results, saving lists).**
1. Locate the workspace with `python3 "$ENGINE/scripts/workspace.py" locate` (elsewhere pass `--workspace DIR`
   to every script). Check the tracker first: `python3 "$ENGINE/scripts/tam_tracker.py" status`. It is
   `tam_tracker.csv` (columns: list_id, master, filters_delta, count, pulled, status new|partial|done,
   last_pulled, file).
2. Plan the cut. Count states in priority order with `count.js` until about 90 percent of the national
   count is covered, then split big states by headcount band, then metro. `python3 "$ENGINE/scripts/shard_plan.py"`
   proposes the split from the counts you give it. State ids come from `typeahead.js`.
3. Record each sub-list under the cap, with ids that carry the master: `python3
   "$ENGINE/scripts/tam_tracker.py" add --list-id acme-tx-c --master acme --filters-delta "state=Texas;
   headcount=C" --count 840 --kind account` (`--kind lead` for people). Exit 5 means over the cap (1,000
   accounts, 2,500 leads): split it further.
4. Ask `python3 "$ENGINE/scripts/tam_tracker.py" next`, pull that list page by page (`account_search.js` or
   `lead_search.js`, `count` 100, `start` += `count`), save each page under `results/<list_id>/`, then
   `python3 "$ENGINE/scripts/tam_tracker.py" update --master acme --list-id ID --pulled N --file PATH`.
   Status turns partial, then done; a changed `--count N` re-derives it.
5. Convert with `python3 "$ENGINE/scripts/salesnav_rows.py" accounts|leads results/<list_id>/*.json -o
   FILE.csv`, check it with `python3 "$ENGINE/scripts/validate_csv.py" FILE.csv`, and merge shards with
   `python3 "$ENGINE/scripts/dedupe.py"`. Shards overlap: report "sum X, unique Y", never the sum alone.
   Qualifying accounts: `salesnav-tam-accounts`.
6. Report `tam_tracker.py status`, the unique total, what is left, and the next list. Across several segments the
   saved Sales Nav list is the master of record: note its list id (from `lists.js`) in `--filters-delta`
   (for example `list=<listId>`) so a later task finds it; `list_id` here is the tracker's own sub-list id.

## Hard rules

- If you cannot run a page snippet (no browser JS tool, no Agent Browser, no CDP), stop and tell the user; never click through the UI.
- Never substitute another data source (other MCP datasets, web estimates) for the Sales Nav count without asking the user.
- Read-only by default; never send from here. A Sales Nav list is the master of record across segments: save to it
  only through `salesnav-tam-accounts` (exact list name confirmed once per run, never modify a list the user did not
  name; saves are paced, shard lists `<name>`, `<name> #2`... at 900 accounts); never create a saved search without the user's explicit confirmation. Say
  what a pull costs in pages first; do not chain big pulls.
- Respect caps: default 100 result pages a day (a `count=100` call is 4 pages), pace 3 to 5 seconds apart.
  Log with `python3 "$ENGINE/scripts/run_log.py" add --pages N` and check
  `python3 "$ENGINE/scripts/run_log.py" quota`; never raise a cap without the user's explicit go. A big TAM is
  several days: the tracker is how the next day resumes.
- Stop on a 403/429, captcha, limit banner, or empty or repeating pages; tell the user the message.
- Never invent rows or slugs; leave `linkedin_url` blank.

Caps, sharding, gotchas: `$ENGINE/reference.md`.
