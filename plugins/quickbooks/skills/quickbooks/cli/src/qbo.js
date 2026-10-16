// QuickBooks Online client over a CDP page. Fast path: QBO's own v3 API called in-page (page/qbo_api.js).
// Fallback: navigate to a verified route and read the DOM (page/ui_read.js).
import { SNIPPETS } from "./snippets.js";
import { BASE, LISTS, classifyUrl, searchPath } from "./routes.js";
import { API_REPORTS, ENTITIES, buildQuery, faultMessage, flattenReport, project, qboString, resolveEntity } from "./entities.js";
import { sleep } from "./cdp.js";

export class QboError extends Error {
  constructor(message, exitCode = 1, extra = {}) { super(message); this.exitCode = exitCode; Object.assign(this, extra); }
}

export class WriteBlocked extends QboError {
  constructor(plan) { super("write not confirmed: re-run with --yes to apply", 0, { plan }); }
}

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export class Qbo {
  constructor(page, { log = () => {} } = {}) { this.page = page; this.log = log; this.realm = null; }

  async state() { return this.page.run(SNIPPETS["ready.js"]); }

  /** Make sure the tab is a loaded, signed-in QBO app page. Navigates to Home only when needed. */
  async ensureReady({ timeoutMs = 45000 } = {}) {
    let s = await this.state().catch(() => ({ state: "other" }));
    if (s.state === "ready") return s;
    if (s.state === "other" || s.state === "gated") { await this.page.goto(BASE + "/app/homepage"); }
    const end = Date.now() + timeoutMs;
    for (;;) {
      s = await this.state().catch(() => ({ state: "loading" }));
      if (s.state === "ready") return s;
      if (s.state === "signed_out") throw new QboError("not signed in to QuickBooks: sign in in this browser first (the CLI never handles passwords or codes)", 3, { state: s });
      if (s.state === "company_select") throw new QboError("QuickBooks is asking which company to open: pick it in the browser, then retry", 3, { state: s });
      if (Date.now() > end) throw new QboError("QuickBooks page never became ready", 7, { state: s });
      await sleep(300);
    }
  }

  async api(params) {
    await this.ensureReady();
    const r = await this.page.run(SNIPPETS["qbo_api.js"], params);
    if (r.status === 0) {
      if (r.error === "not_signed_in") throw new QboError("not signed in to QuickBooks", 3);
      throw new QboError(`QBO API call failed: ${r.error}`, 6);
    }
    this.realm = r.realm;
    if (r.status === 401 || r.status === 403) throw new QboError(`QBO refused the call (HTTP ${r.status}): ${faultMessage(r.data) || "session expired?"}`, 5);
    if (r.status >= 400) throw new QboError(`QBO error HTTP ${r.status}: ${faultMessage(r.data) || JSON.stringify(r.data).slice(0, 200)}`, 1, { status: r.status });
    return r.data;
  }

  async query(sql) {
    const d = await this.api({ path: "/query", query: { query: sql } });
    return d.QueryResponse || {};
  }

  async company() {
    const q = await this.query("select * from CompanyInfo");
    const c = (q.CompanyInfo || [])[0] || {};
    const pref = (await this.query("select * from Preferences")).Preferences?.[0] || {};
    return {
      realm: this.realm, name: c.CompanyName, legalName: c.LegalName, country: c.Country || c.CompanyAddr?.Country,
      email: c.Email?.Address || null, startDate: c.CompanyStartDate, fiscalYearStartMonth: c.FiscalYearStartMonth,
      currency: pref.CurrencyPrefs?.HomeCurrency?.value || null,
      offering: (c.NameValue || []).find((n) => n.Name === "OfferingSku")?.Value || null,
    };
  }

  async count(entityName) {
    const e = this._entity(entityName);
    return (await this.query(buildQuery(e.entity, { count: true }))).totalCount ?? 0;
  }

  async list(entityName, { where, limit = 100, offset = 0, orderBy, all = false, raw = false } = {}) {
    const e = this._entity(entityName);
    const q = await this.query(buildQuery(e.entity, { where, limit, offset, orderBy }));
    const rows = q[e.entity] || [];
    const out = raw ? rows : project(rows, e.cols);
    return { entity: e.entity, count: rows.length, rows: all ? rows : out };
  }

  async get(entityName, id) {
    const e = this._entity(entityName);
    const d = await this.api({ path: `/${e.entity.toLowerCase()}/${encodeURIComponent(id)}` });
    const obj = d[e.entity];
    if (!obj) throw new QboError(`${e.entity} ${id} not found`, 1);
    return obj;
  }

  async report(name, { from, to, method, macro, extra = {} } = {}) {
    const rep = API_REPORTS[name] || (Object.values(API_REPORTS).includes(name) ? name : null);
    if (!rep) throw new QboError(`unknown report "${name}" (see: qbo routes)`, 2);
    const query = { ...extra };
    if (from) query.start_date = from;
    if (to) query.end_date = to;
    if (macro) query.date_macro = macro;
    if (method) query.accounting_method = /^acc/i.test(method) ? "Accrual" : "Cash";
    if (/^Aged/.test(rep) && to && !from) query.report_date = to;
    const d = await this.api({ path: `/reports/${rep}`, query });
    return flattenReport(d);
  }

  /** Name and document search across contacts, items and transactions. */
  async search(text, { limit = 20 } = {}) {
    const like = qboString(`%${text}%`);
    const named = [["Customer", "DisplayName"], ["Vendor", "DisplayName"], ["Item", "Name"], ["Account", "Name"], ["Employee", "DisplayName"]];
    const docs = ["Invoice", "Estimate", "SalesReceipt", "Bill", "CreditMemo", "JournalEntry"];
    await this.ensureReady();
    const parts = await Promise.all([
      ...named.map(([ent, field]) => this.query(`select * from ${ent} where ${field} like ${like} maxresults ${limit}`)
        .then((q) => (q[ent] || []).map((r) => ({ type: ent, id: r.Id, name: r[field], active: r.Active ?? null })))),
      ...docs.map((ent) => this.query(`select * from ${ent} where DocNumber = ${qboString(text)} maxresults ${limit}`)
        .then((q) => (q[ent] || []).map((r) => ({ type: ent, id: r.Id, name: r.DocNumber, date: r.TxnDate, total: r.TotalAmt })))),
    ]);
    const hits = parts.flat();
    return hits;
  }

  /** DOM fallback: open a route and read what the page shows. */
  async ui(pathOrName, { settleMs = 1500, timeoutMs = 30000 } = {}) {
    const route = LISTS[pathOrName];
    const path = route ? route.path : pathOrName;
    await this.page.goto(BASE + path);
    const s = await this.page.waitForFunction(`(()=>{const t=document.body&&document.body.innerText||'';return /accounts\\.intuit\\.com|limitexceeded|obillupgrade/.test(location.href)||document.querySelector('table,[role=table],[role=grid],h1')?location.href:null})()`, { timeoutMs });
    const url = s || (await this.page.url());
    const kind = classifyUrl(url);
    if (kind === "signed_out") throw new QboError("not signed in to QuickBooks", 3);
    if (kind === "gated") return { url: url.split("?")[0], gated: true, tables: [] };
    await sleep(settleMs);
    return this.page.run(SNIPPETS["ui_read.js"], { empty: route?.empty || [] });
  }

  async uiSearch(text) { return this.ui(searchPath(text)); }

  // ------------------------------------------------------------- writes (gated by confirm)
  async _write(plan, confirm, fn) {
    if (!confirm) throw new WriteBlocked(plan);
    return fn();
  }

  async createCustomer({ name, email, phone, company }, confirm) {
    if (!name) throw new QboError("--name is required", 2);
    const body = { DisplayName: name };
    if (company) body.CompanyName = company;
    if (email) body.PrimaryEmailAddr = { Address: email };
    if (phone) body.PrimaryPhone = { FreeFormNumber: phone };
    return this._write({ action: "create customer", body }, confirm, async () => (await this.api({ method: "POST", path: "/customer", body })).Customer);
  }

  async _findOne(entity, field, value) {
    if (/^\d+$/.test(String(value))) return { value: String(value) };
    const q = await this.query(`select * from ${entity} where ${field} = ${qboString(value)}`);
    const r = (q[entity] || [])[0];
    if (!r) throw new QboError(`${entity} "${value}" not found`, 1);
    return { value: r.Id, name: r[field] };
  }

  async _firstItem() {
    const q = await this.query("select * from Item where Type = 'Service' maxresults 1");
    const r = (q.Item || [])[0];
    if (!r) throw new QboError("no service item exists: pass --item", 1);
    return { value: r.Id, name: r.Name };
  }

  async createInvoice({ customer, amount, item, description, date, due }, confirm) {
    if (!customer || !(Number(amount) > 0)) throw new QboError("--customer and a positive --amount are required", 2);
    const CustomerRef = await this._findOne("Customer", "DisplayName", customer);
    const ItemRef = item ? await this._findOne("Item", "Name", item) : await this._firstItem();
    const body = {
      CustomerRef, TxnDate: date || today(),
      Line: [{ DetailType: "SalesItemLineDetail", Amount: Number(amount), Description: description || undefined, SalesItemLineDetail: { ItemRef, Qty: 1, UnitPrice: Number(amount) } }],
    };
    if (due) body.DueDate = due;
    return this._write({ action: "create invoice", body }, confirm, async () => (await this.api({ method: "POST", path: "/invoice", body })).Invoice);
  }

  async createExpense({ amount, account, category, payee, date, memo, paymentType = "Cash" }, confirm) {
    if (!(Number(amount) > 0)) throw new QboError("a positive --amount is required", 2);
    const AccountRef = account ? await this._findOne("Account", "Name", account) : await this._findAccount("AccountType = 'Bank'");
    const catRef = category ? await this._findOne("Account", "Name", category) : await this._findAccount("AccountType = 'Expense'");
    const body = {
      PaymentType: paymentType, AccountRef, TxnDate: date || today(),
      Line: [{ DetailType: "AccountBasedExpenseLineDetail", Amount: Number(amount), Description: memo || undefined, AccountBasedExpenseLineDetail: { AccountRef: catRef } }],
    };
    if (memo) body.PrivateNote = memo;
    if (payee) body.EntityRef = await this._findOne("Vendor", "DisplayName", payee);
    return this._write({ action: "create expense", body }, confirm, async () => (await this.api({ method: "POST", path: "/purchase", body })).Purchase);
  }

  async _findAccount(where) {
    const q = await this.query(`select * from Account where ${where} and Active = true maxresults 1`);
    const r = (q.Account || [])[0];
    if (!r) throw new QboError(`no account matches ${where}`, 1);
    return { value: r.Id, name: r.Name };
  }

  /** Void a transaction (invoice, sales receipt, payment). */
  async voidTxn(entityName, id, confirm) {
    const e = this._entity(entityName);
    if (!e.void) throw new QboError(`${e.entity} cannot be voided`, 2);
    const cur = await this.get(e.key, id);
    const body = { Id: cur.Id, SyncToken: cur.SyncToken, sparse: true };
    const path = e.entity === "Invoice" ? "/invoice?operation=void" : `/${e.entity.toLowerCase()}?operation=update&include=void`;
    return this._write({ action: `void ${e.entity}`, id, docNumber: cur.DocNumber, total: cur.TotalAmt }, confirm,
      async () => (await this.api({ method: "POST", path, body }))[e.entity]);
  }

  /** Delete a transaction, or make a list entry inactive (QBO cannot delete customers, vendors, items, accounts). */
  async remove(entityName, id, confirm) {
    const e = this._entity(entityName);
    if (!e.remove) throw new QboError(`${e.entity} cannot be removed`, 2);
    const cur = await this.get(e.key, id);
    const label = cur.DisplayName || cur.Name || cur.DocNumber || id;
    if (e.remove === "inactivate") {
      const body = { Id: cur.Id, SyncToken: cur.SyncToken, sparse: true, Active: false };
      if (cur.DisplayName) body.DisplayName = cur.DisplayName;
      if (e.entity === "Item" || e.entity === "Account") body.Name = cur.Name;
      return this._write({ action: `make ${e.entity} inactive`, id, label }, confirm,
        async () => ({ inactivated: true, ...(await this.api({ method: "POST", path: `/${e.entity.toLowerCase()}`, body }))[e.entity] }));
    }
    const body = { Id: cur.Id, SyncToken: cur.SyncToken };
    return this._write({ action: `delete ${e.entity}`, id, label, total: cur.TotalAmt }, confirm,
      async () => (await this.api({ method: "POST", path: `/${e.entity.toLowerCase()}?operation=delete`, body }))[e.entity] || { deleted: true });
  }

  _entity(name) {
    const e = resolveEntity(name);
    if (!e) throw new QboError(`unknown entity "${name}". Known: ${Object.keys(ENTITIES).join(", ")}`, 2);
    return e;
  }
}
