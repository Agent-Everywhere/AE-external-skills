// The read-only research commands. Each returns {rows, meta?}.
const PROFILE_FIELDS = [
  "title", "field_cp_contract_number", "field_cp_end_date", "field_cp_contract_description",
  "field_cp_search_keywords", "field_cp_brand_name", "field_cp_eziqc_category",
];
const FIELD_MAP = {
  description: "field_cp_contract_description",
  keywords: "field_cp_search_keywords",
  title: "title",
  number: "field_cp_contract_number",
  brand: "field_cp_brand_name",
};

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function htmlToText(v) {
  const s = v && typeof v === "object" ? v.value : v;
  return clean(
    String(s ?? "")
      .replace(/<\/(p|li|ul|ol|div|h\d)>|<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&amp;/g, "&"),
  );
}

export function profileRow(a, { full = false } = {}) {
  const number = a.field_cp_contract_number || "";
  const title = clean(a.title);
  const row = {
    contract_number: number,
    vendor: clean(a.field_cp_brand_name) || (number ? clean(title.replace(number, "")) : title),
    end_date: a.field_cp_end_date || "",
    description: clean(a.field_cp_contract_description),
    keywords: clean(a.field_cp_search_keywords),
    category: a.field_cp_eziqc_category || "",
  };
  if (full) row.products_services = htmlToText(a.field_cp_products_services);
  return row;
}

export function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

const byEnd = (a, b) => (a.end_date || "9999").localeCompare(b.end_date || "9999") || a.contract_number.localeCompare(b.contract_number);

