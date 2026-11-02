"""Plain-LinkedIn skills (no Sales Navigator): linkedin-find-people, linkedin-outreach, linkedin-replies and their
shared `linkedin` engine under plugins/linkedin: the search-page parser on a redacted real page, the poll snippet,
the three ledgers (caps, reservation, merge idempotency, injection guards), manifests, marketplace and README.

Run from the repo root:  python3 -m pytest -q tests
"""
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "linkedin"
SKILLS = PLUGIN / "skills"
ENGINE = SKILLS / "linkedin"
SCRIPTS = ENGINE / "scripts"
JOBS = {"linkedin-find-people": "linkedin-find-people", "linkedin-outreach": "linkedin-outreach",
        "linkedin-replies": "linkedin-replies"}
FIND = SCRIPTS / "find_people.py"
OUTREACH = SCRIPTS / "outreach.py"
REPLIES = SCRIPTS / "replies.py"
SEARCH_JS = SCRIPTS / "search_people.js"
POLL_JS = SCRIPTS / "poll.js"
EMAILS = ROOT / "plugins" / "linkedin-emails" / "skills" / "linkedin-emails" / "scripts" / "emails.py"
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
PAGE = FIXTURE_DIR / "linkedin_classic" / "search_people_page.html"
HARNESS = FIXTURE_DIR / "linkedin_emails" / "harness.js"
NODE = shutil.which("node")
TOKEN = "ajax:0123456789"
COOKIE = 'lang=v=2; JSESSIONID="%s"; other=1' % TOKEN
T0 = "2026-11-02T10:00:00Z"
T_PLUS_1H = "2026-11-02T11:00:00Z"
T_PLUS_24H = "2026-11-03T10:00:00Z"
T_PLUS_24H1 = "2026-11-03T10:00:01Z"
T_PLUS_7D = "2026-11-09T10:00:00Z"
T_PLUS_8D = "2026-11-10T10:00:00Z"

# the ten people the fixture page lists as results (the rest of its /in/ links are mutual-connection people)
RESULT_VANITIES = ["test-person-%d" % n for n in (1, 2, 5, 6, 8, 10, 7, 12, 15, 18)]


def page_html():
    return PAGE.read_text(encoding="utf-8")


def mutual_vanities():
    return set(re.findall(r"/in/(test-person-\d+)/", page_html())) - set(RESULT_VANITIES)


# ---- node harness -----------------------------------------------------------------------------------------

def run_snippet(snippet, params, responses=None, cookie=COOKIE, rnd=None, env=None):
    """Run a snippet in the shared node harness; returns the harness JSON (result, calls, delays, ...)."""
    argv = ["node", str(HARNESS), str(snippet), json.dumps(params), cookie, json.dumps(responses or [])]
    if rnd is not None:
        argv.append(str(rnd))
    p = subprocess.run(argv, capture_output=True, text=True, env=dict(os.environ, **(env or {})))
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def page_response(**kw):
    return dict({"status": 200, "html_file": str(PAGE)}, **kw)


def html_response(body_html):
    return {"status": 200, "html": "<html><body><main>%s</main></body></html>" % body_html}


def card(vanity, name, line, headline="Head", location="Loc", extra=""):
    return ('<div role="listitem"><a href="https://www.linkedin.com/in/%s/"><div><p><a href="https://www.linkedin.com/in/%s/">%s'
            '</a><span> %s</span></p><div><p><span>%s</span></p></div><div><p><span>%s</span></p></div>%s</div></a></div>'
            % (vanity, vanity, name, line, headline, location, extra))


# ---- python scripts ---------------------------------------------------------------------------------------

class Tool:
    """A temp working dir plus a runner for one of the engine's scripts."""

    def __init__(self, test, script):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.test = test
        self.script = script
        self.n = 0

    def raw(self, *args, now=T0):
        return subprocess.run([sys.executable, "-I", "-B", str(self.script), "--now", now, *args],
                              capture_output=True, text=True, cwd=self.tmp)

    def run(self, *args, now=T0):
        p = self.raw(*args, now=now)
        self.test.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def fail(self, *args, now=T0, code=2):
        p = self.raw(*args, now=now)
        self.test.assertEqual(p.returncode, code, p.stdout + p.stderr)
        return p

    def write(self, name, obj):
        path = self.tmp / name
        path.write_text(obj if isinstance(obj, str) else json.dumps(obj), encoding="utf-8")
        return str(path)

    def results(self, obj):
        self.n += 1
        return self.write("results-%d.json" % self.n, obj)

    def files(self):
        return sorted(p.name for d in self.tmp.iterdir() if d.is_dir() for p in d.iterdir())


def search_result(rows, pages_read=None, stopped=None, page_from=1, search="s1", attempted=None, keywords="realtor",
                  network=("F",)):
    pr = len({r.get("page", 1) for r in rows}) if pages_read is None else pages_read
    return {"rows": rows, "pages_read": pr, "pages_attempted": pr if attempted is None else attempted,
            "stopped_reason": stopped,
            "request": {"keywords": keywords, "network": list(network), "page_from": page_from, "pages": 3,
                        "search": search}}


def person(v, name="Ada Lovelace", headline="Realtor at Acme", location="Austin, TX", degree="1st", page=1):
    return {"vanity": v, "name": name, "degree": degree, "headline": headline, "location": location, "page": page}


# =============================================================================================================
# search_people.js
# =============================================================================================================

