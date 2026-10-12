#!/usr/bin/env python3
"""Normalize, de-duplicate and exclude rows in a Sales Nav accounts.csv or leads.csv.

The file type is detected from the columns (full_name -> leads, else company_name ->
accounts); override with --kind.

Normalization (applied to the output too):
  linkedin_url          -> https://www.linkedin.com/in/<slug>  (lowercase, no query,
                           fragment, trailing slash or sub-path like /details/...)
  salesnav_*_url,
  linkedin_company_url  -> https, lowercase host, query/fragment/trailing slash removed
  company_domain        -> bare lowercase domain (no scheme, www., port or path)

Duplicates (first row kept, empty fields filled in from later duplicates):
  leads     by linkedin_url or salesnav_lead_url; rows with neither URL are matched on
            full_name + company_domain (company_name if there is no domain)
  accounts  by company_domain or salesnav_account_url; rows with neither are matched
            on the normalized company_name (case, punctuation, Inc/LLC/Ltd ignored)

Exclusions (--exclude, repeatable): a .txt file (one entry per line, # comments) or a
.csv (every cell is an entry). Each entry is read as a LinkedIn URL, a domain
(acme.com) or a company name. --exclude-title-words removes leads whose title
contains any listed word (whole words, case-insensitive).

Prints counts: in, duplicates removed, excluded by reason, out. Removed rows go to
--removed with a removed_reason column. Exit code 0 on success, 1 on bad input.
"""
import argparse
import csv
import re
import sys
from collections import Counter
from urllib.parse import urlsplit

LEGAL_SUFFIXES = {"inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation",
                  "co", "company", "gmbh", "plc"}
HEADER_WORDS = {"domain", "company_domain", "company_name", "company", "name", "url",
                "website", "linkedin_url", "linkedin_company_url"}


# --- normalizers -----------------------------------------------------------------

def _split(url):
    u = (url or "").strip()
    if not u:
        return None
    if "://" not in u:
        u = "https://" + u.lstrip("/")
    try:
        return urlsplit(u)
    except ValueError:
        return None


def clean_url(url):
    """https, lowercase host (linkedin.com -> www.linkedin.com), no query/fragment/trailing slash."""
    parts = _split(url)
    if parts is None or not parts.hostname:
        return (url or "").strip()
    host = parts.hostname.lower()
    if host == "linkedin.com":
        host = "www.linkedin.com"
    return "https://" + host + parts.path.rstrip("/")


def normalize_linkedin_url(url):
    parts = _split(url)
    host = (parts.hostname or "").lower() if parts else ""
    if host == "linkedin.com" or host.endswith(".linkedin.com"):
        segs = [s for s in parts.path.split("/") if s]
        if len(segs) >= 2 and segs[0].lower() == "in":
            return "https://www.linkedin.com/in/" + segs[1].lower()
    return clean_url(url)


def normalize_domain(value):
    v = (value or "").strip().lower()
    v = re.sub(r"^[a-z][a-z0-9+.-]*://", "", v).lstrip("/")
    v = re.split(r"[/?#]", v, maxsplit=1)[0]
    v = v.rsplit("@", 1)[-1].split(":", 1)[0].rstrip(".")
    return v[4:] if v.startswith("www.") else v


def normalize_name(name):
    s = re.sub(r"[^\w\s]", " ", (name or "").lower().replace("&", " and ")).replace("_", " ")
    words = s.split()
    if words[:1] == ["the"] and len(words) > 1:
        words = words[1:]
    while len(words) > 1 and words[-1] in LEGAL_SUFFIXES:
        words.pop()
    return " ".join(words)


def normalize_row(row):
    for col in ("salesnav_lead_url", "salesnav_account_url", "linkedin_company_url"):
        if row.get(col):
            row[col] = clean_url(row[col])
    if row.get("linkedin_url"):
        row["linkedin_url"] = normalize_linkedin_url(row["linkedin_url"])
    if row.get("company_domain"):
        row["company_domain"] = normalize_domain(row["company_domain"])
    return row


# --- duplicate keys ----------------------------------------------------------------

def row_keys(row, kind):
    """Return (lookup_keys, register_keys). A row looks itself up by its strongest
    identifiers only, but registers every identifier so later rows can match it."""
    if kind == "leads":
        li, sn = row.get("linkedin_url", ""), row.get("salesnav_lead_url", "")
        name = " ".join(row.get("full_name", "").lower().split())
        where = row.get("company_domain", "") or normalize_name(row.get("company_name", ""))
        strong = ([("li", li.lower())] if li else []) + ([("sn", sn)] if sn else [])
        weak = [("nd", name + "|" + where)] if name and where else []
    else:
        dom, sn = row.get("company_domain", ""), row.get("salesnav_account_url", "")
        nm = normalize_name(row.get("company_name", ""))
        strong = ([("dom", dom)] if dom else []) + ([("sn", sn)] if sn else [])
        weak = [("nm", nm)] if nm else []
    return (strong or weak), strong + weak


def merge_empty(keep, other):
    for col, value in other.items():
        if value and not keep.get(col, ""):
            keep[col] = value


def dedupe_rows(rows, kind):
    """rows: list of dicts (already normalized). Returns (kept, duplicates)."""
    kept, dupes, index = [], [], {}
    for row in rows:
        lookup, register = row_keys(row, kind)
        hit = next((index[k] for k in lookup if k in index), None)
        if hit is None:
            kept.append(row)
            hit = len(kept) - 1
        else:
            merge_empty(kept[hit], row)
            dupes.append(row)
            register = row_keys(kept[hit], kind)[1]
        for key in register:
            index.setdefault(key, hit)
    return kept, dupes


