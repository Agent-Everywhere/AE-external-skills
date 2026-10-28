# 03 Apollo.io

Capture pending live signed-in sessions. **Do not invent verified API paths.** All route rows below
are placeholders or public entry URLs only.

**Anti-bot:** Apollo uses Cloudflare Turnstile and related edge checks on login/signup and high-abuse
APIs. Treat Apollo as the strictest surface in this plugin.

## Public entry URLs and auth notes

| Surface | URL | Auth notes | Status |
|---|---|---|---|
| Sign up | https://www.apollo.io/sign-up | **Sign up with Google** available; free forever for core features; no credit card required for free tier | UNTESTED (entry URL public) |
| Sign up success (Google) | https://www.apollo.io/signup-success-with-google-standard | Post-Google marketing/success path (observed publicly) | UNTESTED (entry URL public) |
| App | https://app.apollo.io | Primary signed-in product | UNTESTED (entry URL public) |
| Free trial of paid plans | In-app Upgrade → Basic/Professional → Try for free | Optional **14-day** paid-plan trial (once); free plan remains after expiry if not upgraded. Organization plans: sales-gated | UNTESTED (docs / in-app) |

## Auth checklist

1. Bitwarden lookup for `apollo.io` / `app.apollo.io` before any sign-up.
2. **Prefer Sign up / Log in with Google** (`glu@agent-everywhere.com`). Do not create a password account if Google SSO works.
3. If a password account already exists in Bitwarden, reuse it; never duplicate.
4. Picnic / openGrok: reuse the same Bitwarden item and session notes; do not start a second free/trial org.

## Anti-bot rules (mandatory)

- **Human-paced:** slower than the default 4s floor; think seconds-to-tens-of-seconds between actions.
- **Single tab** for Apollo. No parallel tabs, no parallel `fetch`, no burst scripts.
- **Stop immediately** on captcha, Turnstile, managed challenge, unusual 403/429 spike, or lockout.
  Report **BLOCKED** with date; do not solve challenges by automation; do not retry.
- Prefer observing `performance` resource entries from normal UI navigation over hammering guessed `/api` paths.
- No headless-only shortcuts that skip the real signed-in UI when a challenge is present.

## Endpoint table (same-origin API — capture pending)

Fill from a signed-in `app.apollo.io` tab only after the UI is calmly loaded and no challenge is showing.

| Capability | Method | Path / URL pattern (placeholder) | Notes | Status |
|---|---|---|---|---|
| Session / current user | GET | _pending live capture_ | Never log tokens or cookies | UNTESTED |
| People search | GET/POST | _pending live capture_ | High-abuse surface — extra slow | UNTESTED |
| People / contact detail | GET | _pending live capture_ | No full PII dumps in outputs | UNTESTED |
| Company search | GET/POST | _pending live capture_ | | UNTESTED |
| Company detail | GET | _pending live capture_ | | UNTESTED |
| Sequences list | GET | _pending live capture_ | | UNTESTED |
| Lists / records save | POST | _pending live capture_ | Write: typed approval; trial may cap bulk select | UNTESTED |
| Enrichment / phone | GET/POST | _pending live capture_ | Trial caps may apply; stop on challenge | UNTESTED |
| Credits / plan entitlements | GET | _pending live capture_ | | UNTESTED |

## Capture notes

- Free forever covers core features; optional 14-day Basic/Professional trial is separate and one-time.
- Mark **VERIFIED YYYY-MM-DD** only after a calm, single-call exercise with shape keys checked.
- If Turnstile fires during capture, set **BLOCKED**, end the Apollo session work for the day, and tell the user.
