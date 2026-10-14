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
SCRIPTS = ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator" / "scripts"
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


def lead_el(pid, name, company_id, company="Acme", **extra):
    e = {"fullName": name, "geoRegion": "Austin, Texas, United States",
         "entityUrn": "urn:li:fs_salesProfile:(%s,NAME_SEARCH,x)" % pid,
         "currentPositions": [{"current": True, "title": "Owner", "companyName": company,
                               "companyUrn": "urn:li:fs_salesCompany:%s" % company_id}]}
    e.update(extra)
    return e


class SearchRowFields(unittest.TestCase):
    """pendingInvitation / degree / openLink carried through, same-name flags, per-row buyer type."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.out = self.dir / "leads.csv"

    def results(self, elements):
        path = self.dir / "r.json"
        path.write_text(json.dumps({"status": 200, "elements": elements}))
        return str(path)

    def test_pending_degree_and_open_link_are_carried(self):
        src = self.results([
            lead_el("A1", "Ann One", "10", pendingInvitation=True, degree=2, openLink=True),
            lead_el("A2", "Bob Two", "10", pendingInvitation=False, degree=1),
            lead_el("A3", "Cy Three", "11", degree=3),
            lead_el("A4", "Di Four", "11"),
        ])
        code, err = run(["leads", src, "-o", str(self.out)])
        self.assertEqual(code, 0, err)
        ann, bob, cy, di = read(self.out)
        self.assertEqual((ann["pending_invitation"], ann["degree"], ann["open_link"]), ("yes", "2nd", "yes"))
        self.assertEqual((bob["pending_invitation"], bob["degree"], bob["open_link"]), ("no", "1st", ""))
        self.assertEqual((cy["degree"], di["degree"], di["pending_invitation"]), ("3rd", "", ""))
        self.assertEqual(ann["signals"], "open profile")
        self.assertEqual(validate(self.out), 0)

    def test_degree_helper_handles_ints_labels_and_junk(self):
        f = salesnav_rows.degree_of
        self.assertEqual([f(1), f(2), f(3), f("2nd"), f("3"), f(0), f(4), f(None), f(True), f("x")],
                         ["1st", "2nd", "3rd", "2nd", "3rd", "", "", "", "", ""])

    def test_same_name_in_one_account_is_flagged_and_reported(self):
        src = self.results([
            lead_el("B1", "Jo  Park", "20"),
            lead_el("B2", "jo park", "20"),          # same company, same name, other profile
            lead_el("B3", "Jo Park", "21"),          # same name, other company: not flagged
            lead_el("B4", "Lee Kim", "20"),
        ])
        code, err = run(["leads", src, "-o", str(self.out)])
        self.assertEqual(code, 0, err)
        flags = [r["dup_suspect"] for r in read(self.out)]
        self.assertEqual(flags, ["yes", "yes", "", ""])
        self.assertIn("2 rows in 1 same-name groups", err)
        self.assertEqual(validate(self.out), 0)

    def test_blank_company_ids_are_never_grouped(self):
        rows = [{"full_name": "A B", "dup_suspect": ""}, {"full_name": "A B", "dup_suspect": ""}]
        self.assertEqual(salesnav_rows.flag_same_name(rows, ["", ""]), 0)

    def test_buyer_type_map_json_overrides_the_default_per_company(self):
        mp = self.dir / "types.json"
        mp.write_text(json.dumps({"10": "type-a", "urn:li:fs_salesCompany:11": "type-b"}))
        src = self.results([lead_el("C1", "A A", "10"), lead_el("C2", "B B", "11"), lead_el("C3", "C C", "12")])
        code, err = run(["leads", src, "-o", str(self.out), "--buyer-type", "other", "--buyer-type-map", str(mp)])
        self.assertEqual(code, 0, err)
        self.assertEqual([r["buyer_type"] for r in read(self.out)], ["type-a", "type-b", "other"])
        self.assertIn("buyer types:", err)

    def test_buyer_type_map_csv_accepts_an_accounts_file(self):
        mp = self.dir / "accounts.csv"
        mp.write_text("company_name,salesnav_account_url,buyer_type\n"
                      "Acme,https://www.linkedin.com/sales/company/10,type-a\n"
                      "Beta,https://www.linkedin.com/sales/company/11,\n")
        src = self.results([lead_el("D1", "A A", "10"), lead_el("D2", "B B", "11")])
        code, err = run(["leads", src, "-o", str(self.out), "--buyer-type", "dflt", "--buyer-type-map", str(mp)])
        self.assertEqual(code, 0, err)
        self.assertEqual([r["buyer_type"] for r in read(self.out)], ["type-a", "dflt"])

    def test_buyer_type_map_also_types_accounts(self):
        mp = self.dir / "t.json"
        mp.write_text(json.dumps({"1234": "type-a"}))
        acc = self.dir / "accounts.csv"
        code, err = run(["accounts", str(FIXTURE), "-o", str(acc), "--buyer-type", "dflt", "--buyer-type-map", str(mp)])
        self.assertEqual(code, 0, err)
        types = {r["company_name"]: r["buyer_type"] for r in read(acc)}
        self.assertEqual(types["Acme Wellness"], "type-a")
        self.assertTrue(all(v == "dflt" for k, v in types.items() if k != "Acme Wellness"))

    def test_bad_buyer_type_map_is_an_error(self):
        bad = self.dir / "bad.csv"
        bad.write_text("name,kind\nx,y\n")
        src = self.results([lead_el("E1", "A A", "10")])
        code, err = run(["leads", src, "-o", str(self.out), "--buyer-type-map", str(bad)])
        self.assertEqual(code, 1)
        self.assertIn("buyer-type map", err)
        code, err = run(["leads", src, "-o", str(self.out), "--buyer-type-map", str(self.dir / "missing.json")])
        self.assertEqual(code, 1)

    def test_lead_urls_with_commas_are_quoted_and_round_trip(self):
        src = self.results([lead_el("F1", "A A", "10")])
        run(["leads", src, "-o", str(self.out)])
        raw = self.out.read_text()
        self.assertIn('"https://www.linkedin.com/sales/lead/F1,NAME_SEARCH,x"', raw)
        self.assertEqual(read(self.out)[0]["salesnav_lead_url"], "https://www.linkedin.com/sales/lead/F1,NAME_SEARCH,x")


class PendingInvitationTriState(unittest.TestCase):
    def test_pending_of_is_yes_no_or_blank_when_absent(self):
        f = salesnav_rows.pending_of
        self.assertEqual([f({"pendingInvitation": True}), f({"pendingInvitation": False}),
                          f({}), f({"pendingInvitation": None}), f({"pendingInvitation": "x"})],
                         ["yes", "no", "", "", ""])

    def test_validator_accepts_yes_no_blank_only_for_pending_invitation(self):
        row = {"pending_invitation": "no", "open_link": "no", "dup_suspect": ""}
        probs = validate_csv.check_row(row, "leads", list(row))
        self.assertEqual([p[0] for p in probs], ["open_link"])
        for ok in ("yes", "no", ""):
            self.assertEqual(validate_csv.check_row({"pending_invitation": ok}, "leads", ["pending_invitation"]), [])
        bad = validate_csv.check_row({"pending_invitation": "maybe"}, "leads", ["pending_invitation"])
        self.assertEqual([p[0] for p in bad], ["pending_invitation"])


class AppendAndFlagDups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.out = self.dir / "leads.csv"

    def results(self, name, elements):
        path = self.dir / name
        path.write_text(json.dumps({"status": 200, "elements": elements}))
        return str(path)

    def test_append_over_a_16_column_file_keeps_its_header_and_warns(self):
        old_header = validate_csv.LEAD_COLUMNS
        with open(self.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=old_header, lineterminator="\n")
            w.writeheader()
            w.writerow({**dict.fromkeys(old_header, ""), "full_name": "Old One", "company_name": "Acme",
                        "status": "collected", "mode": "A"})
        src = self.results("r.json", [lead_el("N1", "New One", "10", pendingInvitation=False, degree=2)])
        code, err = run(["leads", src, "-o", str(self.out), "--append", "--collected-at", "2026-10-13"])
        self.assertEqual(code, 0, err)
        lines = self.out.read_text().splitlines()
        self.assertEqual(lines[0].split(","), old_header)
        self.assertEqual(sum(1 for l in lines if l.startswith("full_name,")), 1)
        rows = read(self.out)
        self.assertEqual([r["full_name"] for r in rows], ["Old One", "New One"])
        self.assertTrue(all(len(r) == 16 for r in rows))
        self.assertIn("older header", err)
        for col in validate_csv.LEAD_OPTIONAL_COLUMNS:
            self.assertIn(col, err)
        self.assertEqual(validate(self.out), 0)

    def test_append_flags_a_same_name_pair_split_across_runs(self):
        a = self.results("a.json", [lead_el("P1", "Jo Park", "20", company="Zed")])
        b = self.results("b.json", [lead_el("P2", "jo  park", "20", company="Zed"),
                                    lead_el("P3", "Lee Kim", "20", company="Zed")])
        self.assertEqual(run(["leads", a, "-o", str(self.out), "--append"])[0], 0)
        self.assertEqual([r["dup_suspect"] for r in read(self.out)], [""])
        code, err = run(["leads", b, "-o", str(self.out), "--append"])
        self.assertEqual(code, 0, err)
        self.assertEqual([r["dup_suspect"] for r in read(self.out)], ["yes", "yes", ""])
        self.assertIn("across all runs", err)
        self.assertEqual(validate(self.out), 0)

    def test_same_profile_twice_is_not_a_dup_suspect(self):
        a = self.results("a.json", [lead_el("P1", "Jo Park", "20", company="Zed")])
        run(["leads", a, "-o", str(self.out), "--append"])
        run(["leads", a, "-o", str(self.out), "--append"])
        self.assertEqual([r["dup_suspect"] for r in read(self.out)], ["", ""])

    def test_flag_dups_mode_rewrites_in_place_and_clears_stale_flags(self):
        cols = validate_csv.LEAD_COLUMNS + validate_csv.LEAD_OPTIONAL_COLUMNS

        def row(name, pid, domain, flag=""):
            return {**dict.fromkeys(cols, ""),
                    "full_name": name, "company_name": "Co", "company_domain": domain, "status": "collected",
                    "mode": "A", "salesnav_lead_url": "https://www.linkedin.com/sales/lead/%s,NAME_SEARCH,x" % pid,
                    "dup_suspect": flag}
        with open(self.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, lineterminator="\n")
            w.writeheader()
            w.writerows([row("Jo Park", "A", "zed.com"), row("Jo Park", "B", "ZED.com"),
                         row("Al Roe", "C", "zed.com", flag="yes"), row("Jo Park", "D", "other.com")])
        code, err = run(["--flag-dups", str(self.out)])
        self.assertEqual(code, 0, err)
        self.assertEqual([r["dup_suspect"] for r in read(self.out)], ["yes", "yes", "", ""])
        self.assertIn("2 rows in 1 same-name groups", err)
        self.assertEqual(self.out.read_text().splitlines()[0].split(","), cols)
        self.assertEqual([p.name for p in self.dir.iterdir()], ["leads.csv"])  # no temp file left behind

    def test_flag_dups_on_a_non_leads_csv_is_an_error_and_leaves_it_alone(self):
        self.out.write_text("company_name\nAcme\n")
        code, err = run(["--flag-dups", str(self.out)])
        self.assertEqual(code, 1)
        self.assertEqual(self.out.read_text(), "company_name\nAcme\n")

    def test_flag_dups_adds_the_column_to_an_older_file(self):
        with open(self.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(validate_csv.LEAD_COLUMNS)
            for pid in ("A", "B"):
                r = {**dict.fromkeys(validate_csv.LEAD_COLUMNS, ""),
                     "full_name": "Jo Park", "company_domain": "zed.com", "company_name": "Zed",
                     "status": "collected", "mode": "A",
                     "salesnav_lead_url": "https://www.linkedin.com/sales/lead/%s,N,x" % pid}
                w.writerow([r[c] for c in validate_csv.LEAD_COLUMNS])
        code, err = run(["--flag-dups", str(self.out)])
        self.assertEqual(code, 0, err)
        self.assertEqual([r["dup_suspect"] for r in read(self.out)], ["yes", "yes"])
        self.assertEqual(validate(self.out), 0)


class BuyerTypeMapIds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_company_id_of_reads_urls_urns_and_bare_ids(self):
        f = salesnav_rows.company_id_of
        self.assertEqual(f("https://www.linkedin.com/sales/company/1234?trk=x"), "1234")
        self.assertEqual(f("https://www.linkedin.com/sales/company/1234/people"), "1234")
        self.assertEqual(f("urn:li:fs_salesCompany:99"), "99")
        self.assertEqual(f(" 77 "), "77")
        # a digit-bearing query string or other path must not be mistaken for the id
        self.assertEqual(f("https://www.linkedin.com/sales/company/55?x=999"), "55")
        self.assertEqual(f("https://www.linkedin.com/company/acme-2024/"), "")
        self.assertEqual(f(""), "")

    def test_csv_with_multiline_quoted_cells_and_url_variants(self):
        mp = self.dir / "m.csv"
        mp.write_text('company_name,salesnav_account_url,buyer_type\n'
                      '"Acme\nWellness",https://www.linkedin.com/sales/company/10?trk=a,type-a\n'
                      'Beta,https://www.linkedin.com/sales/company/11/people,type-b\n'
                      'NoId,https://example.com/x,type-c\n', encoding="utf-8")
        stats = {}
        got = salesnav_rows.load_buyer_type_map(str(mp), stats)
        self.assertEqual(got, {"10": "type-a", "11": "type-b"})
        self.assertEqual(stats["no_id"], 1)

    def test_json_keys_may_be_urls_and_unreadable_keys_are_counted(self):
        mp = self.dir / "m.json"
        mp.write_text(json.dumps({"https://www.linkedin.com/sales/company/10": "a", "urn:li:fs_salesCompany:11": "b",
                                  "12": "c", "Acme Inc": "d"}))
        stats = {}
        self.assertEqual(salesnav_rows.load_buyer_type_map(str(mp), stats), {"10": "a", "11": "b", "12": "c"})
        self.assertEqual(stats["no_id"], 1)

    def test_cli_warns_about_ignored_rows_and_a_map_that_matches_nothing(self):
        mp = self.dir / "m.json"
        mp.write_text(json.dumps({"999": "a", "Acme Inc": "b"}))
        src = self.dir / "r.json"
        src.write_text(json.dumps({"elements": [lead_el("Q1", "A A", "10")]}))
        out = self.dir / "leads.csv"
        code, err = run(["leads", str(src), "-o", str(out), "--buyer-type", "dflt", "--buyer-type-map", str(mp)])
        self.assertEqual(code, 0, err)
        self.assertIn("1 buyer-type map rows have no readable company id", err)
        self.assertIn("none match a company", err)
        self.assertEqual(read(out)[0]["buyer_type"], "dflt")
        # a map that matches does not warn
        mp.write_text(json.dumps({"10": "a"}))
        code, err = run(["leads", str(src), "-o", str(out), "--buyer-type-map", str(mp)])
        self.assertNotIn("none match", err)
        self.assertNotIn("no readable company id", err)


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
        self.assertEqual(header, validate_csv.LEAD_COLUMNS + validate_csv.LEAD_OPTIONAL_COLUMNS)
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


class PersonIdentity(unittest.TestCase):
    """The same person comes back from different searches with different urn suffixes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.out = self.dir / "leads.csv"

    def person(self, pid, suffix, name="Pat Poe", company="Zed"):
        return {"fullName": name, "entityUrn": "urn:li:fs_salesProfile:(%s,%s)" % (pid, suffix),
                "currentPositions": [{"title": "CEO", "companyName": company,
                                      "companyUrn": "urn:li:fs_salesCompany:7"}]}

    def save(self, name, payload):
        path = self.dir / name
        path.write_text(json.dumps(payload))
        return str(path)

    def test_profile_id_is_the_first_component_of_the_urn_inner(self):
        self.assertEqual(salesnav_rows.profile_id("urn:li:fs_salesProfile:(ACw1,NAME_SEARCH,abcd)"), "ACw1")
        self.assertEqual(salesnav_rows.profile_id("urn:li:fs_salesProfile:ACw9"), "ACw9")
        self.assertEqual(salesnav_rows.profile_id(""), "")

    def test_same_person_with_different_search_suffixes_is_one_row_with_the_first_full_url(self):
        a = self.save("a.json", {"status": 200, "elements": [self.person("ACwSAME", "NAME_SEARCH,aaaa")]})
        b = self.save("b.json", {"status": 200, "elements": [self.person("ACwSAME", "NAME_SEARCH,bbbb"),
                                                             self.person("ACwOTHER", "NAME_SEARCH,cccc", name="Sam Roe")]})
        code, err = run(["leads", a, b, "-o", str(self.out), "--collected-at", "2026-10-13"])
        self.assertEqual(code, 0, err)
        rows = read(self.out)
        self.assertEqual([r["full_name"] for r in rows], ["Pat Poe", "Sam Roe"])
        self.assertEqual(rows[0]["salesnav_lead_url"], "https://www.linkedin.com/sales/lead/ACwSAME,NAME_SEARCH,aaaa")
        self.assertIn("1 duplicates dropped", err)

    def test_accepts_bare_per_call_json_files_and_jsonl_wrappers_together_and_is_idempotent(self):
        page0 = {"status": 200, "ms": 5, "total": 2, "start": 0, "rows": 1,
                 "elements": [self.person("ACwONE", "NAME_SEARCH,1111", name="One One")]}
        page25 = {"status": 200, "ms": 5, "total": 2, "start": 25, "rows": 1,
                  "elements": [self.person("ACwTWO", "NAME_SEARCH,2222", name="Two Two")]}
        bare0 = self.save("leads#0.json", page0)  # exactly what the browser JS tool returned
        bare25 = self.save("leads#25.json", page25)
        wrapped = self.dir / "results.jsonl"
        wrapped.write_text("".join(json.dumps({"id": i, "ok": True, "result": r}) + "\n"
                                   for i, r in (("leads#0", page0), ("leads#25", page25))))
        string_encoded = self.save("tool-string.json", json.dumps(page0))  # a tool that hands back a JSON string
        pretty = self.dir / "pretty.json"
        pretty.write_text(json.dumps(page25, indent=2))
        runs = {}
        for label, inputs in (("bare", [bare0, bare25]), ("jsonl", [str(wrapped)]),
                              ("overlap", [bare0, str(wrapped), bare25, string_encoded, str(pretty), bare0]),
                              ("reordered", [str(pretty), bare25, string_encoded, str(wrapped)])):
            out = self.dir / (label + ".csv")
            code, err = run(["leads", *inputs, "-o", str(out), "--collected-at", "2026-10-13"])
            self.assertEqual(code, 0, (label, err))
            runs[label] = read(out)
        self.assertEqual([r["full_name"] for r in runs["bare"]], ["One One", "Two Two"])
        self.assertEqual(runs["bare"], runs["jsonl"])
        self.assertEqual(runs["bare"], runs["overlap"])  # overlapping inputs change nothing
        self.assertEqual(sorted(r["full_name"] for r in runs["reordered"]), ["One One", "Two Two"])
        # running it twice over the same inputs gives the same file
        again = self.dir / "again.csv"
        run(["leads", bare0, str(wrapped), bare25, string_encoded, str(pretty), bare0, "-o", str(again),
             "--collected-at", "2026-10-13"])
        self.assertEqual(again.read_text(), (self.dir / "overlap.csv").read_text())

    def test_company_websites_still_join_whatever_the_file_order(self):
        accounts = self.save("a.json", {"elements": [{"companyName": "Zed", "entityUrn": "urn:li:fs_salesCompany:7"}]})
        sites = self.save("w.json", {"status": 200, "companies": [{"id": "7", "name": "Zed", "website": "https://zed.example"}]})
        for inputs in ([accounts, sites], [sites, accounts, sites]):
            out = self.dir / "accts.csv"
            run(["accounts", *inputs, "-o", str(out)])
            self.assertEqual(read(out)[0]["company_domain"], "zed.example")
            self.assertEqual(len(read(out)), 1)


if __name__ == "__main__":
    unittest.main()
