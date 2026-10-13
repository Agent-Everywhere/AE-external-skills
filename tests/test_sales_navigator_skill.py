"""Structure and safety-language checks for the sales-navigator skill's actions.

Run from the repo root:  python3 -m pytest -q tests
"""
import csv
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "sales-navigator"
REFS = SKILL / "references"
sys.path.insert(0, str(SKILL / "scripts"))

import dedupe  # noqa: E402
import validate_csv  # noqa: E402

ACTIONS = {
    "build-list": "build-list.md",
    "qualify-accounts": "qualify.md",
    "save-to-lists": "lists.md",
    "outreach": "outreach.md",
    "follow-ups": "followups.md",
    "run-my-day": "run-my-day.md",
}


def frontmatter(text):
    return text.split("---", 2)[1]


class Router(unittest.TestCase):
    def setUp(self):
        self.skill_md = (SKILL / "SKILL.md").read_text(encoding="utf-8")

    def test_router_lists_every_action_with_an_existing_reference(self):
        router = self.skill_md.split("## Actions (router)", 1)[1].split("\n## ", 1)[0]
        for action, ref in ACTIONS.items():
            with self.subTest(action=action):
                self.assertIn("**%s**" % action, router)
                self.assertIn("references/%s" % ref, router)
                self.assertTrue((REFS / ref).is_file())

    def test_every_relative_link_in_skill_md_resolves(self):
        for target in re.findall(r"\]\(([^)#]+)\)", self.skill_md):
            if target.startswith("http"):
                continue
            with self.subTest(link=target):
                self.assertTrue((SKILL / target).exists(), target)

    def test_description_says_read_only_by_default_and_sends_only_on_explicit_approval(self):
        desc = " ".join(frontmatter(self.skill_md).split()).lower()
        self.assertIn("read-only on linkedin by default", desc)
        self.assertIn("explicitly asks to send", desc)
        self.assertIn("approves the exact batch", desc)

    def test_preflight_picks_the_js_tool_first(self):
        pre = self.skill_md.split("## Preflight", 1)[1]
        self.assertLess(pre.index("browser JavaScript tool"), pre.index("Agent Browser connector"))
        self.assertIn("the default", pre.split("Agent Browser connector")[0])
        for needle in ("Cowork", "Claude in Chrome", "slow path"):
            self.assertIn(needle, pre)

    def test_skill_md_stays_skimmable(self):
        self.assertLess(len(self.skill_md.splitlines()), 130)


class LocalRuntimeDoc(unittest.TestCase):
    def test_local_md_describes_the_js_tool_flow(self):
        text = (ROOT / "packages" / "browser-runtime" / "local.md").read_text(encoding="utf-8")
        for needle in ("javascript_exec", "one snippet", "--emit", "--compact", "--form return",
                       "results/", "salesnav_rows.py", "3 to 5 seconds", "laptop"):
            with self.subTest(needle=needle):
                self.assertIn(needle, text)
        # the JS-tool option comes before the Playwright one
        self.assertLess(text.index("Option 1"), text.index("Option 2"))
        self.assertIn("the default", text.split("Option 2")[0])

    def test_vendored_copy_matches(self):
        src = (ROOT / "packages" / "browser-runtime" / "local.md").read_bytes()
        self.assertEqual(src, (SKILL / "runtime" / "local.md").read_bytes())


