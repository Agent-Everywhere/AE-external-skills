#!/usr/bin/env python3
"""Check an accounts.csv or leads.csv against references/output.md.

Checks:
  * headers: missing and extra columns (a different column ORDER is only a warning)
  * required fields not empty: accounts company_name, status, mode;
    leads full_name, company_name, status, mode
  * mode is one of A/B/C/D; status is one of the values listed in output.md
  * URL shape: salesnav_*_url, linkedin_company_url, linkedin_url (https://www.linkedin.com/...)
  * company_domain is a bare lowercase domain (no https://, www. or path)
  * collected_at is a real date written YYYY-MM-DD (blank is allowed)

The file type is detected from the columns (full_name -> leads, else accounts); override
with --kind. Prints the first --max-errors problems plus totals by column.
Exit code: 0 clean, 1 problems found or file unreadable.
"""
import argparse
import csv
import re
import sys
from collections import Counter
from datetime import datetime

# Source of truth: references/output.md (tests/test_sales_navigator_scripts.py fails if
# these drift from it). Update both together.
ACCOUNT_COLUMNS = [
    "company_name", "company_domain", "salesnav_account_url", "linkedin_company_url",
    "industry", "headcount_band", "hq_location", "signals", "buyer_type", "shard",
    "mode", "fit_notes", "status", "collected_at",
]
LEAD_COLUMNS = [
    "full_name", "title", "seniority", "company_name", "company_domain",
    "salesnav_lead_url", "linkedin_url", "location", "time_in_role", "signals",
    "dm_rank", "buyer_type", "shard", "mode", "status", "collected_at",
]
COLUMNS = {"accounts": ACCOUNT_COLUMNS, "leads": LEAD_COLUMNS}
REQUIRED = {"accounts": ["company_name", "status", "mode"],
            "leads": ["full_name", "company_name", "status", "mode"]}
STATUSES = {"accounts": ["collected", "qualified", "rejected", "no_dm_found"],
            "leads": ["collected", "qualified", "rejected"]}
MODES = ["A", "B", "C", "D"]

LI = r"https://www\.linkedin\.com"
URL_PATTERNS = {
    "salesnav_account_url": (LI + r"/sales/company/\S+", "https://www.linkedin.com/sales/company/..."),
    "salesnav_lead_url": (LI + r"/sales/lead/\S+", "https://www.linkedin.com/sales/lead/..."),
    "linkedin_company_url": (LI + r"/company/\S+", "https://www.linkedin.com/company/..."),
    "linkedin_url": (LI + r"/in/[^/?#\s]+(?:[/?#]\S*)?", "https://www.linkedin.com/in/<slug>"),
}
DOMAIN_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")


def detect_kind(headers):
    return "leads" if "full_name" in headers else "accounts"


def check_header(headers, kind):
    """Return (errors, warnings) as lists of strings."""
    expected = COLUMNS[kind]
    missing = [c for c in expected if c not in headers]
    extra = [c for c in headers if c not in expected]
    errors = []
    if missing:
        errors.append("header: missing columns: " + ", ".join(missing))
    if extra:
        errors.append("header: extra columns: " + ", ".join(extra))
    if len(set(headers)) != len(headers):
        errors.append("header: duplicate column names")
    warnings = []
    if not missing and not extra and headers != expected:
        warnings.append("header: columns are in a different order than output.md")
    return errors, warnings


def check_row(row, kind, headers):
    """Return a list of (column, code, detail) problems for one row (values stripped)."""
    problems = []
    present = set(headers)
    for col in REQUIRED[kind]:
        if col in present and not row.get(col):
            problems.append((col, "required", "must not be empty"))
    if row.get("mode") and row["mode"] not in MODES:
        problems.append(("mode", "enum", "%r is not one of %s" % (row["mode"], "/".join(MODES))))
    if row.get("status") and row["status"] not in STATUSES[kind]:
        problems.append(("status", "enum", "%r is not one of %s"
                         % (row["status"], "/".join(STATUSES[kind]))))
    for col, (pattern, example) in URL_PATTERNS.items():
        if row.get(col) and not re.fullmatch(pattern, row[col], re.I):
            problems.append((col, "url", "%r should look like %s" % (row[col], example)))
    dom = row.get("company_domain", "")
    if dom and (dom.startswith("www.") or not DOMAIN_RE.fullmatch(dom)):
        problems.append(("company_domain", "domain",
                         "%r should be a bare lowercase domain like acme.com" % dom))
    when = row.get("collected_at", "")
    if when:
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", when):
                raise ValueError(when)
            datetime.strptime(when, "%Y-%m-%d")
        except ValueError:
            problems.append(("collected_at", "date", "%r should be a real date as YYYY-MM-DD" % when))
    return problems


def validate(path, kind="auto"):
    """Return a result dict: kind, rows, header_errors, warnings, errors (row, col, code, detail)."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        headers = [h.strip() for h in next(reader, [])]
        if not headers:
            raise ValueError("%s is empty (no header row)" % path)
        kind = detect_kind(headers) if kind == "auto" else kind
        header_errors, warnings = check_header(headers, kind)
        errors, rows = [], 0
        for line_no, cells in enumerate(reader, start=2):  # spreadsheet row numbers
            if not any(c.strip() for c in cells):
                continue
            rows += 1
            if len(cells) != len(headers):
                errors.append((line_no, "(row)", "cells",
                               "has %d cells, header has %d" % (len(cells), len(headers))))
                continue
            row = {h: c.strip() for h, c in zip(headers, cells)}
            errors += [(line_no,) + prob for prob in check_row(row, kind, headers)]
    return {"kind": kind, "rows": rows, "header_errors": header_errors,
            "warnings": warnings, "errors": errors}


def report(result, max_errors):
    errs = result["errors"]
    lines = ["Checked %d %s rows" % (result["rows"], result["kind"])]
    lines += ["ERROR   " + e for e in result["header_errors"]]
    lines += ["WARNING " + w for w in result["warnings"]]
    for row, col, _code, detail in errs[:max_errors]:
        lines.append("ERROR   row %d: %s: %s" % (row, col, detail))
    if len(errs) > max_errors:
        lines.append("... %d more row errors not shown (raise --max-errors)" % (len(errs) - max_errors))
    if errs:
        lines.append("Row errors by column/check:")
        counts = Counter((col, code) for _r, col, code, _d in errs)
        lines += ["  %5d  %s (%s)" % (n, col, code) for (col, code), n in counts.most_common()]
    total = len(result["header_errors"]) + len(errs)
    bad_rows = len({e[0] for e in errs})
    lines.append("FAIL: %d errors (%d header, %d in %d rows)"
                 % (total, len(result["header_errors"]), len(errs), bad_rows) if total else "OK: no errors")
    return "\n".join(lines), total


def main(argv=None):
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input", help="accounts.csv or leads.csv")
    p.add_argument("--kind", choices=["auto", "accounts", "leads"], default="auto",
                   help="file type (default: detect from columns)")
    p.add_argument("--max-errors", type=int, default=20,
                   help="max row errors to print (default %(default)s); totals always shown")
    args = p.parse_args(argv)
    try:
        result = validate(args.input, args.kind)
    except (OSError, ValueError, csv.Error) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    text, total = report(result, args.max_errors)
    print(text)
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
