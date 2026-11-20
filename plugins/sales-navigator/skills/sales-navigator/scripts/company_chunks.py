#!/usr/bin/env python3
"""Turn a list of company ids into Sales Navigator lead-search queries, at most 400 ids per query.

  company_chunks.py --csv accounts.csv [--column company_id] [--chunk 400] [--seniority 320,310]
                    [--filter-type CURRENT_COMPANY|PAST_COMPANY] [--titles "a,b"] [--recent-job-change]
                    [--extra-filters ',(type:...)'] [--out chunks.json]
  company_chunks.py --ids 1234,5678 ...

A `CURRENT_COMPANY` filter takes its ids in the URL, so the limit is URL length: 420 ids work, 480 are unreliable and
540 or more return HTTP 414 (reference.md, "Scope by many accounts"). Each query is therefore one chunk of at most 400
ids (--chunk may lower that, never raise it):

  (filters:List((type:CURRENT_COMPANY,values:List((id:urn%3Ali%3Aorganization%3A<id>,selectionType:INCLUDED),...))<extra>))

--seniority 320,310 appends a SENIORITY_LEVEL clause; --titles "a,b" a CURRENT_TITLE clause (free text, URL-encoded,
OR'd); --recent-job-change a RECENTLY_CHANGED_JOBS clause (id RPC); --extra-filters appends any raw filter clause(s)
(each starting with a comma) inside the same filters List. --filter-type PAST_COMPANY scopes by where the person USED TO
work (default CURRENT_COMPANY; same value shape and the same 400-id chunk limit).

Ids are read from a CSV column (default `company_id`) or --ids, must be numeric, and are deduped in first-seen order.

Prints (or writes to --out) a JSON list of {"chunk": n, "ids": count, "query": "..."}; chunk numbers start at 1.
Exit codes: 0 ok, 2 bad input. Python 3 standard library only, no network.
"""
import argparse
import csv
import json
import sys
from urllib.parse import quote

MAX_CHUNK = 400
FILTER_TYPES = ("CURRENT_COMPANY", "PAST_COMPANY")
RECENT_JOB_CHANGE = ",(type:RECENTLY_CHANGED_JOBS,values:List((id:RPC,selectionType:INCLUDED)))"
DEFAULT_COLUMN = "company_id"


class InputError(Exception):
    pass


def read_ids(args):
    """Numeric company ids in first-seen order, deduped. Raises InputError on a non-numeric value."""
    if bool(args.csv) == bool(args.ids):
        raise InputError("give exactly one of --csv or --ids")
    if args.csv:
        try:
            with open(args.csv, newline="", encoding="utf-8-sig") as fh:
                reader = csv.DictReader(fh)
                if args.column not in (reader.fieldnames or []):
                    raise InputError("column %r not found in %s (columns: %s)"
                                     % (args.column, args.csv, ", ".join(reader.fieldnames or []) or "none"))
                raw = [row[args.column] for row in reader]
        except OSError as exc:
            raise InputError("cannot read %s: %s" % (args.csv, exc))
    else:
        raw = args.ids.split(",")
    ids = []
    for value in raw:
        value = (value or "").strip()
        if not value:
            continue
        if not value.isascii() or not value.isdigit():
            raise InputError("company id %r is not numeric" % value)
        ids.append(value)
    return list(dict.fromkeys(ids))


def seniority_clause(text):
    levels = [v.strip() for v in text.split(",") if v.strip()]
    if not levels or not all(v.isascii() and v.isdigit() for v in levels):
        raise InputError("--seniority takes comma-separated numeric level ids, e.g. 320,310")
    return ",(type:SENIORITY_LEVEL,values:List(%s))" % ",".join(
        "(id:%s,selectionType:INCLUDED)" % v for v in levels)


def titles_clause(text):
    titles = [t.strip() for t in text.split(",") if t.strip()]
    if not titles:
        raise InputError("--titles takes comma-separated title words, e.g. \"operations manager,facilities\"")
    return ",(type:CURRENT_TITLE,values:List(%s))" % ",".join(
        "(text:%s,selectionType:INCLUDED)" % quote(t, safe="") for t in titles)


def build_chunks(ids, chunk, extra, filter_type=FILTER_TYPES[0]):
    out = []
    for n, start in enumerate(range(0, len(ids), chunk), 1):
        part = ids[start:start + chunk]
        values = ",".join("(id:urn%%3Ali%%3Aorganization%%3A%s,selectionType:INCLUDED)" % i for i in part)
        out.append({"chunk": n, "ids": len(part),
                    "query": "(filters:List((type:%s,values:List(%s))%s))" % (filter_type, values, extra)})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Chunk company ids into Sales Navigator lead-search queries.")
    ap.add_argument("--csv", help="CSV file holding the company ids")
    ap.add_argument("--column", default=DEFAULT_COLUMN, help="CSV column with the ids (default %s)" % DEFAULT_COLUMN)
    ap.add_argument("--ids", help="comma-separated company ids instead of a CSV")
    ap.add_argument("--chunk", type=int, default=MAX_CHUNK, help="ids per query (default and maximum %d)" % MAX_CHUNK)
    ap.add_argument("--seniority", help="comma-separated SENIORITY_LEVEL ids to add, e.g. 320,310")
    ap.add_argument("--filter-type", choices=FILTER_TYPES, default=FILTER_TYPES[0],
                    help="company filter: CURRENT_COMPANY (default) or PAST_COMPANY (people who used to work there)")
    ap.add_argument("--titles", help="comma-separated CURRENT_TITLE words to add (OR'd, URL-encoded here)")
    ap.add_argument("--recent-job-change", action="store_true",
                    help="add the RECENTLY_CHANGED_JOBS filter (id RPC)")
    ap.add_argument("--extra-filters", default="", help="raw filter clause(s) appended inside the filters List")
    ap.add_argument("--out", help="write the JSON here instead of printing it")
    args = ap.parse_args(argv)
    try:
        if not 1 <= args.chunk <= MAX_CHUNK:
            raise InputError("--chunk must be 1..%d (longer URLs return HTTP 414)" % MAX_CHUNK)
        ids = read_ids(args)
        if not ids:
            raise InputError("no company ids found")
        extra = ((seniority_clause(args.seniority) if args.seniority else "")
                 + (titles_clause(args.titles) if args.titles is not None else "")
                 + (RECENT_JOB_CHANGE if args.recent_job_change else "") + args.extra_filters)
    except InputError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    text = json.dumps(build_chunks(ids, args.chunk, extra, args.filter_type), indent=2) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote %d chunk(s) for %d ids to %s" % (-(-len(ids) // args.chunk), len(ids), args.out))
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
