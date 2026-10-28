---
name: procurement-intel
description: >-
  Engine for Sourcewell ProPortal, Dodge One (construction.com), and Apollo.io: auth order
  (Google SSO preferred, Bitwarden for password accounts), same-origin endpoint capture rules,
  and pointers into references/endpoints-kb. Use when researching or automating reads against
  those surfaces, or before creating / reusing trial accounts. Read-only by default; never
  invent verified endpoint paths.
---

# Procurement Intel

The engine: one folder of hard rules and an endpoint knowledge base that
`procurement-diy-endpoints` also uses. Endpoint tables live under
`$ENGINE/references/endpoints-kb/`. Capture is pending live signed-in sessions; every path row
starts **UNTESTED** until exercised.

**Surfaces (eventual coverage).**

| Product | Public entry | Notes |
|---|---|---|
| Sourcewell ProPortal | https://proportal.sourcewell-mn.gov/ | Free vendor account; Create Account; login at `/Module/Tenders/en/Login`; may not offer Google SSO |
| Buy Sourcewell | https://www.sourcewell-mn.gov/buy-sourcewell | Separate marketing / contract surface on sourcewell-mn.gov; site announced retirement of the Buy Sourcewell product surface (accounts deactivated) — confirm current state before any account work |
| Dodge Data & Analytics / Dodge One | https://auth.construction.com/login , https://auth.construction.com/register , https://www.construction.com/customer-log-in/ , apps at https://apps.construction.com | Shared SSO; trial often sales-gated |
| Apollo.io | https://www.apollo.io/sign-up (Sign up with Google), app https://app.apollo.io | Free forever + optional 14-day paid trial; anti-bot heavy (Cloudflare Turnstile) |

**Engine path.** Run this at the top of every shell call (it sets `ENGINE`; quote every path, it may contain
spaces). `ENGINE` is `${CLAUDE_PLUGIN_ROOT}/skills/procurement-intel` when that variable is set (Cowork leaves it
empty), else the Cowork copy `/mnt/skills/plugin-files/procurement-intel/skills/procurement-intel`, else this SKILL.md's own folder,
else the first `procurement-intel/references/endpoints-kb/00-common-rules.md` found under `/mnt/skills` or `~/.claude/plugins`. Each step runs
only if `$ENGINE/references/endpoints-kb/00-common-rules.md` is still missing. Replace the angle-bracket part with the absolute folder
you read this SKILL.md from; never guess it. If none resolves, stop and tell the user.

```sh
ENGINE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/procurement-intel}"
[ -f "$ENGINE/references/endpoints-kb/00-common-rules.md" ] || ENGINE="/mnt/skills/plugin-files/procurement-intel/skills/procurement-intel"
[ -f "$ENGINE/references/endpoints-kb/00-common-rules.md" ] || ENGINE="<absolute folder of this SKILL.md>"
[ -f "$ENGINE/references/endpoints-kb/00-common-rules.md" ] || { ENGINE="$(find -L /mnt/skills "$HOME/.claude/plugins" -maxdepth 8 -path '*procurement-intel/references/endpoints-kb/00-common-rules.md' 2>/dev/null | head -1)"; ENGINE="${ENGINE%/references/endpoints-kb/00-common-rules.md}"; }
```

**Step 0, every flow.** Read `$ENGINE/references/endpoints-kb/00-common-rules.md`. Then open the product file you need (`01-sourcewell.md`, `02-dodge.md`, `03-apollo.md`). Never invent a path that is not already in those tables, and never mark a row VERIFIED without a live same-origin exercise on that date.

## Toolkit (scaffold)

There are no `page/` snippets or `scripts/` yet. Until they land:

1. Sign in per Hard rules (SSO first).
2. Drive reads with one same-origin `fetch` (or inspect `performance.getEntriesByType('resource')`) in the signed-in tab.
3. Record path, method, status, response shape keys only into the matching KB file; mark **VERIFIED YYYY-MM-DD** when exercised.
4. Return only needed fields to the user; never cookies, tokens, CSRF secrets, or full PII.

Focused skill: `procurement-diy-endpoints` (folder next to this one).

## Hard rules

1. **Prefer Google SSO** with `glu@agent-everywhere.com`. Only create a password account when the site has no Google SSO path. Save password accounts to Bitwarden, never to chat or skill outputs.
2. **Never create a duplicate account** if Bitwarden already has a login for that site (or Picnic / openGrok already documented one). Reuse existing Bitwarden logins and session notes.
3. **Picnic / openGrok reuse.** Hand off via Bitwarden (and session notes), not by minting a second trial. Do not create new trial accounts for Picnic when one already exists.
4. **Capture endpoints** via same-origin `fetch` and/or `performance.getEntriesByType('resource')` in a signed-in tab. Mark **VERIFIED** with the exercise date; leave everything else **UNTESTED**. Do not invent verified paths.
5. **Never return cookies, tokens, Authorization headers, CSRF secrets, or full PII** in skill outputs, logs, or KB files. Shape keys and status codes only.
6. **Apollo: extra anti-bot caution.** Human-paced, single tab, no parallel automation, stop immediately on captcha / Turnstile / challenge / lockout. See `03-apollo.md`.
7. **Pace.** One call every few seconds or slower; stop on 401, 403, 429, checkpoint, captcha, or redirect off the app. No retry loops.
8. **Read-only by default.** Writes (bids, saves, outreach sends) need the user's typed approval of the exact action; silence is not approval.

## Purpose skills

`procurement-diy-endpoints` uses this engine. Edit tools and KB here only.
