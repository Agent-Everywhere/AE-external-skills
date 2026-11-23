---
name: law-firm-moves
description: >-
  Check a short watch list of law firms for firm-level moves (a merger, a group of lawyers joining, a new office,
  a new managing partner, a partner promotion class) and report only what is new, each with a dated source link,
  the firm's current leader and a one-line reason to call. Use when the user asks "which firms on my list merged
  or opened an office", "law firm moves this week", "watch these law firms", or wants a weekly check on a handful
  of law firms they sell to. Built for a short list: up to 40 firms, or one state up to 25. Run by hand, read-only,
  public pages only, uses the web search Claude already has.
---

# law-firm-moves

> **Unofficial.** Not affiliated with any law firm, bar association or legal directory. This skill only tells
> Claude how to check a short list of firm websites and news pages and write down what it finds. Not legal advice.

## Job

For the law firms on a short watch list, find firm-level moves from the last two weeks (by default) and report only
the ones not reported before. Each row has a dated source link you opened, the firm's current leader, and one line
on why it is a reason to call. It is a small demo by design: a list you supply, run by hand, about once a week.

## Install (for you, the agent)

- **Claude Code:** `/plugin marketplace add Agent-Everywhere/AE-external-skills`, then
  `/plugin install law-firm-moves@ae-external-skills`; or copy this folder to `~/.claude/skills/law-firm-moves`.
- **Claude Desktop / Cowork:** add the marketplace `Agent-Everywhere/AE-external-skills` (Customize > Plugins > Add)
  and add `law-firm-moves`, or upload a `law-firm-moves.plugin` built with
  `bash scripts/build-plugin-zip.sh law-firm-moves` from the repo.
- **Anywhere else:** copy this folder. Nothing else is needed: no engine, no Node, no keys. It runs on whatever web
  search and page-reading tool your Claude already has.

Files go in a `law-firm-moves-work/` folder inside the user's working folder (in Cowork, a folder the user has
added to the task; its home directory does not survive between tasks).

## Setup (talk first, search nothing)

If `law-firm-moves-work/profile.json` exists, load it, read it back in two or three lines and ask if it is still
right. Otherwise ask these, in one short message:

1. **What do you sell, and to whom?** One line, in their words. This is the only source for "why it matters".
2. **The watch list:** firm names, ideally with each firm's website. Or, instead, **one US state plus a practice
   focus** (for example insurance defense), and you find up to 25 firms there.
3. **Which move types matter** (see below; default all).
4. **Firm-size band**, if any (number of attorneys).
5. **Firms to leave out:** current clients, and firms that are competitors of the user.

Show the plan back, let the user edit it, then save the approved version to `law-firm-moves-work/profile.json`:
`offer` (what they sell, to whom), `firms` (list of `{name, website}`) or `state` and `practice_focus`,
`move_types` (list), `size_band` (or null), `exclude` (list of firm names), `lookback_days` (default 14, max 45).

## Limits (read before taking any list)

- **At most 40 firms per run on a supplied list, or one state with at most 25 firms found.** If the user gives
  more, or asks for a whole market, all states, hundreds of firms or an unattended schedule, say plainly that this
  skill is built for a short list, work only the first 40 (or 25) they pick, and stop there. Do not split a big list
  across runs or sessions to get around the cap.
- **Look-back:** 14 days by default, 45 days at most.
- **By hand:** the user starts each run (weekly is a good rhythm). No timers, no background or unattended runs.
- Read-only. Public pages only. No sign-in, no passwords, no paywall workarounds. Not legal advice.
- Individual staff hires, awards and rankings, verdict news and job postings are out of scope; for job postings
  say "use a job-postings skill for that".

## Move types (the user picks; default all)

- A firm merges with, or absorbs, another firm.
- A group of 3 or more attorneys joins from another firm.
- A new office, or a first office in a new state.
- A new managing partner, president or chair.
- A class of partner or shareholder promotions.
- Several attorneys hired at once (announced together).

## Run

Work one firm at a time, politely: no parallel hammering of one site, a short pause between firms, and stop on
the first sign of a block (rate limit, captcha, login wall) rather than trying to get around it. Cap: 40 firms
(state mode: 25).

For each firm:

1. Look at the firm's **own news or press page** first. If the user gave a website, use it; otherwise find the
   firm's official site by search.
2. Then run **one or two web searches** for that firm and the move types (for example the firm name with
   "merger" or "opens office", limited to the look-back window).
3. Keep only items inside the look-back window. **Take the date from the page itself, never from a search
   result or snippet.** If the page shows no date, it is unverified.
4. **Open the source page before reporting anything.** Anything you did not open is "unverified": list it
   separately at the end and keep it out of the main table.
5. Record the firm's **current leader** (managing partner, chair or president) with the exact title, **from the
   firm's own site**. If the site does not state it, write "leader not stated".
6. Write one line on why the move matters for what the user sells, using their `offer`.

Never guess a name, a date, a headcount or an office. If a number or name is not on the page, leave it out.
If a firm's site cannot be read, record it under "could not be read" and move on.

## New-only memory

Keep `law-firm-moves-work/seen.json`: a list of `{firm, url, first_seen}`. Before reporting, drop any item whose
firm and source URL are already in it; after the run, append the new ones. A later run therefore shows only what
is new. If `seen.json` is missing, treat everything found as new.

## Output

Save a table to `law-firm-moves-work/moves-YYYY-MM-DD.md` and the same rows to `moves-YYYY-MM-DD.csv`:

| Firm | Move | Date | Source link | Firm leader, title | Why it matters for what you sell |
|---|---|---|---|---|---|
| Example & Example LLP (example row) | Merges with Sample Law Group | 2026-01-05 | the page you opened | A. Person, Managing Partner | One line tied to the user's offer |

Then give a short summary in chat: **N firms checked, N with a new move, and the firms that could not be
read.** List unverified items below the table, clearly marked. If nothing is new, say so plainly ("No new
firm-level moves in the last N days") and still list how many firms were checked.
