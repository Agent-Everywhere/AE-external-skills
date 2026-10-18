"""Tests for skills/sales-navigator/page/*.js, run in Node against a fake document and fetch.

Skipped when `node` is not installed. Run from the repo root:  python3 -m pytest -q tests
"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator" / "page"
HARNESS = Path(__file__).resolve().parent / "node_snippet_runner.js"
NODE = shutil.which("node")
COOKIE = 'lang=v=2; JSESSIONID="ajax:0123456789"; other=1'
TOKEN = "ajax:0123456789"

LEAD = "FIXTUREID123,NAME_SEARCH,tok9"
LEAD_URN = "urn:li:fs_salesProfile:(FIXTUREID123,NAME_SEARCH,tok9)"

CLEAN = "(filters:List((type:REGION,values:List((id:103644278,selectionType:INCLUDED)))))"


def run_snippet(name, params, responses=None, cookie=COOKIE):
    proc = subprocess.run(
        [NODE, str(HARNESS), str(PAGE / name), json.dumps(params), cookie, json.dumps(responses or [])],
        capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


LIST_ROW = {"id": 7, "name": "A", "entityCount": 3, "listType": "ACCOUNT", "listSource": "MANUAL", "role": "OWNER",
            "extra": 1}



def lists_resp(rows, total=None):
    return {"status": 200, "body": {"paging": {"total": len(rows) if total is None else total}, "elements": [
        {"id": i, "name": n, "entityCount": c, "listType": "ACCOUNT"} for i, n, c in rows]}}


def save_resp(statuses):
    return {"status": 200, "body": {"value": {"listEntityActionResponses": [{"status": x} for x in statuses]}}}


def save_calls(out):
    return [json.loads(c["body"]) for c in out["calls"] if c["url"] == "/sales-api/salesApiCompanies?action=save"]


SHARD = {"delayMs": 0, "readDelayMs": 0}

PROFILE_MAIN_CASE = {"fullName": "P", "positions": [{"title": "T", "companyUrn": "urn:li:fs_salesCompany:9"}],
                     "contactInfo": {"primaryEmail": "x@example.invalid"}}


@unittest.skipUnless(NODE, "node not installed")
class PageSnippets(unittest.TestCase):
    def test_every_snippet_is_a_single_async_function(self):
        for path in sorted(PAGE.glob("*.js")):
            with self.subTest(snippet=path.name):
                body = "\n".join(l for l in path.read_text().splitlines() if not l.startswith("//")).strip()
                self.assertTrue(body.startswith("async (params) =>"), path.name)

    def test_emitted_standalone_expressions_are_valid_js(self):
        """Each snippet must be pasteable into a browser JS tool as an async IIFE with params inline."""
        import sys
        import tempfile
        sys.path.insert(0, str(ROOT / "packages" / "browser-runtime"))
        import session
        for path in sorted(PAGE.glob("*.js")):
            for form in ("expression", "return"):
                with self.subTest(snippet=path.name, form=form):
                    code = session.emit_expression(path.name, '{"query": "x", "ids": [1]}', [PAGE],
                                                   compact=True, form=form)
                    self.assertNotIn("\n//", code)  # compact drops whole-line comments
                    if form == "return":
                        code = "async function f() {\n" + code + "\n}"
                    with tempfile.TemporaryDirectory() as tmp:
                        out = Path(tmp) / "emitted.js"
                        out.write_text(code)
                        proc = subprocess.run([NODE, "--check", str(out)], capture_output=True, text=True)
                        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_emitted_expression_runs_and_returns_json(self):
        """Evaluate the emitted expression against a fake page, the way a JS tool would."""
        import sys
        sys.path.insert(0, str(ROOT / "packages" / "browser-runtime"))
        import session
        code = session.emit_expression("csrf_ready.js", "{}", [PAGE], compact=True)
        script = ("global.document={cookie:%s};global.location={pathname:'/sales/home'};"
                  "Promise.resolve(eval(%s)).then(r=>console.log(JSON.stringify(r)));"
                  % (json.dumps(COOKIE), json.dumps(code)))
        proc = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {"ready": True, "path": "/sales/home"})

    def test_headers_and_token_handling(self):
        out = run_snippet("lead_search.js", {"query": CLEAN, "count": 1},
                          [{"status": 200, "body": {"paging": {"total": 7}, "elements": []}}])
        call = out["calls"][0]
        self.assertEqual(call["headers"]["csrf-token"], TOKEN)  # quotes stripped
        self.assertEqual(call["headers"]["x-restli-protocol-version"], "2.0.0")
        self.assertEqual(call["headers"]["accept"], "application/json")
        self.assertEqual(call["credentials"], "include")
        self.assertNotIn(TOKEN, json.dumps(out["result"]))  # never returned

    def test_lead_search_url_and_result(self):
        el = {"fullName": "A B", "entityUrn": "urn:li:fs_salesProfile:(X,NAME_SEARCH,y)",
              "profilePictureDisplayImage": {"rootUrl": "x"}, "crmStatus": {"a": 1},
              "currentPositions": [{"title": "T", "companyName": "C", "$recipeType": "r"}]}
        out = run_snippet("lead_search.js", {"query": CLEAN, "start": 50, "count": 25},
                          [{"status": 200, "body": {"paging": {"total": 1234}, "elements": [el]}}])
        url = out["calls"][0]["url"]
        self.assertTrue(url.startswith("/sales-api/salesApiLeadSearch?q=searchQuery&query=" + CLEAN))
        self.assertIn("&start=50&count=25&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14", url)
        res = out["result"]
        self.assertEqual((res["status"], res["total"], res["rows"]), (200, 1234, 1))
        slim = res["elements"][0]
        self.assertNotIn("profilePictureDisplayImage", slim)
        self.assertNotIn("crmStatus", slim)
        self.assertEqual(slim["currentPositions"][0]["title"], "T")
        self.assertNotIn("$recipeType", slim["currentPositions"][0])

    def test_raw_keeps_every_field(self):
        el = {"crmStatus": {"a": 1}}
        out = run_snippet("lead_search.js", {"query": CLEAN, "raw": True},
                          [{"status": 200, "body": {"paging": {"total": 1}, "elements": [el]}}])
        self.assertEqual(out["result"]["elements"], [el])

    def test_count_defaults_to_25_and_is_clamped_to_100_and_the_viewable_cap(self):
        for name, cap in (("lead_search.js", 2500), ("account_search.js", 1000)):
            with self.subTest(snippet=name):
                def count_of(params):
                    out = run_snippet(name, dict({"query": CLEAN}, **params), [{"status": 200, "body": {}}])
                    return out["calls"][0]["url"].split("&count=")[1].split("&")[0]
                self.assertEqual(count_of({}), "25")
                self.assertEqual(count_of({"count": 500}), "100")
                self.assertEqual(count_of({"count": 100}), "100")
                self.assertEqual(count_of({"count": 0}), "1")
                self.assertEqual(count_of({"count": 100, "start": cap - 40}), "40")  # never past the viewable cap
                out = run_snippet(name, {"query": CLEAN, "start": cap}, [])
                self.assertEqual(out["result"]["error"], "beyond_viewable_cap_%d" % cap)

    def test_query_cleaning(self):
        recent = "recentSearchParam:(id:5185,doLogHistory:true)"
        cases = {
            "(" + recent + ",filters:List((type:REGION)))": "(filters:List((type:REGION)))",
            "(filters:List((type:REGION))," + recent + ")": "(filters:List((type:REGION)))",
            "(filters:List((type:REGION)),keywords:abc)": "(filters:List((type:REGION)),keywords:abc)",
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                out = run_snippet("lead_search.js", {"query": raw}, [{"status": 200, "body": {}}])
                self.assertIn("&query=" + want + "&start=0", out["calls"][0]["url"])
        # a fully percent-encoded query (as read off a page URL) is unquoted exactly once
        encoded = "%28recentSearchParam%3A%28id%3A1%2CdoLogHistory%3Atrue%29%2Cfilters%3AList%28%28type%3AREGION%29%29%29"
        out = run_snippet("lead_search.js", {"query": encoded}, [{"status": 200, "body": {}}])
        self.assertIn("&query=(filters:List((type:REGION)))&start=0", out["calls"][0]["url"])
        # a whole page URL works too
        page_url = "https://www.linkedin.com/sales/search/people?query=" + encoded + "&viewAllFilters=true"
        out = run_snippet("lead_search.js", {"query": page_url}, [{"status": 200, "body": {}}])
        self.assertIn("&query=(filters:List((type:REGION)))&start=0", out["calls"][0]["url"])

    def test_missing_csrf_makes_no_request(self):
        for name, params in (("lead_search.js", {"query": CLEAN}), ("account_search.js", {"query": CLEAN}),
                             ("count.js", {"kind": "lead", "query": CLEAN}),
                             ("typeahead.js", {"type": "BING_GEO", "term": "x"}),
                             ("companies_websites.js", {"ids": [1]}),
                             ("companies_details.js", {"ids": [1]}), ("profiles_batch.js", {"leads": [LEAD]}),
                             ("profile.js", {"lead": LEAD}), ("activity.js", {"lead": LEAD}),
                             ("account.js", {"companyId": "123"})):
            with self.subTest(snippet=name):
                out = run_snippet(name, params, cookie="lang=en")
                self.assertEqual(out["result"]["error"], "csrf_missing")
                self.assertEqual(out["calls"], [])

    def test_non_200_is_reported_not_raised(self):
        out = run_snippet("lead_search.js", {"query": CLEAN}, [{"status": 403, "body": {"message": "no"}}])
        self.assertEqual(out["result"]["status"], 403)
        self.assertIn("body", out["result"])

    def test_viewable_caps(self):
        lead = run_snippet("lead_search.js", {"query": CLEAN, "start": 2500})
        self.assertEqual(lead["result"]["error"], "beyond_viewable_cap_2500")
        self.assertEqual(lead["calls"], [])
        acc = run_snippet("account_search.js", {"query": CLEAN, "start": 1000})
        self.assertEqual(acc["result"]["error"], "beyond_viewable_cap_1000")
        ok = run_snippet("account_search.js", {"query": CLEAN, "start": 975},
                         [{"status": 200, "body": {"paging": {"total": 990}, "elements": []}}])
        self.assertEqual(ok["result"]["status"], 200)

    def test_account_search_keywords_after_filters(self):
        q = "(filters:List((type:REGION,values:List((id:103644278,selectionType:INCLUDED)))),keywords:supplement%20OR%20vitamin)"
        out = run_snippet("account_search.js", {"query": q},
                          [{"status": 200, "body": {"paging": {"total": 5}, "elements": [{"companyName": "X"}]}}])
        url = out["calls"][0]["url"]
        self.assertIn("/sales-api/salesApiAccountSearch?q=searchQuery&query=" + q, url)
        self.assertIn("AccountSearchResult-4", url)

    def test_count_many_queries(self):
        out = run_snippet("count.js", {
            "kind": "account", "delayMs": 0,
            "queries": [{"label": "a", "query": CLEAN}, {"label": "b", "query": CLEAN}]},
            [{"status": 200, "body": {"paging": {"total": 11}}}, {"status": 200, "body": {"paging": {"total": 22}}}])
        self.assertEqual([(r["label"], r["total"]) for r in out["result"]["results"]], [("a", 11), ("b", 22)])
        self.assertTrue(all("&count=1&" in c["url"] for c in out["calls"]))

    def test_count_stops_on_403(self):
        out = run_snippet("count.js", {
            "kind": "lead", "delayMs": 0,
            "queries": [{"label": "a", "query": CLEAN}, {"label": "b", "query": CLEAN}]},
            [{"status": 403, "body": {}}])
        self.assertEqual(len(out["calls"]), 1)
        self.assertEqual(out["result"]["status"], 403)

    def test_count_status_is_the_first_failure_not_the_last_result(self):
        three = [{"label": x, "query": CLEAN} for x in "abc"]
        out = run_snippet("count.js", {"kind": "lead", "delayMs": 0, "queries": three},
                          [{"status": 200, "body": {"paging": {"total": 1}}}, {"status": 400, "body": {}},
                           {"status": 200, "body": {"paging": {"total": 3}}}])
        res = out["result"]
        self.assertEqual((res["status"], res["failed"]), (400, 1))  # was 200: the LAST query's status
        self.assertEqual([r["status"] for r in res["results"]], [200, 400, 200])

    def test_count_status_prefers_a_stop_status_and_is_200_only_when_all_succeed(self):
        two = [{"label": x, "query": CLEAN} for x in "ab"]
        out = run_snippet("count.js", {"kind": "lead", "delayMs": 0, "queries": two},
                          [{"status": 500, "body": {}}, {"status": 429, "body": {}}])
        self.assertEqual((out["result"]["status"], out["result"]["failed"]), (429, 2))
        ok = run_snippet("count.js", {"kind": "lead", "delayMs": 0, "queries": two},
                         [{"status": 200, "body": {"paging": {"total": 1}}},
                          {"status": 200, "body": {"paging": {"total": 2}}}])
        self.assertEqual((ok["result"]["status"], ok["result"]["failed"]), (200, 0))

    def test_runner_treats_a_count_result_with_failures_as_not_ok(self):
        import sys
        sys.path.insert(0, str(ROOT / "packages" / "browser-runtime"))
        import session
        out = run_snippet("count.js", {"kind": "lead", "delayMs": 0,
                                       "queries": [{"label": "a", "query": CLEAN}, {"label": "b", "query": CLEAN}]},
                          [{"status": 400, "body": {}}, {"status": 200, "body": {"paging": {"total": 5}}}])
        self.assertFalse(session.result_ok(out["result"]))
        self.assertFalse(session.result_ok({"failed": 1, "results": []}))
        self.assertEqual(session.result_rows(out["result"]), 0)

    def test_companies_websites_encoding_and_chunking(self):
        ids = ["urn:li:fs_salesCompany:%d" % n for n in range(1, 31)]
        body1 = {"results": {str(n): {"name": "N%d" % n, "website": "http://n%d.com" % n} for n in range(1, 25)}}
        body2 = {"results": {"26": {"name": "N26"}}}
        out = run_snippet("companies_websites.js", {"ids": ids, "delayMs": 0},
                          [{"status": 200, "body": body1}, {"status": 200, "body": body2}])
        self.assertEqual(len(out["calls"]), 2)
        first = out["calls"][0]["url"]
        self.assertIn("decoration=%28entityUrn%2Cname%2Cwebsite%29", first)
        self.assertNotIn("decoration=(", first)
        self.assertIn("ids=List(1,2,3", first)
        self.assertEqual(first.count(","), 24)  # 25 ids in the first chunk
        res = out["result"]
        self.assertEqual(res["status"], 200)
        self.assertIn("25", res["missing"])  # asked for, absent from the response
        self.assertIn("26", res["missing"])  # present but no website
        self.assertEqual(res["companies"][0], {"id": "1", "name": "N1", "website": "http://n1.com"})

    def test_companies_websites_batch_param_is_clamped_to_100(self):
        ids = [str(n) for n in range(1, 151)]
        out = run_snippet("companies_websites.js", {"ids": ids, "delayMs": 0, "batch": 500}, [])
        self.assertEqual(len(out["calls"]), 2)
        self.assertEqual(out["calls"][0]["url"].split("&decoration=")[0].count(","), 99)

    def test_companies_details_encoding_shape_and_missing(self):
        ids = ["urn:li:fs_salesCompany:1", "2", "x3", "2", "junk", "urn:li:fs_salesCompany:4a", ""]
        full = {"entityUrn": "urn:li:fs_salesCompany:1", "name": "N1", "website": "http://n1.com",
                "description": "D" * 3000, "specialties": ["a", "b"], "type": "Privately Held", "yearFounded": 1999,
                "industry": "Advertising Services", "employeeCount": 12, "flagshipCompanyUrl": "https://x/1",
                "employeeCountRange": {"start": 11, "end": 50},
                "revenueRange": {"estimatedMinRevenue": {"amount": 1, "unit": "MILLION", "currencyCode": "USD"},
                                 "estimatedMaxRevenue": {"amount": 5, "unit": "MILLION", "currencyCode": "USD"}},
                "headquarters": {"city": "Austin", "geographicArea": "Texas", "country": "US"},
                "employeeDisplayCount": 12, "decisionMakersDisplayCount": 4, "location": "Austin, Texas, United States",
                "employeeGrowthPercentages": [{"timePeriod": {"unit": "YEAR"}, "growthPercentage": 12}]}
        out = run_snippet("companies_details.js", {"ids": ids}, [{"status": 200, "body": {"results": {"1": full}, "errors": {}}}])
        call = out["calls"][0]["url"]
        self.assertEqual(len(out["calls"]), 1)
        self.assertIn("ids=List(1,2)&decoration=", call)  # normalized and deduplicated; non-numeric ids rejected
        deco = call.split("&decoration=")[1]
        self.assertEqual(deco, "%28entityUrn%2Cname%2Cwebsite%2Cdescription%2Cspecialties%2Ctype%2CyearFounded%2Cindustry"
                               "%2Cheadquarters%2CrevenueRange%2CemployeeCount%2CemployeeCountRange"
                               "%2CemployeeGrowthPercentages%2CflagshipCompanyUrl%2CemployeeDisplayCount"
                               "%2CdecisionMakersDisplayCount%2Clocation%29")
        self.assertNotIn("(", deco)
        self.assertNotIn(",", deco)
        res = out["result"]
        self.assertEqual(res["status"], 200)
        self.assertEqual(res["rows"], 1)
        self.assertEqual(res["missing"], ["2"])
        self.assertEqual(res["invalid"], 4)
        row = res["companies"][0]
        self.assertEqual(row["description"], "D" * 3000)  # never truncated
        self.assertEqual(row["specialties"], "a; b")
        self.assertEqual(row["headquarters"], "Austin, Texas, US")
        self.assertEqual(row["employeeCountRange"], "11-50")
        self.assertEqual(row["revenueRange"], "1 MILLION USD - 5 MILLION USD")
        self.assertEqual(row["yearFounded"], 1999)
        self.assertEqual(row["id"], "1")
        self.assertEqual(row["employeeGrowthPercentages"], "timePeriod=unit=YEAR growthPercentage=12")
        self.assertEqual((row["employeeDisplayCount"], row["decisionMakersDisplayCount"]), (12, 4))
        self.assertEqual(row["location"], "Austin, Texas, United States")

    def test_companies_details_growth_sentinel_is_new_and_missing_counts_are_blank(self):
        body = {"results": {"1": {"name": "N", "employeeGrowthPercentages": [
            {"timePeriod": {"unit": "MONTH", "count": 6}, "growthPercentage": 2147483647},
            {"timePeriod": {"unit": "YEAR", "count": 1}, "growthPercentage": 7}]}}}
        out = run_snippet("companies_details.js", {"ids": ["1"]}, [{"status": 200, "body": body}])
        row = out["result"]["companies"][0]
        self.assertIn("growthPercentage=new", row["employeeGrowthPercentages"])
        self.assertIn("growthPercentage=7", row["employeeGrowthPercentages"])
        self.assertNotIn("2147483647", json.dumps(out["result"]))
        self.assertEqual((row["employeeDisplayCount"], row["decisionMakersDisplayCount"], row["location"]), ("", "", ""))

    def test_companies_details_chunks_at_most_100_and_fields_override(self):
        ids = [str(n) for n in range(1, 251)]
        out = run_snippet("companies_details.js", {"ids": ids, "delayMs": 0, "batch": 9999}, [])
        self.assertEqual(len(out["calls"]), 3)
        self.assertEqual([c["url"].split("&decoration=")[0].count(",") + 1 for c in out["calls"]], [100, 100, 50])
        self.assertEqual(out["result"]["missing"], ids)
        out = run_snippet("companies_details.js", {"ids": ["1"], "fields": ["name", "foundedOn", "bad field!"]},
                          [{"status": 200, "body": {"results": {"1": {"name": "N", "foundedOn": {"year": 1}}}}}])
        self.assertTrue(out["calls"][0]["url"].endswith("&decoration=%28entityUrn%2Cname%2CfoundedOn%2Cbadfield%29"))
        self.assertEqual(out["result"]["companies"][0], {"id": "1", "name": "N", "foundedOn": {"year": 1}})  # only requested keys
        out = run_snippet("companies_details.js", {"ids": ["1"], "fields": ["id", "name"]},
                          [{"status": 200, "body": {"results": {"1": {"name": "N", "id": "evil"}}}}])
        self.assertEqual(out["result"]["companies"][0], {"id": "1", "name": "N"})  # passthrough never overwrites id

    def test_companies_details_reports_non_200_with_partial_rows(self):
        ids = [str(n) for n in range(1, 151)]
        body = {"results": {str(n): {"name": "N%d" % n} for n in range(1, 101)}}
        out = run_snippet("companies_details.js", {"ids": ids, "delayMs": 0},
                          [{"status": 200, "body": body}, {"status": 400, "body": {"message": "bad"}}])
        self.assertEqual(out["result"]["status"], 400)
        self.assertEqual(len(out["result"]["companies"]), 100)
        out = run_snippet("companies_details.js", {"ids": []}, [])
        self.assertEqual(out["result"]["error"], "ids_required")

    def test_profiles_batch_url_shape_and_normalization(self):
        urn2 = "urn:li:fs_salesProfile:(SECONDID999,NAME_SEARCH,tok8)"
        body = {"results": {"FIXTUREID123": {
            "entityUrn": LEAD_URN, "fullName": "A B", "headline": "H", "summary": "S" * 2000, "location": "Austin",
            "defaultPosition": {"title": "Old", "companyName": "OldCo"},
            "positions": [{"companyName": "Past", "title": "P", "current": False, "startedOn": {"year": 2010, "month": 2}},
                          {"companyName": "Now", "title": "CEO", "current": True, "description": "runs it",
                           "startedOn": {"year": 2020, "month": 5}}],
            "skills": [{"name": "x"}], "contactInfo": {"primaryEmail": "x@example.invalid"}}}}
        leads = [LEAD_URN, LEAD, {"profileId": "SECONDID999", "authType": "NAME_SEARCH", "authToken": "tok8"}, urn2, "bad", {"profileId": "x"}]
        out = run_snippet("profiles_batch.js", {"leads": leads}, [{"status": 200, "body": body}])
        self.assertEqual(len(out["calls"]), 1)
        url = out["calls"][0]["url"]
        self.assertTrue(url.startswith("/sales-api/salesApiProfiles?ids=List((profileId:FIXTUREID123,authType:NAME_SEARCH,"
                                       "authToken:tok9),(profileId:SECONDID999,authType:NAME_SEARCH,authToken:tok8))&decoration="))
        deco = url.split("&decoration=")[1]
        self.assertEqual(deco, "%28entityUrn%2CfullName%2Cheadline%2Csummary%2Clocation%2CdefaultPosition%2C"
                               "positions*%28companyName%2Ccurrent%2Ctitle%2Cdescription%2CstartedOn%29%29")
        res = out["result"]
        self.assertEqual((res["status"], res["rows"], res["invalid"]), (200, 1, 2))
        self.assertEqual(res["missing"], ["SECONDID999"])  # requested, not returned
        self.assertNotIn("errors", res)
        prof = res["profiles"][0]
        self.assertEqual((prof["currentTitle"], prof["currentCompany"]), ("CEO", "Now"))
        self.assertEqual(prof["summary"], "S" * 2000)
        self.assertEqual(prof["positions"][1], {"companyName": "Now", "title": "CEO", "current": True,
                                                "startedOn": {"year": 2020, "month": 5}, "description": "runs it"})
        self.assertEqual(prof["entityUrn"], LEAD_URN)
        self.assertNotIn("contactInfo", json.dumps(res))
        self.assertNotIn("x@example.invalid", json.dumps(res))

    def test_profiles_batch_extras_adds_one_decoration_and_never_contact_info(self):
        body = {"results": {"FIXTUREID123": {
            "entityUrn": LEAD_URN, "fullName": "A B", "degree": 2, "positions": [
                {"companyName": "Now", "companyUrn": "urn:li:fs_salesCompany:9", "title": "CEO", "current": True,
                 "startedOn": {"year": 2020, "month": 5}, "endedOn": {"year": 2024, "month": 1}}],
            "educations": [{"schoolName": "U", "degree": "BA", "fieldsOfStudy": ["Art"], "startedOn": {"year": 2000, "month": 9},
                            "endedOn": {"year": 2004, "month": 6}}],
            "skills": [{"name": "Ops", "numOfEndorsement": 3}], "languages": [{"name": "English", "proficiency": "NATIVE"}],
            "numOfConnections": 500, "memberBadges": {"premium": True, "openLink": False}, "inmailRestriction": "NO_RESTRICTION",
            "contactInfo": {"primaryEmail": "x@example.invalid"}}}}
        out = run_snippet("profiles_batch.js", {"leads": [LEAD], "extras": True}, [{"status": 200, "body": body}])
        self.assertEqual(len(out["calls"]), 1)  # same single batch call
        deco = out["calls"][0]["url"].split("&decoration=")[1]
        self.assertEqual(deco, "%28entityUrn%2CfullName%2Cheadline%2Csummary%2Clocation%2CdefaultPosition%2Cdegree%2C"
                               "positions*%28companyName%2CcompanyUrn%2Ccurrent%2Ctitle%2Cdescription%2CstartedOn%2CendedOn%29%2C"
                               "educations*%28degree%2CendedOn%2CschoolName%2CstartedOn%2CfieldsOfStudy*%29%2Cskills*%2Clanguages*%2C"
                               "numOfConnections%2CmemberBadges%2CinmailRestriction%29")
        self.assertIn("educations*", deco)
        self.assertIn("skills*", deco)
        self.assertNotIn("contactInfo", deco)
        prof = out["result"]["profiles"][0]
        self.assertEqual(prof["educations"], [{"schoolName": "U", "degree": "BA", "fieldsOfStudy": ["Art"],
                                               "startedOn": {"year": 2000, "month": 9}, "endedOn": {"year": 2004, "month": 6}}])
        self.assertEqual(prof["skills"], [{"name": "Ops", "endorsements": 3}])
        self.assertEqual(prof["languages"], [{"name": "English", "proficiency": "NATIVE"}])
        self.assertEqual((prof["degree"], prof["numOfConnections"], prof["inmailRestriction"]), (2, 500, "NO_RESTRICTION"))
        self.assertEqual(prof["memberBadges"], {"openLink": False, "premium": True})
        self.assertEqual(prof["positions"][0]["companyUrn"], "urn:li:fs_salesCompany:9")
        self.assertEqual(prof["positions"][0]["endedOn"], {"year": 2024, "month": 1})
        self.assertNotIn("x@example.invalid", json.dumps(out["result"]))
        # default behaviour unchanged: no extras keys, no extras decoration
        out = run_snippet("profiles_batch.js", {"leads": [LEAD]}, [{"status": 200, "body": body}])
        self.assertNotIn("educations", out["calls"][0]["url"])
        self.assertNotIn("educations", out["result"]["profiles"][0])
        self.assertNotIn("endedOn", out["result"]["profiles"][0]["positions"][0])

    def test_profiles_batch_surfaces_response_errors(self):
        body = {"results": {}, "errors": {"urn:li:fs_salesProfile:(FIXTUREID123,NAME_SEARCH,tok9)": {"status": 404}}}
        out = run_snippet("profiles_batch.js", {"leads": [LEAD]}, [{"status": 200, "body": body}])
        self.assertEqual(out["result"]["missing"], ["FIXTUREID123"])
        self.assertEqual(out["result"]["errors"], ["urn:li:fs_salesProfile:(FIXTUREID123,NAME_SEARCH,tok9)"])

    def test_profiles_batch_chunking_default_25_max_100_and_errors(self):
        leads = ["urn:li:fs_salesProfile:(ID%07d,NAME_SEARCH,t%d)" % (n, n) for n in range(60)]
        out = run_snippet("profiles_batch.js", {"leads": leads, "delayMs": 0}, [])
        self.assertEqual([c["url"].count("(profileId:") for c in out["calls"]], [25, 25, 10])
        many = ["urn:li:fs_salesProfile:(ID%07d,NAME_SEARCH,t%d)" % (n, n) for n in range(230)]
        out = run_snippet("profiles_batch.js", {"leads": many, "delayMs": 0, "batch": 5000}, [])
        self.assertEqual([c["url"].count("(profileId:") for c in out["calls"]], [100, 100, 30])
        out = run_snippet("profiles_batch.js", {"leads": leads[:2]}, [{"status": 429, "body": {}}])
        self.assertEqual(out["result"]["status"], 429)
        self.assertEqual(out["result"]["profiles"], [])
        out = run_snippet("profiles_batch.js", {"leads": ["nope"]}, [])
        self.assertEqual((out["result"]["error"], out["result"]["invalid"]), ("leads_required", 1))
        self.assertEqual(out["calls"], [])

    def test_profiles_batch_ids_build_name_search_triples_and_chunk(self):
        ids = ["ACoAAA%04d" % n for n in range(230)]
        out = run_snippet("profiles_batch.js", {"ids": ids + [ids[0], "bad id!", 7], "delayMs": 0, "batch": 5000}, [])
        self.assertEqual([c["url"].count("(profileId:") for c in out["calls"]], [100, 100, 30])  # deduped, <= 100 per call
        self.assertTrue(out["calls"][0]["url"].startswith(
            "/sales-api/salesApiProfiles?ids=List((profileId:ACoAAA0000,authType:NAME_SEARCH,authToken:x),"
            "(profileId:ACoAAA0001,authType:NAME_SEARCH,authToken:x),"))
        self.assertEqual(out["result"]["invalid"], 2)
        # ids dedupe against leads on the same id key, and a missing id is reported
        body = {"results": {"FIXTUREID123": {"entityUrn": LEAD_URN, "fullName": "A B"}}}
        out = run_snippet("profiles_batch.js", {"leads": [LEAD], "ids": ["FIXTUREID123", "ACwAAOther-1"]},
                          [{"status": 200, "body": body}])
        self.assertEqual(out["calls"][0]["url"].split("&decoration=")[0],
                         "/sales-api/salesApiProfiles?ids=List((profileId:FIXTUREID123,authType:NAME_SEARCH,authToken:tok9),"
                         "(profileId:ACwAAOther-1,authType:NAME_SEARCH,authToken:x))")
        self.assertEqual((out["result"]["rows"], out["result"]["missing"]), (1, ["ACwAAOther-1"]))
        out = run_snippet("profiles_batch.js", {"ids": ["bad id!"]}, [])
        self.assertEqual((out["result"]["error"], out["result"]["invalid"]), ("leads_required", 1))

    def test_profiles_batch_urls_only_uses_the_minimal_decoration_and_shape(self):
        body = {"results": {"ACoAAAx": {"entityUrn": "urn:li:fs_salesProfile:(ACoAAAx,NAME_SEARCH,x)", "headline": "H",
                                        "flagshipProfileUrl": "https://www.linkedin.com/in/pat", "summary": "dropped"}}}
        out = run_snippet("profiles_batch.js", {"ids": ["ACoAAAx"], "urlsOnly": True, "extras": True},
                          [{"status": 200, "body": body}])
        self.assertEqual(len(out["calls"]), 1)
        self.assertEqual(out["calls"][0]["url"].split("&decoration=")[1],
                         "%28entityUrn%2CflagshipProfileUrl%2Cheadline%29")  # urlsOnly wins over extras
        res = out["result"]
        self.assertEqual((res["status"], res["rows"], res["missing"]), (200, 1, []))
        self.assertEqual(res["profiles"], [{"entityUrn": "urn:li:fs_salesProfile:(ACoAAAx,NAME_SEARCH,x)", "headline": "H",
                                            "profileUrl": "https://www.linkedin.com/in/pat"}])

    def test_typeahead_shape_and_empty_flag(self):
        body = {"elements": [{"id": "103644278", "displayValue": "United States", "extra": 1}]}
        out = run_snippet("typeahead.js", {"type": "BING_GEO", "term": "United States"},
                          [{"status": 200, "body": body}])
        self.assertIn("/sales-api/salesApiFacetTypeahead?q=query&start=0&count=10&type=BING_GEO&query=United%20States",
                      out["calls"][0]["url"])
        self.assertEqual(out["result"]["results"][0]["elements"], [{"id": "103644278", "displayValue": "United States"}])
        empty = run_snippet("typeahead.js", {"type": "INDUSTRY", "term": "nutrition"},
                            [{"status": 200, "body": {"elements": []}}])
        self.assertTrue(empty["result"]["results"][0]["empty"])

    # --- profile.js, activity.js, account.js
    PROFILE_MAIN = {
        "fullName": "Pat Example", "headline": "VP Ops at Acme", "location": "Austin, Texas", "degree": 2,
        "summary": "S" * 2000, "pendingInvitation": False, "flagshipProfileUrl": "https://www.linkedin.com/in/x",
        "contactInfo": {"primaryEmail": "pat@example.invalid", "phoneNumbers": [{"number": "555-0100"}]},
        "crmStatus": {"imported": True}, "objectUrn": "urn:li:member:1", "listCount": 3,
        "positions": [
            {"title": "VP Ops", "companyName": "Acme", "companyUrn": "urn:li:fs_salesCompany:111", "current": True,
             "description": "D" * 900, "startedOn": {"year": 2021, "month": 3}, "location": "Austin", "posId": 9,
             "companyUrnResolutionResult": {"name": "Acme", "companyPictureDisplayImage": {"a": 1}}},
            {"title": "Mgr", "companyName": "Old", "companyUrn": "urn:li:fs_salesCompany:222", "current": False,
             "startedOn": {"year": 2015}, "endedOn": {"year": 2021, "month": 2}}]}
    PROFILE_EXTRAS = {
        "educations": [{"schoolName": "State U", "degree": "BS", "fieldsOfStudy": ["Math"], "eduId": 4,
                        "startedOn": {"year": 2008}, "endedOn": {"year": 2012},
                        "schoolResolutionResult": {"url": "x"}}],
        "skills": [{"name": "Ops", "numOfEndorsement": 5}, {"name": "Sales"}],
        "languages": [{"name": "English", "proficiency": "NATIVE"}], "numOfConnections": 500,
        "memberBadges": {"premium": True, "openLink": False, "jobSeeker": True}, "inmailRestriction": "NO_RESTRICTION",
        "profilePictureDisplayImage": {"rootUrl": "x"}, "volunteeringExperiences": [{"role": "r"}]}

    def test_profile_main_url_slimming_and_contact_info_dropped(self):
        out = run_snippet("profile.js", {"lead": LEAD_URN}, [{"status": 200, "body": self.PROFILE_MAIN}])
        self.assertEqual(len(out["calls"]), 1)
        self.assertEqual(out["result"]["requests"], 1)
        url = out["calls"][0]["url"]
        self.assertTrue(url.startswith(
            "/sales-api/salesApiProfiles/(profileId:FIXTUREID123,authType:NAME_SEARCH,authToken:tok9)?decoration=%28entityUrn%2C"))
        self.assertNotIn("decoration=(", url)
        self.assertIn("contactInfo", url)  # the page's own decoration; the result must not carry it
        self.assertIn("positions*%28companyName%2Ccurrent", url)
        res = out["result"]
        self.assertEqual((res["status"], res["fullName"], res["degree"], res["pendingInvitation"]), (200, "Pat Example", 2, False))
        self.assertEqual(len(res["summary"]), 1500)
        first, second = res["positions"]
        self.assertEqual((first["companyId"], first["current"], first["startedOn"]), ("111", True, {"year": 2021, "month": 3}))
        self.assertEqual(len(first["description"]), 400)
        self.assertEqual(second["endedOn"], {"year": 2021, "month": 2})
        blob = json.dumps(res)
        for gone in ("contactInfo", "pat@example.invalid", "555-0100", "crmStatus", "objectUrn", "posId", "companyUrnResolutionResult"):
            self.assertNotIn(gone, blob)
        self.assertNotIn("educations", res)

    def test_profile_accepts_lead_url_and_triple(self):
        for lead in (LEAD, "https://www.linkedin.com/sales/lead/FIXTUREID123,NAME_SEARCH,tok9?_ntb=abc",
                     "urn%3Ali%3Afs_salesProfile%3A%28FIXTUREID123%2CNAME_SEARCH%2Ctok9%29"):
            with self.subTest(lead=lead):
                out = run_snippet("profile.js", {"lead": lead}, [{"status": 200, "body": {}}])
                self.assertIn("(profileId:FIXTUREID123,authType:NAME_SEARCH,authToken:tok9)", out["calls"][0]["url"])
        bad = run_snippet("profile.js", {"lead": "nonsense"})
        self.assertEqual((bad["result"]["error"], bad["calls"]), ("lead_required", []))

    def test_profile_extras_adds_second_call_and_slims(self):
        out = run_snippet("profile.js", {"lead": LEAD, "extras": True, "delayMs": 0},
                          [{"status": 200, "body": self.PROFILE_MAIN}, {"status": 200, "body": self.PROFILE_EXTRAS}])
        self.assertEqual(len(out["calls"]), 2)
        self.assertEqual(out["result"]["requests"], 2)
        self.assertIn("educations*%28degree%2CeduId", out["calls"][1]["url"])
        self.assertIn("inmailRestriction", out["calls"][1]["url"])
        res = out["result"]
        self.assertEqual(res["educations"], [{"schoolName": "State U", "degree": "BS", "fieldsOfStudy": ["Math"],
                                              "startedOn": {"year": 2008}, "endedOn": {"year": 2012}}])
        self.assertEqual(res["skills"], [{"name": "Ops", "endorsements": 5}, {"name": "Sales", "endorsements": 0}])
        self.assertEqual(res["languages"], [{"name": "English", "proficiency": "NATIVE"}])
        self.assertEqual((res["numOfConnections"], res["memberBadges"], res["inmailRestriction"]),
                         (500, {"openLink": False, "premium": True}, "NO_RESTRICTION"))
        for gone in ("jobSeeker", "volunteering", "profilePicture", "schoolResolutionResult"):
            self.assertNotIn(gone, json.dumps(res))

    def test_profile_errors_are_reported(self):
        out = run_snippet("profile.js", {"lead": LEAD}, [{"status": 403, "body": {"m": "no"}}])
        self.assertEqual(out["result"]["status"], 403)
        self.assertIn("body", out["result"])
        part = run_snippet("profile.js", {"lead": LEAD, "extras": True, "delayMs": 0},
                           [{"status": 200, "body": self.PROFILE_MAIN}, {"status": 429, "body": {}}])
        self.assertEqual((part["result"]["status"], part["result"]["partial"]), (429, True))
        self.assertEqual(part["result"]["fullName"], "Pat Example")
        self.assertEqual(part["result"]["requests"], 2)   # the failed request was made, so it counts
        self.assertEqual(out["result"]["requests"], 1)

    ACTIVITY = {"paging": {"start": 0, "count": 4, "links": []}, "elements": [
        {"createdAt": 1700000000000, "insightId": "i1",
         "activityUnion": {"commentActivity": {"comment": {"text": "C" * 800}, "commentUrl": "https://example.invalid/c1", "x": 1}}},
        {"createdAt": 1700000001000, "insightId": "i2",
         "activityUnion": {"postActivity": {"commentary": "a post"}}},
        {"createdAt": 1700000002000, "insightId": "i3", "activityUnion": {"commentActivity": {}}}]}

    def test_activity_url_and_slimming(self):
        import re
        out = run_snippet("activity.js", {"lead": LEAD, "days": 30, "count": 50}, [{"status": 200, "body": self.ACTIVITY}])
        url = out["calls"][0]["url"]
        self.assertTrue(url.startswith(
            "/sales-api/salesApiInsightsV2?insightTypes=List(LEAD_POST,LEAD_COMMENT)&q=findByMember"
            "&profile=urn%3Ali%3Afs_salesProfile%3A%28FIXTUREID123%2CNAME_SEARCH%2Ctok9%29&timeRange=(start:"))
        self.assertTrue(url.endswith("&start=0&count=10"))  # count clamped to 10
        start, end = map(int, re.search(r"timeRange=\(start:(\d+),end:(\d+)\)", url).groups())
        self.assertEqual(end - start, 30 * 86400000)
        res = out["result"]
        self.assertEqual((res["status"], res["rows"]), (200, 3))
        c1, post, c2 = res["elements"]
        self.assertEqual((c1["kind"], len(c1["text"]), c1["url"]), ("comment", 500, "https://example.invalid/c1"))
        self.assertEqual((post["kind"], post["text"], post["textGuess"]), ("post", "a post", True))
        self.assertNotIn("textGuess", c1)
        self.assertEqual(res["requests"], 1)
        self.assertEqual(c2, {"createdAt": 1700000002000, "kind": "comment"})  # no text or url keys when absent
        self.assertNotIn("insightId", json.dumps(res))

    def test_activity_comment_reads_known_paths_not_another_authors_text(self):
        """A comment item embeds the parent post (another author): its text and url must never be taken for the lead's."""
        nested = {"elements": [
            {"createdAt": 1, "activityUnion": {"commentActivity": {
                "parentPost": {"author": "Someone Else", "text": "OTHER AUTHOR POST", "url": "https://example.invalid/other"},
                "comment": {"text": "the lead's own words"}, "commentUrl": "https://example.invalid/mine"}}},
            {"createdAt": 2, "activityUnion": {"commentActivity": {
                "parentPost": {"text": "OTHER AUTHOR POST", "url": "https://example.invalid/other"}}}},
            {"createdAt": 3, "activityUnion": {"commentActivity": {"comment": {"text": ""}, "text": "loose", "commentUrl": 7}}}]}
        out = run_snippet("activity.js", {"lead": LEAD}, [{"status": 200, "body": nested}])
        first, no_text, loose = out["result"]["elements"]
        self.assertEqual(first, {"createdAt": 1, "kind": "comment", "text": "the lead's own words",
                                 "url": "https://example.invalid/mine"})
        self.assertEqual(no_text, {"createdAt": 2, "kind": "comment"})   # omitted rather than guessed
        self.assertEqual(loose, {"createdAt": 3, "kind": "comment"})
        self.assertNotIn("OTHER AUTHOR", json.dumps(out["result"]))

    def test_activity_default_window_and_errors(self):
        import re
        out = run_snippet("activity.js", {"lead": LEAD}, [{"status": 200, "body": {}}])
        url = out["calls"][0]["url"]
        start, end = map(int, re.search(r"timeRange=\(start:(\d+),end:(\d+)\)", url).groups())
        self.assertEqual(end - start, 90 * 86400000)
        self.assertTrue(url.endswith("&count=4"))
        self.assertEqual(out["result"]["elements"], [])
        bad = run_snippet("activity.js", {"lead": LEAD}, [{"status": 429, "body": {}}])
        self.assertEqual((bad["result"]["status"], bad["result"]["requests"]), (429, 1))
        self.assertEqual(run_snippet("activity.js", {})["result"]["error"], "lead_required")

    COMPANY = {
        "name": "Acme", "description": "d" * 2000, "website": "http://acme.example", "industry": "Software",
        "type": "Privately Held", "yearFounded": 2001, "specialties": ["a", "b"],
        "headquarters": {"city": "Austin", "geographicArea": "Texas", "country": "United States", "line1": "1 Main", "postalCode": "78701"},
        "revenueRange": {"estimatedMinRevenue": {"amount": 1.0, "unit": "MILLION"}},
        "employeeGrowthPercentages": [{"timespan": "SIX_MONTH", "percentage": 4}],
        "employeesResolutionResults": {"k": {"fullName": "Someone"}}, "crmOpportunities": 0, "account": {"saved": True},
        "companyPictureDisplayImage": {"rootUrl": "x"}}
    COUNTS = {"employeeCount": 120, "employeeCountRange": "51-200", "decisionMakersDisplayCount": "9",
              "personaResultCounts": [{"persona": {}}], "sharedAlumniSchoolIds": [1]}
    INSIGHTS = {"medianTenure": 2.5, "monthlyHeadCounts": [
        {"employeeCount": 120, "employeePercentageDifference": 3, "headCountsByDate": [{"date": "2026-01", "count": 110}]}]}
    ALERTS = {"metadata": {"numUnseen": 1}, "elements": [
        {"type": "NEWS_MENTION", "createdAt": 5, "headline": {"text": "Acme raises", "attributes": []}, "body": {"x": 1}},
        {"type": "HIRING", "createdAt": 6, "headline": "plain headline", "image": {"a": 1}}]}

    def test_account_main_only(self):
        out = run_snippet("account.js", {"companyId": "urn:li:fs_salesCompany:123"}, [{"status": 200, "body": self.COMPANY}])
        self.assertEqual(len(out["calls"]), 1)
        self.assertEqual(out["result"]["requests"], 1)
        url = out["calls"][0]["url"]
        self.assertTrue(url.startswith("/sales-api/salesApiCompanies/123?decoration=%28entityUrn%2Cname%2Caccount%28saved"))
        res = out["result"]
        self.assertEqual((res["status"], res["name"], res["website"], res["yearFounded"]), (200, "Acme", "http://acme.example", 2001))
        self.assertEqual(len(res["description"]), 1500)
        self.assertEqual(res["headquarters"], {"city": "Austin", "geographicArea": "Texas", "country": "United States"})
        self.assertEqual(res["employeeGrowthPercentages"], [{"timespan": "SIX_MONTH", "percentage": 4}])
        self.assertNotIn("headcount", res)
        self.assertNotIn("news", res)
        for gone in ("employeesResolutionResults", "Someone", "crmOpportunities", "account", "companyPicture"):
            self.assertNotIn(gone, json.dumps(res))

    def test_account_headcount_and_news_urls_and_slimming(self):
        out = run_snippet("account.js", {"companyId": 123, "headcount": True, "news": True, "count": 99, "delayMs": 0},
                          [{"status": 200, "body": self.COMPANY}, {"status": 200, "body": self.COUNTS},
                           {"status": 200, "body": self.INSIGHTS}, {"status": 200, "body": self.ALERTS}])
        urls = [c["url"] for c in out["calls"]]
        self.assertEqual(len(urls), 4)
        self.assertIn("decoration=%28entityUrn%2CemployeeCount%2CemployeeDisplayCount%2CemployeeCountRange%2CdecisionMakersDisplayCount", urls[1])
        self.assertEqual(urls[2], "/sales-api/salesApiEmployeeInsights/123?employeeInsightType=TOTAL_HEADCOUNT")
        self.assertEqual(urls[3], "/sales-api/salesApiEntityAlerts?q=criteria&entityUrn=urn%3Ali%3Afs_salesCompany%3A123"
                                  "&sortBy=TIME&buyerAlertsIndex=0&start=0&count=20")  # clamped to 20
        res = out["result"]
        self.assertEqual(res["requests"], 4)
        self.assertEqual(res["headcount"], {
            "employeeCount": 120, "employeeCountRange": "51-200", "decisionMakersDisplayCount": "9", "medianTenure": 2.5,
            "employeePercentageDifference": 3, "monthly": [{"date": "2026-01", "count": 110}]})
        self.assertEqual(res["news"], [{"type": "NEWS_MENTION", "headline": "Acme raises", "createdAt": 5},
                                       {"type": "HIRING", "headline": "plain headline", "createdAt": 6}])
        self.assertNotIn("personaResultCounts", json.dumps(res))

    def test_account_errors_and_missing_id(self):
        out = run_snippet("account.js", {"companyId": "1"}, [{"status": 403, "body": {}}])
        self.assertEqual(out["result"]["status"], 403)
        part = run_snippet("account.js", {"companyId": "1", "headcount": True, "delayMs": 0},
                           [{"status": 200, "body": self.COMPANY}, {"status": 200, "body": self.COUNTS}, {"status": 429, "body": {}}])
        self.assertEqual((part["result"]["status"], part["result"]["partial"], part["result"]["name"]), (429, True, "Acme"))
        self.assertEqual(part["result"]["requests"], 3)
        none = run_snippet("account.js", {})
        self.assertEqual((none["result"]["error"], none["calls"]), ("company_id_required", []))

    def test_account_id_is_whole_digits_or_trailing_digits_after_the_last_colon_or_slash(self):
        good = {"123": "123", 123: "123", " 123 ": "123", "urn:li:fs_salesCompany:123": "123",
                "https://www.linkedin.com/sales/company/123": "123",
                "https://www.linkedin.com/sales/company/123?_ntb=abc9": "123",
                "https://www.linkedin.com/sales/company/123/?x=1#top": "123"}
        for value, want in good.items():
            with self.subTest(value=value):
                out = run_snippet("account.js", {"companyId": value}, [{"status": 200, "body": self.COMPANY}])
                self.assertTrue(out["calls"][0]["url"].startswith("/sales-api/salesApiCompanies/%s?" % want), out["calls"])
        for value in ("123abc456", "abc", "12 34", "urn:li:fs_salesCompany:12a", "company/abc9", "", None, "-5", "1.5"):
            with self.subTest(value=value):
                out = run_snippet("account.js", {"companyId": value}, [{"status": 200, "body": self.COMPANY}])
                self.assertEqual((out["result"]["error"], out["calls"]), ("company_id_required", []))

    def test_detail_snippets_never_return_the_token_or_cookie(self):
        cases = (("profile.js", {"lead": LEAD, "extras": True, "delayMs": 0}, [self.PROFILE_MAIN, self.PROFILE_EXTRAS]),
                 ("activity.js", {"lead": LEAD}, [self.ACTIVITY]),
                 ("account.js", {"companyId": "1", "headcount": True, "news": True, "delayMs": 0},
                  [self.COMPANY, self.COUNTS, self.INSIGHTS, self.ALERTS]))
        for name, params, bodies in cases:
            with self.subTest(snippet=name):
                out = run_snippet(name, params, [{"status": 200, "body": b} for b in bodies])
                blob = json.dumps(out["result"])
                for secret in (TOKEN, "JSESSIONID", "tok9", "ajax:"):
                    self.assertNotIn(secret, blob)
                self.assertTrue(all(c["headers"]["csrf-token"] == TOKEN for c in out["calls"]))
                self.assertTrue(all(c["credentials"] == "include" for c in out["calls"]))

    # --- compact mode must not change what a snippet does
    CASES = {
        "lead_search.js": [
            ({"query": "(recentSearchParam:(id:1,doLogHistory:true),filters:List((type:REGION)))", "start": 25},
             [{"status": 200, "body": {"paging": {"total": 90}, "elements": [
                 {"fullName": "A", "crmStatus": {"a": 1}, "currentPositions": [{"title": "T", "$recipeType": "r"}]}]}}]),
            ({"query": "https://www.linkedin.com/sales/search/people?query=%28filters%3AList%28%28type%3AREGION%29%29%29&x=1"},
             [{"status": 403, "body": {"m": "no"}}]),
            ({"query": CLEAN, "raw": True}, [{"status": 200, "body": {"elements": [{"crmStatus": 1}]}}]),
        ],
        "account_search.js": [
            ({"query": CLEAN, "start": 50},
             [{"status": 200, "body": {"paging": {"total": 7}, "elements": [{"companyName": "X"}]}}]),
            ({"query": CLEAN, "start": 1000}, []),
        ],
        "count.js": [
            ({"kind": "account", "delayMs": 0, "queries": [{"label": "a", "query": CLEAN}, {"label": "b", "query": CLEAN}]},
             [{"status": 200, "body": {"paging": {"total": 11}}}, {"status": 400, "body": {}}]),
        ],
        "csrf_ready.js": [({}, [])],
        "typeahead.js": [
            ({"type": "BING_GEO", "term": "United States"},
             [{"status": 200, "body": {"elements": [{"id": "1", "displayValue": "US", "extra": 1}]}}]),
        ],
        "profile.js": [
            ({"lead": LEAD, "extras": True, "delayMs": 0},
             [{"status": 200, "body": PROFILE_MAIN_CASE}, {"status": 200, "body": {"skills": [{"name": "Ops"}]}}]),
            ({"lead": LEAD}, [{"status": 403, "body": {}}]),
        ],
        "activity.js": [
            ({"lead": LEAD, "days": 1, "count": 2},
             [{"status": 200, "body": {"elements": [{"createdAt": 1, "activityUnion": {"commentActivity": {"text": "hi"}}}]}}]),
        ],
        "account.js": [
            ({"companyId": "5", "headcount": True, "news": True, "delayMs": 0},
             [{"status": 200, "body": {"name": "N"}}, {"status": 200, "body": {"employeeCount": 3}},
              {"status": 200, "body": {"medianTenure": 1}}, {"status": 200, "body": {"elements": [{"type": "T", "headline": "h"}]}}]),
        ],
        "companies_websites.js": [
            ({"ids": ["urn:li:fs_salesCompany:1", "2", "x3"], "delayMs": 0},
             [{"status": 200, "body": {"results": {"1": {"name": "N1", "website": "http://n1.com"}}}}]),
        ],
        "companies_details.js": [
            ({"ids": ["urn:li:fs_salesCompany:1", "2"], "delayMs": 0},
             [{"status": 200, "body": {"results": {"1": {"name": "N1", "specialties": ["a", "b"],
                                                          "headquarters": {"city": "C", "country": "US"}}}}}]),
            ({"ids": ["1"], "fields": ["name"]}, [{"status": 403, "body": {}}]),
        ],
        "lists.js": [
            ({"listType": "ACCOUNT", "all": True, "delayMs": 0},
             [{"status": 200, "body": {"paging": {"total": 2}, "elements": [LIST_ROW]}},
              {"status": 200, "body": {"paging": {"total": 2}, "elements": [dict(LIST_ROW, id=8, name="B")]}}]),
            ({"listType": "LEAD"}, [{"status": 403, "body": {}}]),
        ],
        "list_create.js": [
            ({"name": "New", "listType": "ACCOUNT", "description": "d", "delayMs": 0},
             [{"status": 200, "body": {"paging": {"total": 1}, "elements": [LIST_ROW]}},
              {"status": 201, "body": None, "headers": {"x-restli-id": "99"}}]),
            ({"name": "A", "listType": "ACCOUNT"}, [{"status": 200, "body": {"paging": {"total": 1}, "elements": [LIST_ROW]}}]),
        ],
        "list_save_accounts.js": [
            ({"listId": "7", "ids": ["urn:li:fs_salesCompany:1", "2", "x"], "delayMs": 0},
             [{"status": 200, "body": {"value": {"listEntityActionResponses": [{"status": "SUCCESS"}, {"status": "SUCCESS"}]}}}]),
            ({"listId": "7", "ids": ["1"]}, [{"status": 400, "body": {}}]),
        ],
        "list_save_sharded.js": [
            ({"listId": "7", "ids": ["1", "2", "3"], "delayMs": 0, "readDelayMs": 0, "shardAt": 2},
             [lists_resp([(7, "Base", 1)]), save_resp(["SUCCESS"]), lists_resp([(7, "Base", 2)]), lists_resp([(7, "Base", 2)]),
              {"status": 201, "body": None, "headers": {"x-restli-id": "99"}}, save_resp(["SUCCESS"]),
              lists_resp([(7, "Base", 2), (99, "Base #2", 1)])]),
            ({"listId": "7", "ids": ["1"]}, [{"status": 403, "body": {}}]),
        ],
        "profiles_batch.js": [
            ({"leads": [LEAD_URN, "bad"], "delayMs": 0},
             [{"status": 200, "body": {"results": {"FIXTUREID123": {"fullName": "A", "positions": [{"title": "T", "current": True}]}}}}]),
            ({"leads": [LEAD], "batch": 1}, [{"status": 403, "body": {}}]),
            ({"leads": [LEAD_URN], "extras": True, "delayMs": 0},
             [{"status": 200, "body": {"results": {"FIXTUREID123": {"fullName": "A", "skills": [{"name": "x"}],
                                                                    "educations": [{"schoolName": "U"}]}}}}]),
        ],
    }

    @staticmethod
    def _without_ms(value):
        if isinstance(value, dict):
            return {k: PageSnippets._without_ms(v) for k, v in value.items() if k != "ms"}
        if isinstance(value, list):
            return [PageSnippets._without_ms(v) for v in value]
        if isinstance(value, str):  # activity.js stamps "now" into its timeRange
            import re
            return re.sub(r"timeRange=\(start:\d+,end:\d+\)", "timeRange=(now)", value)
        return value

    def test_compact_and_normal_forms_of_every_snippet_behave_identically(self):
        import sys
        import tempfile
        sys.path.insert(0, str(ROOT / "packages" / "browser-runtime"))
        import session
        self.assertEqual(sorted(self.CASES), sorted(p.name for p in PAGE.glob("*.js")), "add a case for each snippet")
        for path in sorted(PAGE.glob("*.js")):
            source = path.read_text(encoding="utf-8")
            compact = session.compact_js(source)
            self.assertLess(len(compact), len(source), path.name)
            with tempfile.TemporaryDirectory() as tmp:
                small = Path(tmp) / path.name
                small.write_text(compact)
                for params, responses in self.CASES[path.name]:
                    with self.subTest(snippet=path.name, params=json.dumps(params)[:60]):
                        want = self._without_ms(run_snippet(path.name, params, responses))
                        proc = subprocess.run(
                            [NODE, str(HARNESS), str(small), json.dumps(params), COOKIE, json.dumps(responses)],
                            capture_output=True, text=True, timeout=30)
                        self.assertEqual(proc.returncode, 0, proc.stderr)
                        self.assertEqual(self._without_ms(json.loads(proc.stdout)), want)

    def test_emitted_compact_expressions_evaluate_like_the_normal_ones(self):
        import sys
        sys.path.insert(0, str(ROOT / "packages" / "browser-runtime"))
        import session
        params = json.dumps({"query": "(recentSearchParam:(id:1),filters:List((type:REGION)))", "count": 1})
        results = []
        for compact in (False, True):
            code = session.emit_expression("lead_search.js", params, [PAGE], compact=compact)
            script = ("global.document={cookie:%s};global.performance={now:()=>0};"
                      "global.fetch=async(u)=>({status:200,json:async()=>({paging:{total:3},elements:[{n:u.length}]}),"
                      "text:async()=>''});"
                      "Promise.resolve(eval(%s)).then(r=>console.log(JSON.stringify(r)));"
                      % (json.dumps(COOKIE), json.dumps(code)))
            proc = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            results.append(json.loads(proc.stdout))
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0]["rows"], 1)

    # --- lists: read, create, save accounts
    def test_lists_url_slim_rows_and_paging(self):
        out = run_snippet("lists.js", {"listType": "ACCOUNT"},
                          [{"status": 200, "body": {"paging": {"total": 40}, "elements": [LIST_ROW]}}])
        call = out["calls"][0]
        self.assertEqual(call["url"], "/sales-api/salesApiLists?q=listType&listType=ACCOUNT&start=0&count=25")
        self.assertNotIn("method", {k: v for k, v in call.items() if v})   # a GET
        res = out["result"]
        self.assertEqual((res["status"], res["total"], res["rows"]), (200, 40, 1))
        self.assertEqual(res["lists"], [{"id": 7, "name": "A", "entityCount": 3, "listType": "ACCOUNT", "listSource": "MANUAL"}])
        out = run_snippet("lists.js", {"listType": "lead", "start": 25, "count": 500}, [{"status": 200, "body": {}}])
        self.assertIn("listType=LEAD&start=25&count=25", out["calls"][0]["url"])   # count is clamped to 25
        out = run_snippet("lists.js", {"listType": "ACCOUNT", "all": True, "delayMs": 0}, [
            {"status": 200, "body": {"paging": {"total": 30}, "elements": [dict(LIST_ROW, id=i) for i in range(25)]}},
            {"status": 200, "body": {"paging": {"total": 30}, "elements": [dict(LIST_ROW, id=100 + i) for i in range(5)]}}])
        self.assertEqual([c["url"].split("&start=")[1].split("&")[0] for c in out["calls"]], ["0", "25"])
        self.assertEqual(len(out["result"]["lists"]), 30)
        named = run_snippet("lists.js", {"listType": "ACCOUNT", "name": " a "},
                            [{"status": 200, "body": {"paging": {"total": 2}, "elements": [LIST_ROW, dict(LIST_ROW, id=8, name="B")]}}])
        self.assertEqual([x["id"] for x in named["result"]["lists"]], [7])
        self.assertEqual(run_snippet("lists.js", {"listType": "PEOPLE"}, [])["result"]["error"], "list_type_invalid")

    def test_list_create_posts_body_with_role_and_reads_id_from_header(self):
        out = run_snippet("list_create.js", {"name": " PureFlow TAM ", "listType": "account", "description": "d"},
                          [{"status": 200, "body": {"paging": {"total": 1}, "elements": [LIST_ROW]}},
                           {"status": 201, "body": None, "headers": {"x-restli-id": "99"}}])
        read, post = out["calls"]
        self.assertIn("/sales-api/salesApiLists?q=listType&listType=ACCOUNT", read["url"])   # reads first
        self.assertEqual((post["url"], post["method"]), ("/sales-api/salesApiLists", "POST"))
        self.assertEqual(json.loads(post["body"]),
                         {"name": "PureFlow TAM", "listType": "ACCOUNT", "role": "OWNER", "description": "d"})
        self.assertEqual(post["headers"]["content-type"], "application/json")
        self.assertEqual(post["headers"]["csrf-token"], TOKEN)
        self.assertEqual(out["result"], {"status": 201, "id": "99", "name": "PureFlow TAM", "reused": False})

    def test_list_create_id_from_body_or_by_rereading_the_lists(self):
        empty = {"status": 200, "body": {"paging": {"total": 0}, "elements": []}}
        out = run_snippet("list_create.js", {"name": "N", "listType": "LEAD"}, [empty, {"status": 200, "body": {"id": 55}}])
        self.assertEqual((out["result"]["id"], len(out["calls"])), ("55", 2))
        again = {"status": 200, "body": {"paging": {"total": 1}, "elements": [dict(LIST_ROW, id=123, name="n")]}}
        out = run_snippet("list_create.js", {"name": "N", "listType": "LEAD", "delayMs": 0},
                          [empty, {"status": 201, "body": None}, again])
        self.assertEqual((out["result"]["id"], out["result"]["reused"], len(out["calls"])), ("123", False, 3))
        out = run_snippet("list_create.js", {"name": "N", "listType": "LEAD", "delayMs": 0},
                          [empty, {"status": 201, "body": None}, empty])
        self.assertEqual(out["result"]["error"], "created_but_id_unread")

    def test_list_create_refuses_an_existing_name_unless_reuse(self):
        existing = [{"status": 200, "body": {"paging": {"total": 1}, "elements": [LIST_ROW]}}]
        out = run_snippet("list_create.js", {"name": " a ", "listType": "ACCOUNT"}, existing)
        self.assertEqual((out["result"]["error"], out["result"]["id"]), ("list_name_exists", 7))
        self.assertEqual([c.get("method") for c in out["calls"]], [None])   # no write was made
        out = run_snippet("list_create.js", {"name": "A", "listType": "ACCOUNT", "reuse": True}, existing)
        self.assertEqual(out["result"], {"status": 200, "id": 7, "name": "A", "reused": True})
        self.assertEqual(len(out["calls"]), 1)

    def test_list_create_refusals_and_errors_make_no_write(self):
        for params, err in (({"listType": "ACCOUNT"}, "name_required"), ({"name": "  ", "listType": "ACCOUNT"}, "name_required"),
                            ({"name": "N"}, "list_type_invalid"), ({"name": "N", "listType": "COMPANY"}, "list_type_invalid")):
            with self.subTest(params=params):
                out = run_snippet("list_create.js", params, [])
                self.assertEqual((out["result"]["error"], out["calls"]), (err, []))
        out = run_snippet("list_create.js", {"name": "N", "listType": "ACCOUNT"}, [], cookie="x=1")
        self.assertEqual((out["result"]["error"], out["calls"]), ("csrf_missing", []))
        out = run_snippet("list_create.js", {"name": "N", "listType": "ACCOUNT"}, [{"status": 403, "body": {"m": "no"}}])
        self.assertEqual((out["result"]["status"], len(out["calls"])), (403, 1))
        empty = {"status": 200, "body": {"paging": {"total": 0}, "elements": []}}
        out = run_snippet("list_create.js", {"name": "N", "listType": "ACCOUNT"}, [empty, {"status": 422, "body": {"m": "x"}}])
        self.assertEqual(out["result"]["status"], 422)
        self.assertIn("x", out["result"]["body"])

    def test_list_save_accounts_url_body_and_result(self):
        ok = {"status": 200, "body": {"value": {"listEntityActionResponses": [{"status": "SUCCESS"}]}}}
        out = run_snippet("list_save_accounts.js", {"listId": "7", "ids": ["urn:li:fs_salesCompany:11", "22", "22", "x"]}, [ok])
        call = out["calls"][0]
        self.assertEqual((call["url"], call["method"]), ("/sales-api/salesApiCompanies?action=save", "POST"))
        self.assertEqual(json.loads(call["body"]), {"companyIds": [11, 22], "lists": ["7"]})   # int ids, deduped
        self.assertEqual(call["headers"]["content-type"], "application/json")
        self.assertEqual(call["headers"]["csrf-token"], TOKEN)
        self.assertEqual(call["credentials"], "include")
        res = out["result"]
        self.assertEqual((res["status"], res["saved"], res["failed"], res["batches"], res["invalid"]), (200, 2, [], 1, 1))

    def test_list_save_accounts_chunks_at_50_and_clamps_batch(self):
        ids = [str(i) for i in range(1, 126)]
        for params in ({}, {"batch": 500}, {"batch": 75}):
            with self.subTest(params=params):
                ok = {"status": 200, "body": {"value": {"listEntityActionResponses": [{"status": "SUCCESS"}]}}}
                out = run_snippet("list_save_accounts.js", dict({"listId": 7, "ids": ids, "delayMs": 0}, **params), [ok] * 3)
                sizes = [len(json.loads(c["body"])["companyIds"]) for c in out["calls"]]
                self.assertEqual(sizes, [50, 50, 25])
                self.assertTrue(all(json.loads(c["body"])["lists"] == ["7"] for c in out["calls"]))
                self.assertEqual((out["result"]["saved"], out["result"]["failed"], out["result"]["batches"]), (125, [], 3))
        out = run_snippet("list_save_accounts.js", {"listId": 7, "ids": ids[:10], "delayMs": 0, "batch": 4}, [])
        self.assertEqual([len(json.loads(c["body"])["companyIds"]) for c in out["calls"]], [4, 4, 2])

    def test_list_save_accounts_reports_partial_failures_and_stops_on_http_errors(self):
        mixed = {"status": 200, "body": {"value": {"listEntityActionResponses": [{"status": "SUCCESS"}, {"status": "FAILED"}, {"status": "SUCCESS"}]}}}
        out = run_snippet("list_save_accounts.js", {"listId": "7", "ids": ["1", "2", "3"]}, [mixed])
        self.assertEqual((out["result"]["saved"], out["result"]["failed"]), (2, ["2"]))   # one entry per id: by position
        odd = {"status": 200, "body": {"value": {"listEntityActionResponses": [{"status": "SUCCESS"}, {"status": "FAILED"}]}}}
        out = run_snippet("list_save_accounts.js", {"listId": "7", "ids": ["1", "2", "3"]}, [odd])
        self.assertEqual((out["result"]["saved"], out["result"]["failed"]), (0, ["1", "2", "3"]))
        out = run_snippet("list_save_accounts.js", {"listId": "7", "ids": ["1", "2", "3"]}, [{"status": 200, "body": {}}])
        self.assertEqual((out["result"]["saved"], out["result"]["failed"]), (0, ["1", "2", "3"]))   # no SUCCESS seen: not saved
        ids = [str(i) for i in range(1, 121)]
        ok = {"status": 200, "body": {"value": {"listEntityActionResponses": [{"status": "SUCCESS"}]}}}
        out = run_snippet("list_save_accounts.js", {"listId": "7", "ids": ids, "delayMs": 0},
                          [ok, {"status": 429, "body": {"m": "slow"}}])
        res = out["result"]
        self.assertEqual((res["status"], res["saved"], res["batches"], len(out["calls"])), (429, 50, 2, 2))
        self.assertEqual(res["failed"], ids[50:])   # the failed batch and the one never attempted

    def test_list_save_accounts_refusals_make_no_request(self):
        for params, err in (({"ids": ["1"]}, "list_id_required"), ({"listId": "  ", "ids": ["1"]}, "list_id_required"),
                            ({"listId": "7", "ids": []}, "ids_required"), ({"listId": "7", "ids": ["x", "y"]}, "ids_required"),
                            ({"listId": "7"}, "ids_required")):
            with self.subTest(params=params):
                out = run_snippet("list_save_accounts.js", params, [])
                self.assertEqual((out["result"]["error"], out["calls"]), (err, []))
        out = run_snippet("list_save_accounts.js", {"listId": "7", "ids": ["1"]}, [], cookie="x=1")
        self.assertEqual((out["result"]["error"], out["calls"]), ("csrf_missing", []))

    def test_only_the_list_write_snippets_use_a_write_method(self):
        writers = sorted(p.name for p in PAGE.glob("*.js") if "method:" in p.read_text())
        self.assertEqual(writers, ["list_create.js", "list_save_accounts.js", "list_save_sharded.js"])

    def test_list_save_accounts_counts_exceed_limit_separately(self):
        mixed = save_resp(["SUCCESS", "EXCEED_LIMIT", "FAILED"])
        res = run_snippet("list_save_accounts.js", {"listId": "7", "ids": ["1", "2", "3"]}, [mixed])["result"]
        self.assertEqual((res["saved"], res["exceeded"], res["failed"]), (1, ["2"], ["3"]))
        res = run_snippet("list_save_accounts.js", {"listId": "7", "ids": ["1", "2", "3"]}, [save_resp(["EXCEED_LIMIT"])])["result"]
        self.assertEqual((res["saved"], res["exceeded"], res["failed"]), (0, ["1", "2", "3"], []))   # unmappable: whole batch

    # --- list_save_sharded.js: auto-rotation at the 1,000 cap
    def test_sharded_rotates_when_the_count_reaches_the_cap_and_creates_the_next_list(self):
        ids = [str(i) for i in range(1, 11)]
        out = run_snippet("list_save_sharded.js", dict({"listId": "7", "ids": ids}, **SHARD), [
            lists_resp([(7, "Base", 996)]),                      # read the confirmed list
            save_resp(["SUCCESS"] * 4),                          # batch cut to the 4 slots left
            lists_resp([(7, "Base", 1000)]),                     # verify entityCount: at the cap
            lists_resp([(7, "Base", 1000)]),                     # look for "Base #2": none
            {"status": 201, "body": None, "headers": {"x-restli-id": "99"}},
            save_resp(["SUCCESS"] * 6),
            lists_resp([(7, "Base", 1000), (99, "Base #2", 6)]),
        ])
        res = out["result"]
        saves = save_calls(out)
        self.assertEqual([(b["lists"], b["companyIds"]) for b in saves], [(["7"], [1, 2, 3, 4]), (["99"], [5, 6, 7, 8, 9, 10])])
        create = [c for c in out["calls"] if c.get("method") == "POST" and c["url"] == "/sales-api/salesApiLists"][0]
        self.assertEqual(json.loads(create["body"]), {"name": "Base #2", "listType": "ACCOUNT", "role": "OWNER"})
        self.assertEqual((res["status"], res["saved"], res["failed"], res["exceeded"], res["base"]), (200, 10, [], 0, "Base"))
        self.assertEqual([(s["listId"], s["name"], s["saved"], s["entityCount"], s["created"]) for s in res["shards"]],
                         [("7", "Base", 4, 1000, False), ("99", "Base #2", 6, 6, True)])

    def test_sharded_exceed_limit_mid_batch_is_not_saved_and_is_resaved_in_the_next_list(self):
        ids = [str(i) for i in range(1, 11)]
        out = run_snippet("list_save_sharded.js", dict({"listId": "7", "ids": ids}, **SHARD), [
            lists_resp([(7, "Base", 990)]),
            save_resp(["SUCCESS"] * 5 + ["EXCEED_LIMIT"] * 5),   # the stale count hid that the list was full
            lists_resp([(7, "Base", 1000)]),
            lists_resp([(7, "Base", 1000)]),
            {"status": 201, "body": None, "headers": {"x-restli-id": "99"}},
            save_resp(["SUCCESS"] * 5),
            lists_resp([(7, "Base", 1000), (99, "Base #2", 5)]),
        ])
        res = out["result"]
        self.assertEqual([(b["lists"], b["companyIds"]) for b in save_calls(out)],
                         [(["7"], list(range(1, 11))), (["99"], [6, 7, 8, 9, 10])])
        self.assertEqual((res["saved"], res["exceeded"], res["failed"]), (10, 5, []))
        self.assertEqual([(s["name"], s["saved"], s["exceeded"]) for s in res["shards"]], [("Base", 5, 5), ("Base #2", 5, 0)])
        self.assertEqual(res["shards"][0]["countMismatches"], 1)   # 990 -> 1000 with 5 saved: the count was stale

    def test_sharded_reuses_an_existing_numbered_list_and_never_creates_it(self):
        out = run_snippet("list_save_sharded.js", dict({"listId": "7", "ids": ["1", "2"]}, **SHARD), [
            lists_resp([(7, "Base", 1000), (8, "base #2", 100)]),   # the confirmed list is already full
            lists_resp([(7, "Base", 1000), (8, "base #2", 100)]),   # "Base #2" exists (case-insensitive)
            save_resp(["SUCCESS", "SUCCESS"]),
            lists_resp([(7, "Base", 1000), (8, "base #2", 102)]),
        ])
        res = out["result"]
        self.assertEqual([c["method"] for c in out["calls"] if c.get("method")], ["POST"])   # only the save
        self.assertEqual([(b["lists"], b["companyIds"]) for b in save_calls(out)], [(["8"], [1, 2])])
        self.assertEqual([(s["listId"], s["created"], s["saved"], s["entityCount"]) for s in res["shards"]],
                         [("7", False, 0, 1000), ("8", False, 2, 102)])

    def test_sharded_strips_an_existing_suffix_and_skips_a_full_next_list(self):
        out = run_snippet("list_save_sharded.js", dict({"listId": "8", "ids": ["1"], "name": "Base #2"}, **SHARD), [
            lists_resp([(8, "Base #2", 1000), (9, "Base #3", 1000)]),
            lists_resp([(8, "Base #2", 1000), (9, "Base #3", 1000)]),   # "Base #3" exists but is full
            lists_resp([(8, "Base #2", 1000), (9, "Base #3", 1000)]),   # so "Base #4" is looked up
            {"status": 201, "body": None, "headers": {"x-restli-id": "10"}},
            save_resp(["SUCCESS"]),
            lists_resp([(10, "Base #4", 1)]),
        ])
        res = out["result"]
        self.assertEqual(res["base"], "Base")
        self.assertEqual([b["lists"] for b in save_calls(out)], [["10"]])
        self.assertEqual([s["name"] for s in res["shards"]], ["Base #2", "Base #3", "Base #4"])
        create = [c for c in out["calls"] if c.get("method") == "POST" and c["url"] == "/sales-api/salesApiLists"][0]
        self.assertEqual(json.loads(create["body"])["name"], "Base #4")

    def test_sharded_batches_are_50_and_stop_on_a_non_200(self):
        ids = [str(i) for i in range(1, 121)]
        out = run_snippet("list_save_sharded.js", dict({"listId": "7", "ids": ids}, **SHARD), [
            lists_resp([(7, "Base", 0)]), save_resp(["SUCCESS"]), lists_resp([(7, "Base", 50)]),
            {"status": 429, "body": {"m": "slow"}},
        ])
        res = out["result"]
        self.assertEqual([len(b["companyIds"]) for b in save_calls(out)], [50, 50])
        self.assertEqual((res["status"], res["saved"], res["batches"]), (429, 50, 2))
        self.assertEqual(res["failed"], ids[50:])   # the failed batch and the one never attempted

    def test_sharded_stops_when_the_next_list_cannot_be_created_or_the_count_is_unreadable(self):
        out = run_snippet("list_save_sharded.js", dict({"listId": "7", "ids": ["1", "2"]}, **SHARD), [
            lists_resp([(7, "Base", 1000)]), lists_resp([(7, "Base", 1000)]), {"status": 422, "body": {"m": "bad"}}])
        res = out["result"]
        self.assertEqual((res["status"], res["saved"], res["failed"], save_calls(out)), (422, 0, ["1", "2"], []))
        out = run_snippet("list_save_sharded.js", dict({"listId": "7", "ids": ["1", "2"]}, **SHARD), [
            lists_resp([(7, "Base", 0)]), save_resp(["SUCCESS"] * 2), {"status": 500, "body": {}}])
        res = out["result"]
        self.assertEqual((res["status"], res["error"], res["saved"], res["failed"]), (500, "count_unreadable", 2, []))

    def test_sharded_caps_shards_and_refuses_without_writing(self):
        out = run_snippet("list_save_sharded.js", dict({"listId": "7", "ids": ["1"], "maxShards": 1}, **SHARD),
                          [lists_resp([(7, "Base", 1000)])])
        self.assertEqual((out["result"]["error"], out["result"]["failed"], save_calls(out)), ("max_shards_reached", ["1"], []))
        out = run_snippet("list_save_sharded.js", dict({"listId": "99", "ids": ["1"]}, **SHARD), [lists_resp([(7, "Base", 0)])])
        self.assertEqual((out["result"]["error"], out["result"]["failed"], save_calls(out)), ("list_not_found", ["1"], []))
        for params, err in (({"ids": ["1"]}, "list_id_required"), ({"listId": "7", "ids": ["x"]}, "ids_required")):
            out = run_snippet("list_save_sharded.js", params, [])
            self.assertEqual((out["result"]["error"], out["calls"]), (err, []))
        out = run_snippet("list_save_sharded.js", {"listId": "7", "ids": ["1"]}, [], cookie="x=1")
        self.assertEqual((out["result"]["error"], out["calls"]), ("csrf_missing", []))

    # --- lead_search.js: per-request timeout, retry with a smaller count
    @staticmethod
    def _run_lead_search_with_hanging_fetch(params, hang_above):
        """A fetch that never answers (but honours AbortSignal) when count > hang_above."""
        script = """
        global.document = {cookie: %s};
        const seen = [];
        global.fetch = (url, opts) => {
          const count = Number(/count=(\\d+)/.exec(url)[1]);
          seen.push(count);
          if (count <= %d) return Promise.resolve({status: 200, json: async () => ({paging: {total: 9}, elements: [{n: count}]}), text: async () => ''});
          return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e); }));
        };
        const fn = eval('(' + %s + ')');
        fn(%s).then((result) => console.log(JSON.stringify({result, seen})));
        """ % (json.dumps(COOKIE), hang_above, json.dumps((PAGE / "lead_search.js").read_text(encoding="utf-8").strip()),
               json.dumps(params))
        proc = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30)
        assert proc.returncode == 0, proc.stderr
        return json.loads(proc.stdout)

    def test_lead_search_retries_a_timed_out_page_with_a_halved_count(self):
        out = self._run_lead_search_with_hanging_fetch(
            {"query": CLEAN, "count": 100, "timeoutMs": 60, "budgetMs": 2000}, hang_above=30)
        res = out["result"]
        self.assertEqual(out["seen"], [100, 50, 25])
        self.assertEqual((res["status"], res["count"], res["retries"], res["rows"], res["start"]), (200, 25, 2, 1, 0))
        self.assertEqual(res["elements"], [{"n": 25}])

    def test_lead_search_without_a_timeout_makes_one_request_and_reports_retries_0(self):
        out = self._run_lead_search_with_hanging_fetch({"query": CLEAN, "count": 40, "timeoutMs": 60}, hang_above=100)
        self.assertEqual((out["seen"], out["result"]["retries"], out["result"]["count"]), ([40], 0, 40))

    def test_lead_search_reports_fetch_timeout_with_a_hint_when_every_attempt_times_out(self):
        out = self._run_lead_search_with_hanging_fetch(
            {"query": CLEAN, "count": 40, "timeoutMs": 40, "budgetMs": 5000}, hang_above=0)
        res = out["result"]
        self.assertEqual(out["seen"], [40, 20, 10])   # halved down to the minimum of 10, then stop
        self.assertEqual((res["status"], res["error"], res["count"], res["retries"], res["tried"]),
                         (0, "fetch_timeout", 10, 2, [40, 20, 10]))
        self.assertIn("evaluate_timeout_ms", res["hint"])
        self.assertIn("lower count", res["hint"])

    def test_lead_search_stops_retrying_when_the_budget_is_spent(self):
        out = self._run_lead_search_with_hanging_fetch(
            {"query": CLEAN, "count": 100, "timeoutMs": 80, "budgetMs": 100}, hang_above=0)
        self.assertEqual(out["result"]["error"], "fetch_timeout")
        self.assertLess(len(out["seen"]), 4)
        self.assertLess(out["result"]["ms"], 1000)

    def test_csrf_ready(self):
        self.assertTrue(run_snippet("csrf_ready.js", {})["result"]["ready"])
        self.assertFalse(run_snippet("csrf_ready.js", {"timeoutMs": 50}, cookie="x=1")["result"]["ready"])


if __name__ == "__main__":
    unittest.main()
