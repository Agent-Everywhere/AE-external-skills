# 02 Dodge Data & Analytics / Dodge One

Capture pending live signed-in sessions. **Do not invent verified API paths.** All route rows below
are placeholders or public entry URLs only.

## Public entry URLs and auth notes

| Surface | URL | Auth notes | Status |
|---|---|---|---|
| Shared SSO login | https://auth.construction.com/login | Email + password Sign In; “Need a Dodge account? Sign Up” | UNTESTED (entry URL public) |
| Shared SSO register | https://auth.construction.com/register | Registration flow; confirm whether Google SSO appears before creating a password account | UNTESTED (entry URL public) |
| Password reset | https://auth.construction.com/reset-password | | UNTESTED (entry URL public) |
| Customer login hub | https://www.construction.com/customer-log-in/ | Points subscribers at Dodge One; legacy first-generation app links listed for users not ready to switch | UNTESTED (entry URL public) |
| Dodge One apps | https://apps.construction.com | Primary post-login research / analytics / workflow surface | UNTESTED (entry URL public) |
| Marketing / company | https://www.construction.com/ | Public site | n/a |

## Auth checklist

1. Bitwarden lookup for `construction.com` / `auth.construction.com` / `apps.construction.com` before register.
2. Prefer Google SSO if offered on `/login` or `/register`; otherwise password account → Bitwarden only.
3. **Trial often sales-gated.** If self-serve trial is unavailable, stop and report the blocker; do not fake access or scrape behind a paywall without an approved account.
4. Picnic / openGrok: reuse existing Bitwarden login / session notes; do not open a second trial.

## Endpoint table (same-origin API — capture pending)

Fill from a signed-in `apps.construction.com` (and related API hosts observed in-page) tab.
Record the **actual** API origin if it differs from the app origin (still only what the page calls).

| Capability | Method | Path / URL pattern (placeholder) | Notes | Status |
|---|---|---|---|---|
| SSO session / token exchange | GET/POST | _pending live capture_ | Observe Network on login redirect into apps.construction.com; never log tokens | UNTESTED |
| Current user / entitlements | GET | _pending live capture_ | Keys only | UNTESTED |
| Project search | GET/POST | _pending live capture_ | | UNTESTED |
| Project detail | GET | _pending live capture_ | | UNTESTED |
| Company / firm detail | GET | _pending live capture_ | | UNTESTED |
| Saved searches / follows | GET | _pending live capture_ | | UNTESTED |
| Alerts / bid dates | GET | _pending live capture_ | | UNTESTED |
| Legacy Global Network / PlanRoom bridges | GET | _pending live capture_ | Only if still called from the signed-in shell | UNTESTED |

## Capture notes

- Prefer capturing against **Dodge One** (`apps.construction.com`) unless the user still lives in a listed legacy app.
- On sales gate or “contact us for trial”, mark relevant rows **BLOCKED** with date and stop.
- Mark **VERIFIED YYYY-MM-DD** only after a live same-origin exercise.
