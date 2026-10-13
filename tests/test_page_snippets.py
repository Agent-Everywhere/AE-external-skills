"""Tests for skills/sales-navigator/page/*.js, run in Node against a fake document and fetch.

Skipped when `node` is not installed. Run from the repo root:  python3 -m pytest -q tests
"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "skills" / "sales-navigator" / "page"
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

    def test_count_is_clamped_to_25(self):
        out = run_snippet("lead_search.js", {"query": CLEAN, "count": 500}, [{"status": 200, "body": {}}])
        self.assertIn("&count=25&", out["calls"][0]["url"])

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
        self.assertEqual((post["kind"], post["text"]), ("post", "a post"))
        self.assertEqual(c2, {"createdAt": 1700000002000, "kind": "comment"})  # no text or url keys when absent
        self.assertNotIn("insightId", json.dumps(res))

    def test_activity_default_window_and_errors(self):
        import re
        out = run_snippet("activity.js", {"lead": LEAD}, [{"status": 200, "body": {}}])
        url = out["calls"][0]["url"]
        start, end = map(int, re.search(r"timeRange=\(start:(\d+),end:(\d+)\)", url).groups())
        self.assertEqual(end - start, 90 * 86400000)
        self.assertTrue(url.endswith("&count=4"))
        self.assertEqual(out["result"]["elements"], [])
        bad = run_snippet("activity.js", {"lead": LEAD}, [{"status": 429, "body": {}}])
        self.assertEqual(bad["result"]["status"], 429)
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
        none = run_snippet("account.js", {})
        self.assertEqual((none["result"]["error"], none["calls"]), ("company_id_required", []))

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

    def test_csrf_ready(self):
        self.assertTrue(run_snippet("csrf_ready.js", {})["result"]["ready"])
        self.assertFalse(run_snippet("csrf_ready.js", {"timeoutMs": 50}, cookie="x=1")["result"]["ready"])


if __name__ == "__main__":
    unittest.main()
