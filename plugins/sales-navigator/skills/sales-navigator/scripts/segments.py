#!/usr/bin/env python3
"""Plan and merge a multi-segment account TAM: several industry-disjoint segments, one merged list.

  segments.py plan  --segments segments.json --region 103644278 --headcount B,C,D --out plan.json [--kind count|pull]
                    [--counts counts.json] [--only NAME[,NAME]]
  segments.py merge --pulls r1.jsonl [r2.jsonl ...] --out merged.csv

segments.json maps a segment name to its net:
  {"S1 retail health": {"industries": ["1359"], "keywords": "tincture OR syrup"},
   "S2 HWF": {"industries": ["3207"], "parts": {"B": ["B"], "CD": ["C", "D"]}, "max_rows": 600},
   ...}
  industries   INDUSTRY ids from typeahead.js (required)
  keywords     optional Boolean text, URL-encoded here (uppercase OR/AND/NOT, quotes)
  headcount    optional letters replacing --headcount for this segment
  parts        optional {part: [headcount letters]}: one search per part, named "<segment>-<part>" (split a
               segment over 1,000 by headcount band first)
  max_rows     optional: pull at most this many rows (a deliberate sample; 25-row pages)

`plan` writes a session.py plan (runtime/session.py --plan plan.json). --kind count (default): count.js over the
segments, 6 queries per call (more per call hit evaluate_timeout). --kind pull: account_search.js per segment, paged
25 at a time up to min(total, 1,000, max_rows), needing --counts (JSON {segment: total}, or a count run's JSONL).
Call ids are count_N and pull_<segment>; paged records are pull_<segment>#<start>. A plan over 200 pages is refused
(pick fewer segments with --only).

`merge` reads the pull records, dedupes by company id and writes id,name,industry,employeeCountRange,segment
(segment is pipe-joined when a company is in several). It prints "sum X, unique Y": segments overlap, so report both.

Exit codes: 0 ok, 2 bad input. Python 3 standard library only, no network.
"""
import argparse
import csv
import json
import math
import re
import sys
from urllib.parse import quote

VIEWABLE_CAP = 1000
PAGE_ROWS = 25
MAX_PAGES = 200
COUNT_CHUNK = 6
COLUMNS = ["id", "name", "industry", "employeeCountRange", "segment"]


class PlanError(ValueError):
    pass


def seg_id(name):
    """A call-id-safe segment name (no '#', no spaces)."""
    s = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name).strip()).strip("_")
    if not s:
        raise PlanError("empty segment name %r" % (name,))
    return s


def _letters(value, where):
    if not (isinstance(value, list) and value and all(isinstance(x, str) and re.fullmatch(r"[A-I]", x) for x in value)):
        raise PlanError("%s: headcount must be a list of letters A-I" % where)
    return value


def build_query(region, industries, headcount, keywords=""):
    def values(ids):
        return "values:List(%s)" % ",".join("(id:%s,selectionType:INCLUDED)" % i for i in ids)
    filters = ["(type:REGION,%s)" % values([region]), "(type:INDUSTRY,%s)" % values(industries),
               "(type:COMPANY_HEADCOUNT,%s)" % values(headcount)]
    query = "(filters:List(%s)" % ",".join(filters)
    if keywords:
        query += ",keywords:%s" % quote(keywords, safe="")
    return query + ")"