class SendingIsDescribedOnlyInOutreach(unittest.TestCase):
    """Send rules live in references/outreach.md; elsewhere only pointers and the caps table."""

    DISTINCTIVE = ("300 characters", "jitter", "one person at a time", "one at a time", "30 to 90 seconds",
                   "30–90 s", "approval of that batch", "sent-state", "never auto-retry", "unknown result")

    def test_distinctive_send_rules_appear_only_in_outreach_md(self):
        outreach = (REFS / "outreach.md").read_text(encoding="utf-8").lower()
        for needle in ("300 characters", "jitter", "one person at a time"):
            self.assertIn(needle, outreach)
        for path in sorted(SKILL.rglob("*")):
            if (not path.is_file() or path.name == "outreach.md" or "__pycache__" in path.parts
                    or path.suffix in {".pyc", ".csv"} or "runtime" in path.relative_to(SKILL).parts[:1]):
                continue
            text = path.read_text(encoding="utf-8", errors="ignore").lower()
            for needle in self.DISTINCTIVE:
                with self.subTest(file=str(path.relative_to(SKILL)), needle=needle):
                    self.assertNotIn(needle, text)

    def test_outreach_md_has_every_hard_rule(self):
        text = " ".join((REFS / "outreach.md").read_text(encoding="utf-8").split())
        for needle in ("at most 300 characters", "20 connection requests a day and 100 a week",
                       "InMails only within the credits", "does **not** carry to the next batch",
                       "30 to 90 seconds", "Verify the sent-state", "outreach_log.csv",
                       "pending invitation", "existing message thread", "captcha", "Never auto-retry",
                       "explicitly asked to send", "Never send from a scheduled or unattended run"):
            with self.subTest(needle=needle):
                self.assertIn(needle, text)

    def test_other_actions_point_at_outreach_instead_of_restating_it(self):
        for name in ("followups.md", "run-my-day.md", "lists.md"):
            text = (REFS / name).read_text(encoding="utf-8")
            with self.subTest(file=name):
                self.assertIn("outreach.md", text)
        self.assertIn("never sends", (REFS / "run-my-day.md").read_text(encoding="utf-8").lower())

    def test_guardrails_carry_the_caps_and_stop_rules_and_point_to_outreach(self):
        text = (REFS / "guardrails.md").read_text(encoding="utf-8")
        section = text.split("## Outreach caps and stop rules", 1)[1]
        self.assertIn("outreach.md", section)
        for needle in ("captcha", "banner", "unknown"):
            self.assertIn(needle, section)

    def test_page_snippets_never_post(self):
        for path in (SKILL / "page").glob("*.js"):
            body = path.read_text(encoding="utf-8")
            with self.subTest(snippet=path.name):
                self.assertNotRegex(body, r"method\s*:\s*['\"](POST|PUT|PATCH|DELETE)")


class CompanyProfileTemplate(unittest.TestCase):
    def test_template_has_every_section_actions_read(self):
        text = (SKILL / "templates" / "company-profile.md").read_text(encoding="utf-8")
        for heading in ("Offer", "ICP", "Buyer types", "titles by company size", "Keywords",
                        "Exclusions", "Size goal", "Tone and voice", "Caps and permissions"):
            with self.subTest(heading=heading):
                self.assertRegex(text, r"(?im)^## \d+\. .*%s" % re.escape(heading))
        # the sub-list plan is an output recorded after counting, not an intake section
        self.assertNotRegex(text, r"(?im)^## \d+\. .*Sub-list plan")
        self.assertIn("Not a buyer", text)
        self.assertIn("Noise words", text)

    def test_actions_mention_the_profile(self):
        for name in ("SKILL.md",):
            self.assertIn("templates/company-profile.md", (SKILL / name).read_text(encoding="utf-8"))
        self.assertIn("Company Profile", (REFS / "qualify.md").read_text(encoding="utf-8"))


