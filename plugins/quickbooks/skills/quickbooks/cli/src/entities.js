// CLI entity names -> QBO v3 entity, default columns, and what deleting means for it.
export const ENTITIES = {
  customers: { entity: "Customer", cols: ["Id", "DisplayName", "PrimaryEmailAddr.Address", "Balance", "Active"], remove: "inactivate" },
  vendors: { entity: "Vendor", cols: ["Id", "DisplayName", "PrimaryEmailAddr.Address", "Balance", "Active"], remove: "inactivate" },
  items: { entity: "Item", cols: ["Id", "Name", "Type", "UnitPrice", "IncomeAccountRef.name", "Active"], remove: "inactivate" },
  accounts: { entity: "Account", cols: ["Id", "Name", "AccountType", "AccountSubType", "CurrentBalance", "Active"], remove: "inactivate" },
  invoices: { entity: "Invoice", cols: ["Id", "DocNumber", "TxnDate", "CustomerRef.name", "TotalAmt", "Balance", "DueDate"], remove: "delete", void: true },
  estimates: { entity: "Estimate", cols: ["Id", "DocNumber", "TxnDate", "CustomerRef.name", "TotalAmt", "TxnStatus"], remove: "delete" },
  "sales-receipts": { entity: "SalesReceipt", cols: ["Id", "DocNumber", "TxnDate", "CustomerRef.name", "TotalAmt"], remove: "delete", void: true },
  payments: { entity: "Payment", cols: ["Id", "TxnDate", "CustomerRef.name", "TotalAmt", "UnappliedAmt"], remove: "delete", void: true },
  "credit-memos": { entity: "CreditMemo", cols: ["Id", "DocNumber", "TxnDate", "CustomerRef.name", "TotalAmt", "Balance"], remove: "delete" },
  bills: { entity: "Bill", cols: ["Id", "DocNumber", "TxnDate", "VendorRef.name", "TotalAmt", "Balance", "DueDate"], remove: "delete" },
  "bill-payments": { entity: "BillPayment", cols: ["Id", "TxnDate", "VendorRef.name", "TotalAmt", "PayType"], remove: "delete" },
  expenses: { entity: "Purchase", cols: ["Id", "TxnDate", "PaymentType", "EntityRef.name", "AccountRef.name", "TotalAmt"], remove: "delete" },
  "vendor-credits": { entity: "VendorCredit", cols: ["Id", "TxnDate", "VendorRef.name", "TotalAmt"], remove: "delete" },
  "purchase-orders": { entity: "PurchaseOrder", cols: ["Id", "DocNumber", "TxnDate", "VendorRef.name", "TotalAmt", "POStatus"], remove: "delete" },
  deposits: { entity: "Deposit", cols: ["Id", "TxnDate", "DepositToAccountRef.name", "TotalAmt"], remove: "delete" },
  "journal-entries": { entity: "JournalEntry", cols: ["Id", "DocNumber", "TxnDate", "TotalAmt"], remove: "delete" },
  transfers: { entity: "Transfer", cols: ["Id", "TxnDate", "FromAccountRef.name", "ToAccountRef.name", "Amount"], remove: "delete" },
  "time-activities": { entity: "TimeActivity", cols: ["Id", "TxnDate", "NameOf", "Hours", "Minutes"], remove: "delete" },
  employees: { entity: "Employee", cols: ["Id", "DisplayName", "Active"], remove: "inactivate" },
  terms: { entity: "Term", cols: ["Id", "Name", "DueDays", "Active"], remove: "inactivate" },
  "payment-methods": { entity: "PaymentMethod", cols: ["Id", "Name", "Type", "Active"], remove: "inactivate" },
  classes: { entity: "Class", cols: ["Id", "Name", "Active"], remove: "inactivate" },
  "tax-codes": { entity: "TaxCode", cols: ["Id", "Name", "Taxable", "Active"], remove: null },
  attachments: { entity: "Attachable", cols: ["Id", "FileName", "ContentType", "Size"], remove: "delete" },
};

/** v3 reports: CLI name -> v3 report name. */
export const API_REPORTS = {
  pandl: "ProfitAndLoss",
  "pandl-detail": "ProfitAndLossDetail",
  "balance-sheet": "BalanceSheet",
  "cash-flow": "CashFlow",
  "trial-balance": "TrialBalance",
  "general-ledger": "GeneralLedger",
  "ar-aging": "AgedReceivables",
  "ar-aging-detail": "AgedReceivableDetail",
  "ap-aging": "AgedPayables",
  "ap-aging-detail": "AgedPayableDetail",
  "account-list": "AccountList",
  "customer-balance": "CustomerBalance",
  "vendor-balance": "VendorBalance",
  "customer-income": "CustomerIncome",
  "sales-by-customer": "CustomerSales",
  "sales-by-item": "ItemSales",
  "vendor-expenses": "VendorExpenses",
  "transaction-list": "TransactionList",
};

export function resolveEntity(name) {
  const n = String(name || "").toLowerCase();
  if (ENTITIES[n]) return { key: n, ...ENTITIES[n] };
  for (const [k, v] of Object.entries(ENTITIES)) if (v.entity.toLowerCase() === n || k.replace(/s$/, "") === n) return { key: k, ...v };
  return null;
}

export function pick(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function project(rows, cols) {
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, pick(r, c) ?? null])));
}

/** Build a safe v3 query string. `where` is raw QBO SQL; string literals in `like` are quote-escaped. */
export function buildQuery(entity, { where, limit = 100, offset = 0, orderBy, count = false } = {}) {
  let q = count ? `select count(*) from ${entity}` : `select * from ${entity}`;
  if (where) q += ` where ${where}`;
  if (!count) {
    if (orderBy) q += ` orderby ${orderBy}`;
    q += ` startposition ${Math.max(1, offset + 1)} maxresults ${Math.min(1000, Math.max(1, limit))}`;
  }
  return q;
}

export function qboString(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** Flatten a v3 report JSON into { title, period, columns, rows: [[label, ...values]], depth-indented }. */
export function flattenReport(rep) {
  const h = rep?.Header || {};
  const columns = (rep?.Columns?.Column || []).map((c) => c.ColTitle || c.ColType || "");
  const rows = [];
  const walk = (list, depth) => {
    for (const r of list || []) {
      const ind = "  ".repeat(depth);
      if (r.Header?.ColData) rows.push(r.Header.ColData.map((c, i) => (i === 0 ? ind + (c.value || "") : c.value || "")));
      if (r.ColData) rows.push(r.ColData.map((c, i) => (i === 0 ? ind + (c.value || "") : c.value || "")));
      if (r.Rows?.Row) walk(r.Rows.Row, depth + 1);
      if (r.Summary?.ColData) rows.push(r.Summary.ColData.map((c, i) => (i === 0 ? ind + (c.value || "") : c.value || "")));
    }
  };
  walk(rep?.Rows?.Row, 0);
  const noData = (h.Option || []).some((o) => o.Name === "NoReportData" && o.Value === "true");
  return { title: h.ReportName || "", basis: h.ReportBasis || null, start: h.StartPeriod || null, end: h.EndPeriod || null, noData, columns, rows };
}

/** v3 fault -> short message. */
export function faultMessage(data) {
  const e = data?.Fault?.Error?.[0] || data?.fault?.error?.[0];
  if (!e) return null;
  return `${e.Message || e.message || "error"}${e.Detail || e.detail ? ": " + (e.Detail || e.detail) : ""} (code ${e.code})`;
}