@unittest.skipUnless(NODE, "node not installed")
class SearchPeopleSnippet(unittest.TestCase):
    def run_search(self, params=None, responses=None, **kw):
        p = {"keywords": "realtor", "network": ["F"], "pages": 1}
        p.update(params or {})
        return run_snippet(SEARCH_JS, p, [page_response()] if responses is None else responses, **kw)

    def test_the_fixture_page_yields_exactly_its_ten_results(self):
        out = self.run_search()["result"]
        self.assertIsNone(out["stopped_reason"])
        self.assertEqual(len(out["rows"]), 10)
        self.assertEqual([r["vanity"] for r in out["rows"]], RESULT_VANITIES)
        self.assertEqual((out["pages_read"], out["pages_attempted"]), (1, 1))
        for r in out["rows"]:
            with self.subTest(vanity=r["vanity"]):
                self.assertRegex(r["vanity"], r"^test-person-\d+$")
                self.assertEqual(r["degree"], "1st")
                self.assertTrue(r["name"].startswith("Text "))
                self.assertTrue(r["headline"].startswith("Text "))
                self.assertTrue(r["location"].startswith("Text "))
                self.assertEqual(r["page"], 1)

    def test_mutual_connection_people_are_never_results(self):
        mutual = mutual_vanities()
        self.assertTrue(mutual, "the fixture is meant to hold mutual-connection links")
        out = self.run_search()["result"]
        self.assertFalse({r["vanity"] for r in out["rows"]} & mutual)
        # nor do their lines leak into headline or location
        for r in out["rows"]:
            self.assertNotIn("mutual", (r["headline"] + r["location"]).lower())

    def test_headline_and_location_come_from_the_right_lines(self):
        rows = {r["vanity"]: r for r in self.run_search()["result"]["rows"]}
        # card 2 has a mutual-connections line after location; card 1 has a followers line
        self.assertEqual((rows["test-person-2"]["headline"], rows["test-person-2"]["location"]), ("Text 1398", "Text 8044"))
        self.assertEqual((rows["test-person-1"]["headline"], rows["test-person-1"]["location"]), ("Text 3173", "Text 8746"))

    def test_request_url_and_headers(self):
        r = self.run_search({"pages": 2, "network": ["F", "S"]}, [page_response(), page_response()], rnd=0)
        urls = [c["url"] for c in r["calls"]]
        base = "/search/results/people/?keywords=realtor&network=%5B%22F%22%2C%22S%22%5D"
        self.assertEqual(urls, [base, base + "&page=2"])
        for c in r["calls"]:
            self.assertEqual(c["credentials"], "include")
            self.assertNotIn("csrf-token", c["headers"])   # an HTML read needs no token
        self.assertEqual(self.run_search({"network": ["F"]})["calls"][0]["url"],
                         "/search/results/people/?keywords=realtor&network=%5B%22F%22%5D")

    def test_default_network_is_first_and_second_degree(self):
        r = run_snippet(SEARCH_JS, {"keywords": "realtor", "pages": 1}, [page_response()])
        self.assertIn("network=%5B%22F%22%2C%22S%22%5D", r["calls"][0]["url"])
        self.assertEqual(r["result"]["request"]["network"], ["F", "S"])

    def test_geo_and_extra_filters_and_page_from(self):
        r = self.run_search({"geoUrn": "urn:li:fsd_geo:103644278", "extra": "?origin=FACETED_SEARCH&keywords=evil&page=9",
                             "page_from": 4})
        url = r["calls"][0]["url"]
        self.assertIn("&geoUrn=%5B%22103644278%22%5D", url)
        self.assertIn("&origin=FACETED_SEARCH", url)
        self.assertEqual(url.count("keywords="), 1)   # extra cannot override keywords, network or page
        self.assertTrue(url.endswith("&page=4"))
        self.assertEqual(r["result"]["request"]["page_from"], 4)
        self.assertEqual({x["page"] for x in r["result"]["rows"]}, {4})

    def test_bad_params_stop_before_any_request(self):
        for params in ({"keywords": ""}, {"keywords": 5}, {"network": ["X"]}, {"network": []}, {"page_from": 0},
                       {"page_from": 101}, {"pages": 0}, {"geoUrn": "abc"}, {"extra": "a=b;rm -rf"},
                       {"extra": "x=<script>"}):
            with self.subTest(params=params):
                r = run_snippet(SEARCH_JS, dict({"keywords": "realtor"}, **params), [page_response()])
                self.assertEqual(r["result"]["stopped_reason"], "bad_params", r["result"])
                self.assertEqual(r["calls"], [])

    def test_pages_are_capped_at_five_per_run(self):
        r = self.run_search({"pages": 9}, [page_response() for _ in range(9)], rnd=0)
        self.assertEqual(len(r["calls"]), 5)
        self.assertEqual(r["result"]["pages_attempted"], 5)
        self.assertEqual(r["result"]["request"]["pages"], 5)
        self.assertEqual(len(r["delays"]), 4)

    def test_repeated_people_are_deduped_across_pages(self):
        r = self.run_search({"pages": 2}, [page_response(), page_response()], rnd=0)["result"]
        self.assertEqual(len(r["rows"]), 10)
        self.assertEqual(r["pages_read"], 2)   # both pages held people

    def test_pacing_between_pages_is_8_to_15_seconds(self):
        for rnd, want in ((0, 8000), (0.5, 11500), (0.999999, 15000)):
            with self.subTest(rnd=rnd):
                r = self.run_search({"pages": 3}, [page_response() for _ in range(3)], rnd=rnd)
                self.assertEqual(len(r["delays"]), 2)
                for d in r["delays"]:
                    self.assertGreaterEqual(d, 8000)
                    self.assertLessEqual(d, 15000)
                    self.assertAlmostEqual(d, want, delta=1)

    def test_pacing_cannot_be_lowered_without_the_test_flag(self):
        r = self.run_search({"pages": 2, "minDelayMs": 0, "maxDelayMs": 1}, [page_response(), page_response()], rnd=0)
        self.assertEqual(r["delays"], [8000])
        r = self.run_search({"pages": 2, "__test": True, "minDelayMs": 5, "maxDelayMs": 5}, [page_response(), page_response()])
        self.assertEqual(r["delays"], [5])

    def test_stop_codes_stop_at_once(self):
        for status in (401, 403, 429, 999, 410):
            with self.subTest(status=status):
                r = self.run_search({"pages": 3}, [{"status": status, "body": {}}, page_response()])
                self.assertEqual(r["result"]["stopped_reason"], "http_%d" % status)
                self.assertEqual(len(r["calls"]), 1)
                self.assertEqual(r["result"]["rows"], [])
        r = self.run_search({"pages": 3}, [{"status": 500, "body": {}}])
        self.assertEqual(r["result"]["stopped_reason"], "http_500")
        self.assertEqual(len(r["calls"]), 1)

    def test_redirects_checkpoint_login_and_network_error(self):
        cases = [({"status": 200, "redirected": True, "url": "https://www.linkedin.com/checkpoint/challenge/x"}, "checkpoint"),
                 ({"status": 200, "redirected": True, "url": "https://www.linkedin.com/login?x=1"}, "login_redirect"),
                 ({"status": 200, "redirected": True, "url": "https://www.linkedin.com/authwall?x"}, "login_redirect"),
                 ({"status": 200, "redirected": True, "url": "https://www.linkedin.com/feed/"}, "unexpected_redirect"),
                 ({"throw": True}, "network_error")]
        for resp, want in cases:
            with self.subTest(want=want):
                r = self.run_search({"pages": 2}, [resp, page_response()])
                self.assertEqual(r["result"]["stopped_reason"], want)
                self.assertEqual(len(r["calls"]), 1)

    def test_a_page_with_a_different_layout_is_suspect_layout(self):
        r = self.run_search({"pages": 3}, [{"status": 200, "html": "<html><body><div>nothing here</div></body></html>"},
                                           page_response()])["result"]
        self.assertEqual(r["stopped_reason"], "suspect_layout")
        self.assertEqual(r["rows"], [])
        r = self.run_search({}, [html_response("<div><p>Something else entirely</p></div>")])["result"]
        self.assertEqual(r["stopped_reason"], "suspect_layout")
        r = self.run_search({}, [html_response('<div role="listitem"><p>no profile link</p></div>')])["result"]
        self.assertEqual(r["stopped_reason"], "suspect_layout")

    def test_end_of_results_and_no_results(self):
        r = self.run_search({"pages": 3, "page_from": 3}, [html_response("<h2>No results found</h2>"), page_response()])["result"]
        self.assertEqual((r["stopped_reason"], r["pages_read"], r["pages_attempted"]), ("end_of_results", 0, 1))
        r = self.run_search({"pages": 3}, [html_response("<h2>No results found</h2>")])["result"]
        self.assertEqual(r["stopped_reason"], "no_results")

    def test_rows_before_the_end_are_kept(self):
        r = self.run_search({"pages": 3}, [page_response(), html_response("<h2>No results found</h2>")], rnd=0)["result"]
        self.assertEqual((r["stopped_reason"], r["pages_read"], r["pages_attempted"], len(r["rows"])),
                         ("end_of_results", 1, 2, 10))

    def test_commercial_use_limit_stops_the_run(self):
        body = card("ada-1", "Ada", "• 1st") + "<p>You have reached the commercial use limit on search.</p>"
        r = self.run_search({"pages": 3}, [html_response(body), page_response()])
        self.assertEqual(r["result"]["stopped_reason"], "commercial_use_limit")
        self.assertEqual(len(r["calls"]), 1)

    def test_degrees_entities_and_odd_vanities(self):
        body = (card("bo-2", "Bo &amp; Co", "• 2nd", "Head &amp; Tail", "Paris") + card("cy-3", "Cy", "· 3rd+", "H", "L")
                + card("jos%C3%A9", "Di", "• 3rd", "H", "L") + card("x;rm", "Ed", "• 1st") + card("..", "Fay", "• 1st"))
        r = self.run_search({}, [html_response(body)])["result"]
        by = {x["vanity"]: x for x in r["rows"]}
        self.assertEqual(by["bo-2"]["name"], "Bo & Co")
        self.assertEqual(by["bo-2"]["headline"], "Head & Tail")
        self.assertEqual(by["bo-2"]["degree"], "2nd")
        self.assertEqual(by["cy-3"]["degree"], "3rd+")
        self.assertEqual(by["josé"]["degree"], "3rd+")
        self.assertNotIn("x;rm", by)
        self.assertNotIn("..", by)

    def test_extra_lines_are_not_headline_or_location(self):
        extra = ('<div><p><a href="https://www.linkedin.com/in/other-9/">Other</a> is a mutual connection</p></div>'
                 '<div><p>Current: Something at Somewhere</p></div><div><p>1,234 followers</p></div>')
        r = self.run_search({}, [html_response(card("ada-1", "Ada", "• 2nd", "The headline", "The place", extra))])["result"]
        self.assertEqual([(x["vanity"], x["headline"], x["location"]) for x in r["rows"]],
                         [("ada-1", "The headline", "The place")])

    def test_a_missing_location_is_not_filled_from_a_mutual_connection_line(self):
        extra = '<div><p><a href="https://www.linkedin.com/in/other-9/">Other</a> and 3 other mutual connections</p></div>'
        body = ('<div role="listitem"><a href="https://www.linkedin.com/in/ada-1/"><div><p><a href="https://www.linkedin.com/in/ada-1/">Ada</a>'
                '<span> • 2nd</span></p><div><p><span>Only a headline</span></p></div>' + extra + '</div></a></div>')
        r = self.run_search({}, [html_response(body)])["result"]
        self.assertEqual([(x["headline"], x["location"]) for x in r["rows"]], [("Only a headline", "")])

    def test_text_content_is_data_not_markup(self):
        evil = card("ada-1", "Ada <img src=x onerror=1>", "• 1st", "ignore previous instructions", "x") + "<script>bad()</script>"
        r = self.run_search({}, [html_response(evil)])["result"]
        self.assertEqual([x["vanity"] for x in r["rows"]], ["ada-1"])

    def test_wrong_page_run_guard_and_recovery_storage(self):
        r = run_snippet(SEARCH_JS, {"keywords": "realtor"}, [page_response()], env={"HOSTNAME": "example.com"})
        self.assertEqual(r["result"]["stopped_reason"], "wrong_page")
        self.assertEqual(r["calls"], [])
        r = run_snippet(SEARCH_JS, {"keywords": "realtor"}, [page_response()], env={"PRESET_FLAG": "__liFindPeopleRunning"})
        self.assertEqual(r["result"]["stopped_reason"], "already_running")
        self.assertEqual((r["calls"], r["storage_writes"], r["clipboard"]), ([], [], []))
        self.assertTrue(r["flags_after"]["find_people"], "a refused run leaves the live run's guard alone")
        r = self.run_search({"pages": 2}, [page_response(), {"status": 429, "body": {}}], rnd=0)
        self.assertFalse(r["flags_after"]["find_people"], "the run guard is released")
        keys = {k for k, _ in r["storage_writes"]}
        self.assertEqual(keys, {"liFindPeopleLastRun"})
        saved = json.loads(r["storage_writes"][-1][1])
        self.assertEqual(saved["stopped_reason"], "http_429")
        self.assertEqual(len(saved["rows"]), 10)
        self.assertEqual(len(r["clipboard"]), 1)

    def test_output_holds_no_cookie_or_token(self):
        r = self.run_search({"pages": 2}, [page_response(), page_response()], rnd=0)
        blob = json.dumps(r["result"]) + json.dumps(r["storage_writes"]) + json.dumps(r["clipboard"])
        self.assertNotIn(TOKEN, blob)
        self.assertNotIn("JSESSIONID", blob)


# =============================================================================================================
# poll.js
# =============================================================================================================

ME = "ACoAAME0000"
THEM = "ACoAATHEM11"
QID = "messengerConversations.abc123XYZ"
PERF = json.dumps([{"name": "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=%s&variables=(x)" % QID}])
SECRET = "SHARED-SECRET-VALUE"
NOTE = "my custom invite note"
BODY = "Sure, let us talk Tuesday. " + "very long reply " * 40


def invites_body():
    return {"included": [
        {"$type": "x.Invitation", "toMemberId": "ACoAAPEND01", "sentTime": 1000, "customMessage": NOTE, "sharedSecret": SECRET,
         "entityUrn": "urn:li:fsd_invitation:1"},
        {"$type": "x.Invitation", "toMemberId": "ACoAAPEND02", "sentTime": 2000, "customMessage": "", "sharedSecret": SECRET,
         "entityUrn": "urn:li:fsd_invitation:2"},
        {"$type": "x.MiniProfile", "entityUrn": "urn:li:fsd_profile:ACoAAPEND01", "publicIdentifier": "pend-one"}]}


def connections_body(times, with_vanity=True):
    inc = [{"$type": "x.Connection", "createdAt": t, "connectedMember": "urn:li:fsd_profile:ACoAAC%04d" % i,
            "entityUrn": "urn:li:fsd_connection:%d" % i} for i, t in enumerate(times)]
    if with_vanity:
        inc += [{"$type": "x.Profile", "entityUrn": "urn:li:fsd_profile:ACoAAC0000", "publicIdentifier": "newest-conn"}]
    return {"included": inc}


def me_body():
    return {"included": [{"$type": "x.MiniProfile", "publicIdentifier": "me-myself", "dashEntityUrn": "urn:li:fsd_profile:" + ME}]}