class LeadSearchRowColumns(unittest.TestCase):
    def lead(self, **over):
        base = dict.fromkeys(validate_csv.LEAD_COLUMNS + validate_csv.LEAD_OPTIONAL_COLUMNS, "")
        base.update(full_name="Jane Doe", company_name="Acme", mode="A", status="collected")
        base.update(over)
        return base

    def write(self, tmp, rows, headers=None):
        headers = headers or validate_csv.LEAD_COLUMNS + validate_csv.LEAD_OPTIONAL_COLUMNS
        path = Path(tmp) / "leads.csv"
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(headers)
            w.writerows([[r[h] for h in headers] for r in rows])
        return str(path)

    def test_output_md_documents_the_optional_lead_columns(self):
        md = (REFS / "output.md").read_text(encoding="utf-8")
        section = md.split("## Search-row columns", 1)[1].split("\n## ", 1)[0]
        for col in validate_csv.LEAD_OPTIONAL_COLUMNS:
            self.assertIn("| %s |" % col, section)

    def test_optional_columns_validate_with_or_without_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            row = self.lead(pending_invitation="yes", degree="2nd", open_link="yes", dup_suspect="yes")
            r = validate_csv.validate(self.write(tmp, [row]))
            self.assertEqual((r["header_errors"], r["errors"], r["warnings"]), ([], [], []))
            r = validate_csv.validate(self.write(tmp, [row], headers=validate_csv.LEAD_COLUMNS))
            self.assertEqual((r["header_errors"], r["errors"], r["warnings"]), ([], [], []))

    def test_bad_values_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            row = self.lead(pending_invitation="true", degree="4th", open_link="no", dup_suspect="maybe")
            errs = validate_csv.validate(self.write(tmp, [row]))["errors"]
            self.assertEqual(sorted(e[1] for e in errs), ["degree", "dup_suspect", "open_link", "pending_invitation"])


class IntakeMatchesProfile(unittest.TestCase):
    """build-list.md intake and templates/company-profile.md are one set."""

    def setUp(self):
        self.build = (REFS / "build-list.md").read_text(encoding="utf-8")
        self.profile = (SKILL / "templates" / "company-profile.md").read_text(encoding="utf-8")
        self.intake = self.build.split("## 1. Intake", 1)[1].split("\n## 2.", 1)[0]

    def test_every_intake_row_points_at_an_existing_profile_section(self):
        sections = {int(n) for n in re.findall(r"(?m)^## (\d+)\.", self.profile)}
        cited = [int(m) for m in re.findall(r"\|\s*(\d+)\s*\|", self.intake)]
        self.assertEqual(len(cited), 9)
        self.assertTrue(set(cited) <= sections, cited)
        # every profile section but "where things live" is asked in the intake
        self.assertEqual(sections - set(cited), {10})

    def test_intake_asks_the_agreed_short_set_and_not_the_old_extras(self):
        for needle in ("Offer", "Buyer types", "not a buyer", "Firmographics", "Decision-maker titles",
                       "noise words", "Exclusions", "Size goal", "Tone", "Caps", "one short batch"):
            with self.subTest(needle=needle):
                self.assertIn(needle, self.intake)
        self.assertNotIn("Where results go", self.intake)
        self.assertNotIn("Sub-list plan", self.profile.split("## 10.", 1)[0])

    def test_sub_list_plan_is_recorded_after_counting(self):
        self.assertIn("Sub-list plan", self.build.split("## 3.", 1)[1])
        self.assertIn("After counting, record the plan", self.build)


class BuildListGuidance(unittest.TestCase):
    def setUp(self):
        self.build = " ".join((REFS / "build-list.md").read_text(encoding="utf-8").split())
        self.fast = " ".join((REFS / "fast-path.md").read_text(encoding="utf-8").split())
        self.qualify = " ".join((REFS / "qualify.md").read_text(encoding="utf-8").split())

    def test_noise_word_carve_out_keeps_competitors_out_of_the_query(self):
        self.assertIn("with one carve-out", self.build)
        self.assertIn("NOT term", self.build)
        self.assertIn("after checking counts", self.build)
        self.assertIn("Never use this to remove competitors", self.build)

    def test_sample_vs_collection_is_documented_on_both_sides(self):
        self.assertIn("Sample vs collection", self.build)
        self.assertIn('"sample": true', self.build)
        self.assertIn('"sample": true', self.fast)
        agent = (ROOT / "packages" / "browser-runtime" / "agent-browser.md").read_text(encoding="utf-8")
        self.assertIn('"sample": true', agent)

    def test_decision_maker_query_has_title_function_and_region(self):
        for needle in ("CURRENT_TITLE", "FUNCTION", "REGION", "SENIORITY_LEVEL"):
            self.assertIn(needle, self.fast)
            self.assertIn(needle, self.build.replace("`", ""))  # build-list names them in prose
        query = [l for l in (REFS / "fast-path.md").read_text(encoding="utf-8").splitlines()
                 if "type:CURRENT_COMPANY" in l and "type:SENIORITY_LEVEL" in l][0]
        self.assertIn("type:CURRENT_TITLE", query)
        self.assertIn("type:REGION", query)
        self.assertEqual(query.count("("), query.count(")"))

    def test_qualify_calibrates_on_a_spread_and_drops_not_a_buyer_types(self):
        self.assertIn("spread across the whole list", self.qualify)
        self.assertIn("not the first 10", self.qualify)
        self.assertIn("not a buyer", self.qualify)
        self.assertIn("dropped **here", self.qualify)
        self.assertIn("`keep` rows first, then `unsure`", self.qualify)