def load_segments(path):
    with open(path, encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if not (isinstance(data, dict) and data):
        raise PlanError("segments file must be a non-empty JSON object {name: {...}}")
    return data


def expand(segments, region, headcount, only=None):
    """-> [{"id", "query", "max_rows"}] one per search (a segment with `parts` gives one per part)."""
    if not re.fullmatch(r"\d+", str(region)):
        raise PlanError("--region must be a numeric REGION id")
    out, seen = [], set()
    for name, spec in segments.items():
        if only and name not in only and seg_id(name) not in only:
            continue
        if not isinstance(spec, dict):
            raise PlanError("%s: segment must be an object" % name)
        inds = spec.get("industries")
        if not (isinstance(inds, list) and inds and all(re.fullmatch(r"\d+", str(i)) for i in inds)):
            raise PlanError("%s: industries must be a list of numeric ids" % name)
        base = _letters(spec.get("headcount", headcount), name)
        max_rows = spec.get("max_rows")
        if max_rows is not None and not (isinstance(max_rows, int) and 1 <= max_rows <= VIEWABLE_CAP):
            raise PlanError("%s: max_rows must be 1..%d" % (name, VIEWABLE_CAP))
        parts = spec.get("parts") or {"": base}
        if not isinstance(parts, dict):
            raise PlanError("%s: parts must be an object {part: [letters]}" % name)
        for part, letters in parts.items():
            sid = seg_id(name) + ("-" + seg_id(part) if part else "")
            if sid in seen:
                raise PlanError("duplicate segment id %s" % sid)
            seen.add(sid)
            out.append({"id": sid, "max_rows": max_rows,
                        "query": build_query(str(region), [str(i) for i in inds], _letters(letters, sid),
                                             str(spec.get("keywords") or "").strip())})
    if not out:
        raise PlanError("no segments selected")
    return out


def load_counts(path):
    """{segment id: total} from a JSON object, or from a count.js run's records (JSONL / JSON)."""
    with open(path, encoding="utf-8-sig") as fh:
        text = fh.read().strip()
    try:
        docs = [json.loads(text)]
    except ValueError:
        docs = [json.loads(l) for l in text.splitlines() if l.strip()]
    counts = {}
    for doc in docs:
        if isinstance(doc, dict) and doc and all(isinstance(v, int) for v in doc.values()):
            counts.update({seg_id(k): v for k, v in doc.items()})
            continue
        result = doc.get("result") if isinstance(doc, dict) else None
        for r in (result or {}).get("results", []) if isinstance(result, dict) else []:
            if isinstance(r, dict) and r.get("status") == 200 and isinstance(r.get("total"), int):
                counts[seg_id(r.get("label", ""))] = r["total"]
    return counts


def base_plan(calls, max_pages_total=None):
    plan = {"start_url": "https://www.linkedin.com/sales/home", "settle_ms": 3000,
            "ready": {"snippet": "csrf_ready.js", "retries": 5, "interval_ms": 2000},
            "delay_ms": [3000, 5000], "calls": calls}
    if max_pages_total:
        plan["max_pages_total"] = max_pages_total
    return plan


def plan_count(searches):
    calls = []
    for n, i in enumerate(range(0, len(searches), COUNT_CHUNK), 1):
        queries = [{"label": s["id"], "query": s["query"]} for s in searches[i:i + COUNT_CHUNK]]
        calls.append({"id": "count_%d" % n, "snippet": "count.js", "params": {"kind": "account", "queries": queries}})
    return base_plan(calls)


def plan_pull(searches, counts):
    calls, pages_total, over = [], 0, []
    for s in searches:
        if s["id"] not in counts:
            raise PlanError("no count for %s: run `plan --kind count` first and pass --counts" % s["id"])
        total = counts[s["id"]]
        rows = min(total, VIEWABLE_CAP, s["max_rows"] or VIEWABLE_CAP)
        if total > VIEWABLE_CAP:
            over.append(s["id"])
        if rows < 1:
            continue
        pages = math.ceil(rows / PAGE_ROWS)
        pages_total += pages
        call = {"id": "pull_" + s["id"], "snippet": "account_search.js", "params": {"query": s["query"], "count": PAGE_ROWS},
                "pages": {"param": "start", "step": PAGE_ROWS, "cap": rows, "max_pages": pages}}
        if rows < total:
            call["sample"] = True   # a deliberate partial pull (cap or max_rows), not a short collection
        calls.append(call)
    if not calls:
        raise PlanError("nothing to pull: every count is 0")
    if pages_total > MAX_PAGES:
        raise PlanError("%d pages exceed the %d per run: pick fewer segments (--only) or set max_rows"
                        % (pages_total, MAX_PAGES))
    return base_plan(calls, pages_total), over


def cmd_plan(args):
    searches = expand(load_segments(args.segments), args.region, _letters(args.headcount.split(","), "--headcount"),
                      set(x.strip() for x in args.only.split(",")) if args.only else None)
    if args.kind == "count":
        plan, over = plan_count(searches), []
    else:
        if not args.counts:
            raise PlanError("--kind pull needs --counts")
        plan, over = plan_pull(searches, load_counts(args.counts))
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, indent=2)
        fh.write("\n")
    print("wrote %s: %d calls%s" % (args.out, len(plan["calls"]),
                                    ", %d pages" % plan["max_pages_total"] if args.kind == "pull" else ""))
    if over:
        print("WARN: over %d viewable, only the first %d rows are pullable: split by headcount band, then state: %s"
              % (VIEWABLE_CAP, VIEWABLE_CAP, ", ".join(over)), file=sys.stderr)
    return 0


