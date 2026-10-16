# QuickBooks Online (qbo.intuit.com) UI route map

Explored: 2026-10-15, company is EMPTY ("No company name"), signed in as the box browser user. READ-ONLY exploration: no Save/Send/Delete/Connect/Upgrade clicks. Blank "new" forms were opened and abandoned (tab closed, nothing saved).

URL notes
- Session params stripped in the URLs below: `intuit_authn_session_slot`, `iux_intuit_tid`. `locale=en-us` also appears on the first load.
- Every page has the same chrome: top bar (company name, search box "Navigate. Find transactions, contacts, help, reports, and more.", Upgrade, Tasks, Help, Settings gear, Intuit account), and a left rail (Create, Bookmarks, Home, Reports, Accounting, Expenses, Sales, More apps, Customize).
- In an empty company most list pages show a marketing/empty-state panel, not a table. Column headers only exist on the "new" forms and on Chart of accounts.
- Redirect/gate behaviour seen: `/app/purchaseorder` -> `/app/obillupgrade` (upgrade gate), `/app/bill-payments` -> `/app/limitexceeded?referrer=bill-payments`, `/app/customreports` -> `/app/limitexceeded?referrer=customreports`, Business Feed -> `/app/limitexceeded?referrer=business-feed`.
- Some pages show a "Cookies and Tracking Technologies" consent overlay (not dismissed; it did not block reads).
- Leaving an unsaved "new" form can raise a `beforeunload` prompt. Accepting it just leaves the page, nothing is saved.
- A draft invoice exists in the company ("You have a draft saved. Restore draft" on /app/invoice). Not restored, not touched.
- Next doc numbers in an empty company: Invoice 1001, Estimate 1001, Sales Receipt 1001, Check #1, Journal Entry #1.
- The Customer/Estimate/Invoice forms show the company contact email and phone in the header. Redacted here.

---

## 0. Home / left nav / top bar

### Home
- URL: `/app/homepage`
- Title: "QuickBooks". Heading "Good evening!" (time-of-day greeting).
- Sections: "Quick links" carousel (Accounting -> /app/banking?jobId=accounting, Expenses & Pay Bills -> /app/expense-overview?jobId=expenses, Sales & Get Paid -> /app/incomeoverview?jobId=sales-payments, Customer Hub -> /app/customers-overview?jobId=customers, Business Tax -> /app/business-tax/overview?jobId=business-tax, Lending -> /app/capital/lendingoverview?jobId=lending, Projects -> /app/projects-discovery?jobId=projects).
- "Create actions" pills: Get paid online, Create invoice, Record expense, Add bank deposit, Create check, Show all.
- "Business at a glance": Sales & Get Paid funnel (Not Paid / Paid / Deposited), Bank accounts (Link your banks; "Find your bank" button), Profit & Loss tile (links to report area), Expenses tile.
- Footer: "See all activity" -> `/app/auditlog`; Privacy -> `/app/privacy`; Security (external); Terms -> `/app/tos?footer=true`.
- Promo: a "Take payments online to get paid faster" panel (with Close button) was present in the first tab on initial load. In a fresh tab it did not appear. No promo blocked clicks.
- Top bar buttons: Upgrade (do not click), Tasks, Help, Settings (gear), Intuit account, "Open Intuit Intelligence chat".

### Left nav
- QuickBooks logo -> `/app/homepage?...`
- **Create** (button, opens flyout, see section 1)
- **Bookmarks** (button, flyout): "Add a bookmark to get started." + "Bookmark current page" button. No page.
- **Home** -> `/app/homepage`
- **Reports** (button) -> navigates to `/app/standardreports`
- **Accounting** (button) -> navigates to `/app/banking`
- **Expenses** (button) -> navigates to `/app/expense-overview`
- **Sales** (button) -> navigates to `/app/incomeoverview`
- **More apps** (button, flyout): Customer Hub -> `/app/customers-overview?jobId=customers`; Business Tax -> `/app/business-tax/overview?jobId=business-tax`; Lending -> `/app/capital/lendingoverview?jobId=lending`; Projects -> `/app/projects-discovery?jobId=projects`; App store -> `/app/discovery-center-ui/discoverycenter`.
- **Customize** (button at bottom).
- Feed: there is no Feed item in the left nav. See "Feed" below.