# --- exclusions ----------------------------------------------------------------------

class Exclusions:
    def __init__(self):
        self.domains, self.names = set(), set()
        self.person_urls, self.company_urls = set(), set()

    def add(self, token):
        t = token.strip()
        low = t.lower()
        if not t:
            return
        if "linkedin.com" in low:
            if "/company/" in low or "/sales/company/" in low:
                self.company_urls.add(clean_url(t).lower())
            else:
                self.person_urls.add(normalize_linkedin_url(t).lower())
        elif re.fullmatch(r"(?:https?://)?(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?", low):
            self.domains.add(normalize_domain(t))
        else:
            name = normalize_name(t)
            if name:
                self.names.add(name)

    def reason(self, row):
        li, cu = row.get("linkedin_url", ""), row.get("linkedin_company_url", "")
        if li and li.lower() in self.person_urls:
            return "excluded:linkedin_url"
        if row.get("company_domain") and row["company_domain"] in self.domains:
            return "excluded:domain"
        if cu and cu.lower() in self.company_urls:
            return "excluded:linkedin_company_url"
        if row.get("company_name") and normalize_name(row["company_name"]) in self.names:
            return "excluded:company_name"
        return None


def load_exclusions(paths):
    ex = Exclusions()
    for path in paths:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            if path.lower().endswith(".csv"):
                for i, cells in enumerate(csv.reader(fh)):
                    cells = [c.strip() for c in cells if c.strip()]
                    if i == 0 and cells and all(c.lower() in HEADER_WORDS for c in cells):
                        continue
                    for c in cells:
                        ex.add(c)
            else:
                for line in fh:
                    if line.strip() and not line.lstrip().startswith("#"):
                        ex.add(line)
    return ex


def title_matcher(words):
    words = [w.strip() for w in words.split(",") if w.strip()]
    if not words:
        return None
    return re.compile(r"\b(?:%s)\b" % "|".join(re.escape(w) for w in words), re.I)


# --- file handling --------------------------------------------------------------------

def detect_kind(fieldnames):
    if "full_name" in fieldnames:
        return "leads"
    if "company_name" in fieldnames:
        return "accounts"
    raise ValueError("cannot tell accounts from leads: need a full_name or company_name column")


def read_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        fields = [f.strip() for f in (reader.fieldnames or [])]
        reader.fieldnames = fields
        rows = [{k: (v or "").strip() for k, v in r.items() if k is not None}
                for r in reader if any((v or "").strip() for v in r.values() if v)]
    if not fields:
        raise ValueError("%s is empty (no header row)" % path)
    return fields, rows


def write_rows(path, fields, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def clean(rows, kind, exclusions=None, title_re=None):
    """Normalize, dedupe, then exclude. Returns (kept, removed) where removed rows carry
    a 'removed_reason' key."""
    rows = [normalize_row(dict(r)) for r in rows]
    kept, dupes = dedupe_rows(rows, kind)
    removed = [dict(r, removed_reason="duplicate") for r in dupes]
    final = []
    for row in kept:
        reason = exclusions.reason(row) if exclusions else None
        if reason is None and title_re and kind == "leads" and title_re.search(row.get("title", "")):
            reason = "excluded:title_word"
        if reason:
            removed.append(dict(row, removed_reason=reason))
        else:
            final.append(row)
    return final, removed


def main(argv=None):
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input", help="accounts.csv or leads.csv")
    p.add_argument("--out", required=True, metavar="FILE", help="cleaned CSV to write")
    p.add_argument("--kind", choices=["auto", "accounts", "leads"], default="auto",
                   help="file type (default: detect from columns)")
    p.add_argument("--exclude", action="append", default=[], metavar="FILE",
                   help=".txt/.csv of domains, company names or LinkedIn URLs (repeatable)")
    p.add_argument("--exclude-title-words", default="", metavar="WORDS",
                   help="comma-separated words, e.g. 'intern,assistant,student' (leads only)")
    p.add_argument("--removed", metavar="FILE",
                   help="write removed rows here, with a removed_reason column")
    args = p.parse_args(argv)
    try:
        fields, rows = read_rows(args.input)
        kind = detect_kind(fields) if args.kind == "auto" else args.kind
        exclusions = load_exclusions(args.exclude) if args.exclude else None
        title_re = title_matcher(args.exclude_title_words)
        if title_re and kind != "leads":
            print("note: --exclude-title-words ignored (accounts have no title)", file=sys.stderr)
        final, removed = clean(rows, kind, exclusions, title_re)
        write_rows(args.out, fields, final)
        if args.removed:
            write_rows(args.removed, fields + ["removed_reason"], removed)
    except (OSError, ValueError, csv.Error) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    by_reason = Counter(r["removed_reason"] for r in removed)
    excluded = {k: v for k, v in by_reason.items() if k != "duplicate"}
    print("File type:          %s" % kind)
    print("Rows in:            %d" % len(rows))
    print("Duplicates removed: %d" % by_reason.get("duplicate", 0))
    print("Excluded:           %d" % sum(excluded.values()))
    for reason in sorted(excluded):
        print("  %-28s %d" % (reason, excluded[reason]))
    print("Rows out:           %d  -> %s" % (len(final), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
