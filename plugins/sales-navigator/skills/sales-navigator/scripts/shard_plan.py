#!/usr/bin/env python3
"""Plan Sales Navigator search shards so every search stays under the result cap.

Sales Nav shows at most ~2,500 viewable results per search (references/gotchas.md #1).
Give this script the result counts you saw for each filter value, one dimension at a
time (geography, headcount band, industry, seniority...). Any shard over the cap is
split along the NEXT dimension you provided; shards still over the cap after the last
dimension are reported as "needs another dimension".

Dimensions are used in the order they first appear (input file first, then --dim flags).

Where does the count of a split shard come from?
  * If you give a conditional count (a `parent` column, or `headcount@geo=CA:...` in
    --dim), that real count is used.
  * Otherwise the parent's count is split in proportion to the overall counts of the
    next dimension. These numbers are marked "~" (estimates): run the search in Sales
    Nav and record the real count before relying on them.

Input forms (combine freely):
  --input FILE.csv    columns: dimension,value,count[,parent]
  --input FILE.json   [{"dimension":"geo","value":"TX","count":1800}, ...]
                      or {"geo": {"TX": 1800, "CA": 3100}, "headcount": {...}}
  --dim "geo:TX=1800,CA=3100"                  overall counts for one dimension
  --dim "headcount@geo=CA:11-50=900,51-200=1200"   counts inside the shard geo=CA
Counts may be written 1,800 or 2.5K. Values containing commas need a file, not --dim.

Exit code: 0 on success (even if some shards need another dimension; use --strict to
make that exit 1), 1 on bad input.
"""
import argparse
import csv
import json
import sys

DEFAULT_CAP = 2500
NEEDS_DIM = "needs another dimension"


def parse_count(text):
    """'1,800' -> 1800, '2.5K' -> 2500, '10K+' -> 10000. Raises ValueError otherwise."""
    s = str(text).strip().replace(",", "").replace("_", "").rstrip("+").strip()
    mult = 1
    if s[-1:] in ("k", "K"):
        mult, s = 1000, s[:-1]
    try:
        value = float(s) * mult
    except ValueError:
        raise ValueError("bad count %r" % (text,))
    if value < 0:
        raise ValueError("negative count %r" % (text,))
    return int(round(value))


def _row(dimension, value, count, parent=""):
    dimension, value = str(dimension).strip(), str(value).strip()
    if not dimension or not value:
        raise ValueError("dimension and value must not be empty")
    return {"dimension": dimension, "value": value,
            "count": parse_count(count), "parent": str(parent or "").strip()}


def load_json(path):
    with open(path, encoding="utf-8-sig") as fh:
        data = json.load(fh)
    rows = []
    if isinstance(data, dict):
        for dim, values in data.items():
            if not isinstance(values, dict):
                raise ValueError("JSON object form must be {dimension: {value: count}}")
            rows += [_row(dim, v, c) for v, c in values.items()]
    elif isinstance(data, list):
        for item in data:
            rows.append(_row(item["dimension"], item["value"], item["count"],
                             item.get("parent", "")))
    else:
        raise ValueError("JSON must be a list of rows or a {dimension: {value: count}} object")
    return rows


def load_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        reader.fieldnames = [(n or "").strip().lower() for n in (reader.fieldnames or [])]
        missing = {"dimension", "value", "count"} - set(reader.fieldnames)
        if missing:
            raise ValueError("CSV needs columns dimension,value,count (missing: %s)"
                             % ", ".join(sorted(missing)))
        return [_row(r["dimension"], r["value"], r["count"], r.get("parent", ""))
                for r in reader if any((v or "").strip() for v in r.values())]


def load_file(path):
    return load_json(path) if path.lower().endswith(".json") else load_csv(path)


def parse_dim_arg(text):
    """'headcount@geo=CA:11-50=900,51-200=1200' -> rows."""
    head, sep, rest = text.partition(":")
    if not sep or not rest.strip():
        raise ValueError("--dim must look like 'geo:TX=1800,CA=3100' (got %r)" % text)
    dim, _, parent = head.partition("@")
    rows = []
    for item in rest.split(","):
        value, eq, count = item.rpartition("=")
        if not eq:
            raise ValueError("--dim item %r must look like VALUE=COUNT" % item)
        rows.append(_row(dim, value, count, parent))
    return rows


def _norm_label(label):
    return " > ".join(p.strip().lower() for p in label.split(">"))