### Global search box (top bar)
- Searchbox name "Search". Placeholder "Navigate. Find transactions, contacts, help, reports, and more."
- Typing shows a suggestion dropdown with two parts:
  1. Search-string suggestions (buttons named "NER Search Strings, <term>", e.g. "customer aging", "aging detail report", "accounts payable aging", "aging summary report"). Clicking these only fills the box. Still on the same page.
  2. A "Reports" section with items named "Reports, Standard, <Report name>" (e.g. "Standard | A/R Aging Summary") and a "Jump To" section (e.g. "Compare and Upgrade Quickbooks Bill Pay Plans", "Employees", "Business Feed - Sales", "Business Feed - Payroll"). Clicking a Reports item opens that report (see section 12).
- Pressing Enter (without picking a suggestion) opens `/app/fullSearch/transactions?origin=prominent&instanceId=<uuid>&text=<term>`, titled "Advanced transactions search". It shows "Search results for "<term>"", a "Go to all transactions" link, filters (Date range, Transaction type, Reference number, Contact, Amount, Filters, Customize), a results table (NEW, DATE, TYPE, REF NO., CONTACT, DUE DATE, BALANCE, TOTAL AMOUNT, MEMO, LAST MODIFIED DATE, STATUS) and a "No results found" empty state. Also "Jump to" links for Bank transactions, Create invoice, Create bank deposit, Create expense.
- Example: term "aging" -> dropdown showed 2 suggestion strings and the A/R Aging Summary report item. Term "accounts payable aging" showed no A/P Aging report item. Term "general ledger" showed no General Ledger report item.
- Typing in the box does not change the URL; Enter does.

### Settings (gear, top bar)
- Dropdown (dialog) groups and links:
  - YOUR COMPANY: Account and settings -> `/app/accountsettings`; Manage users -> `/app/usermgt`; Custom form styles -> `/app/formstyles`; Chart of accounts -> `/app/chartofaccounts`; Payroll settings -> `/app/payroll-signup?usecase=gearmenu`; Workers' comp -> `/app/workersComp?referrer=qboSettings`; Get the desktop app -> `/app/tangodownload`; Get the mobile app -> external quickbooks.intuit.com/accounting/mobile/.
  - Additional info (button) LISTS: All lists -> `/app/lists`; Products and services -> `/app/items`; Attachments -> `/app/attachments`; Custom fields -> `/app/customfields`; Rules -> `/app/olbrules`.
  - TOOLS: Reclassify transactions -> `/app/reclassify-transaction`; Order checks -> external intuitmarket.com/GLOBALSET; Import data -> `/app/import-export-ui/importdata`; Import desktop data -> `/app/importquickbooksdesktop`; Export data -> `/app/exportdata`; Reconcile -> `/app/reconcile`; Budgeting -> `/app/obillupgrade` (upgrade gate); Audit log -> `/app/auditlog`; Share screen (button); Resolution center -> `/app/cases`.
  - PROFILE: Subscriptions and billing -> `/app/billing`; What's new -> external learn-more/whatsnew; Discover more (NEW) -> `/app/discovery-center-ui/discoverycenter`; Feedback (button); Privacy -> `/app/privacy`; Your Privacy Choices (button); Video tutorials.

### Account and settings
- Entry `/app/accountsettings` redirects to `/app/accountsettings?p=company`.
- Title "QuickBooks". Heading "Settings".
- Tabs (buttons, not role=tab): Company, Usage, Payments, Lending, QuickBooks Checking, Accounting, Sales, Expenses, Wallet, Advanced. Also a "Give feedback" button.
- Company tab: "Company info" section (note "This info may be connected to the Business Network or used for billing purposes."), first field "Name". Each section has an "Edit" button (about 12 Edit buttons). Field values not recorded.
- Guessed route `/app/settings?p=Company`: NOT a redirect. Stays at `/app/settings?p=Company`, renders the same Settings shell (tabs above), and content loads with the "Loading" state.

---

## 1. Create menu (left nav "Create")

Flyout is a dialog with 3 columns. Every item's URL below (from the link hrefs):

Customers column
| Item | URL |
|---|---|
| Invoice | `/app/invoice` |
| Payment links | `/app/paymentrequests?new` |
| Receive payment | `/app/recvpayment` |
| Statement | `/app/statements` |
| Estimate | `/app/estimate` |
| Sales receipt | `/app/salesreceipt` |
| Add customer | `/app/customers?add=true` (opens a side panel, see section 3) |

