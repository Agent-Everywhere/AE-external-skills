// Verified QuickBooks Online routes (from references/qbo-ui-map.md, captured 2026-10-15 on a signed-in
// empty company). Paths are relative to BASE. Only add a route here after seeing it load in a real session.
export const BASE = "https://qbo.intuit.com";

const RPT_BACK = "&previousRoute=standardreports&previousRouteText=Back+to+Standard+Reports";

/** Read-only list pages: name -> { path, title (document.title prefix seen), empty (empty-state text) } */
export const LISTS = {
  customers: { path: "/app/customers?jobId=customers", title: "Customers", empty: ["Centralize customer info", "Add customer manually"] },
  vendors: { path: "/app/vendors?jobId=expenses", title: "Vendors", empty: ["One place to track, manage, and pay vendors", "Add Vendor"] },
  items: { path: "/app/items?jobId=sales-payments", title: "Products & services", empty: ["Get started with products and services"] },
  invoices: { path: "/app/invoices?jobId=sales-payments", title: "Invoices", empty: ["Streamline invoicing"] },
  estimates: { path: "/app/estimates?jobId=customers", title: "Estimates", empty: ["Request approvals and more with estimates"] },
  sales: { path: "/app/sales?jobId=sales-payments", title: "Sales transactions", empty: ["Create and send invoices"] },
  bills: { path: "/app/bills?jobId=expenses", title: "Bills", empty: ["How to manage bills"] },
  expenses: { path: "/app/expenses?jobId=expenses", title: "Expenses", empty: ["Have a clear view of income and expenses"] },
  accounts: { path: "/app/chartofaccounts?jobId=accounting", title: "Chart of accounts", empty: [] },
  banking: { path: "/app/banking?jobId=accounting", title: "Bank transactions", empty: ["Connect a bank or credit card to get started"] },
  "payment-links": { path: "/app/paymentrequests?jobId=sales-payments", title: "Payment links", empty: [] },
  payouts: { path: "/app/paymentsdeposits?jobId=sales-payments", title: "QuickBooks payouts", empty: ["Get those payouts flowing"] },
  rules: { path: "/app/olbrules?jobId=accounting", title: "Rules", empty: [] },
  auditlog: { path: "/app/auditlog", title: "Audit", empty: [] },
};

/** Standard reports. rptId values are the system report ids seen in the Standard reports list. */
export const REPORTS = {
  pandl: { token: "PANDL", path: `/app/report/builder?rptId=sbg%3Ac46c823a-8641-4641-b08a-dda0e499066f&type=system&token=PANDL${RPT_BACK}`, title: "Profit and Loss" },
  "balance-sheet": { token: "BAL_SHEET", path: `/app/report/builder?rptId=sbg%3Acbe6fa12-96f4-46ad-9d6e-b13349076ee9&type=system&token=BAL_SHEET${RPT_BACK}`, title: "Balance Sheet" },
  "account-list": { token: "ACCT_LIST", path: `/app/report/builder?rptId=sbg%3Ae3088e53-831a-482a-a340-da2c88a89659&type=system&token=ACCT_LIST${RPT_BACK}`, title: "Account List" },
  // No fixed URL: QBO mints a temp rptId per search. Reached through the global search box.
  "ar-aging": { token: "AR_AGING", search: "aging", pick: "A/R Aging Summary", title: "A/R Aging Summary" },
};

/** "New" forms (write paths). */
export const FORMS = {
  invoice: "/app/invoice",
  estimate: "/app/estimate",
  salesreceipt: "/app/salesreceipt",
  recvpayment: "/app/recvpayment",
  bill: "/app/bill",
  paybills: "/app/paybills",
  expense: "/app/expense",
  check: "/app/check",
  journal: "/app/journal",
  deposit: "/app/deposit",
  customer: "/app/customers?add=true",
  vendor: "/app/vendors?add=true",
  item: "/app/items?itemId=new",
};

/** Other navigable pages for `qbo open`. */
export const PAGES = {
  home: "/app/homepage",
  reports: "/app/standardreports",
  settings: "/app/accountsettings?p=company",
  "customer-hub": "/app/customers-overview?jobId=customers",
  "sales-hub": "/app/incomeoverview?jobId=sales-payments",
  "expenses-hub": "/app/expense-overview?jobId=expenses",
  reconcile: "/app/reconcile?jobId=accounting",
  lists: "/app/lists",
  users: "/app/usermgt",
  billing: "/app/billing",
};

/** Pages that redirect to an upgrade or limit gate on lower plans. */
export const GATED = {
  "purchase-orders": { path: "/app/purchaseorder", gate: "/app/obillupgrade" },
  "bill-payments": { path: "/app/bill-payments", gate: "/app/limitexceeded" },
  "custom-reports": { path: "/app/customreports", gate: "/app/limitexceeded" },
  budgeting: { path: "/app/budgeting", gate: "/app/obillupgrade" },
};

export function searchPath(text) {
  return `/app/fullSearch/transactions?origin=prominent&text=${encodeURIComponent(text)}`;
}

export function resolveOpen(name) {
  const n = String(name || "").toLowerCase();
  if (LISTS[n]) return LISTS[n].path;
  if (REPORTS[n]?.path) return REPORTS[n].path;
  if (FORMS[n]) return FORMS[n];
  if (PAGES[n]) return PAGES[n];
  if (GATED[n]) return GATED[n].path;
  if (n.startsWith("/app/")) return n;
  return null;
}

export function allRouteNames() {
  return { lists: Object.keys(LISTS), reports: Object.keys(REPORTS), forms: Object.keys(FORMS), pages: Object.keys(PAGES), gated: Object.keys(GATED) };
}

/** Classify a URL the browser ended up on. */
export function classifyUrl(url) {
  const u = String(url || "");
  if (/accounts\.intuit\.com|\/app\/sign-?in|iux_redirect_reason/.test(u)) return "signed_out";
  if (/\/app\/companyselection|\/app\/selectcompany/i.test(u)) return "company_select";
  if (/\/app\/obillupgrade|\/app\/limitexceeded/.test(u)) return "gated";
  if (/qbo\.intuit\.com\/app\//.test(u)) return "app";
  return "other";
}
