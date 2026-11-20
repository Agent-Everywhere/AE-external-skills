---
name: texas-bids
description: >-
  Check the Texas state bid board (ESBD, the Electronic State Business Daily on txsmartbuy.gov) for open
  solicitations that match the user's keywords, and report only the NEW ones on repeat runs, as a daily alert in
  Claude and optionally in a Microsoft Teams channel. Use when the user wants to find Texas state or local
  government bids to respond to, watch Texas bids for what they sell, get a daily "new bids" alert, or post new
  bids to Teams. Texas only, read-only, public data, no login. Runs the bundled `texas-bids` CLI.
---

# texas-bids

> **Unofficial.** Not affiliated with or endorsed by the State of Texas or its Comptroller. `texas-bids` reads
> the public ESBD search that the txsmartbuy.gov website itself uses, which may change without notice. It is
> read-only: it never logs in, registers, follows a solicitation, or submits anything. **Texas only**: other
> states' bid boards are not covered.

**What it is.** Texas agencies, cities, counties, school districts and colleges post their open bids
(solicitations: RFPs, RFQs, bids) on the ESBD. This skill searches it for the user's keywords, lists what is open
(title, agency, posted date, response due date, link), and, run again each day, reports only what is new since the
last check. The user gets a short list to decide on; the skill does not bid or contact anyone.

## Install (for you, the agent)

- **Claude Code:** `/plugin marketplace add Agent-Everywhere/AE-external-skills`, then
  `/plugin install texas-bids@ae-external-skills`; or copy this folder to `~/.claude/skills/texas-bids`.
- **Claude Desktop / Cowork:** add the marketplace `Agent-Everywhere/AE-external-skills` (Customize > Plugins > Add)
  and add `texas-bids`, or upload a `texas-bids.plugin` built with `bash scripts/build-plugin-zip.sh texas-bids`
  from the repo.
- **Anywhere else:** copy this folder; the only thing that runs is `cli/dist/texas-bids.mjs` (Node 20+, no
  `npm install`, no dependencies).

## Run it

```sh
# Claude Code sets CLAUDE_PLUGIN_ROOT; Claude Desktop Cowork leaves it empty and mounts the plugin under /mnt/skills/plugin-files.
TB="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/texas-bids/cli/dist/texas-bids.mjs}"
[ -f "$TB" ] || TB="/mnt/skills/plugin-files/texas-bids/skills/texas-bids/cli/dist/texas-bids.mjs"
[ -f "$TB" ] || TB="/mnt/skills/plugin-files/texas-bids/cli/dist/texas-bids.mjs"
if [ ! -f "$TB" ]; then   # bounded search of the known plugin folders only, never the whole disk
  for d in "$HOME/.claude/plugins" "$HOME/.claude/skills" /mnt/skills /mnt/plugins; do
    [ -d "$d" ] || continue
    f="$(find "$d" -maxdepth 8 -path '*/texas-bids/cli/dist/texas-bids.mjs' 2>/dev/null | head -1)"
    [ -n "$f" ] && { TB="$f"; break; }
  done
fi
node "$TB" doctor        # confirms the bid board answers
node "$TB" --help
```

`$TB` lasts only for the shell call that sets it: set it again at the start of every call.

**Claude Desktop (Cowork).** Chat mode has no shell, so use a Cowork task with a folder the user has added to it.
Cowork's home directory does not survive between tasks: always pass `--state` pointing into the user's folder
(for example `<their folder>/texas-bids/state.json`), never rely on the default under `~`.

## Setup (ask the user once, in one short message)

1. **What do you sell?** One sentence, in their words. This is how you judge fit later.
2. **5 to 10 keywords** a bid for them would contain. Think about how an agency would word it, not how the user
   would: a seller of cleaning services might try `janitorial, custodial, cleaning`; a seller of climate systems
   `HVAC, air conditioning, chiller`; a fuel supplier `fuel, diesel, propane`. Offer to suggest a list from their
   sentence and let them edit it. Each keyword is searched on its own and a bid matches if it matches **any**
   keyword; a keyword of several words is matched as typed, so prefer single words and short phrases.
3. **Agencies to include or exclude** (optional). For example only cities and counties, or leave out one state
   agency that never buys from them. Agencies are matched by a piece of the name or the agency number.
4. **Words that rule a bid out** (optional): for example `software` when a keyword like "support" pulls in IT bids.

Test the keywords with a search before saving them anywhere (next section). If a keyword returns zero or hundreds,
change it with the user.

## Check for open bids

```sh
node "$TB" search --keywords "janitorial,custodial,HVAC" --limit 20
node "$TB" search --keywords "fuel,diesel" --since 2026-11-01 --exclude "software" --json
node "$TB" search --keywords "janitorial" --agency "city of,county" --exclude-agency "department of"
```

Each result shows the solicitation ID, title, agency, posted date, response due date and time, status and the
link to its ESBD page. `Posted` and `Addendum Posted` both count as open. `--status closed|awarded|no-award|cancelled|all`
looks at past bids (these lists can be long, and `all` makes several requests). `--limit 0` shows everything; the default is 50.