export function createCommands({ api, portal, today }) {
  const profileFields = (full) => (full ? [...PROFILE_FIELDS, "field_cp_products_services"] : PROFILE_FIELDS);

  async function contractsSearch({ q, field, expiringWithin, limit, full } = {}) {
    if (!q && expiringWithin === undefined) throw new Error("contracts search needs --q <text> or --expiring-within <months>");
    const filters = [];
    if (q) {
      if (field && !FIELD_MAP[field]) throw new Error(`--field must be one of ${Object.keys(FIELD_MAP).join(", ")}`);
      const paths = field ? [FIELD_MAP[field]] : [FIELD_MAP.description, FIELD_MAP.keywords, FIELD_MAP.title];
      const conds = paths.map((path) => ({ path, op: "CONTAINS", value: q }));
      filters.push(conds.length === 1 ? conds[0] : { or: conds });
    }
    if (expiringWithin !== undefined) {
      const months = Number(expiringWithin);
      if (!Number.isFinite(months) || months < 0) throw new Error("--expiring-within must be a number of months");
      const start = today();
      filters.push({ path: "field_cp_end_date", op: ">=", value: start }, { path: "field_cp_end_date", op: "<=", value: addMonths(start, months) });
    }
    const rows = await api.fetchAll({ resource: "node/contractprofile", fields: profileFields(full), filters, sort: "field_cp_end_date" }, { limit });
    return { rows: rows.map((a) => profileRow(a, { full })).sort(byEnd) };
  }

  async function contractsVendor({ name, limit, full } = {}) {
    if (!name) throw new Error("contracts vendor needs a name");
    const filters = [{ or: [{ path: "field_cp_brand_name", op: "CONTAINS", value: name }, { path: "title", op: "CONTAINS", value: name }] }];
    const rows = await api.fetchAll({ resource: "node/contractprofile", fields: profileFields(full), filters, sort: "field_cp_end_date" }, { limit });
    return { rows: rows.map((a) => profileRow(a, { full })).sort(byEnd) };
  }

  const solRow = (a) => ({
    number: clean(a.field_solicitation_bid_rfp_num),
    title: clean(a.title),
    status: a.field_solicitation_process_statu || "",
  });

  async function solicitationsList({ open, status, limit } = {}) {
    const want = status || (open ? "Open" : "");
    const filters = want ? [{ path: "field_solicitation_process_statu", op: "=", value: want }] : [];
    const rows = await api.fetchAll({ resource: "node/competitive_solicitations", filters, sort: "title" }, { limit });
    return { rows: rows.map(solRow).sort((a, b) => a.number.localeCompare(b.number)) };
  }

  async function bidsList({ status, q, full } = {}) {
    return { rows: await portal.listBids({ status: status || "Open", q: q || "", full }) };
  }

  async function bidsDetail({ ref } = {}) {
    if (!ref) throw new Error("bids detail needs a tender id or an RFP number");
    const d = await portal.bidDetail(ref);
    return { rows: [d] };
  }

  async function awardsList({ year, rfp } = {}) {
    if (!year) throw new Error("awards needs --year YYYY");
    return { rows: await portal.awards({ year, rfp }) };
  }

  async function docsDownload({ ref, outDir, username, password } = {}) {
    if (!ref) throw new Error("docs download needs a tender id or an RFP number");
    if (!outDir) throw new Error("docs download needs --out <directory>");
    return { rows: [await portal.downloadDocs({ ref, outDir, username, password })] };
  }

  async function agenciesList({ state, type, limit } = {}) {
    if (!state && !type && limit === undefined) throw new Error("agencies list needs --state XX and/or --type <text> (or --limit N): the full list is very large");
    const filters = [];
    if (state) {
      if (!/^[A-Za-z]{2}$/.test(state)) throw new Error("--state must be a two-letter code, e.g. UT");
      filters.push({ path: "field_state_code", op: "=", value: state.toUpperCase() });
    }
    if (type) filters.push({ or: [{ path: "field_type", op: "CONTAINS", value: type }, { path: "field_sub_type", op: "CONTAINS", value: type }] });
    const fields = ["title", "field_type", "field_sub_type", "field_city", "field_state_code", "field_member_status", "field_website", "field_member_number"];
    const rows = await api.fetchAll({ resource: "node/account", fields, filters, sort: "title" }, { limit });
    return {
      rows: rows.map((a) => ({
        name: clean(a.title), state: a.field_state_code || "", city: a.field_city || "", type: a.field_type || "",
        sub_type: a.field_sub_type || "", member_status: a.field_member_status || "", website: a.field_website || "",
        member_number: a.field_member_number || "",
      })),
    };
  }

  async function termsList(resource, { limit } = {}) {
    const rows = await api.fetchAll({ resource, sort: undefined }, { limit });
    return { rows: rows.map((a) => ({ name: clean(a.name) })).sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** Search phrases from a solicitation title, e.g. "Heavy and Compact Construction Equipment with Related..." */
  function deriveQueries(title) {
    const main = clean(title).split(/,?\s+(?:with|and\s+related|related|including)\s+/i)[0];
    const toks = main.split(/(\s*,\s*(?:and\s+)?|\s+and\s+)/i);
    const parts = []; // {text, joinedByAnd}: a bare " and " (no comma) joins a modifier to what follows
    for (let i = 0; i < toks.length; i += 2) parts.push({ text: clean(toks[i]), joinedByAnd: /^\s+and\s+$/i.test(toks[i + 1] || "") });
    const out = [];
    const add = (t) => { t = clean(t); if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t); };
    parts.forEach((p, i) => {
      const words = p.text.split(" ");
      if (words.length >= 2) {
        add(p.text);
        if (words.length >= 3) add(words.slice(-2).join(" "));
      } else if (p.joinedByAnd) {
        const next = parts.slice(i + 1).find((x) => x.text.split(" ").length >= 2);
        if (next) add(`${p.text} ${next.text.split(" ").pop()}`);
      } else if (p.text.length >= 5) add(p.text);
    });
    return out.slice(0, 6);
  }

  /** Current contractprofile holders for the category of a solicitation / contract number. */
  async function rebid({ ref, limit } = {}) {
    if (!ref) throw new Error("rebid needs an RFP number (e.g. 110326) or a contract number (e.g. 011723-JDC)");
    const m = clean(ref).match(/^(?:RFP|IFB|RFQ)?\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)$/i);
    if (!m) throw new Error(`cannot read ${JSON.stringify(ref)} as an RFP or contract number`);
    const id = m[1];
    const isContract = /^\d{6}-[A-Za-z0-9]+$/.test(id);
    const solNum = isContract ? id.split("-")[0] : id;
    const sols = await api.fetchAll({ resource: "node/competitive_solicitations", filters: [{ path: "field_solicitation_bid_rfp_num", op: "=", value: solNum }] });
    let title = sols[0] ? clean(sols[0].title) : "";
    let status = sols[0] ? sols[0].field_solicitation_process_statu : "";
    if (!title) {
      const bids = (await portal.listBids({ status: "All" })).filter((b) => b.number.toLowerCase() === solNum.toLowerCase());
      if (bids[0]) { title = bids[0].name; status = bids[0].status; }
    }
    if (!title) throw new Error(`no solicitation found for ${solNum}`);
    const queries = deriveQueries(title);
    const seen = new Map();
    for (const phrase of queries) {
      const filters = [{ or: [
        { path: "field_cp_contract_description", op: "CONTAINS", value: phrase },
        { path: "field_cp_search_keywords", op: "CONTAINS", value: phrase },
      ] }];
      const rows = await api.fetchAll({ resource: "node/contractprofile", fields: PROFILE_FIELDS, filters, sort: "field_cp_end_date" }, { limit });
      for (const a of rows) {
        const r = seen.get(a.id) || { ...profileRow(a), matched_terms: [] };
        r.matched_terms.push(phrase);
        seen.set(a.id, r);
      }
    }
    const prefixes = new Map();
    for (const r of seen.values()) { const px = r.contract_number.split("-")[0]; if (/^\d{6}$/.test(px)) prefixes.set(px, (prefixes.get(px) || 0) + 1); }
    const priors = [...prefixes].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([px]) => px);
    if (isContract && !priors.includes(solNum)) priors.unshift(solNum);
    const prior_awards = [];
    for (const px of priors) {
      const year = 2000 + Number(px.slice(4));
      try {
        const [a] = await portal.awards({ year, rfp: px });
        prior_awards.push(a ? { rfp: px, year, name: a.name, bidder_count: a.bidder_count, awardees: a.awardees } : { rfp: px, year, note: "not in the awards report for that year" });
      } catch (e) { prior_awards.push({ rfp: px, year, note: `awards lookup failed: ${e.message}` }); }
    }
    const rows = [...seen.values()].map((r) => ({ ...r, matched_terms: r.matched_terms.join("; ") }))
      .sort((a, b) => b.matched_terms.split("; ").length - a.matched_terms.split("; ").length || byEnd(a, b));
    return { rows, meta: { solicitation: solNum, title, status, queries, prior_awards, note: "Holders are matched on title words in contract descriptions and keywords: verify each row against its description." } };
  }

  return { contractsSearch, contractsVendor, solicitationsList, bidsList, bidsDetail, awardsList, docsDownload, agenciesList, termsList, rebid, deriveQueries };
}