def conversations_body():
    pme = {"$type": "x.MessagingParticipant", "entityUrn": "urn:li:msg_participant:me", "hostIdentityUrn": "urn:li:fsd_profile:" + ME}
    pthem = {"$type": "x.MessagingParticipant", "entityUrn": "urn:li:msg_participant:them", "hostIdentityUrn": "urn:li:fsd_profile:" + THEM,
             "participantType": {"member": {"profileUrl": "https://www.linkedin.com/in/replier-one"}}}
    pother = {"$type": "x.MessagingParticipant", "entityUrn": "urn:li:msg_participant:o", "hostIdentityUrn": "urn:li:fsd_profile:ACoAAOTHER9"}
    conv_reply = {"$type": "x.Conversation", "entityUrn": "urn:li:msg_conversation:(urn:li:fsd_profile:%s,2-AAA)" % ME,
                  "lastActivityAt": 5000, "unreadCount": 1, "read": False,
                  "*conversationParticipants": ["urn:li:msg_participant:me", "urn:li:msg_participant:them"]}
    conv_mine = {"$type": "x.Conversation", "entityUrn": "urn:li:msg_conversation:(urn:li:fsd_profile:%s,2-BBB)" % ME,
                 "lastActivityAt": 6000, "unreadCount": 0, "read": True,
                 "*conversationParticipants": ["urn:li:msg_participant:me", "urn:li:msg_participant:o"]}
    conv_old = {"$type": "x.Conversation", "entityUrn": "urn:li:msg_conversation:(urn:li:fsd_profile:%s,2-CCC)" % ME,
                "lastActivityAt": 100, "unreadCount": 1, "read": False,
                "*conversationParticipants": ["urn:li:msg_participant:me", "urn:li:msg_participant:them"]}
    msg_them = {"$type": "x.Message", "entityUrn": "urn:li:msg_message:1", "deliveredAt": 5000, "body": {"text": BODY},
                "*sender": "urn:li:msg_participant:them", "*conversation": conv_reply["entityUrn"]}
    msg_mine = {"$type": "x.Message", "entityUrn": "urn:li:msg_message:2", "deliveredAt": 6000, "body": {"text": "my own message"},
                "*sender": "urn:li:msg_participant:me", "*conversation": conv_mine["entityUrn"]}
    return {"included": [pme, pthem, pother, conv_reply, conv_mine, conv_old, msg_them, msg_mine]}


def poll_responses(times=(9000, 8000, 7000)):
    return [{"status": 200, "body": invites_body()}, {"status": 200, "body": connections_body(list(times))},
            {"status": 200, "body": me_body()}, {"status": 200, "body": conversations_body()}]


@unittest.skipUnless(NODE, "node not installed")
class PollSnippet(unittest.TestCase):
    def poll(self, params=None, responses=None, **kw):
        env = dict(kw.pop("env", {}), PERF_ENTRIES=kw.pop("perf", PERF))
        return run_snippet(POLL_JS, params or {}, poll_responses() if responses is None else responses, env=env, **kw)

    def test_reads_pending_accepted_and_replied(self):
        r = self.poll({"since": 7500, "conversationsSince": 1000}, rnd=0)
        out = r["result"]
        self.assertIsNone(out["stopped_reason"])
        self.assertEqual([x["member"] for x in out["accepted"]], ["ACoAAC0000", "ACoAAC0001"])   # 9000 and 8000, not 7000
        self.assertEqual(out["accepted"][0]["vanity"], "newest-conn")
        self.assertEqual(out["accepted"][1]["vanity"], "")
        self.assertEqual([(x["member"], x["vanity"], x["sentAt"]) for x in out["pending"]],
                         [("ACoAAPEND01", "pend-one", 1000), ("ACoAAPEND02", "", 2000)])
        self.assertEqual(len(out["replied"]), 1)   # the old one is below the cursor, the other chat's last message is mine
        rep = out["replied"][0]
        self.assertEqual((rep["member"], rep["vanity"], rep["lastMessageAt"], rep["fromThem"]), (THEM, "replier-one", 5000, True))
        self.assertEqual(out["cursor"], {"connectedAt": 9000, "conversationsAt": 6000})
        self.assertFalse(out["has_more_connections"])
        urls = [c["url"] for c in r["calls"]]
        self.assertTrue(urls[0].startswith("/voyager/api/relationships/sentInvitationViewsV2?invitationType=CONNECTION"))
        self.assertIn("ConnectionListWithProfile-16", urls[1])
        self.assertIn("sortType=RECENTLY_ADDED", urls[1])
        self.assertEqual(urls[2], "/voyager/api/me")
        self.assertIn("queryId=" + QID, urls[3])
        self.assertIn("variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3A" + ME + ")", urls[3])
        for c in r["calls"]:
            self.assertEqual(c["headers"]["csrf-token"], TOKEN)

    def test_message_bodies_are_omitted_by_default(self):
        r = self.poll({"since": 0, "conversationsSince": 1000})
        blob = json.dumps(r["result"]) + json.dumps(r["storage_writes"]) + json.dumps(r["clipboard"])
        self.assertNotIn("Tuesday", blob)
        self.assertNotIn("my own message", blob)
        self.assertEqual(len(r["result"]["replied"]), 1)
        self.assertNotIn("text", r["result"]["replied"][0])
        r = self.poll({"includeText": False, "conversationsSince": 1000})
        self.assertNotIn("text", r["result"]["replied"][0])

    def test_include_text_is_opt_in_and_cut_to_280_characters(self):
        r = self.poll({"includeText": True})
        text = r["result"]["replied"][0]["text"]
        self.assertTrue(text.startswith("Sure, let us talk Tuesday."))
        self.assertLessEqual(len(text), 280)
        self.assertGreater(len(BODY), 280)

    def test_no_invite_secrets_notes_cookie_or_token_in_any_output(self):
        r = self.poll({"includeText": True, "since": 0})
        blob = json.dumps(r["result"]) + json.dumps(r["storage_writes"]) + json.dumps(r["clipboard"])
        for needle in (SECRET, NOTE, TOKEN, "JSESSIONID", "sharedSecret", "customMessage"):
            self.assertNotIn(needle, blob)

    def test_first_poll_does_not_walk_back_but_a_later_full_new_page_asks_for_more(self):
        times = [10000 - i for i in range(10)]
        r = self.poll({"since": 0}, poll_responses(times))
        self.assertFalse(r["result"]["has_more_connections"])
        self.assertEqual(len(r["result"]["accepted"]), 10)
        r = self.poll({"since": 5000}, poll_responses(times))
        self.assertTrue(r["result"]["has_more_connections"])
        r = self.poll({"since": 9995}, poll_responses(times))
        self.assertFalse(r["result"]["has_more_connections"])   # the page reaches back past the cursor
        self.assertEqual(len(r["result"]["accepted"]), 5)
        r = self.poll({"since": 5000, "start": 10, "parts": ["connections"]}, [{"status": 200, "body": connections_body([4000])}])
        self.assertIn("start=10", r["calls"][0]["url"])

    def test_pacing_between_requests_is_4_to_8_seconds(self):
        for rnd, want in ((0, 4000), (0.999999, 8000)):
            with self.subTest(rnd=rnd):
                r = self.poll({}, rnd=rnd)
                self.assertEqual(len(r["delays"]), 3)
                for d in r["delays"]:
                    self.assertGreaterEqual(d, 4000)
                    self.assertLessEqual(d, 8000)
                    self.assertAlmostEqual(d, want, delta=1)
        r = self.poll({"minDelayMs": 0, "maxDelayMs": 1}, rnd=0)
        self.assertEqual(r["delays"], [4000, 4000, 4000])   # not lowerable without the test flag

    def test_stop_codes_keep_what_was_read(self):
        for status in (401, 403, 429, 999):
            with self.subTest(status=status):
                resp = poll_responses()
                resp[1] = {"status": status, "body": {}}
                r = self.poll({}, resp)
                self.assertEqual(r["result"]["stopped_reason"], "http_%d" % status)
                self.assertEqual(len(r["calls"]), 2)
                self.assertEqual(len(r["result"]["pending"]), 2)   # the first request's rows survive
        resp = poll_responses()
        resp[1] = {"status": 200, "redirected": True, "url": "https://www.linkedin.com/checkpoint/x"}
        self.assertEqual(self.poll({}, resp)["result"]["stopped_reason"], "checkpoint")

    def test_rotated_ids_are_named_and_a_missing_queryid_makes_no_request(self):
        resp = poll_responses()
        resp[1] = {"status": 400, "body": {}}
        self.assertEqual(self.poll({}, resp)["result"]["stopped_reason"], "decoration_rotated")
        resp = poll_responses()
        resp[3] = {"status": 400, "body": {}}
        self.assertEqual(self.poll({}, resp)["result"]["stopped_reason"], "queryid_rotated")
        r = self.poll({}, perf="[]")
        self.assertEqual(r["result"]["stopped_reason"], "queryid_not_found")
        self.assertEqual(r["calls"], [])
        r = self.poll({"conversationsQueryId": QID, "mailboxUrn": "urn:li:fsd_profile:" + ME, "parts": ["conversations"],
                       "conversationsSince": 1000},
                      [{"status": 200, "body": conversations_body()}], perf="[]")
        self.assertEqual(len(r["calls"]), 1)   # no /me needed when the mailbox is given
        self.assertEqual(len(r["result"]["replied"]), 1)

    def test_run_guard_session_and_wrong_page(self):
        r = self.poll({}, env={"PRESET_FLAG": "__liPollRunning"})
        self.assertEqual(r["result"]["stopped_reason"], "already_running")
        self.assertEqual((r["calls"], r["storage_writes"]), ([], []))
        self.assertEqual(self.poll({}, cookie="a=b")["result"]["stopped_reason"], "no_session")
        self.assertEqual(self.poll({}, env={"HOSTNAME": "example.org"})["result"]["stopped_reason"], "wrong_page")
        r = self.poll({}, rnd=0)
        self.assertFalse(r["flags_after"]["poll"])
        self.assertEqual({k for k, _ in r["storage_writes"]}, {"liPollLastRun"})

    def test_only_reads(self):
        text = POLL_JS.read_text(encoding="utf-8") + SEARCH_JS.read_text(encoding="utf-8")
        self.assertNotRegex(text, r"method:\s*['\"](POST|PUT|DELETE|PATCH)")
        self.assertNotIn("sales-api", text)


# =============================================================================================================
# find_people.py
# =============================================================================================================