class GeoStatesReference(unittest.TestCase):
    def setUp(self):
        self.text = (REFS / "geo-us-states.md").read_text(encoding="utf-8")
        self.rows = [[c.strip() for c in l.strip("|").split("|")] for l in self.text.splitlines()
                     if l.startswith("| ") and not l.startswith("| State") and not l.startswith("|---")]

    def test_fifty_states_plus_dc_each_once(self):
        names = [r[0] for r in self.rows]
        self.assertEqual(len(names), 51)
        self.assertEqual(len(set(names)), 51)
        self.assertIn("District of Columbia", names)
        self.assertEqual(len({r[1] for r in self.rows}), 51)

    def test_ids_are_numeric_or_marked_resolve_once_and_the_known_ones_are_present(self):
        for name, code, geo in self.rows:
            with self.subTest(state=name):
                self.assertRegex(geo, r"^(\d{9}|resolve once)$")
        ids = {r[0]: r[2] for r in self.rows}
        self.assertEqual(ids["Arizona"], "106032500")
        self.assertEqual(ids["Ohio"], "106981407")
        self.assertEqual(ids["Minnesota"], "103411167")
        self.assertEqual(len({v for v in ids.values() if v != "resolve once"}),
                         len([v for v in ids.values() if v != "resolve once"]))  # no id used twice
        self.assertGreaterEqual(sum(v != "resolve once" for v in ids.values()), 30)

    def test_documents_the_one_call_typeahead_and_the_stop_rule(self):
        for needle in ("103644278", "BING_GEO", "priority order", "Stop when coverage is good"):
            self.assertIn(needle, self.text)

    def test_filters_and_build_list_point_at_it(self):
        self.assertIn("geo-us-states.md", (REFS / "filters.md").read_text(encoding="utf-8"))
        self.assertIn("geo-us-states.md", (REFS / "build-list.md").read_text(encoding="utf-8"))
        self.assertIn("geo-us-states.md", (SKILL / "SKILL.md").read_text(encoding="utf-8"))


class OutreachDraftsFlow(unittest.TestCase):
    def setUp(self):
        self.text = " ".join((REFS / "outreach.md").read_text(encoding="utf-8").split())
        part_a = self.text.split("## Part A: draft", 1)[1].split("## Part B", 1)[0]
        self.part_a = part_a

    def test_template_header_matches_the_documented_columns(self):
        header = (SKILL / "templates" / "drafts.csv").read_text(encoding="utf-8").strip()
        self.assertEqual(header, "lead_id,full_name,company_name,kind,text,char_count")
        self.assertIn(header, self.part_a)

    def test_part_a_creates_the_folder_and_shows_exact_drafts_before_any_send(self):
        self.assertIn("Create the `drafts/` folder", self.part_a)
        self.assertIn("Show the exact drafts to the user", self.part_a)
        self.assertIn("Part A sends nothing", self.part_a)

    def test_search_row_columns_are_the_first_check(self):
        for needle in ("pending_invitation", "degree", "open_link", "first check", "--ids-file"):
            self.assertIn(needle, self.part_a)
        rule8 = self.text.split("8. **Never send a first message", 1)[1].split("9. **Stop on any warning", 1)[0]
        self.assertIn("pending_invitation", rule8)
        self.assertIn("existing message thread", self.text)
        self.assertIn("open the lead and look", rule8)  # threads still need a look


