"""Tests for skills/sales-navigator/scripts/*.py (stdlib unittest, no network).

Run from the repo root:  python3 -m unittest discover -s tests -v
"""
import contextlib
import csv
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "sales-navigator"
SCRIPTS = SKILL / "scripts"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SCRIPTS))

import dedupe  # noqa: E402
import run_log  # noqa: E402
import shard_plan  # noqa: E402
import validate_csv  # noqa: E402


def run_main(module, argv):
    """Call module.main(argv) and return (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = module.main(argv)
        except SystemExit as exc:  # argparse errors
            code = exc.code
    return code, out.getvalue(), err.getvalue()


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def md_table_rows(markdown, heading):
    """Rows (list of cell lists) of the first table after a '## heading' line."""
    section = markdown.split("## " + heading, 1)[1].split("\n## ", 1)[0]
    rows = []
    for line in section.splitlines():
        if line.startswith("|") and not re.match(r"\|[-| ]+\|$", line.strip()):
            rows.append([c.strip() for c in line.strip().strip("|").split("|")])
    return rows[1:]  # drop the header row


class ScriptsAreRunnable(unittest.TestCase):
    def test_help_works_for_every_script(self):
        for name in ("shard_plan", "dedupe", "validate_csv", "run_log"):
            with self.subTest(script=name):
                proc = subprocess.run([sys.executable, str(SCRIPTS / (name + ".py")), "--help"],
                                      capture_output=True, text=True, timeout=30)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn("usage:", proc.stdout)

    def test_run_log_subcommand_help(self):
        for sub in ("add", "today"):
            proc = subprocess.run([sys.executable, str(SCRIPTS / "run_log.py"), sub, "--help"],
                                  capture_output=True, text=True, timeout=30)
            self.assertEqual(proc.returncode, 0, proc.stderr)


class ShardPlanTests(unittest.TestCase):
    def plan(self, specs, cap=2500):
        rows = []
        for s in specs:
            rows += shard_plan.parse_dim_arg(s)
        return shard_plan.build_plan(rows, cap)

    def test_parse_count_variants(self):
        self.assertEqual(shard_plan.parse_count("1,800"), 1800)
        self.assertEqual(shard_plan.parse_count("2.5K"), 2500)
        self.assertEqual(shard_plan.parse_count("10K+"), 10000)
        with self.assertRaises(ValueError):
            shard_plan.parse_count("lots")

    def test_everything_under_cap_is_not_split(self):
        plan = self.plan(["geo:TX=1800,CA=2500", "headcount:1-10=10,11-50=20"])
        self.assertEqual([s["shard"] for s in plan["shards"]], ["geo=TX", "geo=CA"])  # == cap is fine
        self.assertEqual(plan["total"], 4300)
        self.assertEqual(plan["over_cap"], [])

    def test_over_cap_shard_splits_proportionally_and_is_marked_estimated(self):
        plan = self.plan(["geo:TX=1000,NY=6000", "headcount:small=1000,mid=3000"])
        by_label = {s["shard"]: s for s in plan["shards"]}
        self.assertEqual(by_label["geo=NY > headcount=small"]["count"], 1500)
        self.assertEqual(by_label["geo=NY > headcount=mid"]["count"], 4500)
        self.assertTrue(by_label["geo=NY > headcount=small"]["estimated"])
        self.assertFalse(by_label["geo=TX"]["estimated"])
        self.assertEqual(plan["over_cap"], ["geo=NY > headcount=mid"])
        self.assertEqual(by_label["geo=NY > headcount=mid"]["status"], shard_plan.NEEDS_DIM)

    def test_recursion_uses_third_dimension_when_second_is_not_enough(self):
        plan = self.plan(["geo:NY=6000", "headcount:a=1,b=1", "seniority:x=1,y=1"])
        self.assertEqual([s["shard"] for s in plan["shards"]],
                         ["geo=NY > headcount=a > seniority=x", "geo=NY > headcount=a > seniority=y",
                          "geo=NY > headcount=b > seniority=x", "geo=NY > headcount=b > seniority=y"])
        self.assertTrue(all(s["count"] == 1500 and s["status"] == "ok" for s in plan["shards"]))
        self.assertEqual(plan["total"], 6000)

    def test_conditional_counts_override_the_estimate(self):
        plan = self.plan(["geo:CA=3100", "headcount@geo=CA:1-10=1000,11-50=1400,51-200=700",
                          "headcount:1-10=1,11-50=1,51-200=1"])
        self.assertEqual([s["count"] for s in plan["shards"]], [1000, 1400, 700])
        self.assertFalse(any(s["estimated"] for s in plan["shards"]))
        self.assertEqual(plan["total"], 3100)

    def test_no_next_dimension_reports_needs_another_dimension(self):
        plan = self.plan(["geo:TX=9000"])
        self.assertEqual(plan["over_cap"], ["geo=TX"])
        self.assertEqual(plan["shards"][0]["status"], shard_plan.NEEDS_DIM)

    def test_custom_cap(self):
        plan = self.plan(["geo:TX=900,CA=1200", "size:a=1,b=1"], cap=1000)
        self.assertEqual([s["shard"] for s in plan["shards"]],
                         ["geo=TX", "geo=CA > size=a", "geo=CA > size=b"])

    def test_csv_with_parent_column_and_json_input(self):
        rows = shard_plan.load_file(str(FIXTURES / "shards.csv"))
        plan = shard_plan.build_plan(rows)
        self.assertEqual(plan["total"], 1800 + 3100 + 6000)
        self.assertEqual(plan["over_cap"], ["geo=NY > headcount=51-200"])
        ny_big = [s for s in plan["shards"] if s["shard"] == "geo=NY > headcount=51-200"][0]
        self.assertEqual((ny_big["count"], ny_big["estimated"]), (3000, True))

        plan_json = shard_plan.build_plan(shard_plan.load_file(str(FIXTURES / "shards.json")))
        self.assertEqual(plan_json["dimensions"], ["geo", "headcount"])
        self.assertEqual(plan_json["total"], 7800)

    def test_bad_input_raises(self):
        with self.assertRaises(ValueError):
            shard_plan.parse_dim_arg("geo TX=1")
        with self.assertRaises(ValueError):
            shard_plan.parse_dim_arg("geo:TX")
        with self.assertRaises(ValueError):
            shard_plan.build_plan([])

    def test_cli_table_json_and_strict(self):
        code, out, _ = run_main(shard_plan, ["--dim", "geo:TX=1800,NY=9000"])
        self.assertEqual(code, 0)
        self.assertIn("Total estimated TAM: 10,800", out)
        self.assertIn("needs another dimension", out)
        code, out, _ = run_main(shard_plan, ["--dim", "geo:TX=1800,NY=9000", "--json"])
        self.assertEqual(json.loads(out)["total"], 10800)
        code, _, _ = run_main(shard_plan, ["--dim", "geo:TX=1800,NY=9000", "--strict"])
        self.assertEqual(code, 1)
        code, _, err = run_main(shard_plan, ["--input", "/no/such/file.csv"])
        self.assertEqual(code, 1)
        self.assertIn("error:", err)
        code, _, _ = run_main(shard_plan, [])
        self.assertEqual(code, 2)


class NormalizerTests(unittest.TestCase):
    def test_linkedin_url_edge_cases(self):
        n = dedupe.normalize_linkedin_url
        want = "https://www.linkedin.com/in/jane-doe"
        for raw in ("https://www.linkedin.com/in/jane-doe",
                    "HTTP://LinkedIn.com/in/Jane-Doe/?trk=x#top",
                    "linkedin.com/in/jane-doe/",
                    "  https://uk.linkedin.com/in/Jane-Doe/details/experience/?a=b  ",
                    "www.linkedin.com/in/jane-doe?utm_source=share"):
            self.assertEqual(n(raw), want, raw)
        self.assertEqual(n(""), "")

    def test_salesnav_and_company_urls(self):
        c = dedupe.clean_url
        self.assertEqual(c("https://www.linkedin.com/sales/lead/ACwAAA1,NAME_SEARCH,x?_ntb=abc#frag"),
                         "https://www.linkedin.com/sales/lead/ACwAAA1,NAME_SEARCH,x")
        self.assertEqual(c("http://LINKEDIN.com/sales/company/1234/"),
                         "https://www.linkedin.com/sales/company/1234")
        self.assertEqual(c(""), "")

    def test_company_domain(self):
        d = dedupe.normalize_domain
        self.assertEqual(d("https://www.AcmeWellness.com/about?x=1"), "acmewellness.com")
        self.assertEqual(d("HTTP://WWW.Acme.COM:8080/a/b#c"), "acme.com")
        self.assertEqual(d("www.acme.com"), "acme.com")
        self.assertEqual(d("sub.acme.co.uk/"), "sub.acme.co.uk")
        self.assertEqual(d("acme.com."), "acme.com")
        self.assertEqual(d("  "), "")

    def test_company_name(self):
        n = dedupe.normalize_name
        self.assertEqual(n("Acme Wellness, Inc."), "acme wellness")
        self.assertEqual(n("The Gamma and Company"), "gamma and")
        self.assertEqual(n("Gamma & Co"), "gamma and")  # '&' reads as 'and'; 'Co' is a legal suffix
        self.assertEqual(n("Inc"), "inc")  # never reduce a name to nothing


class DedupeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tmpdir = Path(self.tmp.name)

    def test_detects_kind_from_columns(self):
        self.assertEqual(dedupe.detect_kind(["full_name", "company_name"]), "leads")
        self.assertEqual(dedupe.detect_kind(["company_name", "company_domain"]), "accounts")
        with self.assertRaises(ValueError):
            dedupe.detect_kind(["foo", "bar"])

    def test_leads_dedupe_merges_by_url_and_name_domain(self):
        fields, rows = dedupe.read_rows(str(FIXTURES / "leads_sample.csv"))
        kept, removed = dedupe.clean(rows, "leads")
        names = [r["full_name"] for r in kept]
        # Jane x2 (same linkedin/salesnav url) and Ann/ann (same name + domain) collapse.
        self.assertEqual(names, ["Jane Doe", "Sam Lee", "Pat Kim", "Ann Roe", "Lee Fox", "Max Ray"])
        self.assertEqual([r["removed_reason"] for r in removed], ["duplicate", "duplicate"])
        jane = kept[0]
        self.assertEqual(jane["linkedin_url"], "https://www.linkedin.com/in/jane-doe")
        self.assertEqual(jane["salesnav_lead_url"], "https://www.linkedin.com/sales/lead/ACwAAA1")
        self.assertEqual(jane["title"], "Head of Product")      # first row wins
        self.assertEqual(jane["signals"], "open profile")        # empty field filled from the dupe
        self.assertEqual(kept[3]["company_domain"], "gamma.io")  # domain lowercased

    def test_leads_same_name_different_company_are_kept(self):
        rows = [{"full_name": "Al Poe", "company_domain": "a.com"},
                {"full_name": "Al Poe", "company_domain": "b.com"}]
        kept, removed = dedupe.clean(rows, "leads")
        self.assertEqual((len(kept), len(removed)), (2, 0))

    def test_url_less_lead_matches_earlier_lead_with_url(self):
        rows = [{"full_name": "Al Poe", "company_domain": "a.com", "linkedin_url": "linkedin.com/in/al"},
                {"full_name": "AL  POE", "company_domain": "A.com", "title": "CEO"}]
        kept, removed = dedupe.clean(rows, "leads")
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["title"], "CEO")

    def test_accounts_dedupe_by_domain_salesnav_url_and_name(self):
        fields, rows = dedupe.read_rows(str(FIXTURES / "accounts_sample.csv"))
        kept, removed = dedupe.clean(rows, "accounts")
        self.assertEqual([r["company_name"] for r in kept],
                         ["Acme Wellness", "Beta Labs", "Gamma & Co", "Rival Corp", "Customer One"])
        acme = kept[0]
        self.assertEqual(acme["company_domain"], "acmewellness.com")
        self.assertEqual(acme["salesnav_account_url"], "https://www.linkedin.com/sales/company/1234")
        self.assertEqual(acme["linkedin_company_url"], "https://www.linkedin.com/company/acme-wellness")
        self.assertEqual(acme["signals"], "hiring ops")
        self.assertEqual(acme["fit_notes"], "sells capsules")
        self.assertEqual(kept[1]["industry"], "Biotech")           # kept row's value survives merge
        # "The Gamma and Company" has no domain/url -> matched on normalized name "gamma and"
        self.assertEqual(len(removed), 3)

    def test_exclusions_by_domain_name_and_linkedin_url(self):
        ex = dedupe.load_exclusions([str(FIXTURES / "exclude.txt"), str(FIXTURES / "exclude.csv")])
        self.assertIn("rival.com", ex.domains)
        self.assertIn("customer1.com", ex.domains)       # csv header row 'domain' skipped
        self.assertNotIn("domain", ex.names)
        self.assertIn("customer one", ex.names)
        self.assertIn("beta labs", ex.names)
        self.assertEqual(ex.person_urls, {"https://www.linkedin.com/in/excluded-person"})

        _, acc_rows = dedupe.read_rows(str(FIXTURES / "accounts_sample.csv"))
        kept, removed = dedupe.clean(acc_rows, "accounts", ex)
        self.assertEqual([r["company_name"] for r in kept], ["Acme Wellness", "Gamma & Co"])
        reasons = {r["company_name"]: r["removed_reason"] for r in removed if r["removed_reason"] != "duplicate"}
        self.assertEqual(reasons["Rival Corp"], "excluded:domain")
        self.assertEqual(reasons["Customer One"], "excluded:domain")      # www.customer1.com normalized
        self.assertEqual(reasons["Beta Labs"], "excluded:company_name")

        _, lead_rows = dedupe.read_rows(str(FIXTURES / "leads_sample.csv"))
        kept, removed = dedupe.clean(lead_rows, "leads", ex)
        by_reason = {r["full_name"]: r["removed_reason"] for r in removed if r["removed_reason"] != "duplicate"}
        self.assertEqual(by_reason["Lee Fox"], "excluded:domain")
        self.assertEqual(by_reason["Max Ray"], "excluded:linkedin_url")
        self.assertEqual(by_reason["Pat Kim"], "excluded:company_name")

    def test_exclude_title_words_match_whole_words_only(self):
        rx = dedupe.title_matcher("intern, assistant ,student")
        self.assertTrue(rx.search("Marketing Intern"))
        self.assertTrue(rx.search("executive ASSISTANT to CEO"))
        self.assertFalse(rx.search("International Sales Director"))
        self.assertIsNone(dedupe.title_matcher(" , "))
        rows = [{"full_name": "A", "title": "Marketing Intern", "company_domain": "x.com"},
                {"full_name": "B", "title": "International Director", "company_domain": "x.com"}]
        kept, removed = dedupe.clean(rows, "leads", None, rx)
        self.assertEqual([r["full_name"] for r in kept], ["B"])
        self.assertEqual(removed[0]["removed_reason"], "excluded:title_word")

    def test_cli_counts_and_removed_file(self):
        out_path, removed_path = self.tmpdir / "out.csv", self.tmpdir / "removed.csv"
        code, out, err = run_main(dedupe, [
            str(FIXTURES / "leads_sample.csv"), "--out", str(out_path),
            "--exclude", str(FIXTURES / "exclude.txt"), "--exclude", str(FIXTURES / "exclude.csv"),
            "--exclude-title-words", "intern,assistant,student", "--removed", str(removed_path)])
        self.assertEqual(code, 0, err)
        self.assertIn("Rows in:            8", out)
        self.assertIn("Duplicates removed: 2", out)
        self.assertIn("Excluded:           4", out)
        self.assertIn("excluded:title_word", out)
        self.assertIn("Rows out:           2", out)
        self.assertEqual([r["full_name"] for r in read_csv(out_path)], ["Jane Doe", "Ann Roe"])
        removed = read_csv(removed_path)
        self.assertEqual(len(removed), 6)
        self.assertEqual({r["removed_reason"] for r in removed},
                         {"duplicate", "excluded:domain", "excluded:linkedin_url",
                          "excluded:company_name", "excluded:title_word"})
        with open(out_path, encoding="utf-8") as fh:  # header preserved exactly
            self.assertEqual(fh.readline().strip(),
                             (FIXTURES / "leads_sample.csv").read_text().splitlines()[0])

    def test_cli_errors(self):
        code, _, err = run_main(dedupe, ["/no/such.csv", "--out", str(self.tmpdir / "o.csv")])
        self.assertEqual(code, 1)
        self.assertIn("error:", err)
        bad = self.tmpdir / "bad.csv"
        bad.write_text("foo,bar\n1,2\n")
        code, _, err = run_main(dedupe, [str(bad), "--out", str(self.tmpdir / "o.csv")])
        self.assertEqual(code, 1)
        self.assertIn("cannot tell", err)


class ValidateCsvTests(unittest.TestCase):
    def test_constants_match_output_md(self):
        md = (SKILL / "references" / "output.md").read_text(encoding="utf-8")
        for kind, heading in (("accounts", "accounts.csv"), ("leads", "leads.csv")):
            rows = md_table_rows(md, heading)
            self.assertEqual([r[0] for r in rows], validate_csv.COLUMNS[kind], kind)
            status_note = [r[-1] for r in rows if r[0] == "status"][0]
            self.assertEqual([s.strip() for s in status_note.split("/")],
                             validate_csv.STATUSES[kind], kind)

    def test_clean_files_pass(self):
        # The raw fixtures carry deliberately dirty URLs/domains, so build clean rows in code.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "leads.csv"
            row = {c: "" for c in validate_csv.LEAD_COLUMNS}
            row.update(full_name="Jane Doe", company_name="Acme", company_domain="acme.com",
                       salesnav_lead_url="https://www.linkedin.com/sales/lead/ACwAAA1,NAME_SEARCH",
                       linkedin_url="https://www.linkedin.com/in/jane-doe", mode="A",
                       status="collected", collected_at="2026-10-13")
            with open(path, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=validate_csv.LEAD_COLUMNS)
                w.writeheader()
                w.writerow(row)
            code, out, _ = run_main(validate_csv, [str(path)])
            self.assertEqual(code, 0, out)
            self.assertIn("OK: no errors", out)

    def test_dedupe_output_of_accounts_fixture_validates(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = Path(tmp) / "accounts.csv"
            self.assertEqual(run_main(dedupe, [str(FIXTURES / "accounts_sample.csv"),
                                               "--out", str(out_path)])[0], 0)
            code, out, _ = run_main(validate_csv, [str(out_path)])
            self.assertEqual(code, 0, out)

    def test_bad_rows_report_every_kind_of_problem(self):
        result = validate_csv.validate(str(FIXTURES / "leads_bad.csv"))
        self.assertEqual(result["kind"], "leads")
        self.assertEqual(result["rows"], 4)
        self.assertEqual(result["header_errors"], [])
        found = {(row, col, code) for row, col, code, _ in result["errors"]}
        self.assertEqual({r for r, _, _ in found}, {3, 4, 5})   # row 2 is clean
        for expected in [(3, "full_name", "required"), (3, "company_name", "required"),
                         (3, "mode", "enum"), (3, "status", "enum"),
                         (3, "company_domain", "domain"), (3, "salesnav_lead_url", "url"),
                         (3, "linkedin_url", "url"), (3, "collected_at", "date"),
                         (4, "company_domain", "domain"), (4, "collected_at", "date"),
                         (5, "(row)", "cells")]:
            self.assertIn(expected, found)

    def test_header_missing_extra_and_order(self):
        result = validate_csv.validate(str(FIXTURES / "leads_bad_header.csv"))
        text = "\n".join(result["header_errors"])
        self.assertIn("missing columns", text)
        self.assertIn("seniority", text)
        self.assertIn("extra columns: notes", text)
        # reordered-but-complete header is only a warning
        errors, warnings = validate_csv.check_header(list(reversed(validate_csv.ACCOUNT_COLUMNS)), "accounts")
        self.assertEqual(errors, [])
        self.assertEqual(len(warnings), 1)

    def test_accounts_enum_allows_no_dm_found_but_leads_do_not(self):
        acc = {"company_name": "A", "status": "no_dm_found", "mode": "B"}
        self.assertEqual(validate_csv.check_row(acc, "accounts", validate_csv.ACCOUNT_COLUMNS), [])
        lead = {"full_name": "A", "company_name": "B", "status": "no_dm_found", "mode": "A"}
        probs = validate_csv.check_row(lead, "leads", validate_csv.LEAD_COLUMNS)
        self.assertEqual([(c, k) for c, k, _ in probs], [("status", "enum")])

    def test_url_and_date_shape_rules(self):
        cols = validate_csv.LEAD_COLUMNS
        base = {"full_name": "A", "company_name": "B", "status": "collected", "mode": "A"}
        def problems(**kw):
            return [(c, k) for c, k, _ in validate_csv.check_row(dict(base, **kw), "leads", cols)]
        self.assertEqual(problems(linkedin_url="https://www.linkedin.com/in/jane-doe/"), [])
        self.assertEqual(problems(linkedin_url="https://www.linkedin.com/sales/lead/ACw"), [("linkedin_url", "url")])
        self.assertEqual(problems(linkedin_url="linkedin.com/in/jane"), [("linkedin_url", "url")])
        self.assertEqual(problems(company_domain="Acme.com"), [("company_domain", "domain")])
        self.assertEqual(problems(company_domain="acme"), [("company_domain", "domain")])
        self.assertEqual(problems(company_domain="acme.com"), [])
        self.assertEqual(problems(collected_at="2026-1-5"), [("collected_at", "date")])
        self.assertEqual(problems(collected_at="2024-02-29"), [])
        self.assertEqual(problems(collected_at="2025-02-29"), [("collected_at", "date")])

    def test_cli_exit_codes_and_error_cap(self):
        code, out, _ = run_main(validate_csv, [str(FIXTURES / "leads_bad.csv"), "--max-errors", "3"])
        self.assertEqual(code, 1)
        self.assertIn("more row errors not shown", out)
        self.assertIn("Row errors by column/check", out)
        self.assertIn("FAIL:", out)
        self.assertEqual(sum(1 for line in out.splitlines() if line.startswith("ERROR   row")), 3)
        code, out, _ = run_main(validate_csv, [str(FIXTURES / "leads_bad_header.csv")])
        self.assertEqual(code, 1)
        self.assertIn("ERROR   header: missing columns", out)
        code, _, err = run_main(validate_csv, ["/no/such.csv"])
        self.assertEqual(code, 1)
        self.assertIn("error:", err)

    def test_empty_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "e.csv"
            empty.write_text("")
            code, _, err = run_main(validate_csv, [str(empty)])
            self.assertEqual(code, 1)
            self.assertIn("empty", err)


class RunLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = str(Path(self.tmp.name) / "run_log.csv")

    def test_constants_match_guardrails_md(self):
        md = (SKILL / "references" / "guardrails.md").read_text(encoding="utf-8")
        rows = {r[0]: r for r in md_table_rows(md, "Daily volume defaults")}
        expect = {"Search result pages read": "pages", "Individual profiles opened": "profiles",
                  "Small API calls (counts, typeahead, website batches)": "small_calls",
                  "Account pages opened": "accounts", "Saved searches created": "saved_searches"}
        for label, key in expect.items():
            default = int(re.match(r"\d+", rows[label][1]).group())
            ceiling = int(re.match(r"\d+", rows[label][2]).group())
            self.assertEqual(run_log.LIMITS[key], {"default": default, "ceiling": ceiling}, label)

    def test_classify_thresholds(self):
        lim = {"default": 40, "ceiling": 80}
        c = run_log.classify
        self.assertEqual(c(0, lim), "OK")
        self.assertEqual(c(31, lim), "OK")
        self.assertEqual(c(32, lim), "NEAR")       # exactly 80% of default
        self.assertEqual(c(40, lim), "NEAR")       # at the default is not over it
        self.assertEqual(c(41, lim), "OVER DEFAULT")
        self.assertEqual(c(80, lim), "OVER DEFAULT")  # at the ceiling is not past it
        self.assertEqual(c(81, lim), "OVER CEILING")

    def test_add_then_today_sums_the_local_date(self):
        for argv in (["add", "--pages", "10", "--profiles", "5"], ["add", "--pages", "25"]):
            code, out, err = run_main(run_log, argv + ["--log", self.log])
            self.assertEqual(code, 0, err)
        code, out, _ = run_main(run_log, ["today", "--log", self.log])
        self.assertEqual(code, 0)
        pages = [l for l in out.splitlines() if l.startswith("pages")][0].split()
        self.assertEqual(pages[1:], ["35", "40", "80", "NEAR"])
        profiles = [l for l in out.splitlines() if l.startswith("profiles")][0].split()
        self.assertEqual(profiles[1:], ["5", "80", "150", "OK"])
        lines = Path(self.log).read_text().splitlines()
        self.assertEqual(lines[0], "date,time,pages,profiles,accounts,saved_searches,small_calls,note")
        self.assertEqual(len(lines), 3)
        self.assertEqual(read_csv(self.log)[0]["pages"], "10")
        self.assertEqual(read_csv(self.log)[0]["date"], date.today().isoformat())

    def write_rows(self, *rows):
        with open(self.log, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(run_log.COLUMNS)
            for r in rows:
                w.writerow(r)

    def test_other_days_are_not_counted(self):
        today = date.today()
        yesterday = today - timedelta(days=1)
        self.write_rows((yesterday.isoformat(), "09:00:00", 79, 0, 0, 0, 0, ""),
                        ("not-a-date", "09:00:00", 5, 0, 0, 0, 0, ""),
                        (today.isoformat(), "10:00:00", 3, 0, 0, 0, 0, "x"))
        with contextlib.redirect_stderr(io.StringIO()):
            entries = run_log.read_entries(self.log)
        self.assertEqual(len(entries), 2)
        self.assertEqual(run_log.totals_for(entries, today)["pages"], 3)
        self.assertEqual(run_log.totals_for(entries, yesterday)["pages"], 79)
        code, out, err = run_main(run_log, ["today", "--log", self.log])
        self.assertEqual(code, 0)
        self.assertIn("line 3 skipped", err)

    def test_dates_are_local_calendar_dates_written_as_text(self):
        entries = [{"date": "2026-03-10", "time": "23:30:00", "pages": 7}]
        self.assertEqual(run_log.totals_for(entries, date(2026, 3, 10))["pages"], 7)
        self.assertEqual(run_log.totals_for(entries, date(2026, 3, 11))["pages"], 0)
        # the row written by `add` carries the local date and time
        now = datetime(2026, 3, 10, 23, 30, 5)
        run_log.append_entry(self.log, dict(dict.fromkeys(run_log.LIMITS, 0), pages=2), "late", now=now)
        row = read_csv(self.log)[0]
        self.assertEqual((row["date"], row["time"], row["pages"], row["note"]), ("2026-03-10", "23:30:05", "2", "late"))

    def test_wrong_header_is_an_error_not_silently_empty(self):
        Path(self.log).write_text("a,b\n1,2\n")
        code, _, err = run_main(run_log, ["today", "--log", self.log])
        self.assertEqual(code, 1)
        self.assertIn("header must be", err)

    def test_over_ceiling_exits_2_and_over_default_exits_0(self):
        code, out, _ = run_main(run_log, ["add", "--pages", "41", "--log", self.log])
        self.assertEqual(code, 0)
        self.assertIn("OVER DEFAULT", out)
        self.assertIn("explicit go", out)
        code, out, _ = run_main(run_log, ["add", "--pages", "40", "--log", self.log])
        self.assertEqual(code, 2)            # 81 > ceiling 80
        self.assertIn("OVER CEILING", out)
        self.assertIn("STOP", out)
        code, _, _ = run_main(run_log, ["today", "--log", self.log])
        self.assertEqual(code, 2)

    def test_limits_file_override(self):
        limits = Path(self.tmp.name) / "limits.json"
        limits.write_text(json.dumps({"pages": {"default": 10, "ceiling": 12}}))
        code, out, _ = run_main(run_log, ["add", "--pages", "13", "--log", self.log,
                                          "--limits-file", str(limits)])
        self.assertEqual(code, 2)
        row = [l for l in out.splitlines() if l.startswith("pages")][0].split()
        self.assertEqual(row[1:], ["13", "10", "12", "OVER", "CEILING"])
        # untouched actions keep the built-in numbers
        self.assertEqual(run_log.load_limits(str(limits))["profiles"], run_log.LIMITS["profiles"])

    def test_bad_limits_and_inputs_exit_1(self):
        limits = Path(self.tmp.name) / "limits.json"
        for bad in ({"pages": {"default": 50, "ceiling": 10}}, {"nope": {"default": 1}},
                    {"pages": {"default": "x"}}, [1, 2]):
            limits.write_text(json.dumps(bad))
            code, _, err = run_main(run_log, ["today", "--log", self.log, "--limits-file", str(limits)])
            self.assertEqual(code, 1, bad)
            self.assertIn("error:", err)
        code, _, err = run_main(run_log, ["add", "--log", self.log])
        self.assertEqual(code, 1)
        self.assertIn("nothing to add", err)
        code, _, _ = run_main(run_log, ["add", "--pages", "-1", "--log", self.log])
        self.assertEqual(code, 1)
        code, _, _ = run_main(run_log, ["today", "--log", self.log, "--date", "yesterday"])
        self.assertEqual(code, 1)

    def test_today_with_no_log_file_is_all_ok(self):
        code, out, _ = run_main(run_log, ["today", "--log", self.log])
        self.assertEqual(code, 0)
        self.assertEqual(out.count("OK"), 5)

    def test_small_calls_are_counted_against_their_guardrail(self):
        code, out, _ = run_main(run_log, ["add", "--small-calls", "125", "--log", self.log])
        row = [l for l in out.splitlines() if l.startswith("small_calls")][0].split()
        self.assertEqual((code, row[1], row[2], row[3], row[4]), (0, "125", "150", "200", "NEAR"))
        code, out, _ = run_main(run_log, ["add", "--small-calls", "30", "--log", self.log])
        self.assertEqual(code, 0)
        self.assertIn("OVER DEFAULT", [l for l in out.splitlines() if l.startswith("small_calls")][0])
        code, out, _ = run_main(run_log, ["add", "--small-calls", "50", "--log", self.log])
        self.assertEqual(code, 2)
        self.assertIn("OVER CEILING", out)

    def test_small_call_default_is_150_with_a_200_ceiling(self):
        self.assertEqual(run_log.LIMITS["small_calls"], {"default": 150, "ceiling": 200})
        # 150 calls (a 50-account pull plus sizing and lookups) is still inside the default
        code, out, _ = run_main(run_log, ["add", "--small-calls", "150", "--log", self.log])
        line = [l for l in out.splitlines() if l.startswith("small_calls")][0]
        self.assertEqual(code, 0)
        self.assertNotIn("OVER", line)

    def test_cap_messages_tell_the_agent_to_report_remaining_rows_and_offer_a_choice(self):
        _, out, _ = run_main(run_log, ["add", "--small-calls", "151", "--log", self.log])
        self.assertIn("how many rows remain", out)
        self.assertIn("continue tomorrow or raise today's cap with their explicit OK", out)
        _, out, _ = run_main(run_log, ["add", "--small-calls", "60", "--log", self.log])
        self.assertIn("how many rows remain", out)
        self.assertIn("offer to continue tomorrow", out)

    def test_saved_searches_flag_is_recorded(self):
        run_main(run_log, ["add", "--saved-searches", "9", "--log", self.log])
        code, out, _ = run_main(run_log, ["today", "--log", self.log])
        row = [l for l in out.splitlines() if l.startswith("saved_searches")][0].split()
        self.assertEqual(row[1:], ["9", "10", "25", "NEAR"])


class DedupePreservesQualifyColumns(unittest.TestCase):
    """facts / fit_reason / keep (references/qualify.md) must survive normalisation and de-duplication."""

    FIELDS = validate_csv.ACCOUNT_COLUMNS + validate_csv.QUALIFY_COLUMNS

    def rows(self):
        base = dict.fromkeys(self.FIELDS, "")
        base.update(mode="B", collected_at="2026-10-13")
        return [
            dict(base, company_name="Acme Wellness", company_domain="https://www.acme.com/about",
                 salesnav_account_url="https://www.linkedin.com/sales/company/1/", facts="sells vitamins; ships to retailers",
                 fit_reason="fits buyer type A", keep="keep", status="qualified"),
            dict(base, company_name="Acme Wellness Inc", company_domain="acme.com", facts="",
                 fit_reason="", keep="", status="collected"),
            dict(base, company_name="Bright Foods", company_domain="brightfoods.co", facts="b2b only",
                 fit_reason="wrong buyer", keep="drop", status="qualified"),
            dict(base, company_name="Maybe Ltd", company_domain="maybe.example", keep="unsure", status="qualified"),
        ]

    def test_columns_and_values_survive_dedupe_and_a_csv_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, out, removed = (Path(tmp) / n for n in ("in.csv", "out.csv", "removed.csv"))
            dedupe.write_rows(src, self.FIELDS, self.rows())
            code = dedupe.main([str(src), "--out", str(out), "--removed", str(removed)])
            self.assertEqual(code, 0)
            with open(out, newline="", encoding="utf-8") as fh:
                reader = csv.DictReader(fh)
                header, kept = reader.fieldnames, list(reader)
            self.assertEqual(header, self.FIELDS)
            self.assertTrue({"facts", "fit_reason", "keep"} <= set(header))
            by_name = {r["company_name"]: r for r in kept}
            self.assertEqual(sorted(by_name), ["Acme Wellness", "Bright Foods", "Maybe Ltd"])
            acme = by_name["Acme Wellness"]
            self.assertEqual((acme["facts"], acme["fit_reason"], acme["keep"]),
                             ("sells vitamins; ships to retailers", "fits buyer type A", "keep"))
            self.assertEqual((by_name["Bright Foods"]["keep"], by_name["Bright Foods"]["fit_reason"]), ("drop", "wrong buyer"))
            self.assertEqual(by_name["Maybe Ltd"]["keep"], "unsure")
            with open(removed, newline="", encoding="utf-8") as fh:
                gone = list(csv.DictReader(fh))
            self.assertEqual([(r["company_name"], r["removed_reason"]) for r in gone], [("Acme Wellness Inc", "duplicate")])
            self.assertEqual(run_main(validate_csv, [str(out)])[0], 0)  # still a valid accounts file

    def test_a_duplicate_fills_in_blank_qualify_cells_but_never_overwrites_them(self):
        rows = self.rows()
        rows[0]["keep"] = ""            # first row has not been judged yet ...
        rows[1]["keep"] = "drop"        # ... its duplicate has
        rows[1]["facts"] = "should not replace"
        kept, dupes = dedupe.dedupe_rows([dedupe.normalize_row(dict(r)) for r in rows[:2]], "accounts")
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["keep"], "drop")  # blank filled from the duplicate
        self.assertEqual(kept[0]["facts"], "sells vitamins; ships to retailers")  # non-blank kept
        self.assertEqual(kept[0]["fit_reason"], "fits buyer type A")


class DedupeKeepsOptionalLeadColumns(unittest.TestCase):
    def test_round_trip_keeps_the_four_optional_columns_and_their_values(self):
        cols = validate_csv.LEAD_COLUMNS + validate_csv.LEAD_OPTIONAL_COLUMNS

        def row(name, pid, **kw):
            r = {**dict.fromkeys(cols, ""),
                 "full_name": name, "company_name": "Zed", "company_domain": "zed.com", "status": "collected",
                 "mode": "A", "salesnav_lead_url": "https://www.linkedin.com/sales/lead/%s,N,x" % pid}
            return {**r, **kw}
        rows = [row("Jo Park", "A", pending_invitation="no", degree="2nd", open_link="yes", dup_suspect="yes"),
                row("Jo Park", "B", pending_invitation="yes", degree="3rd", dup_suspect="yes"),
                row("Al Roe", "C", pending_invitation="", degree="1st")]
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "in.csv", Path(tmp) / "out.csv"
            with open(src, "w", newline="", encoding="utf-8") as fh:
                w = csv.DictWriter(fh, fieldnames=cols, lineterminator="\n")
                w.writeheader()
                w.writerows(rows)
            code, _out, err = run_main(dedupe, [str(src), "--out", str(out)])
            self.assertEqual(code, 0, err)
            with open(out, newline="", encoding="utf-8") as fh:
                reader = csv.DictReader(fh)
                got = list(reader)
                self.assertEqual(reader.fieldnames, cols)
        self.assertEqual(len(got), 3)  # different profiles of one name are not merged
        for want, have in zip(rows, got):
            for col in validate_csv.LEAD_OPTIONAL_COLUMNS:
                self.assertEqual(have[col], want[col], col)


class DraftsCsvValidation(unittest.TestCase):
    """drafts/<date>.csv (outreach.md Part A): every claim cited in `sources`, counted length."""

    def draft(self, **over):
        text = "Hi Jane, I saw you lead product development at Acme. Do you make liquids?"
        base = dict(lead_id="https://www.linkedin.com/sales/lead/ACw1,NAME_SEARCH,x",
                    full_name="Jane Doe", company_name="Acme", kind="connection", text=text,
                    char_count=str(len(text)), sources="title; facts: sells gummies")
        base.update(over)
        return base

    def write(self, tmp, rows, headers=None):
        headers = headers or validate_csv.DRAFT_COLUMNS
        path = Path(tmp) / "drafts.csv"
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(headers)
            for row in rows:
                w.writerow([row[h] for h in headers])
        return str(path)

    def problems(self, **over):
        with tempfile.TemporaryDirectory() as tmp:
            result = validate_csv.validate(self.write(tmp, [self.draft(**over)]))
        return result["kind"], result["header_errors"], [(e[1], e[2]) for e in result["errors"]]

    def test_template_and_output_md_match_the_validator_columns(self):
        header = (SKILL / "templates" / "drafts.csv").read_text(encoding="utf-8").strip()
        self.assertEqual(header.split(","), validate_csv.DRAFT_COLUMNS)
        md = (SKILL / "references" / "output.md").read_text(encoding="utf-8")
        rows = md_table_rows(md, "drafts/<yyyy-mm-dd>.csv")
        self.assertEqual([r[0] for r in rows], validate_csv.DRAFT_COLUMNS)

    def test_a_clean_draft_passes_and_is_detected_as_drafts(self):
        self.assertEqual(self.problems(), ("drafts", [], []))

    def test_sources_are_required(self):
        self.assertEqual(self.problems(sources="")[2], [("sources", "required")])

    def test_old_header_without_sources_fails(self):
        old = validate_csv.DRAFT_COLUMNS[:-1]
        with tempfile.TemporaryDirectory() as tmp:
            result = validate_csv.validate(self.write(tmp, [self.draft()], headers=old), "drafts")
        self.assertTrue(any("missing columns: sources" in e for e in result["header_errors"]))

    def test_inmail_kind_is_allowed_and_bad_kind_is_not(self):
        self.assertEqual(self.problems(kind="inmail")[2], [])
        self.assertEqual(self.problems(kind="dm")[2], [("kind", "enum")])

    def test_char_count_must_equal_the_counted_length(self):
        self.assertEqual(self.problems(char_count="10")[2], [("char_count", "count")])
        self.assertEqual(self.problems(char_count="ten")[2], [("char_count", "int")])

    def test_connection_note_over_300_fails_but_an_inmail_may_be_longer(self):
        long = "x" * 301
        self.assertEqual(self.problems(text=long, char_count="301")[2], [("text", "length")])
        self.assertEqual(self.problems(text=long, char_count="301", kind="inmail")[2], [])
        edge = "x" * 300
        self.assertEqual(self.problems(text=edge, char_count="300")[2], [])

    def test_duplicate_lead_id_in_one_drafts_file_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = validate_csv.validate(self.write(tmp, [self.draft(), self.draft()]))
        self.assertEqual([(e[0], e[2]) for e in result["errors"]], [(3, "duplicate")])


if __name__ == "__main__":
    unittest.main()