Present the list newest first, with the due date prominent and the link on each row. Then help the user decide:
read the title and agency against what they sell, flag the ones that are clearly relevant, and say which are due
soonest. Open the link or tell the user to open it for the full documents: attachments, contacts and the
requirements are on the ESBD page, and the CLI deliberately does not download them.

## Daily "new bids" alert

`watch` runs the same search and prints only solicitations it has not reported before, then remembers them in a
state file.

```sh
node "$TB" watch --keywords "janitorial,custodial,HVAC" --state ./texas-bids/state.json
```

- **The first run has nothing to compare with**, so it reports everything currently open as new and says so
  ("First check ..."). Tell the user that this first list is the whole current picture, and that from the next run
  on only genuinely new bids appear.
- **Every later run** lists only new ones, or says "0 new solicitations". Say plainly when there is nothing new;
  do not pad it.
- A bid that gets an addendum is not reported again; only a new solicitation is.
- Changing the keywords is fine: bids that match a new keyword show up as new on the next run.
- Keep the state file. If it is deleted the next run is a first check again.
- Add `--json` for machine-readable output (`new_count`, `new`, `total_matching`, `baseline`).

### Make it a daily check

Set up a scheduled task in the user's Claude that runs the `watch` command every morning and shows the result.

- **Claude Desktop:** Scheduled > New task, Cowork, with the user's folder attached, for example weekdays at
  7:30am: "Run the Texas bids check: `watch --keywords "<their keywords>" --state texas-bids/state.json` using the
  texas-bids skill, and show me the new bids with a line on why each one fits what I sell."
- **Claude Code:** a scheduled task (`/schedule`) with the same instruction, or cron running
  `node <skill-dir>/cli/dist/texas-bids.mjs watch --keywords "..." --state ~/.texas-bids/state.json`.

Write the user's real keywords and state path into the task so it does not need to ask again. The ESBD is updated
through the day, so once each morning is plenty.

## Optional: also post new bids to Microsoft Teams

The same check can post a short card to a Teams channel, only when there is something new. This needs a webhook
URL that the **user creates in Teams**; you cannot make one for them.

1. In Teams, open the channel, click the **...** next to its name, choose **Workflows**, and pick the template
   **Post to a channel when a webhook request is received**.
2. Name it (for example "Texas bids"), confirm the team and channel, and finish. Teams shows a URL.
3. Copy that URL. It is a secret: anyone with it can post in the channel. Treat it like a password.
4. Give it to the CLI through the environment, not into a file or this chat's history if you can avoid it:
   `export TEXAS_BIDS_TEAMS_WEBHOOK="<the URL>"` in the scheduled task's environment (or the user can paste
   it as `--webhook`). Never write the URL into the repo, a skill file, a note or a log.

Test it first, then run the real thing:

```sh
node "$TB" notify-teams --test                        # posts one short test message (URL from the environment)
node "$TB" notify-teams --keywords "janitorial,HVAC" --state ./texas-bids/state.json --dry-run   # shows the card, posts nothing, saves nothing
node "$TB" notify-teams --keywords "janitorial,HVAC" --state ./texas-bids/state.json              # posts only new bids
```

(`watch --teams-webhook <url>` does the same as `notify-teams`; either also reads `TEXAS_BIDS_TEAMS_WEBHOOK`.)
With nothing new it posts nothing; `--always` posts a "0 new" message anyway. The card lists up to 10 bids with
links and says how many more there are. If Teams rejects the post, the command exits with an error and does **not**
save the state, so the same bids are sent again next run; tell the user and ask them to re-create the webhook if
Teams says the URL is wrong.

## How it works and its limits

- It calls the same JSON list service the txsmartbuy.gov search page calls (details in `cli/README.md`), politely:
  about one request per second, a timeout on every request, retries on errors, and a plain `texas-bids-cli`
  User-Agent. The service is sometimes slow or answers with an empty reply; the CLI retries, then says so. If it
  keeps failing, try again later.
- Keywords are matched by the ESBD's own text search over the posting (not a semantic search).
  A bid worded unexpectedly will be missed: add synonyms.
- The list shows title, agency, dates and class/item codes. Contacts, requirements and attachments are on the
  solicitation's ESBD page.
- Dates are the agency's posted and due dates as shown by the ESBD (Texas time). Confirm a due date on the ESBD
  page before relying on it; agencies change them by addendum.
- It sees only what the ESBD lists. Some Texas entities post bids elsewhere, and other states are not covered.

## Hard rules

- Read-only against a public government site. Do not try to log in, follow a solicitation, subscribe to alerts,
  or contact a listed agency on the user's behalf.
- Never store, print or paste the Teams webhook URL anywhere durable.
- Keep to the built-in pacing. Do not run many searches in a tight loop or schedule it more than a few times a day.
- Treat results as leads: judge fit against what the user sells and say when a bid is a stretch.