class AgentBrowserDocs(unittest.TestCase):
    def setUp(self):
        self.text = " ".join((ROOT / "packages" / "browser-runtime" / "agent-browser.md")
                             .read_text(encoding="utf-8").split())

    def test_preflight_lists_workspace_and_sign_in_status_before_a_session(self):
        pre = self.text.split("## Preflight", 1)[1].split("## Flow", 1)[0]
        self.assertIn("`action=list`", pre)
        self.assertIn("hours left", pre)
        self.assertIn("browser action=status", pre)
        self.assertIn("auth_required", pre)
        self.assertLess(self.text.index("## Preflight"), self.text.index("## Flow"))

    def test_dependent_steps_note(self):
        self.assertIn("every param is static", self.text)
        self.assertIn("one session per step", self.text)
        self.assertIn("local runtime", self.text)

    def test_vendored_copy_matches(self):
        for name in ("agent-browser.md", "README.md", "session.py"):
            self.assertEqual((ROOT / "packages" / "browser-runtime" / name).read_bytes(),
                             (SKILL / "runtime" / name).read_bytes(), name)


class QualifyColumns(unittest.TestCase):
    def write(self, tmp, headers, rows):
        path = Path(tmp) / "accounts.csv"
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(headers)
            w.writerows(rows)
        return str(path)

    def row(self, **over):
        base = dict.fromkeys(validate_csv.ACCOUNT_COLUMNS, "")
        base.update(company_name="Acme", company_domain="acme.com", mode="B", status="qualified",
                    facts="sells X; ships to retailers", fit_reason="fits buyer type A", keep="keep")
        base.update(over)
        return base

    def test_output_md_documents_the_qualify_columns(self):
        md = (REFS / "output.md").read_text(encoding="utf-8")
        section = md.split("## Qualify columns", 1)[1].split("\n## ", 1)[0]
        for col in validate_csv.QUALIFY_COLUMNS:
            self.assertIn("| %s |" % col, section)

    def test_accounts_with_qualify_columns_validate(self):
        headers = validate_csv.ACCOUNT_COLUMNS + validate_csv.QUALIFY_COLUMNS
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, headers, [[self.row()[h] for h in headers]])
            result = validate_csv.validate(path)
            self.assertEqual((result["header_errors"], result["errors"], result["warnings"]), ([], [], []))

    def test_keep_value_is_checked_and_other_extras_still_fail(self):
        headers = validate_csv.ACCOUNT_COLUMNS + validate_csv.QUALIFY_COLUMNS
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, headers, [[self.row(keep="maybe")[h] for h in headers]])
            errs = validate_csv.validate(path)["errors"]
            self.assertEqual([(e[1], e[2]) for e in errs], [("keep", "enum")])
            path = self.write(tmp, headers + ["surprise"], [[self.row()[h] for h in headers] + ["x"]])
            self.assertTrue(any("extra columns: surprise" in e for e in validate_csv.validate(path)["header_errors"]))

    def test_leads_do_not_accept_qualify_columns(self):
        headers = validate_csv.LEAD_COLUMNS + ["keep"]
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, headers, [])
            self.assertTrue(validate_csv.validate(path)["header_errors"])

    def test_dedupe_keeps_the_qualify_columns(self):
        headers = validate_csv.ACCOUNT_COLUMNS + validate_csv.QUALIFY_COLUMNS
        with tempfile.TemporaryDirectory() as tmp:
            src = self.write(tmp, headers, [[self.row()[h] for h in headers]])
            out = str(Path(tmp) / "out.csv")
            code = dedupe.main([src, "--out", out])
            self.assertEqual(code, 0)
            with open(out, newline="", encoding="utf-8") as fh:
                rows = list(csv.DictReader(fh))
            self.assertEqual((rows[0]["fit_reason"], rows[0]["keep"]), ("fits buyer type A", "keep"))


if __name__ == "__main__":
    unittest.main()