class FindPeopleLedger(unittest.TestCase):
    def setUp(self):
        self.t = Tool(self, FIND)
        self.t.run("init", "--keywords", "realtor", "--network", "F")

    def pages(self, now=T0, n=None, **kw):
        args = ["next-pages"] + (["--pages", str(n)] if n else [])
        return self.t.run(*args, now=now)

    def test_init_refuses_to_overwrite_and_adds_searches(self):
        self.t.fail("init", "--keywords", "loan officer")
        p = self.t.run("add-search", "--keywords", "loan officer", "--network", "F,S", "--geo", "103644278")
        self.assertEqual(p["added"]["id"], "s2")
        self.assertEqual(p["added"]["geo"], "103644278")
        led = json.loads((self.t.tmp / "linkedin-find-people-work" / "ledger.json").read_text())
        self.assertEqual([s["keywords"] for s in led["searches"]], ["realtor", "loan officer"])
        self.t.fail("init", "--keywords", "x", "--network", "Z", "--force")
        self.t.fail("add-search", "--keywords", "x", "--geo", "abc")
        self.t.fail("add-search", "--keywords", "x", "--extra", "a=b;c")

    def test_force_backs_up_and_keeps_people_and_cap_history(self):
        self.pages(n=2)
        self.t.run("merge", self.t.results(search_result([person("ada-1")], attempted=2)))
        out = self.t.run("init", "--keywords", "other", "--force")
        self.assertEqual(out["kept_people"], 1)
        self.assertEqual(len(out["backups"]), 2)
        self.assertEqual(self.t.run("status")["used_24h"], 2)

    def test_next_pages_params_and_reservation(self):
        r = self.pages()
        self.assertEqual(r["params"], {"keywords": "realtor", "network": ["F"], "page_from": 1, "pages": 3, "search": "s1"})
        self.assertEqual((r["used_24h"], r["remaining_24h"]), (3, 7))
        r = self.t.run("next-pages", now=T0)
        self.assertEqual(r["reason"], "open_issue")
        self.assertIsNone(r["params"])
        self.assertEqual(self.t.run("status")["used_24h"], 3)

    def test_pages_per_run_max_five(self):
        self.assertEqual(self.pages(n=9)["params"]["pages"], 5)

    def test_cap_is_ten_pages_in_a_rolling_24_hours(self):
        a = self.pages(n=5)
        self.t.run("merge", self.t.results(search_result([person("a-%d" % i, page=p) for p in range(1, 6) for i in (1,)],
                                                         pages_read=5, page_from=a["params"]["page_from"])))
        b = self.pages(now=T_PLUS_1H, n=5)
        self.assertEqual(b["params"]["page_from"], 6)
        self.t.run("merge", self.t.results(search_result([person("b-%d" % p, page=p) for p in range(6, 11)], pages_read=5,
                                                         page_from=6)), now=T_PLUS_1H)
        c = self.t.run("next-pages", now=T_PLUS_1H)
        self.assertEqual((c["reason"], c["used_24h"], c["remaining_24h"]), ("daily_cap_reached", 10, 0))
        self.assertIsNone(c["params"])
        d = self.t.run("next-pages", now=T_PLUS_24H1)   # the first issue (T0) has left the window
        self.assertEqual(d["used_24h"], 8)               # the 5 from T+1h plus the 3 pages reserved just now
        self.assertEqual((d["remaining_24h"], d["params"]["pages"]), (2, 3))

    def test_pages_are_trimmed_to_what_is_left_of_the_cap(self):
        self.t.run("cap", "8")
        a = self.pages(n=5)
        self.t.run("merge", self.t.results(search_result([person("a-1")], pages_read=5, page_from=1)))
        self.assertEqual(self.pages(n=5)["params"]["pages"], 3)

    def test_cap_cannot_rise_without_approval_and_can_fall(self):
        self.t.fail("cap", "11")
        self.assertEqual(self.t.run("cap", "11", "--user-approved-raise")["daily_cap"], 11)
        self.assertEqual(self.t.run("cap", "4")["daily_cap"], 4)
        self.t.fail("cap", "0")

    def test_merge_settles_the_reservation_without_double_counting(self):
        self.pages(n=5)
        out = self.t.run("merge", self.t.results(search_result([person("a-1"), person("a-2")], pages_read=1, attempted=2)))
        self.assertEqual(out["used_24h"], 2)   # reserved 5, two fetches actually made
        self.assertEqual(out["next_page"], 2)
        self.assertEqual(self.pages(n=5)["params"]["page_from"], 2)

    def test_abandoned_issue_still_counts(self):
        self.pages(n=4)
        r = self.t.run("next-pages", "--abandon-issue", "--pages", "2")
        self.assertEqual(r["used_24h"], 6)
        self.assertEqual(r["params"]["page_from"], 1)

    def test_merge_is_idempotent_and_dedupes(self):
        self.pages(n=2)
        rows = [person("ada-1"), person("ada-1", name="Dup"), person("Ada-1"), person("bob-2", name="Bob")]
        path = self.t.results(search_result(rows))
        a = self.t.run("merge", path)
        self.assertEqual((a["added"], a["already_known"], a["total_people"]), (2, 2, 2))
        b = self.t.run("merge", path)
        self.assertTrue(b["already_merged"])
        self.assertEqual(self.t.run("status")["people"], 2)
        self.assertEqual(self.t.run("status")["used_24h"], 1)   # not counted twice

    def test_a_second_search_adds_its_keywords_to_a_known_person(self):
        self.t.run("add-search", "--keywords", "broker")
        self.t.run("merge", self.t.results(search_result([person("ada-1", headline="")])))
        self.t.run("merge", self.t.results(search_result([person("ada-1", headline="Broker")], search="s2", keywords="broker")))
        out = self.t.run("export", "--out", str(self.t.tmp / "o.csv"))
        row = next(csv.DictReader(open(self.t.tmp / "o.csv", encoding="utf-8-sig")))
        self.assertEqual((out["rows"], row["keywords"], row["headline"]), (1, "realtor; broker", "Broker"))

    def test_merge_rejects_unsafe_vanities_and_cleans_fields(self):
        rows = [person(v) for v in ("../etc", "a b", "x;rm", "", "a'b", "..", "ok-1")]
        rows.append(person("ok-2", name="Zed‮\x00 Name\n", headline="x" * 900, degree="bogus"))
        out = self.t.run("merge", self.t.results(search_result(rows)))
        self.assertEqual((out["added"], out["ignored_rows"]), (2, 6))
        self.t.run("export", "--out", str(self.t.tmp / "o.csv"))
        by = {r["profile_url"]: r for r in csv.DictReader(open(self.t.tmp / "o.csv", encoding="utf-8-sig"))}
        z = by["https://www.linkedin.com/in/ok-2/"]
        self.assertEqual((z["name"], len(z["headline"]), z["degree"]), ("Zed Name", 300, ""))

    def test_merge_needs_a_matching_search_and_a_results_object(self):
        self.t.fail("merge", self.t.results({"nope": 1}))
        self.t.fail("merge", self.t.results(search_result([person("a-1")], keywords="different", search="s9")))
        (self.t.tmp / "bad.json").write_text("not json")
        self.t.fail("merge", str(self.t.tmp / "bad.json"))
        self.t.fail("merge", str(self.t.tmp / "missing.json"))

    def test_stops_lock_24_hours_except_the_benign_ones(self):
        for reason in ("http_429", "suspect_layout", "commercial_use_limit", "checkpoint", "login_redirect"):
            with self.subTest(reason=reason):
                t = Tool(self, FIND)
                t.run("init", "--keywords", "realtor")
                t.run("next-pages")
                out = t.run("merge", t.results(search_result([], pages_read=0, attempted=1, stopped=reason)))
                self.assertEqual(out["stopped_reason"], reason)
                r = t.run("next-pages", now=T_PLUS_1H)
                self.assertEqual(r["reason"], "stopped:" + reason)
                self.assertEqual(r["locked_until"], "2026-11-03T10:00:00Z")
                self.assertEqual(t.run("next-pages", now=T_PLUS_24H1)["reason"], None)
        for reason in ("already_running", "wrong_page", "network_error", "bad_params"):
            with self.subTest(reason=reason):
                t = Tool(self, FIND)
                t.run("init", "--keywords", "realtor")
                t.run("next-pages")
                t.run("merge", t.results(search_result([], pages_read=0, attempted=0, stopped=reason)))
                self.assertIsNone(t.run("next-pages", now=T_PLUS_1H)["reason"])

    def test_end_of_results_marks_the_search_done_and_does_not_lock(self):
        self.pages(n=3)
        out = self.t.run("merge", self.t.results(search_result([person("a-1")], pages_read=1, attempted=2, stopped="end_of_results")))
        self.assertTrue(out["search_done"])
        self.assertEqual(self.t.run("next-pages", now=T_PLUS_1H)["reason"], "nothing_left")
        self.assertEqual(self.t.run("status")["stopped"], None)

    def test_the_commercial_limit_note_says_stop_until_it_lifts(self):
        self.pages(n=3)
        out = self.t.run("merge", self.t.results(search_result([], pages_read=0, attempted=1, stopped="commercial_use_limit")))
        self.assertIn("monthly", out["note"])

    def test_export_guards_against_spreadsheet_formulas(self):
        evil = ["=HYPERLINK(\"http://x\")", "+1+1", "-2", "@SUM(A1)", "\tTAB"]
        rows = [person("p-%d" % i, name=n, headline=n, location=n) for i, n in enumerate(evil)]
        self.t.run("merge", self.t.results(search_result(rows)))
        self.t.run("export", "--out", str(self.t.tmp / "o.csv"))
        for r in csv.DictReader(open(self.t.tmp / "o.csv", encoding="utf-8-sig")):
            for col in ("name", "headline", "location"):
                self.assertTrue(r[col] == "" or r[col][0] not in "=+-@\t\r", r[col])
            if r["name"]:
                self.assertTrue(r["name"].startswith("'") or r["name"][0].isalnum(), r["name"])

    def test_export_columns_where_filter_and_emails_handoff(self):
        rows = [person("a-1", name="Ada Lovelace", headline="Realtor at Acme"), person("b-2", name="Bo Diddley", headline="Loan Officer"),
                person("c-3", name="Cy Young", headline="Dentist", degree="2nd")]
        self.t.run("merge", self.t.results(search_result(rows)))
        out = self.t.run("export", "--out", str(self.t.tmp / "o.csv"), "--where", "headline=realtor|loan officer")
        self.assertEqual((out["rows"], out["of"]), (2, 3))
        with open(self.t.tmp / "o.csv", encoding="utf-8-sig") as f:
            r = csv.DictReader(f)
            self.assertEqual(r.fieldnames, ["name", "headline", "location", "degree", "profile_url", "keywords", "found_at"])
            self.assertEqual([x["name"] for x in r], ["Ada Lovelace", "Bo Diddley"])
        self.t.fail("export", "--where", "nope=x")
        self.t.fail("export", "--where", "headline=(")
        self.assertEqual(self.t.run("export", "--out", str(self.t.tmp / "e.csv"), "--where", "degree=1st", "--emails-csv")["rows"], 2)
        # the handoff file is a valid input for linkedin-emails
        e = subprocess.run([sys.executable, "-I", str(EMAILS), "init", str(self.t.tmp / "e.csv"), "--out", str(self.t.tmp / "ew")],
                           capture_output=True, text=True)
        self.assertEqual(e.returncode, 0, e.stderr)
        self.assertEqual(json.loads(e.stdout)["rows"], 2)

    def test_lock_file_blocks_a_second_writer_and_nothing_is_left_behind(self):
        d = self.t.tmp / "linkedin-find-people-work"
        (d / ".lock").write_text("123")
        p = self.t.fail("next-pages")
        self.assertIn("another run", p.stderr)
        (d / ".lock").unlink()
        self.t.run("next-pages")
        self.assertEqual(self.t.files(), ["ledger.json", "people.csv"])

    def test_status_before_and_after(self):
        s = self.t.run("status")
        self.assertEqual((s["people"], s["used_24h"], s["daily_cap"]), (0, 0, 10))
        Tool(self, FIND).fail("status")   # no working dir yet


