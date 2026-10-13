#!/usr/bin/env python3
"""Map Sales Navigator API results to the standard CSVs in references/output.md.

Input: the JSONL a runtime run wrote (page/lead_search.js, page/account_search.js and
page/companies_websites.js results), a bare per-call JSON file (the object a snippet returned,
saved as is, e.g. results/<shard>/<call id>.json), a saved API response (a JSON object with
"elements"), or a plain JSON list of elements. Several files may be given and mixed, and they may
overlap (the same call saved twice, a JSONL plus its per-call files): website records found in any
input are used to fill company_domain, and every person or company is written once.

  salesnav_rows.py leads    results.jsonl -o leads.csv    --mode A --buyer-type X --shard "US|11-50"
  salesnav_rows.py accounts results.jsonl -o accounts.csv --mode B --buyer-type X --shard "US-CA"
  salesnav_rows.py --flag-dups leads.csv

What is mapped (and what is deliberately left blank):
  leads     full_name, title/company_name/time_in_role from the current position,
            salesnav_lead_url from entityUrn, location from geoRegion, signals "open profile"
            when the lead accepts open messages. seniority is blank unless --seniority is given
            (the API does not return it; pass the level the search was filtered on).
            linkedin_url stays blank: search results do not contain the public profile URL, and a
            slug is never invented.
            Optional columns from the search row: pending_invitation (yes when an invitation is
            already pending, no when the row carries the field and it is false, blank when the
            field is absent from the row), degree (1st/2nd/3rd) and open_link (yes), so outreach
            can check them without opening the profile. dup_suspect is yes on every row of a
            same-name group inside one account (two profiles, one company, one name: often a
            duplicate profile; check before contacting) and a count is printed.
            --append over an existing CSV keeps that file's header (columns it lacks are dropped
            from the new rows, with a warning) and then recomputes dup_suspect over the combined
            file, so a duplicate split across two runs is still flagged. --flag-dups FILE does
            only that recompute, in place, over any leads CSV (an atomic rewrite). Across runs
            the company is matched on company_domain, else on the company name.
            The lead URL contains commas, so the CSV quotes it; read the file with a CSV reader.
  buyer type per row: --buyer-type is the default for every row; --buyer-type-map PATH overrides
            it per company. PATH is a JSON object {company id: type} or a CSV with a buyer_type
            column plus company_id or salesnav_account_url (an accounts.csv works as is).
  accounts  company_name, industry, headcount_band (from employeeCountRange),
            salesnav_account_url from the company id, company_domain from the website records.
            hq_location stays blank (not in the search result).
Rows are de-duplicated on the person (the profile id, the first part of the lead urn: the same
person comes back with a different search-context suffix on every search) or the company id; the
first one wins and its full Sales Navigator URL is kept. Re-running over overlapping files gives
the same CSV. --company-ids PATH also writes a salesnav_lead_url,company_id sidecar so leads can
be joined to their accounts by company id.

Exit code: 0 rows written, 1 nothing to write or unreadable input.
Python 3 standard library only, no network.
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import tempfile
from collections import Counter
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

import validate_csv  # sibling script: the column lists live there

LEAD_URL = "https://www.linkedin.com/sales/lead/"
COMPANY_URL = "https://www.linkedin.com/sales/company/"


# ----------------------------------------------------------------------------- reading input

def _records(path):
    """Yield every JSON value in a file that is JSON or JSONL."""
    text = Path(path).read_text(encoding="utf-8").strip()
    if not text:
        return
    try:
        yield json.loads(text)
        return
    except ValueError:
        pass
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except ValueError:
            continue


def _payload(rec):
    """The API-shaped dict inside a runner record, or the record itself.

    A browser JS tool may hand back the result as a JSON string; that is decoded once.
    """
    if isinstance(rec, str):
        try:
            rec = json.loads(rec)
        except ValueError:
            return None
    if isinstance(rec, dict) and isinstance(rec.get("result"), dict):
        return rec["result"]
    return rec


def element_kind(e):
    """'leads' for a person element, 'accounts' for a company element, '' when unsure."""
    urn = e.get("entityUrn") or ""
    if "salesProfile" in urn or "currentPositions" in e or "fullName" in e or "firstName" in e:
        return "leads"
    if "salesCompany" in urn or "companyName" in e:
        return "accounts"
    return ""


def load_inputs(paths, kind):
    """Return (elements, websites): elements of `kind` in order, and {company_id: website}.

    Inputs may mix lead pages, account pages and website records; only `kind` elements are kept.
    """
    elements, websites = [], {}

    def keep(items):
        elements.extend(e for e in items if isinstance(e, dict) and element_kind(e) in (kind, ""))

    for path in paths:
        for rec in _records(path):
            if isinstance(rec, list):
                keep(rec)
                continue
            payload = _payload(rec)
            if isinstance(payload, list):
                keep(payload)
                continue
            if not isinstance(payload, dict):
                continue
            if isinstance(payload.get("elements"), list):
                keep(payload["elements"])
            for comp in payload.get("companies") or []:
                if isinstance(comp, dict) and comp.get("id") and comp.get("website"):
                    websites[str(comp["id"])] = comp["website"]
            raw = payload.get("results")
            if isinstance(raw, dict):  # a saved salesApiCompanies response
                for cid, comp in raw.items():
                    if isinstance(comp, dict) and comp.get("website"):
                        websites[str(cid)] = comp["website"]
    return elements, websites


# ----------------------------------------------------------------------------- field helpers

def urn_id(urn):
    """Trailing numeric id of a urn like urn:li:fs_salesCompany:12345 ('' when absent)."""
    m = re.search(r"(\d+)\)?$", urn or "")
    return m.group(1) if m else ""


def profile_id(entity_urn):
    """The profile id: the first component of the urn's inner part (urn:li:fs_salesProfile:(ID,CONTEXT,TOKEN)).

    The context and token change with every search; the id is the person.
    """
    urn = entity_urn or ""
    if "(" in urn:
        inner = urn.split("(", 1)[1].rstrip(")")
    else:
        inner = urn.rsplit(":", 1)[-1] if urn.startswith("urn:") else ""
    return inner.split(",", 1)[0].strip()


def lead_url(entity_urn):
    """https://www.linkedin.com/sales/lead/<inner> from urn:li:fs_salesProfile:(<inner>)."""
    urn = entity_urn or ""
    if "(" in urn:
        inner = urn.split("(", 1)[1].rstrip(")")
    else:
        inner = urn.rsplit(":", 1)[-1] if urn.startswith("urn:") else ""
    return LEAD_URL + inner if inner else ""