def _records(path):
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


def company_id(element):
    m = re.search(r"(\d+)\)?$", element.get("entityUrn") or "")
    return m.group(1) if m else ""


def cmd_merge(args):
    pages = {}   # record id -> (segment, elements); a re-run of the same page replaces, never doubles
    for path in args.pulls:
        for rec in _records(path):
            rid, result = rec.get("id"), rec.get("result")
            if not (isinstance(rid, str) and rid.startswith("pull_") and rec.get("ok") and isinstance(result, dict)):
                continue
            seg = rid[len("pull_"):].split("#", 1)[0]
            pages[rid] = (seg, [e for e in result.get("elements") or [] if isinstance(e, dict)])
    merged, order, total, per = {}, [], 0, {}
    for seg, elements in pages.values():
        for e in elements:
            cid = company_id(e)
            if not cid:
                continue
            total += 1
            per[seg] = per.get(seg, 0) + 1
            row = merged.get(cid)
            if row is None:
                merged[cid] = row = {"id": cid, "name": e.get("companyName") or e.get("name") or "",
                                     "industry": e.get("industry") or "",
                                     "employeeCountRange": e.get("employeeCountRange") or "", "segment": []}
                order.append(cid)
            if seg not in row["segment"]:
                row["segment"].append(seg)
    if not merged:
        raise PlanError("no pull_<segment> account rows found in the inputs")
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        for cid in order:
            row = dict(merged[cid])
            row["segment"] = "|".join(row["segment"])
            w.writerow(row)
    print("segments: %s" % ", ".join("%s %d" % (s, n) for s, n in sorted(per.items())))
    print("sum %d, unique %d -> %s" % (total, len(merged), args.out))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan", help="build a session.py plan (counts or paged pulls) from segments.json")
    p.add_argument("--segments", required=True, metavar="FILE")
    p.add_argument("--region", required=True, metavar="ID", help="REGION id, e.g. 103644278 (United States)")
    p.add_argument("--headcount", default="B,C,D", metavar="LETTERS", help="default B,C,D")
    p.add_argument("--out", required=True, metavar="FILE")
    p.add_argument("--kind", choices=("count", "pull"), default="count")
    p.add_argument("--counts", metavar="FILE", help="counts per segment (needed for --kind pull)")
    p.add_argument("--only", metavar="NAMES", help="comma-separated segment names to include")
    m = sub.add_parser("merge", help="merge pull records into one deduped CSV with a segment column")
    m.add_argument("--pulls", required=True, nargs="+", metavar="FILE", help="session.py output JSONL files")
    m.add_argument("--out", required=True, metavar="FILE")
    args = ap.parse_args(argv)
    try:
        return cmd_plan(args) if args.cmd == "plan" else cmd_merge(args)
    except (PlanError, OSError, ValueError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
