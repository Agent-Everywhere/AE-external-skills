// JSON / CSV output, plus the three artifacts a rep uses: the full CSV, an Apollo-ready company CSV and a people CSV.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// CSV cells that start with a formula character are prefixed with an apostrophe so a spreadsheet shows them as text.
const cell = (v) => {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = "'" + s;
  return s;
};
const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(q).join(",")];
  for (const r of rows) lines.push(cols.map((c) => q(cell(r[c]))).join(","));
  return lines.join("\n") + "\n";
}

export function render(result, format = "json") {
  if (format === "csv") return result.rows.length && !("issuer_name" in result.rows[0]) ? toCsv(result.rows) : toCsv(fullRows(result.rows), FULL_COLUMNS);
  if (format !== "json") throw new Error(`unknown --format ${JSON.stringify(format)}; use json or csv`);
  const body = { count: result.rows.length, ...(result.meta ? { meta: result.meta } : {}), rows: result.rows };
  return JSON.stringify(body, null, 2) + "\n";
}

// ---------- helpers ----------

const usd = (n) => (n === null || n === undefined || n === "" ? "" : "$" + Number(n).toLocaleString("en-US"));
const titleCase = (s) => (s && s === s.toUpperCase() && /[A-Z]/.test(s) ? s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s || "");
const personName = (p) => [p.first_name, p.last_name].filter(Boolean).map(titleCase).join(" ");
const personTitle = (p) => p.clarification || (p.relationships || []).join(" / ");
const isNo = (row) => String(row.fit || "").toLowerCase() === "no";

export const FULL_COLUMNS = [
  "issuer_name", "cik", "state", "city", "industry_group", "form", "is_amendment", "filing_date", "date_of_first_sale",
  "raise_amount", "raise_amount_basis", "total_offering_amount", "total_offering_text", "total_amount_sold", "total_remaining_text", "investors_count",
  "year_of_inc", "entity_type", "revenue_range", "securities", "website", "people", "matched_keywords", "filing_count", "first_filing_date",
  "filtered_reason", "fit", "fit_reason", "evidence", "filing_url", "accession",
];

const fullRows = (rows) => rows.map((r) => ({
  ...r,
  people: (r.related_persons || []).map((p) => `${personName(p)} (${personTitle(p) || "related person"})`).join("; "),
}));

/** One-line, human-readable notes for the Apollo company CSV. */
export function companyNotes(r) {
  const parts = [];
  if (r.raise_amount) parts.push(r.raise_amount_basis === "offering" ? `Offering of ${usd(r.raise_amount)} (amount sold not reported)` : `${usd(r.raise_amount)} sold`);
  else parts.push("Raise amount not disclosed");
  if (r.total_offering_amount && r.raise_amount_basis === "sold" && r.total_offering_amount !== r.raise_amount) parts[parts.length - 1] += ` of a ${usd(r.total_offering_amount)} offering`;
  if (r.date_of_first_sale) parts.push(`first sale ${r.date_of_first_sale}`);
  parts.push(`SEC Form D ${r.is_amendment ? "amendment" : "new filing"} filed ${r.filing_date}`);
  if (r.industry_group) parts.push(r.industry_group);
  return parts.join("; ");
}

export const COMPANY_COLUMNS = ["Company Name", "Website", "Raise Amount (USD)", "Raise Date", "Filing Date", "Total Offering (USD)", "State", "City", "Industry Group", "Notes", "Fit", "Fit Reason", "Evidence", "EDGAR URL"];

/** Apollo-ready company rows. Rows judged fit "no" are left out (they stay in the full CSV). */
export function companyRows(rows) {
  return rows.filter((r) => !isNo(r)).map((r) => ({
    "Company Name": r.issuer_name, Website: r.website || "",
    "Raise Amount (USD)": r.raise_amount ?? "", "Raise Date": r.date_of_first_sale || r.filing_date || "", "Filing Date": r.filing_date,
    "Total Offering (USD)": r.total_offering_amount ?? "", State: r.state, City: r.city, "Industry Group": r.industry_group,
    Notes: companyNotes(r), Fit: r.fit || "", "Fit Reason": r.fit_reason || "", Evidence: r.evidence || "", "EDGAR URL": r.filing_url,
  }));
}

export const PEOPLE_COLUMNS = ["First Name", "Last Name", "Title", "Relationship", "Company Name", "Website", "Raise Amount (USD)", "Filing Date", "Source", "Fit", "EDGAR URL"];

/** One row per related person (and the filing's signer when not already listed), for Apollo people lookup. No addresses. */
export function peopleRows(rows) {
  const out = [];
  for (const r of rows) {
    if (isNo(r)) continue;
    const seen = new Map();
    const push = (first, last, title, relationship, source) => {
      const key = `${first} ${last}`.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key) return;
      if (seen.has(key)) { const prior = seen.get(key); if (!prior.Title && title) prior.Title = title; return; }
      const row = {
        "First Name": titleCase(first), "Last Name": titleCase(last), Title: title, Relationship: relationship, "Company Name": r.issuer_name,
        Website: r.website || "", "Raise Amount (USD)": r.raise_amount ?? "", "Filing Date": r.filing_date, Source: source, Fit: r.fit || "", "EDGAR URL": r.filing_url,
      };
      seen.set(key, row);
      out.push(row);
    };
    for (const p of r.related_persons || []) push(p.first_name, p.last_name, p.clarification || "", (p.relationships || []).join(" / "), "related person");
    const sig = r.signer || {};
    if (sig.name) {
      const parts = sig.name.trim().split(/\s+/);
      push(parts[0] || "", parts.slice(1).join(" "), sig.title || "", "", "signer");
    }
  }
  // Fall back to the relationship when no title was written.
  for (const row of out) if (!row.Title) row.Title = row.Relationship;
  return out;
}

// ---------- writing ----------

export async function writeOutputs(dir, name, result) {
  await mkdir(dir, { recursive: true });
  const files = {
    json: join(dir, `${name}.json`),
    full: join(dir, `${name}-full.csv`),
    companies: join(dir, `${name}-apollo-companies.csv`),
    people: join(dir, `${name}-people.csv`),
  };
  const companies = companyRows(result.rows);
  const people = peopleRows(result.rows);
  await writeFile(files.json, render(result, "json"));
  await writeFile(files.full, toCsv(fullRows(result.rows), FULL_COLUMNS));
  await writeFile(files.companies, toCsv(companies, COMPANY_COLUMNS));
  await writeFile(files.people, toCsv(people, PEOPLE_COLUMNS));
  return { files, counts: { full: result.rows.length, companies: companies.length, people: people.length } };
}

/** Write to --out (returns a short note for stderr) or to stdout. */
export async function emit(result, { format = "json", out, stdout }) {
  const text = render(result, format);
  if (out) { await writeFile(out, text); return `wrote ${result.rows.length} rows to ${out}`; }
  stdout(text);
  return null;
}
