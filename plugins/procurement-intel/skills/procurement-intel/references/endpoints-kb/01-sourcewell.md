# 01 Sourcewell (ProPortal / Buy Sourcewell)

Capture pending live signed-in sessions. **Do not invent verified API paths.** All route rows below
are placeholders or public entry URLs only.

## Public entry URLs and auth notes

| Surface | URL | Auth notes | Status |
|---|---|---|---|
| ProPortal home | https://proportal.sourcewell-mn.gov/ | Free vendor account; Create Account on the portal | UNTESTED (entry URL public) |
| ProPortal login | https://proportal.sourcewell-mn.gov/Module/Tenders/en/Login | Username + password; **may not offer Google SSO** — expect Bitwarden password account if no SSO | UNTESTED (entry URL public) |
| Create Account guide (PDF) | https://www.sourcewell-mn.gov/sites/default/files/2019-03-27/sourcewell_proportal_create_account_guide.pdf | Public how-to; not an API | n/a (docs) |
| Buy Sourcewell | https://www.sourcewell-mn.gov/buy-sourcewell | Separate surface on sourcewell-mn.gov. Site copy has announced retirement of the Buy Sourcewell product (accounts deactivated); confirm current state before any account or capture work. Contract search on sourcewell-mn.gov may still apply | UNTESTED (entry URL public; product may be retired) |
| Become a supplier | https://www.sourcewell-mn.gov/sourcewell-for-vendors/become-a-supplier | Marketing / process page pointing at ProPortal registration | n/a (docs) |

## Auth checklist

1. Bitwarden lookup for `proportal.sourcewell-mn.gov` (and related Sourcewell hosts) before Create Account.
2. Prefer Google SSO if the login UI ever offers it; research so far suggests username/password only.
3. If creating: free vendor account, legal company name + contact + category selection; save password to Bitwarden only.
4. Picnic / openGrok: reuse that Bitwarden item; do not open a second vendor account.

## Endpoint table (same-origin API — capture pending)

Fill from a signed-in ProPortal tab via `performance.getEntriesByType('resource')` and paced
`fetch`. Leave **UNTESTED** until exercised.

| Capability | Method | Path / URL pattern (placeholder) | Notes | Status |
|---|---|---|---|---|
| Session / me | GET | _pending live capture_ | Observe after login; keys only | UNTESTED |
| Bid / solicitation list | GET | _pending live capture_ | Public bids homepage may differ from authenticated list | UNTESTED |
| Solicitation detail | GET | _pending live capture_ | | UNTESTED |
| Document / addenda download | GET | _pending live capture_ | Free account often required to download | UNTESTED |
| Q&A submit | POST | _pending live capture_ | Write: typed approval required | UNTESTED |
| Account / profile | GET | _pending live capture_ | No full PII in outputs | UNTESTED |
| Buy Sourcewell / contract search APIs | GET | _pending live capture_ | Confirm surface still exists before capture | UNTESTED |

## Capture notes

- Technical support for ProPortal has historically been bids&tenders (`support@bidsandtenders.ca` on public pages); that is support contact context, not an API host to call from this skill unless observed in-page.
- Mark **VERIFIED YYYY-MM-DD** only after a 200 (or expected status) in a signed-in tab with shape keys checked.
