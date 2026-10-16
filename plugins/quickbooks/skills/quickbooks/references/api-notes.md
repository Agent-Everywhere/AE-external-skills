# QuickBooks Online: in-page API notes

Discovered 2026-10-15 by watching network traffic in a signed-in session (`qbo discover`).

## The call

- Endpoint: `https://qbo.intuit.com/api/v3/company/<realm>/<path>?minorversion=75` (same origin as the app).
  This is QuickBooks' public v3 API surface (query language, entities, reports), served to the web app.
- Credentials: the page's session cookies (`credentials: 'include'`).
- Headers the app sends and `page/qbo_api.js` rebuilds:
  - `authorization: Intuit_APIKey intuit_apikey=<browser key>,intuit_appid=<asset alias>,intuit_apikey_version=1.0,intuit_realmid=<realm>,intuit_userid=<user>`.
    The key is the web app's public browser key from `window.qbo.pluginsInfo.plugins['qbo-web-app-ui']`
    (it ships in the app config). Realm comes from the `qbo.currentcompanyid` cookie, user from `userIdentifier`.
  - `x-csrf-token`: the `qbo.csrftoken` cookie.
  - `intuit-company-id`: realm.
- Without the authorization header the API answers 401 (code 3200) even with cookies.
- Nothing secret leaves the page: the snippet returns `{status, realm, data}` only.

## Verified paths

- `GET /query?query=select ...` for Customer, Vendor, Item, Account, Invoice, Estimate, SalesReceipt, Payment,
  CreditMemo, Bill, BillPayment, Purchase, VendorCredit, PurchaseOrder, Deposit, JournalEntry, Transfer,
  TimeActivity, Employee, Term, PaymentMethod, Class, TaxCode, Attachable, CompanyInfo, Preferences.
- `GET /<entity>/<id>`.
- `GET /reports/<Name>`: ProfitAndLoss, ProfitAndLossDetail, BalanceSheet, CashFlow, TrialBalance, GeneralLedger,
  AgedReceivables, AgedReceivableDetail, AgedPayables, AgedPayableDetail, AccountList, CustomerBalance,
  VendorBalance, CustomerIncome, CustomerSales, ItemSales, VendorExpenses, TransactionList.
  (A/P aging and General Ledger were not reachable in the UI on this plan, but the API serves them.)
- Writes (tested live): `POST /customer`, `POST /invoice`, `POST /purchase`, `POST /invoice?operation=void`,
  `POST /invoice?operation=delete`, `POST /purchase?operation=delete`, sparse `POST /customer` with
  `Active: false` (QuickBooks renames an inactivated customer to "<name> (deleted)").

## Other traffic seen (not used)

The app also calls `qbo.intuit.com/api/v4/graphql` (invoice summary, spend lists), `coa-core.api.intuit.com/graphql`
(chart of accounts), `commercecontrol.api.intuit.com/graphql` (products), `sbseggraphqlorch.api.intuit.com/graphql`
(vendors, contacts) and `homepage-bff.api.intuit.com/v1/customers`. They need the same header scheme with a
per-plugin key. v3 covers everything this CLI needs, so they are left out.

## Limits

- `maxresults` <= 1000 per query; page with `--offset`.
- Each command is one or a few calls; `search` runs 11 queries in parallel.
- Cold start (tab not on QuickBooks) costs a full app load (about 1 to 3 s) before the first call.