def build_plan(rows, cap=DEFAULT_CAP):
    """Return {'cap', 'dimensions', 'shards', 'total', 'over_cap'}."""
    if cap < 1:
        raise ValueError("cap must be at least 1")
    dims = []
    for r in rows:
        if r["dimension"] not in dims:
            dims.append(r["dimension"])
    if not dims:
        raise ValueError("no shard counts provided")
    shards = []

    def label(path):
        return " > ".join("%s=%s" % pv for pv in path)

    def add(path, count, estimated, status):
        shards.append({"shard": label(path), "filters": [list(pv) for pv in path],
                       "count": count, "estimated": estimated, "status": status})

    def visit(path, count, estimated, level):
        if count <= cap:
            return add(path, count, estimated, "ok")
        if level + 1 >= len(dims):
            return add(path, count, estimated, NEEDS_DIM)
        nxt = dims[level + 1]
        parent = _norm_label(label(path))
        kids = [(r["value"], r["count"]) for r in rows
                if r["dimension"] == nxt and r["parent"] and _norm_label(r["parent"]) == parent]
        kids_estimated = False
        if not kids:
            overall = [r for r in rows if r["dimension"] == nxt and not r["parent"]]
            total = sum(r["count"] for r in overall)
            if total <= 0:
                return add(path, count, estimated, NEEDS_DIM)
            kids = [(r["value"], int(round(count * r["count"] / total))) for r in overall]
            kids_estimated = True
        for value, kid_count in kids:
            visit(path + [(nxt, value)], kid_count, kids_estimated, level + 1)

    for r in rows:
        if r["dimension"] == dims[0]:
            visit([(dims[0], r["value"])], r["count"], False, 0)
    return {"cap": cap, "dimensions": dims, "shards": shards,
            "total": sum(s["count"] for s in shards),
            "over_cap": [s["shard"] for s in shards if s["status"] != "ok"]}


def render_table(plan):
    shards = plan["shards"]
    counts = [("~" if s["estimated"] else "") + format(s["count"], ",") for s in shards]
    wlabel = max([len("shard")] + [len(s["shard"]) for s in shards])
    wcount = max([len("count")] + [len(c) for c in counts])
    lines = ["Shard plan (cap %s; dimensions: %s)"
             % (format(plan["cap"], ","), " > ".join(plan["dimensions"])),
             "  #  %-*s  %*s  status" % (wlabel, "shard", wcount, "count")]
    for i, (s, c) in enumerate(zip(shards, counts), 1):
        lines.append("%3d  %-*s  %*s  %s" % (i, wlabel, s["shard"], wcount, c, s["status"]))
    lines.append("")
    lines.append("Total estimated TAM: %s across %d shards" % (format(plan["total"], ","), len(shards)))
    if any(s["estimated"] for s in shards):
        lines.append("~ = estimated by splitting the parent in proportion to the overall counts of "
                     "that dimension. Run the search in Sales Nav and record the real count.")
    if plan["over_cap"]:
        lines.append("")
        lines.append("%d shard(s) still over the cap after all dimensions (%s):"
                     % (len(plan["over_cap"]), NEEDS_DIM))
        lines += ["  - " + s for s in plan["over_cap"]]
    return "\n".join(lines)


def main(argv=None):
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input", "-i", action="append", default=[], metavar="FILE",
                   help="CSV or JSON of shard counts (repeatable)")
    p.add_argument("--dim", action="append", default=[], metavar="SPEC",
                   help="inline counts, e.g. 'geo:TX=1800,CA=3100' (repeatable)")
    p.add_argument("--cap", type=int, default=DEFAULT_CAP,
                   help="max results per shard (default %(default)s)")
    p.add_argument("--json", action="store_true", help="print the plan as JSON")
    p.add_argument("--strict", action="store_true",
                   help="exit 1 if any shard still needs another dimension")
    args = p.parse_args(argv)
    if not args.input and not args.dim:
        p.error("give at least one --input FILE or --dim SPEC")
    try:
        rows = []
        for path in args.input:
            rows += load_file(path)
        for spec in args.dim:
            rows += parse_dim_arg(spec)
        plan = build_plan(rows, args.cap)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    print(json.dumps(plan, indent=2) if args.json else render_table(plan))
    return 1 if args.strict and plan["over_cap"] else 0


if __name__ == "__main__":
    sys.exit(main())