@unittest.skipUnless(NODE, "node not installed")
class FindPeopleEndToEnd(unittest.TestCase):
    def test_fixture_page_through_snippet_merge_and_export(self):
        t = Tool(self, FIND)
        t.run("init", "--keywords", "realtor", "--network", "F")
        params = t.run("next-pages", "--pages", "1")["params"]
        res = run_snippet(SEARCH_JS, params, [page_response()])["result"]
        out = t.run("merge", t.results(res))
        self.assertEqual((out["added"], out["pages_read"], out["used_24h"]), (10, 1, 1))
        t.run("export", "--out", str(t.tmp / "o.csv"))
        rows = list(csv.DictReader(open(t.tmp / "o.csv", encoding="utf-8-sig")))
        self.assertEqual([r["profile_url"].split("/in/")[1].strip("/") for r in rows], RESULT_VANITIES)
        self.assertTrue(all(r["degree"] == "1st" and r["headline"] and r["location"] for r in rows))
        self.assertFalse({r["profile_url"].split("/in/")[1].strip("/") for r in rows} & mutual_vanities())


# =============================================================================================================
# outreach.py
# =============================================================================================================

def people_csv(n, degree="2nd", rows=()):
    lines = ["name,headline,location,degree,profile_url,keywords,found_at"]
    for i in range(1, n + 1):
        lines.append("Person%d Smith,Realtor at Firm%d,Austin,%s,https://www.linkedin.com/in/p%d/,realtor,2026-11-01T00:00:00Z"
                     % (i, i, degree, i))
    lines.extend(rows)
    return "\n".join(lines) + "\n"


