"""linkedin-job-signals and its engine parts under plugins/linkedin: the public-page parsers on fixtures, profile
validation and the presets, the title/post filters, the paced public fetcher against a local server (no cookies, stops
at the first block, daily caps), reading posts, company fit, the CSV exports, the signed-in fallback snippet and its
merge, and the skill's manifest and docs.

Run from the repo root:  python3 -m pytest -q tests
"""
import csv
import datetime
import http.server
import json
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_linkedin_classic import (COOKIE, ENGINE, HARNESS, NODE, SCRIPTS, SKILLS, T0, T_PLUS_1H, T_PLUS_24H1,  # noqa: E402
                                   run_snippet)

TOOL = SCRIPTS / "job_signals.py"
SEARCH_JS = SCRIPTS / "search_jobs.js"
PRESETS = ENGINE / "references" / "job_signal_presets.json"
FIX = Path(__file__).resolve().parent / "fixtures" / "linkedin_jobs"
SKILL = SKILLS / "linkedin-job-signals" / "SKILL.md"

sys.path.insert(0, str(SCRIPTS))
import job_signals as js  # noqa: E402

NOW = datetime.datetime(2026, 11, 5, 12, 0, 0)


def fx(name):
    return (FIX / name).read_text(encoding="utf-8")


# ---- a local stand-in for LinkedIn's public pages ----------------------------------------------------------

