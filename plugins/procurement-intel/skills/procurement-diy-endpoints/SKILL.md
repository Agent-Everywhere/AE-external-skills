---
name: procurement-diy-endpoints
description: >-
  DIY same-origin endpoint map for Sourcewell ProPortal, Dodge One (construction.com), and
  Apollo.io from the user's own signed-in browser tab: discover routes via performance resource
  entries and fetch, record UNTESTED vs VERIFIED rows in the engine KB, never print cookies or
  tokens. Use for "capture Sourcewell endpoints", "map Dodge One API", "Apollo same-origin
  routes", "without a hosted API". Read-only unless the user typed approval for a specific write.
---

# DIY procurement / intel endpoints

**Engine path.** Run this at the top of every shell call (it sets `ENGINE`; quote every path, it may contain
spaces). `ENGINE` is `${CLAUDE_PLUGIN_ROOT}/skills/procurement-intel` when that variable is set (Cowork leaves it
empty), else the Cowork copy `/mnt/skills/plugin-files/procurement-intel/skills/procurement-intel`, else the `procurement-intel` folder next to this skill's folder,
else the first `procurement-intel/references/endpoints-kb/00-common-rules.md` found under `/mnt/skills` or `~/.claude/plugins`. Each step runs
only if `$ENGINE/references/endpoints-kb/00-common-rules.md` is still missing. Replace the angle-bracket part with the absolute folder
you read this SKILL.md from; never guess it. If none resolves, stop and tell the user.

```sh
ENGINE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/procurement-intel}"
[ -f "$ENGINE/references/endpoints-kb/00-common-rules.md" ] || ENGINE="/mnt/skills/plugin-files/procurement-intel/skills/procurement-intel"
[ -f "$ENGINE/references/endpoints-kb/00-common-rules.md" ] || ENGINE="<absolute folder of this SKILL.md>/../procurement-intel"
[ -f "$ENGINE/references/endpoints-kb/00-common-rules.md" ] || { ENGINE="$(find -L /mnt/skills "$HOME/.claude/plugins" -maxdepth 8 -path '*procurement-intel/references/endpoints-kb/00-common-rules.md' 2>/dev/null | head -1)"; ENGINE="${ENGINE%/references/endpoints-kb/00-common-rules.md}"; }
```

Before any step read `$ENGINE/references/endpoints-kb/00-common-rules.md`, then the product file:
`$ENGINE/references/endpoints-kb/01-sourcewell.md`, `02-dodge.md`, or `03-apollo.md`.

**Job.** Mirror what a hosted API would expose for these products, from the user's own machine and
signed-in browser: discover same-origin routes, document request shape, verify with a dated marker,
and keep secrets out of outputs. Modeled on `salesnav-diy-linkedin` + salesnav KB 16.

## Flow

0. Resolve `ENGINE`. If the common-rules file is missing, stop and tell the user.
1. Auth per hard rules (Google SSO preferred; Bitwarden lookup before any Create Account). Never ask
   the user to paste a password into chat.
2. Open the product's signed-in app tab (ProPortal, apps.construction.com / Dodge One, or
   app.apollo.io). Confirm the session is ready (UI shows the logged-in shell).
3. Discover candidates: in the page console (or browser JS tool), list
   `performance.getEntriesByType('resource')` names that look like XHR/fetch API routes. Optionally
   exercise one same-origin `fetch(url, { credentials: 'include', headers: ... })` per candidate,
   pacing ≥ 4 seconds apart (slower on Apollo).
4. Update the matching KB table row: method, path (or full same-origin URL pattern), needed headers
   (names only), response shape **keys only**, Status **VERIFIED YYYY-MM-DD** or leave **UNTESTED**.
   Never invent a path that was not observed.
5. Report to the user: which rows were verified, which remain untested, any blockers (SSO missing,
   sales gate, captcha). Do not include cookies, tokens, or full PII.

## Hard rules

- Prefer Google SSO (`glu@agent-everywhere.com`). Password accounts only when SSO is unavailable;
  save those to Bitwarden, not chat. Never create a duplicate if Bitwarden already has the site.
- Picnic / openGrok: reuse existing Bitwarden logins and session notes; do not create new trial accounts.
- Same-origin only, `credentials: 'include'`. Read CSRF or auth headers **inside the page**; never
  print, log, or save cookie values, bearer tokens, or full `contactInfo`-style PII.
- Pace: one call every 4 seconds or slower; Apollo: slower still, single tab, no parallel calls.
  Stop on 401, 403, 429, captcha, Turnstile, checkpoint, or limit banner. No retries.
- Writes need the user's typed approval of the exact action. Silence is never approval.
- If you cannot run page JS (no browser tool), stop; do not click-scrape the UI as a substitute for
  endpoint capture, and do not invent paths from memory or docs.

Shared rules and markers: `$ENGINE/references/endpoints-kb/00-common-rules.md`.
