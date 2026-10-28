# 00 Common rules (procurement-intel endpoints)

Shared rules for Sourcewell, Dodge One, and Apollo.io endpoint capture. Read before any product KB
file. Modeled on sales-navigator KB 16 status markers and pacing.

## Status markers

| Marker | Meaning |
|---|---|
| **VERIFIED YYYY-MM-DD** | Read-only GET (or documented method) run in a signed-in browser on that date, expected status, shape checked (keys only, no data kept) |
| **UNTESTED** | Not exercised in a live session, or a write not yet approved. Default for every row until capture lands |
| **GONE** | Returned 404/410 (or equivalent) on a dated check; do not use |
| **BLOCKED** | Captcha, Turnstile, sales gate, or account lock prevented exercise; note the date and stop |

Do **not** invent verified endpoint paths. Leave tables **UNTESTED** until a live same-origin session
observes them. Public marketing or login URLs alone are not API verification.

## Auth order

1. Check Bitwarden (and Picnic / openGrok session notes) for an existing login for the site. If one
   exists, reuse it. Never create a duplicate trial or vendor account.
2. Prefer **Google SSO** with `glu@agent-everywhere.com` when the site offers it.
3. Only create a password account when SSO is unavailable. Generate and store the password in
   **Bitwarden**, never in chat, KB files, or skill outputs.
4. Google SSO sessions still need no Bitwarden password entry; optional Bitwarden note that SSO was
   used is fine (no secrets).

## Capture method

- Work in a **signed-in** tab on the product origin (or the origin that serves the XHR/fetch calls).
- Discover candidates with `performance.getEntriesByType('resource')` (filter XHR/fetch / `api` paths).
- Confirm with one same-origin `fetch(path, { credentials: 'include', headers })` at a time.
- Record: method, path template, header **names** (not values), query/body field names, response
  top-level keys, status marker + date.
- CSRF / session tokens: read inside the page only; never print, log, copy to chat, or save to KB.

## Pacing and stop rules

- Default pace: **one call every 4 seconds or slower**, never in parallel.
- **Apollo:** slower, single tab only; treat any challenge as a hard stop for the day (see `03-apollo.md`).
- Stop on 401, 403 (after the UI was ready), 429, captcha, Turnstile, checkpoint, limit banner, or
  unexpected redirect to login. No retry loops, no parallel automation, one seat per browser profile.

## Output hygiene

Never return in skill outputs, commit messages, or KB rows:

- Cookie values, `Authorization` / bearer tokens, CSRF secrets, API keys
- Full email lists, phone numbers, or other bulk PII from responses
- Passwords (Bitwarden only)

Safe to return: path templates, header names, status codes, response **key** names, VERIFIED dates,
and high-level blockers.

## Picnic / openGrok

Reuse existing Bitwarden logins and session notes. Do not mint new trial accounts for a second agent.
Hand-off is via Bitwarden (and notes), not by pasting cookies into chat.

## Index

| File | Product |
|---|---|
| [01-sourcewell.md](01-sourcewell.md) | Sourcewell ProPortal / Buy Sourcewell |
| [02-dodge.md](02-dodge.md) | Dodge Data & Analytics / Dodge One |
| [03-apollo.md](03-apollo.md) | Apollo.io |
