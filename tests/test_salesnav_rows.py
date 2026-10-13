"""Tests for skills/sales-navigator/scripts/salesnav_rows.py (hand-made fixtures, no network).

Run from the repo root:  python3 -m pytest -q tests
"""
import csv
import io
import json
import contextlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "sales-navigator" / "scripts"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "salesnav_results.jsonl"
sys.path.insert(0, str(SCRIPTS))

import salesnav_rows  # noqa: E402
import validate_csv  # noqa: E402


def run(argv):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        code = salesnav_rows.main(argv)
    return code, err.getvalue()


def validate(path):
    with contextlib.redirect_stdout(io.StringIO()):
        return validate_csv.main([str(path)])


def read(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


class Helpers(unittest.TestCase):
    def test_lead_url_from_entity_urn(self):
        self.assertEqual(salesnav_rows.lead_url("urn:li:fs_salesProfile:(ACw1,NAME_SEARCH,xy)"),
                         "https://www.linkedin.com/sales/lead/ACw1,NAME_SEARCH,xy")
        self.assertEqual(salesnav_rows.lead_url("urn:li:fs_salesProfile:ACw9"),
                         "https://www.linkedin.com/sales/lead/ACw9")
        self.assertEqual(salesnav_rows.lead_url(""), "")

    def test_urn_id(self):
        self.assertEqual(salesnav_rows.urn_id("urn:li:fs_salesCompany:15196636"), "15196636")
        self.assertEqual(salesnav_rows.urn_id(""), "")

    def test_domain_of(self):
        cases = {"https://www.AcmeWellness.com/about?x=1": "acmewellness.com",
                 "http://brightfoods.co": "brightfoods.co", "shop.example.org:8080/x": "shop.example.org",
                 "": "", "not a url": "", "http://localhost": ""}
        for site, want in cases.items():
            with self.subTest(site=site):
                self.assertEqual(salesnav_rows.domain_of(site), want)

    def test_tenure_and_band(self):
        self.assertEqual(salesnav_rows.tenure({"tenureAtPosition": {"numYears": 1, "numMonths": 3}}), "1 yr 3 mo")
        self.assertEqual(salesnav_rows.tenure({"tenureAtPosition": {"numMonths": 8}}), "8 mo")
        self.assertEqual(salesnav_rows.tenure({}), "")
        self.assertEqual(salesnav_rows.headcount_band("51-200 employees"), "51-200")
        self.assertEqual(salesnav_rows.headcount_band("10,001+ employees"), "10001+")
        self.assertEqual(salesnav_rows.headcount_band("1 employee"), "1")
        self.assertEqual(salesnav_rows.headcount_band(None), "")


class Leads(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "leads.csv"

    def tearDown(self):
        self.tmp.cleanup()

    def test_maps_fields_dedupes_and_validates(self):
        side = Path(self.tmp.name) / "ids.csv"
        code, err = run(["leads", str(FIXTURE), "-o", str(self.out), "--mode", "A", "--buyer-type", "owner",
                         "--shard", "US|11-50", "--seniority", "Owner/Partner",
                         "--collected-at", "2026-10-13", "--company-ids", str(side)])
        self.assertEqual(code, 0, err)
        rows = read(self.out)
        self.assertEqual(len(rows), 2)  # the repeated Jane Doe URL is dropped
        self.assertIn("1 duplicates dropped", err)
        jane, sam = rows
        self.assertEqual(jane["full_name"], "Jane Doe")
        self.assertEqual(jane["title"], "Head of Product")
        self.assertEqual(jane["company_name"], "Acme Wellness")
        self.assertEqual(jane["company_domain"], "acmewellness.com")  # joined from the website record
        self.assertEqual(jane["salesnav_lead_url"], "https://www.linkedin.com/sales/lead/ACwAAAexample1,NAME_SEARCH,abcd")
        self.assertEqual(jane["linkedin_url"], "")  # never invented
        self.assertEqual(jane["location"], "Austin, Texas, United States")
        self.assertEqual(jane["time_in_role"], "1 yr 3 mo")
        self.assertEqual(jane["signals"], "open profile")
        self.assertEqual((jane["mode"], jane["status"], jane["collected_at"]), ("A", "collected", "2026-10-13"))
        self.assertEqual((jane["buyer_type"], jane["shard"], jane["seniority"]), ("owner", "US|11-50", "Owner/Partner"))
        # name from first+last, current position preferred over the earlier advisor role
        self.assertEqual(sam["full_name"], "Sam Roe")
        self.assertEqual((sam["title"], sam["company_name"], sam["time_in_role"]), ("Founder", "Bright Foods", "8 mo"))
        self.assertEqual(sam["company_domain"], "brightfoods.co")
        self.assertEqual(sam["signals"], "")
        self.assertEqual([r["company_id"] for r in read(side)], ["1234", "5678"])
        # the output passes the repo's own CSV validator
        self.assertEqual(validate(self.out), 0)

    def test_default_mode_and_header_order(self):
        run(["leads", str(FIXTURE), "-o", str(self.out), "--collected-at", "2026-10-13"])
        header = self.out.read_text().splitlines()[0].split(",")
        self.assertEqual(header, validate_csv.LEAD_COLUMNS)
        self.assertEqual(read(self.out)[0]["mode"], "A")

    def test_append_keeps_one_header(self):
        for _ in range(2):
            run(["leads", str(FIXTURE), "-o", str(self.out), "--append", "--collected-at", "2026-10-13"])
        lines = self.out.read_text().splitlines()
        self.assertEqual(sum(1 for l in lines if l.startswith("full_name,")), 1)
        self.assertEqual(len(lines), 1 + 4)

    def test_accepts_raw_response_and_plain_list(self):
        el = {"fullName": "Pat Poe", "entityUrn": "urn:li:fs_salesProfile:(ACw3,NAME_SEARCH,zz)",
              "currentPositions": [{"title": "CEO", "companyName": "Zed", "companyUrn": "urn:li:fs_salesCompany:7"}]}
        raw = Path(self.tmp.name) / "raw.json"
        raw.write_text(json.dumps({"elements": [el], "paging": {"total": 1}}))
        lst = Path(self.tmp.name) / "list.json"
        lst.write_text(json.dumps([el]))
        for src in (raw, lst):
            with self.subTest(src=src.name):
                code, _ = run(["leads", str(src), "-o", str(self.out)])
                self.assertEqual(code, 0)
                self.assertEqual(read(self.out)[0]["full_name"], "Pat Poe")

    def test_no_elements_is_an_error(self):
        empty = Path(self.tmp.name) / "empty.jsonl"
        empty.write_text('{"event":"done"}\n')
        code, err = run(["leads", str(empty), "-o", str(self.out)])
        self.assertEqual(code, 1)
        self.assertIn("no search elements", err)
        self.assertFalse(self.out.exists())


class Accounts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "accounts.csv"

    def tearDown(self):
        self.tmp.cleanup()

    def test_maps_fields_and_joins_websites(self):
        code, err = run(["accounts", str(FIXTURE), "-o", str(self.out), "--mode", "B", "--buyer-type", "brand",
                         "--shard", "US-TX", "--collected-at", "2026-10-13"])
        self.assertEqual(code, 0, err)
        rows = read(self.out)
        self.assertEqual([r["company_name"] for r in rows], ["Acme Wellness", "Bright Foods", "No Site Ltd"])
        acme, bright, nosite = rows
        self.assertEqual(acme["salesnav_account_url"], "https://www.linkedin.com/sales/company/1234")
        self.assertEqual(acme["company_domain"], "acmewellness.com")
        self.assertEqual(acme["headcount_band"], "11-50")
        self.assertEqual(acme["industry"], "Health, Wellness & Fitness")
        self.assertEqual(bright["headcount_band"], "10001+")
        self.assertEqual(nosite["company_domain"], "")  # no website -> blank, not guessed
        self.assertEqual(acme["hq_location"], "")  # not in the search result
        self.assertEqual((acme["mode"], acme["status"], acme["shard"]), ("B", "collected", "US-TX"))
        self.assertEqual(self.out.read_text().splitlines()[0].split(","), validate_csv.ACCOUNT_COLUMNS)

    def test_output_validates(self):
        run(["accounts", str(FIXTURE), "-o", str(self.out), "--collected-at", "2026-10-13"])
        self.assertEqual(validate(self.out), 0)

    def test_leads_output_validates(self):
        out = Path(self.tmp.name) / "leads.csv"
        run(["leads", str(FIXTURE), "-o", str(out), "--collected-at", "2026-10-13"])
        self.assertEqual(validate(out), 0)

    def test_raw_company_response_supplies_websites(self):
        resp = Path(self.tmp.name) / "companies.json"
        resp.write_text(json.dumps({"statuses": {}, "results": {"42": {"name": "N", "website": "https://nosite.example"}}}))
        acct = Path(self.tmp.name) / "a.json"
        acct.write_text(json.dumps({"elements": [{"companyName": "No Site Ltd", "entityUrn": "urn:li:fs_salesCompany:42"}]}))
        run(["accounts", str(acct), str(resp), "-o", str(self.out)])
        self.assertEqual(read(self.out)[0]["company_domain"], "nosite.example")


if __name__ == "__main__":
    unittest.main()