def domain_of(website):
    """Bare lowercase domain from a website value ('' when it is not a usable host)."""
    site = (website or "").strip()
    if not site:
        return ""
    if "://" not in site:
        site = "http://" + site
    host = (urlparse(site).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host if validate_csv.DOMAIN_RE.fullmatch(host) else ""


def current_position(lead):
    positions = lead.get("currentPositions") or []
    for pos in positions:
        if pos.get("current"):
            return pos
    return positions[0] if positions else {}


def tenure(pos):
    t = pos.get("tenureAtPosition") or {}
    parts = []
    if t.get("numYears"):
        parts.append("%d yr" % t["numYears"])
    if t.get("numMonths"):
        parts.append("%d mo" % t["numMonths"])
    return " ".join(parts)


def headcount_band(text):
    """'51-200 employees' -> '51-200'; '10,001+ employees' -> '10001+'."""
    band = re.sub(r"\s*employees?\s*$", "", text or "", flags=re.I)
    return band.replace(",", "").strip()


DEGREES = {1: "1st", 2: "2nd", 3: "3rd"}


def degree_of(value):
    """The connection degree as 1st/2nd/3rd ('' when absent or not a degree)."""
    if isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return DEGREES.get(value, "")
    text = str(value or "").strip().lower()
    for n, label in DEGREES.items():
        if text in (str(n), label, "dist_%d" % n, "distance_%d" % n):
            return label
    return ""


def pending_of(e):
    """yes / no / blank for the search row's pendingInvitation: blank means the field was absent."""
    value = e.get("pendingInvitation")
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return ""


def company_id_of(value):
    """A Sales Nav company id from a /sales/company/<id> URL, a company urn or a bare id ('' if none)."""
    text = str(value or "").strip()
    m = re.search(r"/sales/company/(\d+)", text)
    if m:
        return m.group(1)
    if re.fullmatch(r"\d+", text):
        return text
    m = re.search(r"salesCompany:(\d+)", text)
    return m.group(1) if m else ""


def load_buyer_type_map(path, stats=None):
    """{company id: buyer type} from a JSON object or a CSV (buyer_type + company_id/salesnav_account_url).

    Ids are read from /sales/company/<id> URLs, company urns or bare ids. When `stats` is a dict it
    gets "no_id": the number of map rows whose company id could not be read (they are skipped).
    """
    text = Path(path).read_text(encoding="utf-8-sig")
    out, no_id = {}, 0
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if isinstance(data, dict):
        for key, val in data.items():
            if not (isinstance(val, str) and val.strip()):
                continue
            cid = company_id_of(key)
            if cid:
                out[cid] = val.strip()
            else:
                no_id += 1
    elif data is not None:
        raise ValueError("buyer-type map: JSON must be an object {company id: type}")
    else:
        reader = csv.DictReader(io.StringIO(text))
        fields = reader.fieldnames or []
        if "buyer_type" not in fields or not ({"company_id", "salesnav_account_url"} & set(fields)):
            raise ValueError("buyer-type map: a CSV needs a buyer_type column and company_id or "
                             "salesnav_account_url")
        for row in reader:
            kind = (row.get("buyer_type") or "").strip()
            if not kind:
                continue
            cid = company_id_of(row.get("company_id")) or company_id_of(row.get("salesnav_account_url"))
            if cid:
                out[cid] = kind
            else:
                no_id += 1
    if stats is not None:
        stats["no_id"] = no_id
    return out


def same_name_groups(rows, company_ids):
    """Lists of row indexes that share a company id and a normalised full name (2 or more rows)."""
    groups = {}
    for i, (row, cid) in enumerate(zip(rows, company_ids)):
        name = re.sub(r"\s+", " ", (row.get("full_name") or "").strip().lower())
        if cid and name:
            groups.setdefault((cid, name), []).append(i)
    return [m for m in groups.values() if len(m) > 1]


def flag_same_name(rows, company_ids):
    """Mark dup_suspect=yes on every row of a same-name group; return the number of groups."""
    groups = same_name_groups(rows, company_ids)
    for members in groups:
        for i in members:
            rows[i]["dup_suspect"] = "yes"
    return len(groups)


# ----------------------------------------------------------------------------- row builders

def buyer_type_for(company_id, meta):
    """The per-company type from --buyer-type-map, else the --buyer-type default."""
    return (meta.get("buyer_type_map") or {}).get(company_id) or meta.get("buyer_type", "")


def lead_row(e, meta, websites):
    pos = current_position(e)
    name = e.get("fullName") or " ".join(x for x in (e.get("firstName"), e.get("lastName")) if x)
    company_id = urn_id(pos.get("companyUrn") or "")
    row = dict.fromkeys(validate_csv.LEAD_COLUMNS + validate_csv.LEAD_OPTIONAL_COLUMNS, "")
    row.update({
        "full_name": name,
        "title": pos.get("title", ""),
        "seniority": meta.get("seniority", ""),
        "company_name": pos.get("companyName", ""),
        "company_domain": domain_of(websites.get(company_id, "")),
        "salesnav_lead_url": lead_url(e.get("entityUrn")),
        "location": e.get("geoRegion", ""),
        "time_in_role": tenure(pos),
        "signals": "open profile" if e.get("openLink") else "",
        "buyer_type": buyer_type_for(company_id, meta),
        "shard": meta.get("shard", ""),
        "mode": meta.get("mode", "A"),
        "status": "collected",
        "collected_at": meta.get("collected_at", ""),
        "pending_invitation": pending_of(e),
        "degree": degree_of(e.get("degree")),
        "open_link": "yes" if e.get("openLink") is True else "",
    })
    return row, company_id


def account_row(e, meta, websites):
    company_id = urn_id(e.get("entityUrn") or "")
    row = dict.fromkeys(validate_csv.ACCOUNT_COLUMNS, "")
    row.update({
        "company_name": e.get("companyName") or e.get("name") or "",
        "company_domain": domain_of(websites.get(company_id, "")),
        "salesnav_account_url": COMPANY_URL + company_id if company_id else "",
        "industry": e.get("industry", ""),
        "headcount_band": headcount_band(e.get("employeeCountRange")),
        "hq_location": e.get("location", "") if isinstance(e.get("location"), str) else "",
        "buyer_type": buyer_type_for(company_id, meta),
        "shard": meta.get("shard", ""),
        "mode": meta.get("mode", "B"),
        "status": "collected",
        "collected_at": meta.get("collected_at", ""),
    })
    return row, company_id


def build_rows(kind, elements, websites, meta):
    """Return (rows, company_ids, duplicates_dropped). rows are dicts in column order.

    Leads are de-duplicated on the profile id (not the whole URL), accounts on the company id.
    """
    build = lead_row if kind == "leads" else account_row
    key = "salesnav_lead_url" if kind == "leads" else "salesnav_account_url"
    seen, rows, ids, dups = set(), [], [], 0
    for e in elements:
        row, company_id = build(e, meta, websites)
        person = profile_id(e.get("entityUrn")) if kind == "leads" else ""
        ident = (("profile", person) if person else
                 (key, row[key]) if row[key] else
                 ("name", row.get("full_name") or row.get("company_name"), company_id))
        if ident in seen:
            dups += 1
            continue
        seen.add(ident)
        rows.append(row)
        ids.append(company_id)
    if kind == "leads":
        flag_same_name(rows, ids)
    return rows, ids, dups


def write_csv(path, columns, rows, append=False):
    """Write rows to path; return the `columns` an existing --append file's header does not have.

    Appending to a non-empty file keeps that file's header: rows are written under it and any of
    `columns` it lacks are dropped (returned, so the caller can warn). A new or replaced file gets
    `columns` as its header.
    """
    exists = append and Path(path).is_file() and Path(path).stat().st_size > 0
    fields, dropped = list(columns), []
    if exists:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            header = [h.strip() for h in next(csv.reader(fh), [])]
        if header:
            fields = header
            dropped = [c for c in columns if c not in header]
        else:
            exists = False
    with open(path, "a" if append else "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        if not exists:
            writer.writeheader()
        writer.writerows(rows)
    return dropped


# ----------------------------------------------------------------------------- dup_suspect over a file

def _company_key(row):
    """The company a CSV row belongs to: its domain, else its normalised name ('' when neither)."""
    dom = (row.get("company_domain") or "").strip().lower()
    if dom:
        return "d:" + dom
    name = re.sub(r"\s+", " ", (row.get("company_name") or "").strip().lower())
    return "n:" + name if name else ""


def _row_person(row, index):
    """Profile id from salesnav_lead_url (rows without one count as different people)."""
    url = (row.get("salesnav_lead_url") or "").strip()
    if url.startswith(LEAD_URL):
        url = url[len(LEAD_URL):]
    return ("p", url.split(",", 1)[0].strip()) if url else ("row", index)


def flag_dups_rows(rows):
    """Recompute dup_suspect on CSV rows: yes on every row of a same-name, same-company group of
    two or more different profiles, blank elsewhere. Return (rows flagged, groups)."""
    groups = {}
    for i, row in enumerate(rows):
        row["dup_suspect"] = ""
        name = re.sub(r"\s+", " ", (row.get("full_name") or "").strip().lower())
        company = _company_key(row)
        if name and company:
            groups.setdefault((company, name), []).append(i)
    flagged = n_groups = 0
    for members in groups.values():
        if len({_row_person(rows[i], i) for i in members}) > 1:
            n_groups += 1
            for i in members:
                rows[i]["dup_suspect"] = "yes"
                flagged += 1
    return flagged, n_groups


def flag_dups_file(path, add_column=True):
    """Recompute dup_suspect over a whole leads CSV, in place (temp file, then an atomic rename).

    Returns (rows flagged, groups, added) where `added` says the dup_suspect column was missing and
    was appended. When the column is missing and add_column is False the file is left untouched and
    None is returned.
    """
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        header = [h.strip() for h in (reader.fieldnames or [])]
        if "full_name" not in header:
            raise ValueError("%s is not a leads CSV (no full_name column)" % path)
        reader.fieldnames = header
        rows = [{k: (v or "") for k, v in r.items() if k is not None} for r in reader]
    added = "dup_suspect" not in header
    if added:
        if not add_column:
            return None
        header = header + ["dup_suspect"]
    flagged, n_groups = flag_dups_rows(rows)
    fd, tmp = tempfile.mkstemp(dir=str(Path(path).resolve().parent), prefix=".flag_dups.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=header, extrasaction="ignore", lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return flagged, n_groups, added


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("kind", nargs="?", choices=["leads", "accounts"])
    ap.add_argument("inputs", nargs="*", help="JSONL / JSON files from a runtime run or saved responses")
    ap.add_argument("-o", "--out", help="CSV to write")
    ap.add_argument("--append", action="store_true",
                    help="append to --out instead of replacing it (keeps the file's header; "
                         "leads: dup_suspect is recomputed over the combined file)")
    ap.add_argument("--flag-dups", metavar="FILE",
                    help="only recompute dup_suspect over a whole leads CSV, in place (no input needed)")
    ap.add_argument("--mode", choices=validate_csv.MODES, help="A/B/C/D (default A for leads, B for accounts)")
    ap.add_argument("--buyer-type", default="", help="default buyer type for every row")
    ap.add_argument("--buyer-type-map", metavar="PATH",
                    help="per-company buyer type: JSON {company id: type}, or a CSV with buyer_type "
                         "and company_id / salesnav_account_url (an accounts.csv works)")
    ap.add_argument("--shard", default="")
    ap.add_argument("--seniority", default="", help="leads: the level the search was filtered on")
    ap.add_argument("--collected-at", default=date.today().isoformat(), help="YYYY-MM-DD (default today)")
    ap.add_argument("--company-ids", metavar="PATH",
                    help="leads: also write a salesnav_lead_url,company_id sidecar CSV")
    args = ap.parse_args(argv)

    if args.flag_dups:
        try:
            result = flag_dups_file(args.flag_dups)
        except (OSError, ValueError, csv.Error) as exc:
            print("error: %s" % exc, file=sys.stderr)
            return 1
        flagged, n_groups, added = result
        print("flag-dups: %d rows in %d same-name groups marked dup_suspect=yes in %s%s"
              % (flagged, n_groups, args.flag_dups, " (dup_suspect column added)" if added else ""),
              file=sys.stderr)
        return 0
    if not args.kind or not args.inputs or not args.out:
        ap.error("kind, at least one input and -o/--out are required (or use --flag-dups FILE)")

    try:
        elements, websites = load_inputs(args.inputs, args.kind)
    except OSError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    if not elements:
        print("error: no search elements found in the input", file=sys.stderr)
        return 1
    type_map, map_stats = {}, {}
    if args.buyer_type_map:
        try:
            type_map = load_buyer_type_map(args.buyer_type_map, map_stats)
        except (OSError, ValueError) as exc:
            print("error: %s" % exc, file=sys.stderr)
            return 1
        if map_stats.get("no_id"):
            print("warning: %d buyer-type map rows have no readable company id and were ignored"
                  % map_stats["no_id"], file=sys.stderr)
    meta = {"buyer_type_map": type_map, "mode": args.mode or ("A" if args.kind == "leads" else "B"),
            "buyer_type": args.buyer_type, "shard": args.shard,
            "seniority": args.seniority, "collected_at": args.collected_at}
    rows, ids, dups = build_rows(args.kind, elements, websites, meta)
    if args.buyer_type_map and type_map and not (set(ids) & set(type_map)):
        print("warning: the buyer-type map has %d entries but none match a company in these %s; "
              "every row keeps the --buyer-type default" % (len(type_map), args.kind), file=sys.stderr)
    columns = (validate_csv.LEAD_COLUMNS + validate_csv.LEAD_OPTIONAL_COLUMNS
               if args.kind == "leads" else validate_csv.ACCOUNT_COLUMNS)
    dropped = write_csv(args.out, columns, rows, append=args.append)
    if dropped:
        print("warning: %s has an older header; these columns are not in it and were dropped from the "
              "new rows: %s" % (args.out, ", ".join(dropped)), file=sys.stderr)
    if args.company_ids and args.kind == "leads":
        side = [{"salesnav_lead_url": r["salesnav_lead_url"], "company_id": cid}
                for r, cid in zip(rows, ids)]
        write_csv(args.company_ids, ["salesnav_lead_url", "company_id"], side, append=args.append)
    print("%s: %d rows written to %s (%d duplicates dropped, %d website records)"
          % (args.kind, len(rows), args.out, dups, len(websites)), file=sys.stderr)
    if args.kind == "leads" and args.append:
        try:
            result = flag_dups_file(args.out, add_column=False)
        except (OSError, ValueError, csv.Error) as exc:
            print("warning: could not recompute dup_suspect over %s: %s" % (args.out, exc), file=sys.stderr)
        else:
            if result is None:
                print("warning: %s has no dup_suspect column, so duplicates across runs were not checked; "
                      "run --flag-dups on it to add the column" % args.out, file=sys.stderr)
            elif result[1]:
                print("warning: %d rows in %d same-name groups within one account (across all runs in %s) "
                      "are marked dup_suspect=yes; check them before contacting"
                      % (result[0], result[1], args.out), file=sys.stderr)
    elif args.kind == "leads":
        groups = same_name_groups(rows, ids)
        if groups:
            print("warning: %d rows in %d same-name groups within one account are marked dup_suspect=yes; "
                  "check them before contacting" % (sum(len(g) for g in groups), len(groups)), file=sys.stderr)
    if type_map:
        typed = Counter(r["buyer_type"] or "(blank)" for r in rows)
        print("buyer types: " + ", ".join("%s=%d" % kv for kv in sorted(typed.items())), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