class OutreachLedger(unittest.TestCase):
    def start(self, n=30, degree="2nd", rows=(), *args):
        t = Tool(self, OUTREACH)
        t.csv = t.write("people.csv", people_csv(n, degree, rows))
        t.tpl = t.write("tpl.txt", "Hi {first_name}, I noticed you are {headline}. Would love to connect.")
        t.msg = t.write("msg.txt", "Hi {first_name}, thanks for connecting. Any time to chat about {headline}?")
        t.run("init", t.csv, *args)
        return t

    def send_batch(self, t, kind, limit, now=T0, status="sent"):
        b = t.run("batch", "--kind", kind, "--limit", str(limit), now=now)
        if not b["items"]:
            return b
        t.run("approve", "--typed", "approve %d" % b["count"], now=now)
        for it in b["items"]:
            t.run("record", it["vanity"], "--status", status, now=now)
        return b

    def test_init_summary_dedupe_and_fields(self):
        t = Tool(self, OUTREACH)
        csv_path = t.write("p.csv", people_csv(3, rows=["Dup Person,x,y,2nd,https://www.linkedin.com/in/P1/,k,t",
                                                          "No Url,x,y,2nd,,k,t", "Bad,x,y,2nd,https://example.com/in/;rm,k,t"]))
        out = t.run("init", csv_path)
        self.assertEqual((out["people"], out["duplicates_dropped"], out["no_url"]), (3, 1, 2))
        self.assertIn("first_name", out["fields_available_for_templates"])
        self.assertIn("headline", out["fields_available_for_templates"])
        t.fail("init", csv_path)
        t.run("init", csv_path, "--force")
        self.assertEqual(len([n for n in os.listdir(t.tmp / "linkedin-outreach-work") if ".bak-" in n]), 1)
        t.fail("init", t.write("empty.csv", "a,b\n1,2\n"))

    def test_init_from_the_linkedin_emails_working_copy_means_first_degree(self):
        t = Tool(self, OUTREACH)
        out = t.run("init", str(FIXTURE_DIR / "linkedin_emails" / "Connections.csv"))
        self.assertGreater(out["people"], 3)
        t.run("draft", "--kind", "message", "--template", t.write("m.txt", "Hi {first_name}!"))
        self.assertGreater(t.run("status")["drafts"]["message"], 0)

    def test_draft_fills_validates_and_reports_problems(self):
        t = self.start(rows=["NoHead,,Austin,2nd,https://www.linkedin.com/in/nh/,k,t",
                             "Long Head,%s,Austin,2nd,https://www.linkedin.com/in/lh/,k,t" % ("w" * 400)])
        out = t.run("draft", "--kind", "connect", "--template", t.tpl)
        self.assertEqual(out["drafted"], 30)
        self.assertEqual({p["vanity"]: p["reason"] for p in out["problems"]},
                         {"nh": "missing headline", "lh": "%d characters, the connect limit is 300" % len(
                             "Hi Long, I noticed you are %s. Would love to connect." % ("w" * 300))})   # a field is cut at 300
        self.assertEqual(out["samples"][0]["text"], "Hi Person1, I noticed you are Realtor at Firm1. Would love to connect.")
        self.assertEqual(t.run("draft", "--kind", "connect", "--template", t.tpl, "--where", "headline=Firm1$")["drafted"], 1)
        t.fail("draft", "--kind", "connect", "--template", t.write("u.txt", "Hi {nickname}"))
        t.fail("draft", "--kind", "connect", "--template", t.write("e.txt", "  \n"))
        t.fail("draft", "--kind", "connect", "--template", str(t.tmp / "missing.txt"))

    def test_note_limit_is_exactly_300_and_message_limit_8000(self):
        t = self.start(2)
        edge = t.write("e.txt", "{first_name} " + "x" * (300 - len("Person1 ")))
        self.assertEqual(t.run("draft", "--kind", "connect", "--template", edge)["drafted"], 2)   # Person1 and Person2: 300
        over = t.write("o.txt", "{first_name} " + "x" * (301 - len("Person1 ")))
        out = t.run("draft", "--kind", "connect", "--template", over)
        self.assertEqual((out["drafted"], len(out["problems"])), (0, 2))
        t2 = self.start(2, "1st")
        big = t2.write("b.txt", "y" * 8000)
        self.assertEqual(t2.run("draft", "--kind", "message", "--template", big)["drafted"], 2)
        self.assertEqual(len(t2.run("draft", "--kind", "message", "--template", t2.write("c.txt", "y" * 8001))["problems"]), 2)

    def test_field_values_are_data_not_template_or_control_text(self):
        t = Tool(self, OUTREACH)
        t.run("init", t.write("p.csv", people_csv(0, rows=['"Mal {headline} Smith","Evil\nline\x00 {first_name}",Austin,2nd,https://www.linkedin.com/in/m1/,k,t'])))
        out = t.run("draft", "--kind", "connect", "--template", t.write("t.txt", "Hi {first_name}: {headline}"))
        self.assertEqual(out["samples"][0]["text"], "Hi Mal: Evil line {first_name}")   # no second expansion, one line

    def test_connect_skips_first_degree_and_message_wants_first_degree(self):
        t = self.start(3, "1st")
        out = t.run("draft", "--kind", "connect", "--template", t.tpl)
        self.assertEqual((out["drafted"], out["not_eligible"]), (0, {"not a new, non-1st-degree person": 3}))
        self.assertEqual(t.run("draft", "--kind", "message", "--template", t.msg)["drafted"], 3)
        t2 = self.start(3, "2nd")
        out = t2.run("draft", "--kind", "message", "--template", t2.msg)
        self.assertEqual((out["drafted"], out["not_eligible"]), (0, {"not known to be a 1st-degree connection": 3}))

    def test_batch_prints_the_exact_texts_and_needs_typed_approval_to_record(self):
        t = self.start(5)
        t.run("draft", "--kind", "connect", "--template", t.tpl)
        b = t.run("batch", "--kind", "connect", "--limit", "3")
        self.assertEqual(b["count"], 3)
        self.assertEqual(b["items"][0]["text"], "Hi Person1, I noticed you are Realtor at Firm1. Would love to connect.")
        self.assertEqual(b["items"][0]["profile_url"], "https://www.linkedin.com/in/p1/")
        self.assertEqual(b["to_approve"], "the user must type exactly: approve 3")
        t.fail("record", "p1", "--status", "sent")                      # not approved yet
        for typed in ("approve", "approve 2", "approve 4", "yes", "go ahead", "approved 3", "approve three", ""):
            with self.subTest(typed=typed):
                t.fail("approve", "--typed", typed)
        t.fail("record", "p5", "--status", "sent")                      # not in the batch
        self.assertTrue(t.run("approve", "--typed", "  Approve 3 ")["approved"])
        self.assertTrue(t.run("approve", "--typed", "approve 3")["already_approved"])
        self.assertEqual(t.run("record", "p1", "--status", "sent")["state"], "pending")
        self.assertTrue(t.run("record", "p1", "--status", "sent")["already_recorded"])
        t.fail("record", "p1", "--status", "failed")
        t.run("record", "p2", "--status", "skipped", "--note", "already pending")
        self.assertEqual(t.run("record", "p3", "--status", "failed")["batch_left"], 0)
        s = t.run("status")
        self.assertEqual((s["states"]["pending"], s["states"]["new"], s["open_batch"]), (1, 4, None))
        t.fail("approve", "--typed", "approve 1")                       # nothing open

    def test_open_batch_blocks_the_next_one_and_abandoned_people_stay_counted(self):
        t = self.start(10)
        t.run("draft", "--kind", "connect", "--template", t.tpl)
        t.run("batch", "--kind", "connect", "--limit", "4")
        self.assertEqual(t.run("status")["connect"]["used_24h"], 4)      # reserved before any send
        r = t.run("batch", "--kind", "connect", "--limit", "4")
        self.assertEqual((r["reason"], r["items"]), ("open_batch", []))
        r = t.run("batch", "--kind", "connect", "--limit", "2", "--abandon-batch")
        self.assertEqual(r["abandoned"], 4)
        self.assertEqual([i["vanity"] for i in r["items"]], ["p5", "p6"])
        self.assertEqual(t.run("status")["connect"]["used_24h"], 6)

    def test_skipped_gives_the_slot_back_failed_and_sent_do_not(self):
        t = self.start(10)
        t.run("draft", "--kind", "connect", "--template", t.tpl)
        b = t.run("batch", "--kind", "connect", "--limit", "3")
        t.run("approve", "--typed", "approve 3")
        t.run("record", "p1", "--status", "sent")
        t.run("record", "p2", "--status", "failed")
        t.run("record", "p3", "--status", "skipped")
        self.assertEqual(t.run("status")["connect"]["used_24h"], 2)
        again = t.run("batch", "--kind", "connect", "--limit", "10")
        self.assertNotIn("p1", [i["vanity"] for i in again["items"]])
        self.assertNotIn("p2", [i["vanity"] for i in again["items"]])    # failed is not retried unless asked
        self.assertNotIn("p3", [i["vanity"] for i in again["items"]])    # a skip stays skipped until re-drafted
        t.run("approve", "--typed", "approve %d" % again["count"])
        for i in again["items"]:
            t.run("record", i["vanity"], "--status", "skipped")
        retry = t.run("batch", "--kind", "connect", "--limit", "10", "--retry-failed")
        self.assertIn("p2", [i["vanity"] for i in retry["items"]])

    def test_connection_requests_are_capped_at_20_a_day(self):
        t = self.start(45)
        t.run("draft", "--kind", "connect", "--template", t.tpl)
        b = self.send_batch(t, "connect", 50)
        self.assertEqual(b["count"], 20)
        self.assertEqual(t.run("status")["connect"], {"used_24h": 20, "used_7d": 20, "remaining_now": 0})
        r = t.run("batch", "--kind", "connect", "--limit", "5", now=T_PLUS_1H)
        self.assertEqual((r["reason"], r["items"]), ("daily_cap_reached", []))
        r = t.run("batch", "--kind", "connect", "--limit", "50", now=T_PLUS_24H1)
        self.assertEqual(r["count"], 20)

    def test_connection_requests_are_capped_at_100_per_7_days(self):
        t = self.start(130)
        t.run("draft", "--kind", "connect", "--template", t.tpl)
        led_path = t.tmp / "linkedin-outreach-work" / "ledger.json"
        led = json.loads(led_path.read_text())
        # 96 sent on 28 to 31 October, none in the 24 hours before the test's "now"
        for i in range(96):
            led["events"].append({"at": "2026-10-%02dT12:00:00Z" % (28 + i % 4),
                                  "vanity": "x%d" % i, "kind": "connect", "status": "sent", "batch": "b"})
        led_path.write_text(json.dumps(led))
        now = "2026-11-02T10:00:00Z"
        s = t.run("status", now=now)
        self.assertEqual(s["connect"]["used_7d"], 96)
        b = t.run("batch", "--kind", "connect", "--limit", "20", now=now)
        self.assertEqual(b["count"], 4)                                   # 100 - 96, even though today's cap is 20
        t.run("approve", "--typed", "approve 4", now=now)
        for it in b["items"]:
            t.run("record", it["vanity"], "--status", "sent", now=now)
        r = t.run("batch", "--kind", "connect", "--limit", "20", now="2026-11-03T11:00:00Z")
        self.assertEqual((r["reason"], r["items"]), ("weekly_cap_reached", []))
        # the oldest of the 100 leaves the window
        r = t.run("batch", "--kind", "connect", "--limit", "20", now="2026-11-09T13:00:00Z")
        self.assertGreater(r["count"], 0)

    def test_messages_are_capped_at_40_a_day_and_3_per_person(self):
        t = self.start(45, "1st")
        t.run("draft", "--kind", "message", "--template", t.msg)
        b = self.send_batch(t, "message", 100)
        self.assertEqual(b["count"], 40)
        r = t.run("batch", "--kind", "message", "--limit", "5", now=T_PLUS_1H)
        self.assertEqual((r["reason"], r["items"]), ("daily_cap_reached", []))
        # 3 messages per person: rounds on later days
        t.run("draft", "--kind", "message", "--template", t.msg, "--limit", "1")
        for day, now in enumerate(("2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z")):
            t.run("draft", "--kind", "message", "--template", t.msg, "--where", "name=^Person1 ", now=now)
            b = t.run("batch", "--kind", "message", "--limit", "1", now=now)
            self.assertEqual([i["vanity"] for i in b["items"]], ["p1"], day)
            t.run("approve", "--typed", "approve 1", now=now)
            t.run("record", "p1", "--status", "sent", now=now)
        out = t.run("draft", "--kind", "message", "--template", t.msg, "--where", "name=^Person1 ", now="2026-11-08T10:00:00Z")
        self.assertEqual(out["drafted"], 0)
        self.assertEqual(out["not_eligible"], {"already messaged 3 times": 1})
        self.assertEqual(t.run("status", now="2026-11-08T10:00:00Z")["states"]["messaged"], 40)

    def test_reserved_messages_count_toward_the_per_person_limit(self):
        t = self.start(2, "1st")
        t.run("draft", "--kind", "message", "--template", t.msg)
        for n in range(3):
            now = "2026-11-0%dT10:00:00Z" % (2 + 2 * n)
            self.send_batch(t, "message", 1, now=now)
            t.run("draft", "--kind", "message", "--template", t.msg, "--where", "name=^Person1 ", now=now)
        b = t.run("batch", "--kind", "message", "--limit", "5", now="2026-11-10T10:00:00Z")
        self.assertNotIn("p1", [i["vanity"] for i in b["items"]])

    def test_new_account_halves_every_cap(self):
        t = self.start(60, "2nd", (), "--new-account")
        t.run("draft", "--kind", "connect", "--template", t.tpl)
        self.assertEqual(t.run("status")["caps"]["connect_day"], 10)
        self.assertEqual(t.run("batch", "--kind", "connect", "--limit", "50")["count"], 10)
        t.run("approve", "--typed", "approve 10")
        for i in range(1, 11):
            t.run("record", "p%d" % i, "--status", "sent")
        st = t.run("status")
        self.assertEqual((st["caps"]["connect_week"], st["caps"]["message_day"], st["caps"]["new_account_half"]), (50, 20, True))
        later = t.run("status", now="2026-11-17T10:00:00Z")           # past the two weeks
        self.assertEqual((later["caps"]["connect_day"], later["caps"]["message_day"]), (20, 40))
        t.run("account", "--established")
        self.assertEqual(t.run("status")["caps"]["connect_day"], 20)
        self.assertEqual(t.run("account", "--new-account")["caps"]["connect_day"], 10)

    def test_stop_locks_batches_for_24_hours(self):
        t = self.start(5)
        t.run("draft", "--kind", "connect", "--template", t.tpl)
        out = t.run("stop", "--reason", "Limit Banner!")
        self.assertEqual(out["stopped"], "limitbanner")
        r = t.run("batch", "--kind", "connect", "--limit", "2", now=T_PLUS_1H)
        self.assertEqual((r["reason"], r["locked_until"]), ("stopped:limitbanner", "2026-11-03T10:00:00Z"))
        self.assertEqual(t.run("batch", "--kind", "connect", "--limit", "2", now=T_PLUS_24H1)["count"], 2)

    def test_export_status_csv_has_a_formula_guard(self):
        t = Tool(self, OUTREACH)
        t.run("init", t.write("p.csv", people_csv(0, rows=["=cmd|calc,h,l,2nd,https://www.linkedin.com/in/e1/,k,t"])))
        t.run("draft", "--kind", "connect", "--template", t.write("t.txt", "Hi there"))
        self.send_batch(t, "connect", 5)
        t.run("export", "--out", str(t.tmp / "o.csv"))
        rows = list(csv.DictReader(open(t.tmp / "o.csv", encoding="utf-8-sig")))
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["name"], rows[0]["state"], rows[0]["connect_status"], rows[0]["messages_sent"]),
                         ("'=cmd|calc", "pending", "sent", "0"))

    def test_no_files_other_than_the_ledger_and_no_secrets(self):
        t = self.start(3)
        t.run("draft", "--kind", "connect", "--template", t.tpl)
        self.send_batch(t, "connect", 3)
        self.assertEqual(t.files(), ["ledger.json"])
        text = (t.tmp / "linkedin-outreach-work" / "ledger.json").read_text()
        self.assertNotIn("JSESSIONID", text)

    def test_lock_file_blocks_a_second_writer(self):
        t = self.start(3)
        (t.tmp / "linkedin-outreach-work" / ".lock").write_text("1")
        self.assertIn("another run", t.fail("stop", "--reason", "x").stderr)


# =============================================================================================================
# replies.py
# =============================================================================================================

def poll_result(accepted=(), pending=(), replied=(), stopped=None, since=0, start=0, has_more=False, conn_at=0, conv_at=0):
    return {"accepted": list(accepted), "pending": list(pending), "replied": list(replied),
            "cursor": {"connectedAt": conn_at, "conversationsAt": conv_at}, "has_more_connections": has_more,
            "seen": {}, "stopped_reason": stopped, "request": {"since": since, "start": start, "includeText": False}}