class Site:
    """Serves the fixtures on 127.0.0.1 and records every request, so the fetcher is tested over real HTTP."""

    def __init__(self):
        self.requests = []
        self.search_status = 200
        self.search_body = fx("search_page.html")
        self.fragment_body = fx("search_fragment.html")
        self.redirect_to = None
        self.detail_override = None
        site = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, status, body="", headers=None):
                self.send_response(status)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(body.encode())

            def do_GET(self):
                site.requests.append({"path": self.path, "headers": dict(self.headers)})
                if self.path.startswith("/authwall"):
                    return self.reply(200, "<html>please sign in</html>")
                if site.redirect_to:
                    return self.reply(302, "", {"Location": site.redirect_to})
                if self.path.startswith("/jobs/search"):
                    return self.reply(site.search_status, site.search_body if site.search_status == 200 else "")
                if self.path.startswith("/jobs-guest/jobs/api/seeMoreJobPostings/search"):
                    return self.reply(site.search_status, site.fragment_body if site.search_status == 200 else "")
                m = re.match(r"/jobs/view/(\d+)", self.path)
                if m and site.detail_override is not None:
                    return self.reply(200, site.detail_override)
                if m:
                    jid = m.group(1)
                    if jid == "4400000001":
                        return self.reply(200, fx("detail_robotics.html"))
                    if jid in ("4400000005", "4400000004"):
                        return self.reply(200, fx("detail_noise.html"))
                    if jid == "4400000099":
                        return self.reply(404)
                    return self.reply(200, fx("detail_robotics.html"))
                self.reply(404)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Work(unittest.TestCase):
    """A temp working dir, a local site, and a runner for job_signals.py."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.site = Site()
        self.addCleanup(self.site.close)
        self.dir = self.tmp / "linkedin-job-signals-work"

    def raw(self, *args, now=T0, stdin=None):
        return subprocess.run([sys.executable, "-I", "-B", str(TOOL), "--now", now, "--base-url", self.site.url, "--fast",
                               *args], capture_output=True, text=True, cwd=self.tmp, input=stdin)

    def run_ok(self, *args, now=T0):
        p = self.raw(*args, now=now)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def refuses(self, *args, now=T0, code=2):   # not `fail`: unittest's sequence/dict asserts call self.refuses()
        p = self.raw(*args, now=now)
        self.assertEqual(p.returncode, code, p.stdout + p.stderr)
        return p

    def write(self, name, obj):
        path = self.tmp / name
        path.write_text(obj if isinstance(obj, str) else json.dumps(obj), encoding="utf-8")
        return str(path)

    def set_profile(self, **changes):
        base = {"name": "t", "offer": "a data service", "icp": {"industries": ["robotics"]},
                "keywords": ["teleoperation operator"], "location": "United States", "days": 30,
                "title_exclude": ["dispatch", "telecommunicat", "\\b911\\b"],
                "families": [{"name": "Teleoperation", "title_regex": ["tele-?operat", "data collect"],
                              "buyer_titles": ["Head of Data Operations", "Robot Learning Lead"]}],
                "description_include": ["robot", "humanoid"], "description_exclude": ["\\b911\\b"],
                "evidence_terms": ["humanoid"], "buyer_titles": ["Head of Data"],
                "qualify_rules": ["strong: builds robots"]}
        base.update(changes)
        self.dir.mkdir(exist_ok=True)
        (self.dir / "profile.json").write_text(json.dumps(base), encoding="utf-8")

    def started(self, **changes):
        self.set_profile(**changes)
        self.run_ok("init")

    def ledger(self):
        return json.loads((self.dir / "ledger.json").read_text())

    def jobs(self):
        with open(self.dir / "jobs.csv", encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


# ---- parsers ----------------------------------------------------------------------------------------------

class PublicPageParsers(unittest.TestCase):
    def test_search_page_cards(self):
        rows = js.parse_cards(fx("search_page.html"))
        self.assertEqual([r["job_id"] for r in rows], ["44000000%02d" % n for n in range(1, 8)])   # the repeat is dropped
        first = rows[0]
        self.assertEqual((first["title"], first["company"], first["company_slug"], first["location"], first["listed_at"],
                          first["listed_text"]), ("Teleoperation Operator", "Company A", "company-a", "Austin, TX",
                                                  "2026-11-03", "1 day ago"))
        self.assertEqual(rows[2]["title"], "Robot Teleoperator & Pilot")            # entities decoded
        undated = rows[6]
        self.assertEqual((undated["company"], undated["company_slug"], undated["listed_at"], undated["listed_text"]),
                         ("Company F (Confidential)", "", "", "4 days ago"))

    def test_fragment_and_empty_and_garbage(self):
        self.assertEqual([r["job_id"] for r in js.parse_cards(fx("search_fragment.html"))], ["4400000011"])
        self.assertEqual(js.parse_cards(fx("search_empty.html")), [])
        self.assertEqual(js.parse_cards("<html>" + "x" * 1000), [])

    def test_job_detail_page(self):
        d = js.parse_detail(fx("detail_robotics.html"))
        self.assertEqual((d["title"], d["company"], d["location"], d["posted"]),
                         ("Teleoperation Operator", "Company A", "Austin, TX", "2 days ago"))
        self.assertEqual(d["criteria"], ["Entry level", "Full-time", "Engineering"])
        self.assertIn("hiring 7 teleoperation operators", d["text"])
        self.assertIn("Operate humanoid robots remotely", d["text"])
        self.assertNotIn("<", d["text"])
        self.assertIn("Perks: relocation support.", d["text"])         # text after a nested <div> is kept
        self.assertIn("three sites", d["text"])
        self.assertEqual(js.parse_detail("<html></html>")["text"], "")

    def test_a_post_is_cut_at_a_fixed_length(self):
        big = fx("detail_robotics.html").replace("We are scaling", "x" * 20000 + " We are scaling")
        self.assertLessEqual(len(js.parse_detail(big)["text"]), js.MAX_TEXT)

    def test_block_reasons(self):
        b = js.block_reason
        for status in (401, 403, 429, 999):
            self.assertEqual(b(status, "", ""), "http_%d" % status)
        self.assertEqual(b(200, "https://www.linkedin.com/authwall?trk=x", ""), "login_redirect")
        self.assertEqual(b(200, "https://www.linkedin.com/checkpoint/challenge", ""), "checkpoint")
        self.assertEqual(b(200, "https://www.linkedin.com/jobs/search", fx("search_captcha.html")), "captcha")
        self.assertEqual(b(500, "", ""), "http_500")
        self.assertEqual(b(0, "", ""), "network_error")
        self.assertIsNone(b(200, "https://www.linkedin.com/jobs/search", fx("search_page.html")))
        self.assertIsNone(b(200, "x", fx("search_empty.html")))
        # a legitimate page that merely contains sign-in wording is not a block
        self.assertIsNone(b(200, "x", fx("search_empty.html") + "<p>Sign in to continue to save jobs</p>"))
        self.assertIsNone(b(200, "x", "<html>sign in to continue</html>"))
        # a redirect is a stop, never followed
        self.assertEqual(b(302, "https://www.linkedin.com/authwall?x=1", ""), "login_redirect")
        self.assertEqual(b(302, "https://www.linkedin.com/somewhere", ""), "unexpected_redirect")

    def test_dates(self):
        d = js.iso_date
        self.assertEqual(d("2026-10-01", NOW), ("2026-10-01", False))
        self.assertEqual(d("3 days ago", NOW), ("2026-11-02", True))
        self.assertEqual(d("2 weeks ago", NOW), ("2026-10-22", True))
        self.assertEqual(d("5 hours ago", NOW), ("2026-11-05", True))
        self.assertEqual(d(1793000000000, NOW)[1], False)
        self.assertEqual(d("Reposted", NOW), ("", False))


# ---- profile, presets and filters -------------------------------------------------------------------------

class ProfileAndPresets(unittest.TestCase):
    def test_every_preset_is_a_valid_profile_with_precise_phrases(self):
        presets = json.loads(PRESETS.read_text())["presets"]
        self.assertEqual(sorted(presets), ["ai-domain-experts", "physical-ai-data"])
        for name, body in presets.items():
            with self.subTest(preset=name):
                prof = js.validate_profile(dict(body, name=name))
                self.assertGreaterEqual(len(prof["keywords"]), 6)
                self.assertTrue(all(len(k.split()) >= 2 or k.isupper() for k in prof["keywords"]), prof["keywords"])
                self.assertTrue(prof["families"] and all(f["buyer_titles"] for f in prof["families"]))
                self.assertTrue(prof["description_include"])
                self.assertEqual(prof["offer"], "")    # a seller sets their own offer at intake

    def test_physical_ai_preset_drops_emergency_dispatch_titles(self):
        prof = js.validate_profile(json.loads(PRESETS.read_text())["presets"]["physical-ai-data"])
        smap = {"s1": {"keywords": "teleoperation operator"}}
        rows = js.parse_cards(fx("search_page.html"))
        for r in rows:
            r["searches"] = "s1"
        verdict = {r["title"]: js.judge(prof, r, smap, {})["ok"] for r in rows}
        self.assertTrue(verdict["Teleoperation Operator"])
        self.assertTrue(verdict["Robot Teleoperator & Pilot"])
        self.assertTrue(verdict["Robot Data Collection Technician"])
        self.assertTrue(verdict["Robotics Data Annotator"])
        self.assertFalse(verdict["Public Safety Telecommunicator I"])
        self.assertFalse(verdict["Teleoperations Dispatcher"])

    def test_invalid_profiles_are_refused_with_a_reason(self):
        ok = {"keywords": ["a b"]}
        js.validate_profile(ok)
        for bad, word in (({}, "keywords"), ({"keywords": []}, "keywords"), ({"keywords": ["a"], "days": 0}, "days"),
                          ({"keywords": ["a"], "days": 400}, "days"), ({"keywords": ["a"], "title_exclude": ["("]}, "regular"),
                          ({"keywords": ["a"], "families": [{"name": ""}]}, "families"), ([], "object"),
                          ({"keywords": "a b"}, "keywords")):
            with self.subTest(bad=bad):
                with self.assertRaises(js.Fail) as cm:
                    js.validate_profile(bad)
                self.assertIn(word, str(cm.exception))

    def test_all_words_fallback_when_the_profile_has_no_title_filters(self):
        prof = js.validate_profile({"keywords": ["ai trainer"]})
        smap = {"s1": {"keywords": "ai trainer"}}
        hit = {"title": "Senior AI Trainer (Coding)", "searches": "s1", "job_id": "1"}
        miss = {"title": "Trainer of Dogs", "searches": "s1", "job_id": "2"}
        self.assertTrue(js.judge(prof, hit, smap, {})["ok"])
        self.assertFalse(js.judge(prof, miss, smap, {})["ok"])

    def test_the_post_confirms_or_rejects_a_role(self):
        prof = js.validate_profile(json.loads(PRESETS.read_text())["presets"]["physical-ai-data"])
        job = {"title": "Teleoperation Operator", "searches": "s1", "job_id": "9"}
        good = {"9": {"status": "ok", "text": "Teleoperate humanoid robots."}}
        noise = {"9": {"status": "ok", "text": "Answer 911 emergency calls."}}
        vague = {"9": {"status": "ok", "text": "Work shifts in a control room."}}
        self.assertEqual(js.judge(prof, job, {}, good)["post"], "confirmed")
        r = js.judge(prof, job, {}, noise)
        self.assertEqual((r["ok"], r["post"]), (False, "rejected"))
        self.assertEqual(js.judge(prof, job, {}, vague)["post"], "rejected")      # no description_include word
        self.assertEqual(js.judge(prof, job, {}, {})["post"], "not read")

    def test_evidence_snippets_hold_headcount_and_profile_terms(self):
        prof = js.validate_profile({"keywords": ["a b"], "evidence_terms": ["humanoid"]})
        ev = js.evidence_of(prof, js.parse_detail(fx("detail_robotics.html"))["text"])
        self.assertTrue(any("hiring 7 teleoperation operators" in e for e in ev), ev)
        self.assertTrue(any("humanoid" in e.lower() for e in ev))
        self.assertLessEqual(len(ev), 4)


class ProfileCommands(Work):
    def test_profile_from_a_preset_then_init_creates_one_search_per_keyword(self):
        out = self.run_ok("profile", "--preset", "physical-ai-data")
        self.assertTrue(out["valid"])
        self.assertTrue((self.dir / "profile.json").is_file())
        self.refuses("profile", "--preset", "physical-ai-data")                  # never overwrites silently
        self.run_ok("profile", "--preset", "physical-ai-data", "--force")
        self.refuses("profile", "--preset", "nope")
        init = self.run_ok("init")
        self.assertEqual(len(init["searches"]), 8)
        self.assertEqual(self.ledger()["caps"], {"public_search": 12, "public_detail": 30, "tab_search": 10})

    def test_a_saved_profile_is_loaded_again_and_edits_sync_the_searches(self):
        self.started(keywords=["teleoperation operator", "robot data collection"])
        self.assertEqual(len(self.ledger()["searches"]), 2)
        self.set_profile(keywords=["teleoperation operator", "humanoid data collection"])
        out = self.run_ok("init")
        self.assertEqual((out["searches_added"], out["searches_retired"]), (1, 1))
        retired = {s["keywords"]: s["retired"] for s in self.ledger()["searches"]}
        self.assertEqual(retired, {"teleoperation operator": False, "robot data collection": True, "humanoid data collection": False})
        (self.dir / "profile.json").write_text("{not json")
        p = self.refuses("status")
        self.assertIn("not valid JSON", p.stderr)

    def test_presets_command_lists_the_examples_only(self):
        out = self.run_ok("presets")
        self.assertEqual([p["name"] for p in out["presets"]], ["physical-ai-data", "ai-domain-experts"])


# ---- the public fetcher ------------------------------------------------------------------------------------

class PublicFetch(Work):
    def test_fetch_reads_the_page_and_sends_no_cookie_or_login(self):
        self.started()
        out = self.run_ok("fetch")
        self.assertEqual((out["requests_made"], out["total_jobs"]), (1, 7))
        req = self.site.requests[0]
        self.assertTrue(req["path"].startswith("/jobs/search?"))
        self.assertIn("keywords=teleoperation%20operator", req["path"])
        self.assertIn("location=United%20States", req["path"])
        self.assertIn("f_TPR=r2592000", req["path"])
        self.assertIn("sortBy=DD", req["path"])
        low = {k.lower() for k in req["headers"]}
        self.assertFalse(low & {"cookie", "authorization", "csrf-token"}, low)
        self.assertIn("Mozilla/5.0", req["headers"]["User-Agent"])
        self.assertEqual(len(self.jobs()), 7)
        self.assertEqual(self.ledger()["searches"][0]["next_start"], 7)   # 8 cards on the page, one a repeat

    def test_second_page_uses_the_see_more_endpoint_with_a_start_offset(self):
        self.started()
        self.run_ok("fetch")
        out = self.run_ok("fetch", "--search", "s1")
        self.assertEqual(out["per_search"]["s1"]["added"], 1)
        path = self.site.requests[1]["path"]
        self.assertTrue(path.startswith("/jobs-guest/jobs/api/seeMoreJobPostings/search?"), path)
        self.assertIn("start=7", path)
        self.assertIn("f_TPR=r2592000", path)

    def test_a_repeat_fetch_dedupes_by_job_id_and_remembers_the_search(self):
        self.started(keywords=["teleoperation operator", "robot teleoperator"])
        self.run_ok("fetch", "--max-requests", "2")
        rows = self.jobs()
        self.assertEqual(len(rows), 7)
        self.assertEqual({r["searches"] for r in rows}, {"s1; s2"})
        self.assertEqual(self.ledger()["searches"][1]["next_start"], 7)

    def test_a_search_without_results_is_marked_done_and_does_not_lock(self):
        self.site.search_body = fx("search_empty.html")
        self.started()
        out = self.run_ok("fetch")
        self.assertEqual(out["per_search"]["s1"]["ended"], "no_results")
        self.assertTrue(self.ledger()["searches"][0]["done"])
        self.assertEqual(self.ledger()["stops"], [])

    def test_a_block_stops_at_once_locks_for_a_day_and_is_never_retried(self):
        self.started(keywords=["teleoperation operator", "robot teleoperator"])
        self.site.search_status = 429
        out = self.run_ok("fetch", "--max-requests", "6")
        self.assertEqual((out["stopped_reason"], out["requests_made"]), ("http_429", 1))
        self.assertIn("signed-in tab fallback", out["note"])
        self.assertEqual(len(self.site.requests), 1)                       # no retry, no next search
        again = self.run_ok("fetch", now=T_PLUS_1H)
        self.assertEqual(again["reason"], "stopped:http_429")
        self.assertEqual(again["locked_until"], "2026-11-03T10:00:00Z")
        self.assertEqual(len(self.site.requests), 1)                       # the lock made no request at all
        self.site.search_status = 200
        self.assertEqual(self.run_ok("fetch", now=T_PLUS_24H1)["stopped_reason"], None)

    def test_login_wall_redirects_and_captcha_pages_are_blocks(self):
        for label, setup, reason in (("authwall", lambda s: setattr(s, "redirect_to", "/authwall?trk=x"), "login_redirect"),
                                     ("captcha", lambda s: setattr(s, "search_body", fx("search_captcha.html")), "captcha"),
                                     ("999", lambda s: setattr(s, "search_status", 999), "http_999")):
            with self.subTest(label):
                self.setUp()
                self.started()
                setup(self.site)
                out = self.run_ok("fetch")
                self.assertEqual(out["stopped_reason"], reason)
                self.assertEqual(self.ledger()["stops"][0]["reason"], reason)

    def test_the_daily_cap_and_the_per_run_limit(self):
        self.started(keywords=["k%d one" % i for i in range(8)])
        self.run_ok("cap", "public_search", "3")
        out = self.run_ok("fetch", "--max-requests", "6")
        self.assertEqual((out["requests_made"], out["stopped_reason"]), (3, "daily_cap_reached"))
        self.assertEqual(self.run_ok("fetch", now=T_PLUS_1H)["requests_made"], 0)
        self.assertEqual(self.run_ok("fetch", now=T_PLUS_24H1)["requests_made"] > 0, True)
        p = self.refuses("cap", "public_search", "50")
        self.assertIn("--user-approved-raise", p.stderr)
        self.run_ok("cap", "public_search", "50", "--user-approved-raise")
        self.refuses("cap", "bogus", "3")

    def test_the_run_limit_is_six_requests(self):
        self.started(keywords=["k%d one" % i for i in range(8)])
        self.run_ok("cap", "public_search", "12")
        out = self.run_ok("fetch", "--max-requests", "50")
        self.assertEqual((out["requests_made"], out["stopped_reason"]), (6, "run_limit"))

    def test_a_remote_base_url_other_than_linkedin_is_refused(self):
        self.started()
        p = subprocess.run([sys.executable, "-I", "-B", str(TOOL), "--now", T0, "--base-url", "https://example.org", "fetch"],
                           capture_output=True, text=True, cwd=self.tmp)
        self.assertEqual(p.returncode, 2)
        self.assertIn("--base-url", p.stderr)

    def test_a_redirect_is_not_followed(self):
        self.started()
        self.site.redirect_to = "/authwall?trk=x"
        out = self.run_ok("fetch")
        self.assertEqual(out["stopped_reason"], "login_redirect")
        self.assertEqual([r["path"].split("?")[0] for r in self.site.requests], ["/jobs/search"])   # /authwall never requested
        self.site.redirect_to = "/elsewhere"
        self.assertEqual(self.run_ok("fetch", now=T_PLUS_24H1)["stopped_reason"], "unexpected_redirect")

    def test_an_empty_page_without_the_results_list_is_a_suspect_layout_not_the_end(self):
        self.started()
        self.site.search_body = "<!DOCTYPE html><html><body><h1>Something changed</h1></body></html>"
        out = self.run_ok("fetch")
        self.assertEqual(out["stopped_reason"], "suspect_layout")
        self.assertFalse(self.ledger()["searches"][0]["done"])
        self.assertEqual(self.ledger()["stops"][0]["reason"], "suspect_layout")
        self.assertIn("does not recognise", out["note"])

    def test_a_later_page_ends_only_on_an_empty_fragment(self):
        self.started()
        self.run_ok("fetch")
        self.site.fragment_body = "   \n"
        out = self.run_ok("fetch", "--search", "s1")
        self.assertEqual(out["per_search"]["s1"]["ended"], "end_of_results")
        self.assertTrue(self.ledger()["searches"][0]["done"])
        self.setUp()
        self.started()
        self.run_ok("fetch")
        self.site.fragment_body = "<html><body>who knows</body></html>"
        self.assertEqual(self.run_ok("fetch", "--search", "s1")["stopped_reason"], "suspect_layout")
        self.assertFalse(self.ledger()["searches"][0]["done"])

    def test_the_last_request_time_is_kept_in_the_ledger_and_the_pause_holds_across_runs(self):
        from unittest import mock
        self.started()
        self.run_ok("fetch")
        self.assertGreater(self.ledger()["last_public"], 0)
        pub = js.Public(self.site.url, False, last=js.time.time())      # a run that starts right after another
        with mock.patch.object(js.time, "sleep") as sleep, mock.patch.object(js.random, "uniform", return_value=5.0):
            pub.get("/jobs/view/4400000001")
        self.assertEqual(len(sleep.call_args_list), 1)
        self.assertTrue(4.0 <= sleep.call_args[0][0] <= 5.0, sleep.call_args)

    def test_the_fetcher_has_a_randomised_pause_of_three_to_eight_seconds(self):
        self.assertEqual(js.DELAY, (3.0, 8.0))
        src = (SCRIPTS / "job_signals.py").read_text()
        self.assertIn("random.uniform(*DELAY)", src)
        self.assertNotIn("http.cookiejar", src)
        self.assertNotIn("HTTPCookieProcessor", src)


# ---- posts, fit, export ------------------------------------------------------------------------------------

class PostsFitAndExport(Work):
    def fetched(self, **changes):
        self.started(**changes)
        self.run_ok("fetch")

    def test_report_ranks_companies_and_says_why_each_matched(self):
        self.fetched()
        rep = self.run_ok("report")
        names = [c["company"] for c in rep["results"]]
        self.assertEqual(names[0], "Company A")                                  # two matching roles
        self.assertEqual(set(names), {"Company A", "Company B", "Company F (Confidential)"})
        self.assertEqual(rep["dropped_by_title"], 3)                              # telecommunicator, dispatcher, annotator
        a = rep["results"][0]
        self.assertEqual(a["open_roles"], 2)
        self.assertEqual((a["most_recent_posting"], a["earliest_posting"]), ("2026-11-03", "2026-10-20"))
        self.assertEqual(a["linkedin_company_url"], "https://www.linkedin.com/company/company-a/")
        self.assertEqual(a["suggested_buyer_titles"], ["Head of Data Operations", "Robot Learning Lead", "Head of Data"])
        self.assertTrue(all("post: not read" in w for w in a["why"]))
        self.assertIn("untrusted", rep["note"])
        self.assertEqual(rep["offer"], "a data service")

    def test_all_titles_shows_what_the_filters_dropped(self):
        self.fetched()
        self.assertEqual(self.run_ok("report", "--all-titles")["companies"], 6)

    def test_details_read_the_posts_and_confirm_or_reject_roles(self):
        self.fetched(title_exclude=["telecommunicat"])        # let the dispatcher title through: the post must drop it
        before = self.run_ok("report")
        self.assertIn("City D", [c["company"] for c in before["results"]])
        out = self.run_ok("details", "--limit", "10")
        self.assertEqual(out["posts_gone"], 0)
        self.assertGreaterEqual(out["posts_read"], 3)
        paths = [r["path"] for r in self.site.requests if r["path"].startswith("/jobs/view/")]
        self.assertTrue(paths and all(re.fullmatch(r"/jobs/view/\d+", p) for p in paths), paths)
        after = self.run_ok("report")
        names = [c["company"] for c in after["results"]]
        self.assertNotIn("City D", names)                                          # 911 post rejected the role
        self.assertEqual(after["dropped_by_post"], 1)
        a = next(c for c in after["results"] if c["company"] == "Company A")
        self.assertGreaterEqual(a["posts_read"], 1)
        self.assertTrue(any("hiring 7 teleoperation operators" in e for e in a["post_evidence"]), a["post_evidence"])
        self.assertEqual(a["seniority"], ["Entry level"])
        self.assertTrue(any("post: confirmed" in w for w in a["why"]))
        text = self.run_ok("job-text", "4400000001")
        self.assertIn("hiring 7 teleoperation operators", text["untrusted_text"])
        self.refuses("job-text", "4400000999")
        dets = json.loads((self.dir / "details.json").read_text())
        self.assertNotIn("cookie", json.dumps(dets).lower())

    def test_details_go_one_post_per_company_first_and_never_repeat(self):
        self.fetched()
        self.run_ok("details", "--limit", "1")
        first = [r["path"] for r in self.site.requests if r["path"].startswith("/jobs/view/")]
        self.assertEqual(len(first), 1)
        self.run_ok("details", "--limit", "2")
        seen = [r["path"] for r in self.site.requests if r["path"].startswith("/jobs/view/")]
        self.assertEqual(len(seen), len(set(seen)), seen)
        self.run_ok("cap", "public_detail", "2")
        out = self.run_ok("details", "--limit", "5", now=T_PLUS_1H)
        self.assertEqual((out["requests_made"], out["stopped_reason"]), (0, "daily_cap_reached"))

    def test_a_page_that_is_not_a_job_page_is_never_stored_as_a_post(self):
        self.fetched()
        self.site.detail_override = fx("detail_interstitial.html")
        out = self.run_ok("details", "--limit", "5")
        self.assertEqual((out["stopped_reason"], out["requests_made"], out["posts_read"]), ("suspect_layout", 1, 0))
        self.assertFalse((self.dir / "details.json").exists() and json.loads((self.dir / "details.json").read_text()))
        self.assertEqual(self.run_ok("details", now=T_PLUS_1H)["reason"], "stopped:suspect_layout")

    def test_two_job_pages_in_a_row_without_a_description_stop_the_run(self):
        self.fetched()
        self.site.detail_override = fx("detail_nodesc.html")
        out = self.run_ok("details", "--limit", "5")
        self.assertEqual((out["stopped_reason"], out["requests_made"]), ("suspect_layout", 2))
        dets = json.loads((self.dir / "details.json").read_text())
        self.assertEqual({v["status"] for v in dets.values()}, {"no_text"})

    def test_init_force_keeps_stops_requests_fit_and_posts_and_drop_work_keeps_the_locks(self):
        self.fetched()
        self.run_ok("details", "--limit", "1")
        self.run_ok("qualify", self.write("fit.json", [{"company": "Company A", "fit": "strong", "reason": "r"}]))
        self.site.search_status = 429
        self.run_ok("fetch", "--search", "s1", now=T_PLUS_1H)
        n_requests = len(self.ledger()["requests"])
        out = self.run_ok("init", "--force", now=T_PLUS_1H)
        self.assertTrue(out["restarted"])
        led = self.ledger()
        self.assertEqual(len(led["requests"]), n_requests)
        self.assertEqual(led["stops"][0]["reason"], "http_429")
        self.assertIn("li:company-a", led["fit"])
        self.assertEqual(led["searches"][0]["next_start"], 0)
        self.assertEqual(len(self.jobs()), 7)
        self.assertTrue(json.loads((self.dir / "details.json").read_text()))
        self.assertEqual(self.run_ok("fetch", now=T_PLUS_1H)["reason"], "stopped:http_429")      # the lock survived
        self.refuses("init", "--drop-work")
        self.run_ok("init", "--force", "--drop-work", now=T_PLUS_1H)
        led = self.ledger()
        self.assertEqual((led["fit"], self.jobs(), led["stops"][0]["reason"]), ({}, [], "http_429"))
        self.assertEqual(len(led["requests"]), n_requests)
        self.assertEqual(json.loads((self.dir / "details.json").read_text()), {})

    def test_a_saved_fit_follows_a_company_that_later_gets_a_linkedin_slug(self):
        prof = js.validate_profile({"keywords": ["teleoperation operator"]})
        row = {"job_id": "4400000007", "title": "Teleoperation Operator", "company": "Beta Robotics, Inc.", "company_slug": "",
               "location": "", "listed_at": "2026-11-01", "listed_text": "", "dates_approx": "", "job_url": "u", "searches": "s1"}
        led = {"searches": [{"id": "s1", "keywords": "teleoperation operator"}], "fit": {
            "name:beta robotics": {"name": "beta robotics", "fit": "strong", "reason": "r", "evidence": "", "website": ""}}}
        first = js.companies(prof, [row], led, {})[0][0]
        self.assertEqual((first["key"], first["fit"]), ("name:beta robotics", "strong"))
        later = js.companies(prof, [dict(row, company_slug="beta-robotics")], led, {})[0][0]
        self.assertEqual((later["key"], later["fit"]), ("li:beta-robotics", "strong"))

    def test_a_block_while_reading_posts_stops_and_locks(self):
        self.fetched()
        self.site.redirect_to = "/authwall?x=1"
        out = self.run_ok("details", "--limit", "5")
        self.assertEqual((out["stopped_reason"], out["requests_made"]), ("login_redirect", 1))
        self.assertEqual(self.run_ok("details", now=T_PLUS_1H)["reason"], "stopped:login_redirect")

    def test_qualify_stores_fit_and_validates_it(self):
        self.fetched()
        f = self.write("fit.json", [
            {"company": "Company A", "fit": "strong", "reason": "builds humanoids, 2 roles", "evidence": "hiring 7 operators",
             "website": "https://www.company-a.example/careers"},
            {"company": "Company B", "fit": "no", "reason": "existing customer"},
            {"company": "Nobody Inc", "fit": "maybe"}])
        out = self.run_ok("qualify", f)
        self.assertEqual((out["saved"], out["unmatched"]), (2, ["Nobody Inc"]))
        self.assertEqual(out["unqualified_left"], 1)
        self.refuses("qualify", self.write("bad.json", [{"company": "Company A", "fit": "great"}]))
        self.refuses("qualify", self.write("bad2.json", {"x": 1}))
        led = self.ledger()["fit"]["li:company-a"]
        self.assertEqual((led["fit"], led["website"]), ("strong", "company-a.example"))
        st = self.run_ok("status")
        self.assertEqual(st["fit"], {"strong": 1, "maybe": 0, "no": 1, "unqualified": 1})

    def test_export_writes_the_full_csv_with_fit_columns_and_an_apollo_csv_without_no_fits(self):
        self.fetched(exclude_companies=["Company F (Confidential)"])
        self.run_ok("details", "--limit", "10")
        self.run_ok("qualify", self.write("fit.json", [
            {"company": "Company A", "fit": "strong", "reason": "builds humanoids", "evidence": "hiring 7 operators",
             "website": "company-a.example"},
            {"company": "Company B", "fit": "no", "reason": "already a customer"}]))
        out = self.run_ok("export")
        full = read_csv(self.tmp / out["full_csv"])
        self.assertEqual(list(full[0].keys()), js.COMPANY_COLS)
        by = {r["company"]: r for r in full}
        self.assertEqual(set(by), {"Company A", "Company B", "Company F (Confidential)"})
        a = by["Company A"]
        self.assertEqual((a["fit"], a["fit_reason"], a["evidence"], a["website"]),
                         ("strong", "builds humanoids", "hiring 7 operators", "company-a.example"))
        self.assertEqual(a["open_roles"], "2")
        self.assertEqual(a["role_titles"], "Teleoperation Operator; Robot Data Collection Technician")
        self.assertEqual((a["most_recent_posting"], a["earliest_posting"]), ("2026-11-03", "2026-10-20"))
        self.assertEqual(a["locations"], "Austin, TX")
        self.assertEqual(a["suggested_buyer_titles"], "Head of Data Operations; Robot Learning Lead; Head of Data")
        self.assertEqual(len(a["job_urls"].split()), 2)
        self.assertEqual((by["Company B"]["fit"], by["Company B"]["fit_reason"]), ("no", "already a customer"))
        self.assertEqual(by["Company F (Confidential)"]["fit"], "no")
        self.assertIn("excluded", by["Company F (Confidential)"]["fit_reason"])
        apollo = read_csv(self.tmp / out["apollo_csv"])
        self.assertEqual(list(apollo[0].keys()), ["Company Name", "Website", "LinkedIn Url", "Keywords", "Notes"])
        self.assertEqual([r["Company Name"] for r in apollo], ["Company A"])           # "no" fits are not in the Apollo file
        self.assertEqual((apollo[0]["Website"], apollo[0]["LinkedIn Url"]), ("company-a.example", "https://www.linkedin.com/company/company-a/"))
        self.assertIn("Teleoperation", apollo[0]["Keywords"])
        self.assertIn("Hiring 2 matching roles (posted 2026-10-20 to 2026-11-03)", apollo[0]["Notes"])
        self.assertIn("Fit: strong - builds humanoids", apollo[0]["Notes"])
        self.assertEqual((out["full_rows"], out["apollo_rows"], out["dropped_as_no_fit"]), (3, 1, 2))

    def test_unqualified_companies_are_in_apollo_unless_fit_is_required(self):
        self.fetched()
        self.assertEqual(self.run_ok("export")["apollo_rows"], 3)
        self.assertEqual(self.run_ok("export", "--require-fit")["apollo_rows"], 0)

    def test_export_filter_out_dir_and_formula_guard(self):
        self.fetched()
        self.run_ok("qualify", self.write("fit.json", [{"company": "Company A", "fit": "maybe", "reason": "=HYPERLINK(\"x\")"}]))
        out = self.run_ok("export", "--where", "company=Company A", "--out-dir", str(self.tmp / "out"))
        self.assertEqual(out["full_rows"], 1)
        raw = (self.tmp / "out" / "job-signals.companies.csv").read_text(encoding="utf-8-sig")
        self.assertIn("'=HYPERLINK", raw)
        self.refuses("export", "--where", "nope=x")

    def test_an_undated_card_keeps_its_listed_text_and_approximate_flag(self):
        self.fetched()
        rows = {r["job_id"]: r for r in self.jobs()}
        undated = rows["4400000007"]
        self.assertEqual((undated["listed_at"], undated["listed_text"], undated["dates_approx"]), ("2026-10-29", "4 days ago", "1"))
        self.assertEqual(rows["4400000001"]["dates_approx"], "")

    def test_jobs_csv_is_formula_guarded_on_disk_and_raw_in_memory(self):
        self.site.search_body = fx("search_page.html").replace("Company B", "=cmd|x")
        self.fetched()
        raw = (self.dir / "jobs.csv").read_text(encoding="utf-8-sig")
        self.assertIn("'=cmd|x", raw)
        names = [c["company"] for c in self.run_ok("report")["results"]]
        self.assertIn("=cmd|x", names)


# ---- the signed-in fallback --------------------------------------------------------------------------------

def tab_result(issue, rows, stopped=None, pages_read=1, search="s1", page_from=1):
    return {"rows": rows, "pages_read": pages_read, "pages_attempted": pages_read, "total": 40, "stopped_reason": stopped,
            "request": {"keywords": "teleoperation operator", "days": 30, "page_from": page_from, "pages": 3,
                        "search": search, "issue": issue}}


def tab_row(jid, title="Teleoperation Operator", company="Company Z", cid="777", at="2026-10-30"):
    return {"job_id": jid, "title": title, "company": company, "company_id": cid, "location": "Remote",
            "listed_at": at, "listed_text": "6 days ago", "page": 1}


class TabFallback(Work):
    def test_next_pages_reserves_requests_and_merge_settles_them(self):
        self.started()
        n = self.run_ok("next-pages")
        self.assertEqual(n["params"]["keywords"], "teleoperation operator")
        self.assertEqual((n["params"]["page_from"], n["params"]["pages"], n["params"]["days"], n["params"]["location"]),
                         (1, 3, 30, "United States"))
        self.assertEqual(n["remaining_24h"], 7)
        self.assertEqual(self.run_ok("next-pages")["reason"], "open_issue")
        res = self.write("r.json", tab_result(n["params"]["issue"], [tab_row("4400000101"), tab_row("4400000102", company="Company Y", cid="")], pages_read=2))
        m = self.run_ok("merge", res)
        self.assertEqual((m["added"], m["total_jobs"]), (2, 2))
        self.assertTrue(self.run_ok("merge", res)["already_merged"])
        rows = {r["job_id"]: r for r in self.jobs()}
        self.assertEqual(rows["4400000101"]["company_url"], "https://www.linkedin.com/company/777/")
        self.assertEqual((rows["4400000101"]["source"], rows["4400000101"]["searches"]), ("signed-in", "s1"))
        n2 = self.run_ok("next-pages", now=T_PLUS_1H)
        self.assertEqual(n2["params"]["page_from"], 3)                  # two pages of 25 were read
        self.assertEqual(n2["remaining_24h"], 5)

    def test_merge_needs_a_run_id_from_this_ledger_and_a_rows_list(self):
        self.started()
        self.refuses("merge", self.write("a.json", {"rows": [], "request": {"issue": "nope"}}))
        self.refuses("merge", self.write("b.json", {"nothing": 1}))
        self.refuses("merge", str(self.tmp / "absent.json"))

    def test_a_tab_stop_locks_the_tab_channel_only(self):
        self.started()
        n = self.run_ok("next-pages")
        self.run_ok("merge", self.write("r.json", tab_result(n["params"]["issue"], [], stopped="http_429", pages_read=0)))
        self.assertEqual(self.run_ok("next-pages", now=T_PLUS_1H)["reason"], "stopped:http_429")
        self.assertIsNone(self.run_ok("fetch", now=T_PLUS_1H)["stopped_reason"])    # the public channel is unaffected

    def test_the_last_page_is_marked_done_and_never_issued_as_page_41(self):
        self.started(keywords=["teleoperation operator", "robot teleoperator"])
        led = self.ledger()
        led["searches"][0]["tab_next_start"] = 975
        led["searches"][1]["tab_next_start"] = 1000
        (self.dir / "ledger.json").write_text(json.dumps(led))
        n = self.run_ok("next-pages", "--search", "s2")
        self.assertEqual((n["params"], n["reason"]), (None, "nothing_left"))
        self.assertTrue(self.ledger()["searches"][1]["tab_done"])
        n = self.run_ok("next-pages", "--pages", "5")
        self.assertEqual((n["params"]["search"], n["params"]["page_from"], n["params"]["pages"]), ("s1", 40, 1))
        self.run_ok("merge", self.write("r.json", tab_result(n["params"]["issue"], [tab_row("4400000201")], search="s1", page_from=40)))
        self.assertTrue(self.ledger()["searches"][0]["tab_done"])
        self.assertEqual(self.run_ok("next-pages", now=T_PLUS_1H)["reason"], "nothing_left")

    def test_abandoned_runs_still_count_against_the_cap(self):
        self.started()
        self.run_ok("next-pages", "--pages", "5")
        out = self.run_ok("next-pages", "--abandon-issue", "--pages", "5")
        self.assertEqual(out["remaining_24h"], 0)


@unittest.skipUnless(NODE, "node not installed")
class SearchJobsSnippet(unittest.TestCase):
    MS = 1793000000000

    def card(self, jid, title="Teleoperation Operator", company="Company Z", cid="777"):
        return {"$type": "com.linkedin.voyager.dash.jobs.JobPostingCard", "jobPostingTitle": title,
                "jobPostingUrn": "urn:li:fsd_jobPosting:%s" % jid, "primaryDescription": {"text": company},
                "secondaryDescription": {"text": "Remote"},
                "footerItems": [{"type": "LISTED_DATE", "timeAt": self.MS, "text": {"text": "2 days ago"}}],
                "logo": {"attributes": [{"detailDataUnion": {"companyLogo": "urn:li:fsd_company:%s" % cid}}]}}

    def page(self, *ids, extra=(), total=60):
        return {"status": 200, "body": {
            "data": {"paging": {"total": total, "count": 25, "start": 0},
                     "elements": [{"jobCardUnion": {"*jobPostingCard": "urn:li:fsd_jobPostingCard:(%s,JOB_DETAILS)" % i}} for i in ids]},
            "included": [self.card(i) for i in ids] + [self.card(i, title="Prefetched") for i in extra]}}

    def run_js(self, params, responses=None, **kw):
        return run_snippet(SEARCH_JS, dict({"__test": True, "minDelayMs": 0, "maxDelayMs": 0}, **params), responses, **kw)

    def test_request_url_headers_and_rows(self):
        out = self.run_js({"keywords": "teleoperation operator", "location": "United States", "days": 7, "pages": 1},
                          [self.page("4400000101", "4400000102", extra=("4400000999",))])
        call = out["calls"][0]
        self.assertTrue(call["url"].startswith("/voyager/api/voyagerJobsDashJobCards?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220&count=25&q=jobSearch&query=("), call["url"])
        self.assertIn("keywords:teleoperation%20operator", call["url"])
        self.assertIn("locationUnion:(seoLocation:(location:United%20States))", call["url"])
        self.assertIn("selectedFilters:(sortBy:List(DD),timePostedRange:List(r604800))", call["url"])
        self.assertTrue(call["url"].endswith("&start=0"))
        self.assertEqual(call["headers"]["csrf-token"], "ajax:0123456789")
        self.assertEqual(call["credentials"], "include")
        r = out["result"]
        self.assertEqual([x["job_id"] for x in r["rows"]], ["4400000101", "4400000102"])      # the prefetched card is not a row
        self.assertEqual((r["rows"][0]["company"], r["rows"][0]["company_id"], r["rows"][0]["location"]), ("Company Z", "777", "Remote"))
        self.assertEqual(r["rows"][0]["listed_at"], datetime.datetime.fromtimestamp(self.MS / 1000, datetime.timezone.utc).strftime("%Y-%m-%d"))
        self.assertEqual((r["pages_read"], r["total"], r["stopped_reason"]), (1, 60, None))

    def test_values_with_parentheses_are_encoded_for_the_query(self):
        out = self.run_js({"keywords": "a (b), c: d", "pages": 1}, [self.page("4400000101")])
        self.assertIn("keywords:a%20%28b%29%2C%20c%3A%20d", out["calls"][0]["url"])
        self.assertNotIn("locationUnion", out["calls"][0]["url"])

    def test_pages_pacing_and_the_five_page_cap(self):
        out = self.run_js({"keywords": "x y", "pages": 9, "__test": False},
                          [self.page("44000001%02d" % i, total=500) for i in range(5)], rnd=0.5)
        self.assertEqual(len(out["calls"]), 5)
        self.assertEqual([c["url"].rsplit("start=", 1)[1] for c in out["calls"]], ["0", "25", "50", "75", "100"])
        self.assertEqual(len(out["delays"]), 4)
        self.assertTrue(all(8000 <= d <= 15000 for d in out["delays"]), out["delays"])
        self.assertEqual(out["result"]["request"]["pages"], 5)

    def test_stop_statuses_redirects_and_end_of_results(self):
        for status in (401, 403, 429, 999):
            with self.subTest(status=status):
                out = self.run_js({"keywords": "x y", "pages": 3}, [{"status": status, "body": {}}])
                self.assertEqual((out["result"]["stopped_reason"], len(out["calls"])), ("http_%d" % status, 1))
        out = self.run_js({"keywords": "x y"}, [{"status": 200, "body": {}, "redirected": True, "url": "https://www.linkedin.com/authwall"}])
        self.assertEqual(out["result"]["stopped_reason"], "login_redirect")
        out = self.run_js({"keywords": "x y"}, [{"status": 200, "body": {}, "redirected": True, "url": "https://www.linkedin.com/checkpoint/x"}])
        self.assertEqual(out["result"]["stopped_reason"], "checkpoint")
        out = self.run_js({"keywords": "x y"}, [{"status": 400, "body": {}}])
        self.assertEqual(out["result"]["stopped_reason"], "decoration_rotated")
        out = self.run_js({"keywords": "x y", "pages": 2}, [self.page("4400000101", total=10), self.page("4400000102")])
        self.assertEqual((out["result"]["stopped_reason"], len(out["calls"])), ("end_of_results", 1))
        out = self.run_js({"keywords": "x y"}, [{"status": 200, "body": {"data": {"elements": []}, "included": []}}])
        self.assertEqual(out["result"]["stopped_reason"], "no_results")

    def test_bad_params_session_wrong_page_and_run_guard(self):
        for params in ({}, {"keywords": "x y", "days": 0}, {"keywords": "x y", "page_from": 99}, {"keywords": "x y", "pages": 0}):
            with self.subTest(params=params):
                out = self.run_js(params)
                self.assertEqual((out["result"]["stopped_reason"], out["calls"]), ("bad_params", []))
        self.assertEqual(self.run_js({"keywords": "x y"}, cookie="lang=v=2")["result"]["stopped_reason"], "no_session")
        self.assertEqual(self.run_js({"keywords": "x y"}, env={"HOSTNAME": "example.org"})["result"]["stopped_reason"], "wrong_page")
        out = self.run_js({"keywords": "x y"}, env={"PRESET_FLAG": "__liJobSignalsRunning"})
        self.assertEqual((out["result"]["stopped_reason"], out["calls"]), ("already_running", []))

    def test_the_run_id_is_echoed_and_nothing_secret_is_returned_or_saved(self):
        out = self.run_js({"keywords": "x y", "pages": 1, "search": "s2", "issue": "20261102T100000Z-1"}, [self.page("4400000101")])
        self.assertEqual((out["result"]["request"]["search"], out["result"]["request"]["issue"]), ("s2", "20261102T100000Z-1"))
        blob = json.dumps([out["result"], out["clipboard"], out["storage_writes"]])
        self.assertNotIn("0123456789", blob)
        self.assertNotIn("JSESSIONID", blob)
        self.assertEqual(out["storage_writes"][-1][0], "liJobSignalsLastRun")

    def test_params_read_are_documented_in_the_header(self):
        src = SEARCH_JS.read_text()
        header = "\n".join(l for l in src.splitlines() if l.startswith("//"))
        for name in set(re.findall(r"\bp\.(\w+)", src)) - {"__test", "minDelayMs", "maxDelayMs"}:
            self.assertIn(name, header, name)

    def test_the_snippet_only_reads(self):
        src = SEARCH_JS.read_text()
        self.assertNotIn("POST", src)
        self.assertNotIn("PUT", src)
        self.assertNotIn(".click(", src)
        self.assertIn("method: 'GET'", src)


# ---- packaging and docs ------------------------------------------------------------------------------------

class SkillPackaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SKILL.read_text(encoding="utf-8")
        cls.flat = " ".join(cls.text.split())

    def test_the_skill_follows_the_five_phases_in_order(self):
        order = ["**Phase 1, intake", "**Phase 2, calibration", "**Phase 3, read the posts", "**Phase 4, qualify",
                 "**Phase 5, output and opener"]
        idx = [self.text.find(w) for w in order]
        self.assertTrue(all(i >= 0 for i in idx), idx)
        self.assertEqual(idx, sorted(idx))

    def test_the_docs_state_python_the_disclaimer_and_only_real_stops(self):
        self.assertIn("Python 3.9 or newer", self.flat)
        self.assertIn("unofficial", self.flat.lower())
        self.assertIn("stops at the first block", self.flat)
        self.assertNotIn("commercial_use_limit", self.flat)
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("That is unofficial: it sends no cookies", readme)

    def test_public_path_first_and_the_tab_is_only_a_fallback(self):
        self.assertLess(self.flat.find("public"), self.flat.find("signed-in"))
        for piece in ("no sign-in", "no cookies", "3 to 8 seconds", "429", "stop", "Cowork", "fallback", "search_jobs.js",
                      "profile.json", "never hardcode", "untrusted data"):
            self.assertIn(piece.lower(), self.flat.lower(), piece)

    def test_the_skill_asks_what_the_user_sells_instead_of_hardcoding_a_pitch(self):
        self.assertIn("what they sell", self.flat.lower())
        self.assertIn("opener", self.flat.lower())

    def test_ship_list_and_manifest(self):
        self.assertEqual(sorted(p.name for p in (SKILLS / "linkedin-job-signals").iterdir() if p.name != ".DS_Store"),
                         ["SKILL.md", "skill.yaml"])
        for rel in ("scripts/job_signals.py", "scripts/search_jobs.js", "references/job_signal_presets.json"):
            self.assertTrue((ENGINE / rel).is_file(), rel)

    def test_marketplace_entry_and_readme(self):
        market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
        e = {p["name"]: p for p in market["plugins"]}["linkedin-job-signals"]
        self.assertEqual((e["source"], e["skills"]), ("./plugins/linkedin", ["./skills/linkedin-job-signals"]))
        self.assertTrue(e["description"].startswith("Plain LinkedIn, no Sales Navigator needed."))
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("linkedin-job-signals", readme)


if __name__ == "__main__":
    unittest.main()