Vendors column
| Item | URL |
|---|---|
| Expense | `/app/expense` |
| Check | `/app/check` |
| Bill | `/app/bill` |
| Pay bills | `/app/paybills` |
| Purchase order | `/app/purchaseorder` (redirects to `/app/obillupgrade`, upgrade gate, see section 8) |
| Vendor credit | `/app/vendorcredit` |
| Credit card credit | `/app/creditcardcredit` |
| Print checks | `/app/printchecks` |
| Add vendor | `/app/vendors?add=true` (opens a side panel) |

Team column
| Item | URL |
|---|---|
| Payroll | `/app/payroll-signup` |
| Single time activity | `/app/timeactivity?t=s` |
| Weekly timesheet | `/app/timetracking` |
| Add contractor | `/app/contractors?showAddModal=true` |

Other column
| Item | URL |
|---|---|
| Task | (button, no URL) |
| Bank deposit | `/app/deposit` |
| Journal entry | `/app/journal` |
| Add product/service | `/app/items?add=true` (redirects to `/app/items?itemId=new`, side panel) |

- **Credit memo is NOT in the Create menu.** `/app/creditmemo`, `/app/creditmemos`, `/app/credit-memo`, `/app/credit`, `/app/creditnote` all return "We're sorry, we can't find the page you requested." How to reach it in this UI is still unknown (likely from a transaction list's New transaction menu, which is not shown for an empty company).

---

## 2. Customers / Customer Hub

### Customer Hub overview
- URL `/app/customers-overview?jobId=customers`. Title "Overview - Customer Hub". Heading "Customer Hub overview", section "Overview".
- Left sub-nav "CUSTOMER HUB": Overview (`/app/customers-overview?jobId=customers`), Customers (`/app/customers?jobId=customers`), Estimates (`/app/estimates?jobId=customers`).
- Content: CUSTOMERS FUNNEL (Open opportunities, Open estimates, Open contracts, In progress projects, Unpaid invoices, Reviews; "Last 365 days"), "OVERDUE INVOICES" card ("Create an invoice" button), "OPEN ESTIMATES" card ("Create an estimate" button), "NEEDS ATTENTION" table (Task, Assigned To, Due Date, Actions), "SHORTCUTS".
- Buttons: Create an invoice, Create an estimate, Feedback.

### Customers list
- URL `/app/customers` (also `/app/customers?jobId=customers`). Title "Customers". Heading "CUSTOMER HUB".
- Empty-state marketing page: "Centralize customer info & tasks", "See how it works" video, "Import customers", "Add customer manually" buttons, TIPS & RESOURCES links.
- No tabs or column headers when empty. Populated-table columns not observed (no customers in company).

### Customer detail
- NOT reachable: no customers exist, so no detail page was opened. Detail URL pattern not captured. Needs a populated company.

### Add customer (side panel, from "Add customer manually" or `/app/customers?add=true`)
- Opened via the button, closed without saving (tab closed).
- Sections: Customer > Name and contact.
- Field labels: Title, First name, Middle name, Last name, Suffix, Company name, Customer display name * (combobox), Email, Phone number, Cc, Bcc, Mobile number, Fax, Other, Website, Name to print on checks, Is a sub-customer (checkbox), Street address 1, Street address 2, City, State, ZIP code, Country, "Same as billing address" (checkbox, checked), Notes, Select a primary payment method (combobox), Sales form delivery options, Language to use when you send invoices, Exemption details, Opening balance, As of (date), Sources, Referred by, Job title, Role, Preferred contact method, Industry.
- Buttons: Close, Save (do not click).

---

## 3. Sales & Get Paid hub (Sales left-nav button -> `/app/incomeoverview`)

### Sales hub overview
- URL `/app/incomeoverview?jobId=sales-payments`. Title "Overview - Sales & Get Paid". Heading "SALES & GET PAID".
- Sub-nav: Overview (`/app/incomeoverview?jobId=sales-payments`), Sales transactions (`/app/sales?jobId=sales-payments`), Invoices (`/app/invoices?jobId=sales-payments`), QuickBooks payouts (`/app/paymentsdeposits?jobId=sales-payments`), Products & services (`/app/items?jobId=sales-payments`), Payment links (`/app/paymentrequests?jobId=sales-payments`).

### Sales transactions
- URL `/app/sales?jobId=sales-payments`. Title "Sales transactions - Sales & Get Paid".
- Empty state: "Create and send invoices—then get paid", "Create an invoice" button. No tabs/columns when empty. Only button: "Create an invoice". No links to Credit memo or Sales receipt.

### Invoices list
- URL `/app/invoices?jobId=sales-payments`. Title "Invoices - Sales & Get Paid".
- Empty state: "Streamline invoicing with QuickBooks Payments", buttons "Create invoice", "Compare rates". Tips: "Record a customer payment", "Create and send invoices".

### Invoice (new)
- URL `/app/invoice` (no query). Title "Invoice". Heading "Invoice 1001" / "INVOICE". Tabs: Edit, Email view, Payor view, PDF view.
- Field labels: Customer (combobox), Invoice number (default 1001), Select term (combobox, default "Net 30"), Invoice date, Due date, Product or service line 1 (combobox), Description line 1, Quantity line 1, Rate line 1, Amount line 1, Tell your customer how you want to get paid (textbox), Note to customer, Memo on statement (hidden).
- Table columns: #, Product/service, Description, Qty, Rate, Amount.
- Buttons: Edit company, Add product or service, Clear all lines, Activate payments, Add attachment, Show existing, + Charge a deposit, Edit totals, Manage, Print or download, Save, Review and send. Do not click Save or Review and send.
- A draft exists: "You have a draft saved. Restore draft" banner. Not clicked.

### Estimate (new)
- URL `/app/estimate`. Title "Estimate". Heading "Estimate 1001" / "ESTIMATE". Tabs: Edit, Email view, Payor view, PDF view.
- Field labels: Customer (combobox), Estimate number (1001), Estimate date, Expiration date, Accepted by, Accepted date, Product or service line 1 (combobox), Description line 1, Quantity line 1, Rate line 1, Amount line 1, Note to customer, Memo on statement (hidden), Deposit request (defaults 0%).
- Table columns: #, Product/service, Description, Qty, Rate, Amount.
- Buttons: Turn on e-signatures, Edit company, Add product or service, Clear all lines, Activate payments, Add attachment, Show existing, %, $, Edit totals, Manage, Print or download, Save, Review and send, Go to estimate.
- The estimate list `/app/estimates` (in Customer Hub): title "Estimates - Customer Hub", empty state "Request approvals and more with estimates", button "Create an estimate". No table when empty.

### Sales receipt (new)
- URL `/app/salesreceipt`. Title "Sales Receipt". Heading "Sales Receipt # 1001".
- Radio/mode: "Record payment (Received via check, cash, other)" [selected] vs "Charge new payment (Process a card or ACH bank transfer)".
- Field labels: Customer (combobox), Email, Send later (checkbox), Sales Receipt no. (1001), Sales Receipt Date, Payment method (combobox "Select method"), Reference no., Deposit To (combobox, default "Cash"), Bill to (textbox, Addresses section), Product or service line 1/2 (combobox), Description line 1/2, Quantity line 1/2, Rate line 1/2, Amount line 1/2, Message displayed on sales receipt, Message displayed on statement.
- Table columns: #, PRODUCT/SERVICE, DESCRIPTION, QTY, RATE, AMOUNT.
- Buttons: Feedback, Add lines, Clear all lines, Add sales tax, Add attachment, Show existing, Cancel, Print or Preview, Customize, Record, Record and close, Next. Do not click Record.
- Sales receipts LIST: `/app/salesreceipts` is NOT valid ("We're sorry, we can't find the page you requested."). List not found by guessing.

### Receive payment (new)
- URL `/app/recvpayment`. Title "Receive Payment". Heading "Receive Payment".
- Mode radios: Record payment (Received via check, cash, other) [selected] vs Charge new payment (Process a card or ACH bank transfer).
- Field labels: Customer (combobox), Find by invoice no. (button/field), AMOUNT RECEIVED ($0.00), Customer balance, Payment Date, Payment method (combobox), Reference no., Deposit To / Choose an account (combobox, default Cash), Amount (received, per row), Memo, Attachments (Add attachment).
- Buttons: Feedback, Cancel, Print, Record, Record and close. Do not click Record.

### Credit memo
- Not found. Create menu has no entry. `/app/creditmemo` and variants 404. Still unknown how to open a new credit memo UI in this company.

### QuickBooks payouts (`/app/paymentsdeposits?jobId=sales-payments`)
- Title "QuickBooks payouts - Sales & Get Paid". Empty state: "Get those payouts flowing", "Get started" button.

### Payment links (`/app/paymentrequests?jobId=sales-payments`)
- Title "Payment links - Sales & Get Paid". Empty list (no table). Create entry is `/app/paymentrequests?new` (from Create menu).

### Products & services (`/app/items`)
- URL `/app/items` (also `/app/items?jobId=sales-payments`). Title "Products & services - Sales & Get Paid". Heading "Get started with products and services". Buttons: Create items, Import items. Empty state. Sub-nav same as Sales hub.
- Redirect check: `/app/items?add=true` -> `/app/items?itemId=new`. Opens a side panel "Add a new service" (Basic info, Add an image, Sales, Purchasing tabs). Buttons: Save and new, Save and close, Cancel (do not click).
- Field labels on new item panel: Name* (textbox), Item type (combobox, default "Service"), SKU, Category selection dropdown, Sales description, Price/rate, Income account* (combobox, default "Services"), "I purchase this service from a supplier" (checkbox).

---

## 4. Expenses & Pay Bills hub (Expenses left-nav button -> `/app/expense-overview`)

### Expenses hub overview
- URL `/app/expense-overview?jobId=expenses`. Title "Overview - Expenses & Pay Bills". Heading "Expenses & Pay Bills overview".
- Sub-nav: Overview (`/app/expense-overview?jobId=expenses`), Expense transactions (`/app/expenses?jobId=expenses`), Vendors (`/app/vendors?jobId=expenses`), Bills (`/app/bills?jobId=expenses`), Mileage (`/app/mileage?jobId=expenses`), Contractors (`/app/contractors?jobId=expenses`), 1099s (`/app/1099FilingDetails?jobId=expenses`), Bill payments (`/app/bill-payments?jobId=expenses`).

### Expense transactions (list)
- URL `/app/expenses?jobId=expenses`. Title "Expenses". Heading "Expenses". Buttons: Give feedback, Purchase notifications, Print Checks, New transaction, Filter, Dates "Last 12 months". Includes checks and expenses (no separate checks list).
- Empty state: "Have a clear view of income and expenses", QuickBooks Payments promo.

### Expense (new)
- URL `/app/expense`. Title "Expense". Heading empty (no number). Field labels: Payee (combobox), Payment account (combobox, default "Cash"), Balance ($0.00), AMOUNT ($0.00), Payment Date, Payment Method (combobox), Ref no., Memo.
- Table columns: #, CATEGORY, DESCRIPTION, AMOUNT.
- Buttons: Autofill this expense, Give feedback, Add lines, Clear all lines, Add attachment, Show existing, Cancel, Make recurring, Save, Save and close. Do not click Save.

### Check (new)
- URL `/app/check`. Title "Check". Heading "Check #1".
- Field labels: Payee (combobox), Bank Account (combobox, default "Cash"), Balance ($0.00), AMOUNT ($0.00), Mailing address, Payment date, Check no. (default 1), Print later (checkbox), Memo.
- Table columns: #, CATEGORY, DESCRIPTION, AMOUNT.
- Buttons: Give feedback, Add lines, Clear all lines, Add attachment, Show existing, Cancel, Print check, Order checks, Make recurring, More, Save, Save and close. Do not click Save.
- Checks LIST: `/app/checks` is NOT valid (404). Check transactions show in Expense transactions (`/app/expenses`).

### Print checks
- `/app/printchecks` is linked from Create menu ("Print checks"). Not opened.

### Vendors (`/app/vendors`)
- Title "Vendors". Heading "EXPENSES & BILLS". Empty state: "One place to track, manage, and pay vendors", "See how it works" video, Import Vendors and Add Vendor buttons.

### Vendor (new, side panel from "Add Vendor" button or `/app/vendors?add=true`)
- Field labels: Company name, Vendor display name (required, combobox), Title, First name, Middle name, Last name, Suffix, Email, Phone number, Cc, Bcc, Mobile number, Fax, Other, Website, Name to print on checks, Street address 1, Street address 2, City, State, ZIP code, Country, Notes, Bank account number, Routing number, Business ID Number / Social Security Number (sensitive, do not fill), Account number, Choose account (combobox). Plus a Select an element combobox. Close button.
- Not saved.

### Bills (list) `/app/bills`
- Title "Bills". Heading "Bills". Tabs: For review, Unpaid, Paid. Buttons: Give feedback, Pay bills, Add bill. Empty state: "How to manage bills".

### Bill (new)
- URL `/app/bill`. Title "Bill". Heading "Bill".
- Field labels: Vendor (combobox), Mailing address, Terms (combobox), Bill date, Due date, Bill no., Memo.
- Table columns: #, CATEGORY, DESCRIPTION, AMOUNT.
- Buttons: Give feedback, Add lines, Clear all lines, Add attachment, Show existing, Cancel, Print, Make recurring, Save bill, Save and schedule payment. Do not click Save.

### Pay bills (`/app/paybills`)
- Title "Bills - Expenses & Pay Bills". Heading "Pay Bills". Title strip: "Pay Bills", Give feedback, Filters.
- Fields: Payment account (combobox), Balance ($0.00), Payment date (textbox + Calendar button), Starting check no. (textbox), Print later (checkbox). Table of bills to pay is empty when no bills.
- Bill payments list `/app/bill-payments` -> `/app/limitexceeded?referrer=bill-payments` (upgrade gate, "Pay bills right from QuickBooks").

### Purchase orders
- `/app/purchaseorder` redirects to `/app/obillupgrade` (title "Purchase Order", body: "Upgrade" and "Cancel" only). Gated.
- `/app/purchaseorders` is "We're sorry, we can't find the page you requested" (404). No list page found.

### Mileage, Contractors, 1099s
- Sub-nav links exist: `/app/mileage`, `/app/contractors`, `/app/1099FilingDetails`. Not opened in detail.

### Vendor credit / Credit card credit
- Create menu links `/app/vendorcredit` and `/app/creditcardcredit`. Not opened.

---

## 5. Accounting hub (Accounting left-nav button -> `/app/banking`)

### Bank transactions
- URL `/app/banking?jobId=accounting`. Title "Bank transactions". Heading area "ACCOUNTING".
- Sub-nav (left): Bank transactions (`/app/banking?jobId=accounting`), Integration transactions (`/app/apptransactions?jobId=accounting`), Receipts (`/app/receipts?jobId=accounting`), Reconcile (`/app/reconcile?jobId=accounting`), Chart of accounts (`/app/chartofaccounts?jobId=accounting`), Rules (`/app/olbrules?jobId=accounting`), My accountant (`/app/my-accountant?jobId=accounting`).
- Buttons: Connect account, Upload transactions, Manage connections. Empty state: "Connect a bank or credit card to get started", "Automate income and expense tracking" (do NOT click Connect account).
- Bank accounts on home show Home Depot Consumer Credit Card (Citi), Citi, Chase as "link your bank" options (not connected).

### Chart of accounts
- URL `/app/chartofaccounts`. Title "Chart of accounts - Accounting". Heading "Chart of accounts". Breadcrumb "Accounting / Chart of accounts".
- Buttons: Feedback, Run report, New account, Edit mode. Filter textbox "Filter by name or number". Combobox "Filter by limit" (All). Pagination Previous/Next.
- Table columns: (checkbox), Name, Account type, Detail type, QuickBooks balance, Bank balance, Action (View register / View).
- Default accounts present (76 rows including header), e.g. Cash (Bank, Cash on hand), Accounts receivable (A/R), Allowance for bad debts, ...
- "New account" side panel was clicked but its fields were not captured.

---

## 6. Journal entry
- URL `/app/journal`. Title "Journal Entry". Heading "Journal Entry #1". Tabs/links: Feedback. 
- Field labels: Journal date (active), Journal no. (default 1), Memo.
- Table columns: #, ACCOUNT, DEBITS, CREDITS, DESCRIPTION, NAME (5 lines by default).
- Buttons: Feedback, Add lines, Clear all lines, Add attachment, Show existing, Cancel, Make recurring, Save, Save and new. Do not click Save.
- Bank deposit: `/app/deposit` (title "Bank Deposit", heading "Bank Deposit"). Fields: Account (combobox, default Cash), Date, Memo, Cash back account (combobox), Cash back memo, Cash back amount. Columns: #, RECEIVED FROM, ACCOUNT, DESCRIPTION, ... Buttons: Add funds to this deposit, Add lines, Clear all lines, Cancel, Print, Make recurring, Save and new (do not click).

---

## 7. Products / services and Lists
- See section 3 (Products & services). Settings lists: `/app/lists` (All lists), `/app/items` (Products and services). Not opened separately.

---

## 8. Gated / upgrade pages (do not click Upgrade)
- `/app/purchaseorder` -> `/app/obillupgrade` (upgrade gate).
- `/app/budgeting` (gear "Budgeting") -> `/app/obillupgrade`.
- `/app/bill-payments` -> `/app/limitexceeded?referrer=bill-payments`.
- `/app/customreports` -> `/app/limitexceeded?referrer=customreports`.
- Business Feed (search "Business Feed - Sales") -> `/app/limitexceeded?referrer=business-feed` ("Intuit Intelligence isn't included on your free plan").

---

## 9. Feed
- There is no `/app/feed` (404) and no `/app/bookmarks` (404). Left nav has no Feed item. "Business Feed - Sales / Accounting / Payroll" appear as Jump-to targets in global search and go to limitexceeded (gated). So "Feed" = gated Business Feed, reachable only through search.

---

## 10. Bookmarks
- Left nav "Bookmarks" is a flyout only (no URL). Shows "Add a bookmark to get started." and a "Bookmark current page" button. The sub-nav "Add bookmark <Name>" buttons (e.g. Add bookmark Overview, Vendors, Bills) add the current hub page as a bookmark. Not clicked.

---

## 11. Reports
### Reports list
- URL `/app/standardreports`. Title "Standard reports - Reports". Heading "REPORTS & ANALYTICS".
- Tabs (links): Standard reports (`/app/standardreports`), Custom reports (`/app/customreports`, gated).
- Standard Reports list shows only 3 items in this empty company: Profit and Loss, Balance Sheet, Account List.
- A/R Aging, A/P Aging and General Ledger are NOT on this list. See 11.5 for how they are reached.

### 11.1 Profit and Loss
- URL `/app/report/builder?rptId=sbg%3Ac46c823a-8641-4641-b08a-dda0e499066f&type=system&token=PANDL&previousRoute=standardreports&previousRouteText=Back+to+Standard+Reports`
- Title "Profit and Loss". Heading "No company name" / "January 1-October 15, 2026" (period default: this year to date).
- Header controls: Report period (From, To), Accounting method (Cash | Accrual toggle), Display columns by, Compare to, Customize, Save As, Compact | 100%, Add note. Also "Back to Standard Reports" link, Give feedback.
- Body: "Profit and Loss report is ready", "Your selection doesn't have any info." (empty company). Cash basis.

### 11.2 Balance Sheet
- URL `/app/report/builder?rptId=sbg%3Acbe6fa12-96f4-46ad-9d6e-b13349076ee9&type=system&token=BAL_SHEET&previousRoute=standardreports`
- Title "Balance Sheet". Heading "As of October 15, 2026". Same toolbar (Report period, Accounting method, Display columns by, Compare to, Customize, Save As, Compact | 100%, Add note). Empty.

### 11.3 Account List
- URL `/app/report/builder?rptId=sbg%3Ae3088e53-831a-482a-a340-da2c88a89659&type=system&token=ACCT_LIST&previousRoute=standardreports&previousRouteText=Back+to+Standard+Reports` (from the list href; not opened in detail).

### 11.4 Guessed report route
- `/app/reportv2?token=PROFIT_AND_LOSS`: does NOT redirect. Renders a blank shell with title "No company name - QuickBooks Online" and no report content.
- `/app/reportv2?token=AgedReceivables`, `?token=AgedPayables`, `?token=GeneralLedger`: same blank shell. Do not work.
- `/app/report/builder?type=temp&token=AP_AGING` and `...token=GENERAL_LEDGER` (no rptId): "We couldn't load your report" / "Go back". Do not work without an rptId.

### 11.5 A/R Aging Summary (via global search)
- Path: type "aging" in the global search box, wait for the dropdown, click the Reports item "Standard | A/R Aging Summary".
- URL `/app/report/builder?rptId=a4f9045f-d1b2-445e-bd9e-f0e808725fe1&type=temp&token=AR_AGING`
  - Note: rptId is a per-search temp report id (`type=temp`). The reliable part is `token=AR_AGING`. Build the URL by searching, not by hardcoding rptId.
- Title "A/R Aging Summary Report". Heading "As of October 15, 2026". Controls: Report period "as of", Customize, Save As, Compact | 100%. Body: "A/R Aging Summary Report is ready", "Your selection doesn't have any info." (empty).

### 11.6 A/P Aging — NOT FOUND
- Global search for "accounts payable aging", "A/P aging", "payables": no "Standard" Reports item appears, only search strings and "Accounts payable reports" (a search string). Clicking "accounts payable aging" suggestion only fills the box. Enter opens search results with no A/P report.
- Direct `token=AP_AGING` without rptId: "We couldn't load your report".
- Status: not reached. Needs a different route (not found in this company).

### 11.7 General Ledger — NOT FOUND
- Global search for "general ledger" shows only search strings ("general ledger report", "general ledger", "print general ledger"), no Reports item.
- Direct `token=GENERAL_LEDGER` without rptId: "We couldn't load your report".
- Status: not reached.

---

## 12. Settings-related guessed routes and others
- `/app/settings?p=Company`: loads the Settings shell (see section 0). Not a redirect.
- `/app/accountsettings` -> `/app/accountsettings?p=company` (redirect with query added).

---

## 13. Guessed routes: results

| Route | Result |
|---|---|
| `/app/invoice` | Works. New Invoice form (Invoice 1001). |
| `/app/estimate` | Works. New Estimate form (Estimate 1001). |
| `/app/salesreceipt` | Works. New Sales Receipt form (# 1001). |
| `/app/recvpayment` | Works. Receive Payment form. |
| `/app/bill` | Works. New Bill form. |
| `/app/expense` | Works. New Expense form. |
| `/app/check` | Works. New Check form (Check #1). |
| `/app/journal` | Works. Journal Entry form (#1). |
| `/app/items` | Works. Products & services list (empty state). |
| `/app/chartofaccounts` | Works. Chart of accounts table. |
| `/app/banking` | Works. Bank transactions page (no bank connected). |
| `/app/vendors` | Works. Vendors page (empty state). |
| `/app/reportv2?token=PROFIT_AND_LOSS` | Does NOT work. Blank shell, no redirect. Use `/app/report/builder?...&token=PANDL` (section 11.1). |
| `/app/settings?p=Company` | Loads Settings shell at same URL. Not a redirect. |

Other notable redirects/404s:
- `/app/salesreceipts` (list): 404 "We're sorry, we can't find the page you requested."
- `/app/checks` (list): 404.
- `/app/purchaseorders` (list): 404.
- `/app/creditmemo`, `/app/creditmemos`, `/app/credit-memo`, `/app/credit`, `/app/creditnote`: 404.
- `/app/feed`, `/app/bookmarks`: 404.
- `/app/purchaseorder` -> `/app/obillupgrade` (gate).
- `/app/bill-payments` -> `/app/limitexceeded?referrer=bill-payments` (gate).

---

## 14. Summary: path to automate common tasks (what works in this empty company)

- New invoice: `https://qbo.intuit.com/app/invoice` (form works; fields in section 3).
- New estimate: `/app/estimate`; new sales receipt: `/app/salesreceipt`; receive payment: `/app/recvpayment`.
- New bill: `/app/bill`; pay bills: `/app/paybills`; new expense: `/app/expense`; new check: `/app/check`.
- Journal entry: `/app/journal`; bank deposit: `/app/deposit`.
- Add customer / vendor / product: side panels from `/app/customers?add=true`, `/app/vendors?add=true`, `/app/items?add=true` (-> `/app/items?itemId=new`).
- Lists: `/app/customers` (Customer Hub), `/app/vendors`, `/app/items`, `/app/chartofaccounts`, `/app/banking`, `/app/bills`, `/app/expenses`, `/app/invoices`, `/app/estimates`.
- Reports: `/app/standardreports` (list). P&L `/app/report/builder?...&token=PANDL`, BS `...&token=BAL_SHEET`, A/R aging `...&token=AR_AGING` (reached via search). A/P aging and General Ledger: not reached.
- Gated: purchase orders, bill payments, custom reports, Business Feed, budgeting.
- Not reached (needs data): customer detail, credit memo, sales receipt list.