class RepliesLedger(unittest.TestCase):
    def setUp(self):
        self.o = Tool(self, OUTREACH)
        self.r = Tool(self, REPLIES)
        self.r.tmp = self.o.tmp                                          # one cwd: default dirs sit side by side
        self.o.csv = self.o.write("p.csv", people_csv(6))
        self.o.run("init", self.o.csv)
        self.o.run("draft", "--kind", "connect", "--template", self.o.write("t.txt", "Hi {first_name}"))
        b = self.o.run("batch", "--kind", "connect", "--limit", "4")
        self.o.run("approve", "--typed", "approve 4")
        for it in b["items"]:
            self.o.run("record", it["vanity"], "--status", "sent")

    def state(self, v):
        led = json.loads((self.o.tmp / "linkedin-outreach-work" / "ledger.json").read_text())
        return led["people"][v]

    def test_merge_moves_pending_people_to_connected_and_replied(self):
        self.r.run("next")
        out = self.r.run("merge", self.r.results(poll_result(
            accepted=[{"vanity": "p1", "member": "M1", "connectedAt": 1767225600000}, {"vanity": "", "member": "M2", "connectedAt": 1767225700000},
                      {"vanity": "p5", "member": "M5", "connectedAt": 1767225800000}, {"vanity": "", "member": "M9", "connectedAt": 5}],
            replied=[{"vanity": "p1", "member": "M1", "conversation": "c", "lastMessageAt": 1767226000000, "fromThem": True}],
            conn_at=1767225800000)))
        u = out["outreach_updates"]
        self.assertTrue(out["outreach_ledger"])
        self.assertEqual((u["accepted_applied"], u["accepted_not_pending"], u["replied_applied"], u["unmatched"]), (1, 1, 1, 2))
        self.assertEqual(u["newly_connected"], ["p1"])
        self.assertEqual(u["newly_replied"], ["p1"])
        self.assertEqual(out["unresolved_members"], [{"member": "M2", "kind": "accepted"}, {"member": "M9", "kind": "accepted"}])
        p1 = self.state("p1")
        self.assertEqual((p1["state"], p1["member"], p1["accepted_at"], p1["replied_at"]),
                         ("replied", "M1", "2026-01-01T00:00:00Z", "2026-01-01T00:06:40Z"))
        self.assertEqual(self.state("p5")["state"], "new")               # accepted but never invited by this tool: untouched

    def test_member_ids_learned_earlier_resolve_vanity_less_rows(self):
        self.r.run("next")
        self.r.run("merge", self.r.results(poll_result(accepted=[{"vanity": "p2", "member": "M2", "connectedAt": 1000}], conn_at=1000)))
        self.assertEqual(self.state("p2")["state"], "connected")
        self.r.run("next", now=T_PLUS_1H)
        out = self.r.run("merge", self.r.results(poll_result(
            replied=[{"vanity": "", "member": "M2", "conversation": "c", "lastMessageAt": 2000, "fromThem": True}], conv_at=2000)),
            now=T_PLUS_1H)
        self.assertEqual(out["outreach_updates"]["replied_applied"], 1)
        self.assertEqual(self.state("p2")["state"], "replied")

    def test_state_never_goes_backwards(self):
        self.r.run("next")
        self.r.run("merge", self.r.results(poll_result(replied=[{"vanity": "p3", "member": "", "conversation": "c", "lastMessageAt": 5, "fromThem": True}])))
        self.r.run("next", now=T_PLUS_1H)
        out = self.r.run("merge", self.r.results(poll_result(accepted=[{"vanity": "p3", "member": "", "connectedAt": 6}])), now=T_PLUS_1H)
        self.assertEqual(out["outreach_updates"]["accepted_not_pending"], 1)
        self.assertEqual(self.state("p3")["state"], "replied")

    def test_merge_is_idempotent(self):
        self.r.run("next")
        path = self.r.results(poll_result(accepted=[{"vanity": "p1", "member": "", "connectedAt": 1}], conn_at=1))
        self.assertFalse(self.r.run("merge", path)["already_merged"])
        self.assertTrue(self.r.run("merge", path)["already_merged"])
        self.assertEqual(self.r.run("status")["polls_24h"], 1)

    def test_works_without_an_outreach_dir_and_with_a_custom_one(self):
        r = Tool(self, REPLIES)
        r.run("next")
        out = r.run("merge", r.results(poll_result(accepted=[{"vanity": "p1", "member": "", "connectedAt": 1}], conn_at=1)))
        self.assertFalse(out["outreach_ledger"])
        self.assertEqual(r.run("status")["accepted_seen"], 1)
        shutil.copytree(self.o.tmp / "linkedin-outreach-work", r.tmp / "elsewhere")
        r.run("next", now=T_PLUS_1H)
        out = r.run("merge", r.results(poll_result(accepted=[{"vanity": "p2", "member": "", "connectedAt": 2}], conn_at=2)),
                    "--outreach-dir", str(r.tmp / "elsewhere"), now=T_PLUS_1H)
        self.assertEqual(out["outreach_updates"]["accepted_applied"], 1)

    def test_four_polls_a_day_at_least_an_hour_apart(self):
        times = ["2026-11-02T10:00:00Z", "2026-11-02T11:30:00Z", "2026-11-02T14:00:00Z", "2026-11-02T20:00:00Z"]
        for n, now in enumerate(times):
            out = self.r.run("next", now=now)
            self.assertIsNotNone(out["params"], (n, out))
            self.r.run("merge", self.r.results(poll_result(conn_at=n + 1)), now=now)
        out = self.r.run("next", now="2026-11-02T23:00:00Z")
        self.assertEqual((out["reason"], out["params"], out["used_24h"]), ("daily_cap_reached", None, 4))
        self.assertIsNotNone(self.r.run("next", now="2026-11-03T10:00:01Z")["params"])   # the first poll left the window

    def test_a_second_poll_inside_the_hour_is_refused_and_an_open_poll_blocks(self):
        self.r.run("next")
        self.assertEqual(self.r.run("next", now="2026-11-02T10:10:00Z")["reason"], "open_issue")
        self.r.run("merge", self.r.results(poll_result()))
        out = self.r.run("next", now="2026-11-02T10:30:00Z")
        self.assertEqual((out["reason"], out["next_poll_after"]), ("too_soon", "2026-11-02T11:00:00Z"))
        self.r.run("next", now=T_PLUS_1H)
        out = self.r.run("next", "--abandon-issue", now="2026-11-02T12:30:00Z")   # an abandoned poll still counts
        self.assertEqual(out["used_24h"], 3)

    def test_cursors_advance_only_when_the_whole_new_range_was_read(self):
        out = self.r.run("next")
        self.assertEqual(out["params"], {"since": 0, "start": 0, "conversationsSince": 0})
        self.r.run("merge", self.r.results(poll_result(conn_at=9000, conv_at=7000, has_more=True, since=0, start=0)))
        nxt = self.r.run("next", now=T_PLUS_1H)["params"]
        self.assertEqual(nxt, {"since": 0, "start": 10, "conversationsSince": 7000})   # keep reading down the list
        self.r.run("merge", self.r.results(poll_result(conn_at=5000, conv_at=7500, has_more=False, start=10)), now=T_PLUS_1H)
        nxt = self.r.run("next", now="2026-11-02T13:00:00Z")["params"]
        self.assertEqual(nxt, {"since": 9000, "start": 0, "conversationsSince": 7500})  # the newest seen across the pages

    def test_stops_lock_and_nothing_ran_does_not_use_a_poll(self):
        self.r.run("next")
        out = self.r.run("merge", self.r.results(poll_result(stopped="http_429")))
        self.assertEqual(out["stopped_reason"], "http_429")
        self.assertEqual(self.r.run("next", now=T_PLUS_1H)["reason"], "stopped:http_429")
        for reason in ("no_session", "wrong_page", "already_running", "queryid_not_found"):
            with self.subTest(reason=reason):
                r = Tool(self, REPLIES)
                r.run("next")
                out = r.run("merge", r.results(poll_result(stopped=reason)))
                self.assertEqual(out["used_24h"], 0)
                self.assertIsNotNone(r.run("next", now=T0)["params"])
        for reason in ("decoration_rotated", "queryid_rotated"):
            with self.subTest(reason=reason):
                r = Tool(self, REPLIES)
                r.run("next")
                r.run("merge", r.results(poll_result(stopped=reason)))
                self.assertIsNone(r.run("next", now=T_PLUS_1H)["reason"])   # no day lock

    def test_unsafe_rows_are_ignored_and_no_message_text_is_stored(self):
        self.r.run("next")
        rows = [{"vanity": "../x", "member": "", "connectedAt": 1}, {"vanity": "", "member": "bad id;", "connectedAt": 1},
                {"vanity": "p1", "member": "", "connectedAt": 1, "text": "SECRET BODY"}]
        self.r.run("merge", self.r.results(poll_result(accepted=rows)))
        led = (self.r.tmp / "linkedin-replies-work" / "ledger.json").read_text()
        self.assertNotIn("SECRET BODY", led)
        self.assertEqual(self.state("p1")["state"], "connected")
        self.r.fail("merge", self.r.results({"nothing": 1}))
        self.r.fail("merge", str(self.r.tmp / "absent.json"))


# =============================================================================================================
# manifests, marketplace, README, install text
# =============================================================================================================

def marketplace():
    return json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())


def yaml_of(path):
    sys.path.insert(0, str(ROOT / "build"))
    import sync_runtime
    return sync_runtime.load_manifest(path)


