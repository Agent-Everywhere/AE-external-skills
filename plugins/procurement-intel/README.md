# procurement-intel

Unofficial plugin: capture and document same-origin browser endpoints for procurement and construction-intel surfaces (Sourcewell ProPortal, Dodge One / construction.com, Apollo.io), then drive read-only lookups from a signed-in tab the way `salesnav-diy-linkedin` does for LinkedIn.

## Purpose

Install this when an agent needs a durable endpoint map and hard rules for those three products: Google SSO preferred, Bitwarden for password accounts, never print cookies or tokens, VERIFIED markers only after a live exercise, and extra anti-bot caution on Apollo.

## Skills

| Skill | Role |
|---|---|
| [`procurement-intel`](skills/procurement-intel/SKILL.md) | Engine overview, auth order, capture workflow, pointers into `references/endpoints-kb/` |
| [`procurement-diy-endpoints`](skills/procurement-diy-endpoints/SKILL.md) | DIY same-origin fetch map: exercise KB rows from a signed-in tab, mark VERIFIED with date |

Endpoint tables start as **UNTESTED** placeholders with public entry URLs only. Fill paths after live account sessions; do not invent verified routes.

## Install

From the AE-external-skills marketplace (once added):

```
/plugin install procurement-intel@ae-external-skills
```

Or zip `plugins/procurement-intel/` and upload as a local plugin in Claude Desktop.

## Status

Scaffold only (v0.1.0). No page snippets or runtime yet. Picnic / openGrok reuse should use existing Bitwarden logins and session notes; do not mint duplicate trial accounts.