def skill_text(name):
    return (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")


RESOLVE = ('ENGINE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/linkedin}"\n'
           '[ -f "$ENGINE/scripts/li_common.py" ] || ENGINE="<absolute folder of this SKILL.md>/../linkedin"\n'
           '[ -f "$ENGINE/scripts/li_common.py" ] || { ENGINE="$(find -L /mnt/skills "$HOME/.claude/plugins" -maxdepth 8 '
           "-path '*linkedin/scripts/li_common.py' 2>/dev/null | head -1)\"; ENGINE=\"${ENGINE%/scripts/li_common.py}\"; }\n"
           '[ -f "$ENGINE/scripts/li_common.py" ] || echo "linkedin engine not found: stop and tell the user"')


class ClassicLinkedinPackaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.market = marketplace()
        cls.entries = {p["name"]: p for p in cls.market["plugins"]}
        cls.readme = (ROOT / "README.md").read_text(encoding="utf-8")

    def test_the_plugin_folder_ships_only_skills_and_the_engine_is_not_a_job(self):
        self.assertEqual({p.name for p in PLUGIN.iterdir() if p.name != ".DS_Store"}, {"skills"})
        self.assertEqual(sorted(p.name for p in SKILLS.iterdir() if p.is_dir()), sorted(["linkedin"] + list(JOBS)))
        self.assertFalse((ENGINE / "SKILL.md").exists(), "the engine is not user-facing")
        for name in JOBS:
            self.assertEqual(sorted(p.name for p in (SKILLS / name).iterdir() if p.name != ".DS_Store"),
                             ["SKILL.md", "skill.yaml"])
        for rel in ("scripts/li_common.py", "scripts/find_people.py", "scripts/outreach.py", "scripts/replies.py",
                    "scripts/search_people.js", "scripts/poll.js", "references/endpoints.md", "skill.yaml"):
            self.assertTrue((ENGINE / rel).is_file(), rel)
        for path in PLUGIN.rglob("*"):
            self.assertNotIn("__pycache__", path.parts)

    def test_manifests(self):
        eng = yaml_of(ENGINE)
        self.assertEqual((eng["name"], eng["category"], eng["runtimes"]), ("linkedin", "sales", []))
        self.assertRegex(eng["version"], r"^\d+\.\d+\.\d+$")
        for name in JOBS:
            with self.subTest(skill=name):
                m = yaml_of(SKILLS / name)
                self.assertEqual((m["name"], m["engine"], m["runtimes"], m["category"]), (name, "linkedin", [], "sales"))
                self.assertEqual(m["version"], eng["version"])
                self.assertRegex(skill_text(name), r"(?m)^name: %s$" % re.escape(name))
                self.assertRegex(skill_text(name), r"(?s)^---\n.*?description: >-\n.*?\n---\n")

    def test_marketplace_entries_share_one_source_and_one_skill_each(self):
        eng = yaml_of(ENGINE)
        for name, skill in JOBS.items():
            with self.subTest(plugin=name):
                e = self.entries[name]
                self.assertEqual(e["source"], "./plugins/linkedin")
                self.assertIs(e["strict"], False)
                self.assertEqual(e["skills"], ["./skills/" + skill])
                self.assertEqual(e["version"], eng["version"])
                self.assertEqual(e["category"], "sales")
                self.assertTrue(e["description"].startswith("Plain LinkedIn, no Sales Navigator needed."))
                self.assertNotIn("Needs a LinkedIn Sales Navigator seat", e["description"])
                self.assertTrue((PLUGIN / "skills" / skill / "SKILL.md").is_file())
                source = (ROOT / e["source"]).resolve()
                self.assertEqual(source, PLUGIN.resolve())
                self.assertTrue((source / "skills" / "linkedin" / "scripts" / "li_common.py").is_file(), "the engine ships")
        sharing = [p["name"] for p in self.market["plugins"] if p["source"] == "./plugins/linkedin"]
        self.assertEqual(sorted(sharing), sorted(JOBS))

    def test_linkedin_emails_is_untouched_where_it_was(self):
        e = self.entries["linkedin-emails"]
        self.assertEqual((e["source"], e["skills"]), ("./plugins/linkedin-emails", ["./skills/linkedin-emails"]))
        self.assertTrue(EMAILS.is_file())

    def test_linkedin_and_salesnav_sources_are_never_mixed(self):
        for p in self.market["plugins"]:
            with self.subTest(plugin=p["name"]):
                if p["source"] == "./plugins/sales-navigator":
                    self.assertFalse(p["name"].startswith("linkedin-"), p["name"])
                if p["source"] == "./plugins/linkedin":
                    self.assertTrue(p["name"].startswith("linkedin-"), p["name"])
                    self.assertFalse(p["name"].startswith("salesnav-"), p["name"])
                if p["name"].startswith("linkedin-") and p["name"] != "linkedin-emails":
                    self.assertEqual(p["source"], "./plugins/linkedin")
                if p["name"].startswith("salesnav-"):
                    self.assertEqual(p["source"], "./plugins/sales-navigator")

    def test_install_block_tells_a_copying_agent_to_bring_the_engine(self):
        for name in JOBS:
            text = skill_text(name)
            with self.subTest(skill=name):
                self.assertIn("## Install (for you, the agent)", text)
                block = text.split("## Install (for you, the agent)", 1)[1].split("\n## ", 1)[0]
                self.assertIn("AND the sibling `linkedin` engine folder", block)
                self.assertIn("/home/box/agent-data/workflows/%s/" % name, block)
                self.assertIn("/home/box/agent-data/workflows/linkedin/", block)
                self.assertIn("~/.codex/skills/%s" % name, block)
                self.assertIn("~/.codex/skills/linkedin", block)
                self.assertIn("~/.claude/skills/", block)
                self.assertIn("/plugin install %s@ae-external-skills" % name, block)
                self.assertIn("plugins/linkedin/skills/%s" % name, block)

    def test_every_command_goes_through_engine_and_the_resolve_block_is_literal(self):
        bare = re.compile(r"(?<!ENGINE/)(?<!ENGINE\}/)(?<![\w.$/-])(?:scripts|references)/[\w.<>*-]+")
        for name in JOBS:
            text = skill_text(name)
            with self.subTest(skill=name):
                blocks = re.findall(r"```sh\n(.*?)\n```", text, re.S)
                self.assertEqual(blocks, [RESOLVE])
                self.assertEqual(bare.findall(text), [])
                for m in re.finditer(r"python3 (\S+)", text):
                    self.assertTrue(m.group(1).startswith('"$ENGINE/scripts/'), m.group(0))
                self.assertIn("quote every path", " ".join(text.split()))
                self.assertIn("If none resolves, stop and tell the user", " ".join(text.split()))
                self.assertIn("never guess it", " ".join(text.split()))
                self.assertLessEqual(len(text.splitlines()), 112)

    def test_engine_block_resolves_in_each_install_shape(self):
        block = re.findall(r"```sh\n(.*?)\n```", skill_text("linkedin-outreach"), re.S)[0]
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)

            def resolve(skill_dir, home, plugin_root=None, mnt=None):
                b = block.replace("<absolute folder of this SKILL.md>", str(skill_dir)).replace("/mnt/skills", str(mnt or tmp / "nomnt"))
                env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_PLUGIN_ROOT", "HOME")}
                env["HOME"] = str(home)
                if plugin_root is not None:
                    env["CLAUDE_PLUGIN_ROOT"] = str(plugin_root)
                p = subprocess.run(["sh", "-c", b + '\nprintf "%s" "$ENGINE"'], capture_output=True, text=True, env=env)
                return p.stdout.splitlines()[-1] if p.stdout else ""

            copy = tmp / "copy"
            shutil.copytree(PLUGIN, copy, ignore=shutil.ignore_patterns("__pycache__"))
            home = tmp / "home"
            home.mkdir()
            self.assertEqual(resolve(copy / "skills" / "linkedin-outreach", home, plugin_root=copy), str(copy / "skills" / "linkedin"))
            self.assertEqual(resolve(copy / "skills" / "linkedin-outreach", home, plugin_root=""), str(copy / "skills" / "linkedin-outreach" / ".." / "linkedin"))
            # a lone skill folder with the engine only reachable through the plugin cache or /mnt/skills
            lone = tmp / "lone" / "linkedin-outreach"
            shutil.copytree(copy / "skills" / "linkedin-outreach", lone)
            cache = home / ".claude" / "plugins" / "cache" / "ae" / "linkedin-outreach" / "0.1.0"
            shutil.copytree(copy, cache)
            self.assertEqual(resolve(lone, home, plugin_root=""), str(cache / "skills" / "linkedin"))
            mnt = tmp / "mnt"
            shutil.copytree(copy, mnt / "plugin-files" / "linkedin")
            self.assertEqual(resolve(lone, tmp / "emptyhome", plugin_root="", mnt=mnt), str(mnt / "plugin-files" / "linkedin" / "skills" / "linkedin"))
            # nothing anywhere: the block says so and ENGINE does not point at a usable engine
            out = subprocess.run(["sh", "-c", block.replace("<absolute folder of this SKILL.md>", str(lone)).replace("/mnt/skills", str(tmp / "no"))
                                  + '\n[ -f "$ENGINE/scripts/li_common.py" ] && echo FOUND || echo MISSING'],
                                 capture_output=True, text=True, env={"PATH": os.environ["PATH"], "HOME": str(tmp / "emptyhome")})
            self.assertIn("linkedin engine not found: stop and tell the user", out.stdout)
            self.assertTrue(out.stdout.rstrip().endswith("MISSING"))

    def test_skills_state_the_safety_rules(self):
        for name in JOBS:
            text = " ".join(skill_text(name).split()).lower()
            with self.subTest(skill=name):
                self.assertIn("untrusted data", text)
                self.assertIn("no cookies", text)
                self.assertIn("no hosted services", text)
                self.assertIn("never ask for", text)
                self.assertNotIn("unipile", text)
        out = " ".join(skill_text("linkedin-outreach").split()).lower()
        self.assertIn("typed approval", out)
        self.assertIn("approve n", out)
        self.assertIn("45 to 120 seconds", out)
        self.assertIn("20 connection requests a day and 100 per 7 days", out)
        self.assertIn("40 messages a day", out)
        self.assertIn("3 messages per person", out)
        self.assertIn("only drafts", out)
        self.assertIn("commercial use limit", " ".join(skill_text("linkedin-find-people").split()).lower())
        self.assertIn("4 polls", " ".join(skill_text("linkedin-replies").split()).lower())

    def test_endpoints_reference_marks_verified_rows_and_the_search_finding(self):
        text = (ENGINE / "references" / "endpoints.md").read_text(encoding="utf-8")
        self.assertIn("VERIFIED 2026-11-02", text)
        self.assertIn("/search/results/people/?keywords=", text)
        kb = (ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator" / "references" / "salesnav-kb"
              / "16-diy-linkedin-endpoints.md").read_text(encoding="utf-8")
        verified = [ln for ln in kb.splitlines() if "VERIFIED 2026-10-18" in ln and "voyager" in ln and "/sales-api" not in ln]
        self.assertGreaterEqual(len(verified), 5)
        for ln in verified:   # every classic row KB16 verified is mapped here with the same marker
            m = re.search(r"`(GET /voyager/api/[a-zA-Z/]+)", ln)
            if m:
                self.assertIn(m.group(1), text, m.group(1))
        for line in text.splitlines():
            if "sentInvitationViewsV2?" in line or "dash/connections?" in line:
                self.assertIn("VERIFIED 2026-10-18", line)
        self.assertNotIn("/sales-api", text.split("## Common request rules")[1].replace("The Sales Navigator endpoints (`/sales-api/...`", ""))

    def test_readme_rows_tables_and_notes(self):
        head = self.readme.split("## What's in here", 1)[0]
        plain = head.split("### Plain LinkedIn (no Sales Navigator needed)", 1)[1].split("### Sales Navigator", 1)[0]
        for name in JOBS:
            with self.subTest(plugin=name):
                sentence = ("`Install the %s skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/linkedin "
                            "and set it up for me.` | A LinkedIn account, signed in in your browser |" % name)
                self.assertIn(sentence, plain)
                self.assertIn("| `%s` | `%s` |" % (name, JOBS[name]), self.readme)
        self.assertNotIn("are coming", self.readme)
        self.assertNotIn("More plain-LinkedIn skills", self.readme)
        self.assertIn("plugins/linkedin/", self.readme.split("## Layout", 1)[1])
        self.assertIn("plugins/linkedin/skills/linkedin", self.readme)
        self.assertRegex(self.readme.split("## Upgrading", 1)[1].split("## Layout", 1)[0], r"linkedin-find-people.*0\.1\.0")

    def test_sync_runtime_check_is_clean(self):
        p = subprocess.run([sys.executable, str(ROOT / "build" / "sync_runtime.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main()
