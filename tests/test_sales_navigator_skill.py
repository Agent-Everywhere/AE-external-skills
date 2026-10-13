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
                       "noise words", "Exclusions", "Size goal", "Tone", "Caps", "ONE message"):
            with self.subTest(needle=needle):
                self.assertIn(needle, " ".join(self.intake.split()))
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
        self.assertEqual(header, "lead_id,full_name,company_name,kind,text,char_count,sources")
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

    def test_rule_8_skips_the_profile_open_only_on_no_plus_2nd_3rd_plus_today(self):
        rule8 = self.text.split("8. **Never send a first message", 1)[1].split("9. **Stop on any warning", 1)[0]
        for needle in ("`pending_invitation = no`", "2nd or 3rd", "`collected_at` is today",
                       "blank means the field was absent", "on a live seat", "`degree = 1st` means already connected"):
            self.assertIn(needle.lower(), rule8.lower(), needle)
        self.assertIn("ONLY when", self.part_a)
        for needle in ("`pending_invitation = no`", "2nd or 3rd", "`collected_at` is today"):
            self.assertIn(needle, self.part_a)

    def test_output_md_documents_the_no_value(self):
        md = (REFS / "output.md").read_text(encoding="utf-8")
        row = [l for l in md.splitlines() if l.startswith("| pending_invitation |")][0]
        self.assertIn("`no`", row)
        self.assertIn("live seat", row)


class SubListPlanReferences(unittest.TestCase):
    def test_no_stale_section_7_sub_list_plan_pointer(self):
        for name in ("lists.md", "followups.md", "run-my-day.md"):
            text = " ".join((REFS / name).read_text(encoding="utf-8").split())
            self.assertNotRegex(text, r"(?i)section 7[^.]{0,60}sub-list plan", name)
            self.assertNotRegex(text, r"(?i)sub-list plan[^.]{0,60}section 7", name)
        for name in ("lists.md", "run-my-day.md"):
            self.assertIn("## Sub-list plan", (REFS / name).read_text(encoding="utf-8"), name)


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


def squash(path):
    return " ".join(path.read_text(encoding="utf-8").split())


class QualifyTiers(unittest.TestCase):
    """Cowork prompts once per website: qualify from search data first, fetch only `unsure` rows."""

    def setUp(self):
        self.text = squash(REFS / "qualify.md")
        self.tier1 = self.text.split("### Tier 1", 1)[1].split("### Tier 2", 1)[0]
        self.tier2 = self.text.split("### Tier 2", 1)[1].split("## Run it", 1)[0]

    def test_tier_one_uses_search_data_only_and_opens_no_website(self):
        for needle in ("search data", "Open no website", "`unsure`", "company_name", "industry",
                       "headcount_band"):
            self.assertIn(needle, self.tier1)
        self.assertNotIn("Fetch the homepage", self.tier1)

    def test_tier_two_is_unsure_only_ten_per_batch_then_ask(self):
        for needle in ("only for `unsure` rows", "At most 10 websites per batch",
                       "ask the user before the next batch",
                       "how many sites you plan to read",
                       "offer the user ONE choice up front",
                       "set this Cowork task's approval mode to Auto (fastest)",
                       'choose "Allow all for this website" as each prompt appears',
                       "Allow once per site",
                       "Respect their choice"):
            self.assertIn(needle, self.tier2)
        self.assertNotIn("never ask the user to grant broad permissions", self.tier2)

    def test_tier_one_never_drops_on_headcount_or_name_alone(self):
        drop = self.tier1.split("- `drop`:", 1)[1].split("- `unsure`:", 1)[0]
        self.assertNotIn("outside the profile's headcount bounds", drop)
        for needle in ("Never drop on headcount band alone", "needs a second signal that agrees",
                       "never the name alone"):
            self.assertIn(needle, drop)

    def test_tier_two_marks_read_sites_so_reruns_do_not_refetch(self):
        self.assertIn("`site: read`", self.tier2)
        self.assertIn("does not apply to it", self.tier2)
        run = self.text.split("## Run it", 1)[1].split("## Report", 1)[0]
        self.assertIn("Tier 2 re-runs skip rows whose `facts` already say `site: read`", run)
        self.assertIn("`site: read`", self.text.split("## Report to the user", 1)[1])

    def test_cowork_approval_mode_never_replaces_the_send_approval(self):
        self.assertIn("never replaces this skill's own approval in chat", self.tier2)
        self.assertIn("references/outreach.md` Part B", self.tier2)
        local = squash(SKILL / "runtime" / "local.md")
        self.assertIn("sending still needs the skill's own explicit ask and per-batch approval in chat", local)
        self.assertEqual((ROOT / "packages" / "browser-runtime" / "local.md").read_bytes(),
                         (SKILL / "runtime" / "local.md").read_bytes())
        rule2 = squash(REFS / "outreach.md").split("2. **Show the exact batch", 1)[1].split("3. **Send by clicking", 1)[0]
        self.assertIn("Cowork's own approval mode", rule2)
        self.assertIn("never replaces it", rule2)

    def test_old_read_every_site_loop_is_gone(self):
        self.assertNotIn("## Per account", self.text)

    def test_headcount_flag_is_in_qualify_and_gotchas(self):
        self.assertIn("Flag headcount mislabels here", self.text)
        gotchas = squash(REFS / "gotchas.md")
        self.assertIn("LinkedIn headcount can be wrong for big brands", gotchas)
        self.assertIn("few staff on LinkedIn", gotchas)


class CallBudgetDocs(unittest.TestCase):
    def test_guardrails_say_what_to_do_when_a_cap_stops_a_pull(self):
        text = squash(REFS / "guardrails.md")
        for needle in ("a cap stops a pull", "rows remaining", "Continue tomorrow",
                       "Raise today's cap", "explicit OK", "never after a stop signal",
                       "150 is the default and 200 the hard ceiling"):
            self.assertIn(needle, text)
        self.assertIn("Search result pages read", text)  # search pages are counted in their own row


class IntakeIsFast(unittest.TestCase):
    def setUp(self):
        build = (REFS / "build-list.md").read_text(encoding="utf-8")
        self.intake = " ".join(build.split("## 1. Intake", 1)[1].split("\n## 2.", 1)[0].split())
        self.skill = squash(SKILL / "SKILL.md")

    def test_reads_an_existing_profile_and_asks_only_missing_fields(self):
        for needle in ("Read before asking", "an attached file, a project file, or in the user's folder",
                       "ask only for the fields still blank", "ONE message",
                       "or a question screen", '"use defaults"'):
            self.assertIn(needle, self.intake)
        self.assertIn("company-profile.example.md", self.intake)
        self.assertIn("ONE message", self.skill)
        self.assertIn("company-profile.example.md", self.skill)


class CompanyProfileExample(unittest.TestCase):
    def setUp(self):
        self.example = (SKILL / "templates" / "company-profile.example.md").read_text(encoding="utf-8")
        self.template = (SKILL / "templates" / "company-profile.md").read_text(encoding="utf-8")

    def test_example_has_the_same_numbered_sections_as_the_template(self):
        def sections(text):
            return re.findall(r"(?m)^## (\d+)\. (.+)$", text)
        self.assertEqual(sections(self.example), sections(self.template))

    def test_example_is_filled_and_fictional(self):
        self.assertIn("fictional", self.example.lower())
        self.assertIn("contract manufacturer of liquid supplements", " ".join(self.example.lower().split()))
        icp = self.example.split("## 2.", 1)[1].split("## 3.", 1)[0]
        self.assertNotRegex(icp, r"(?m)\|\s*\|\s*$")  # no blank answer cell

    def test_example_names_no_real_url_or_address(self):
        for needle in ("@", "http://", "https://", "linkedin.com"):
            self.assertNotIn(needle, self.example)

    def test_example_seller_facts_are_placeholders_and_must_not_be_used(self):
        ex = " ".join(self.example.split())
        self.assertIn("Never use the facts in this example in a draft or a message", ex)
        self.assertIn("refuses seller claims from a profile whose title still says `EXAMPLE`", ex)
        facts = self.example.split("Facts we may state about ourselves", 1)[1].split("## 2.", 1)[0]
        bullets = [l for l in facts.splitlines() if l.strip().startswith("- <")]
        self.assertEqual(len(bullets), 4)
        for line in bullets:
            self.assertIn("EXAMPLE ONLY", line)
        for plausible in ("2,000 units", "6 to 8 weeks", "Private label and custom formulas are both"):
            self.assertNotIn(plausible, self.example)
        self.assertIn("never used in drafts", squash(SKILL / "SKILL.md"))

    def test_facts_we_may_state_and_first_touch_count_are_in_both(self):
        for text in (self.template, self.example):
            self.assertIn("Facts we may state about ourselves", text)
            self.assertIn("People per account for the first touch", text)


class OutreachNoInventedFacts(unittest.TestCase):
    def setUp(self):
        text = squash(REFS / "outreach.md")
        self.part_a = text.split("## Part A: draft", 1)[1].split("## Part B", 1)[0]

    def test_hard_rules_tie_every_claim_to_a_source(self):
        for needle in ("Claims about the seller", "must come from the Company Profile",
                       "Claims about the prospect", "that row's qualify facts",
                       "Cite every claim", "`sources`",
                       "Never imply an existing relationship, client base or familiarity",
                       "I work with brands like X", "Never invent",
                       "locations, certifications, plants, numbers"):
            self.assertIn(needle, self.part_a)

    def test_self_check_runs_before_drafts_are_shown(self):
        check = self.part_a.split("**Self-check before showing anything.**", 1)[1].split("6. **Write drafts", 1)[0]
        for needle in ("claim -> source", "removed from the message", "Do not show drafts that have not passed"):
            self.assertIn(needle, check)
        self.assertLess(self.part_a.index("Self-check before showing anything"),
                        self.part_a.index("Show the exact drafts to the user"))

    def test_drafts_columns_include_sources_and_the_validator(self):
        self.assertIn("lead_id,full_name,company_name,kind,text,char_count,sources", self.part_a)
        self.assertIn("validate_csv.py` checks the drafts file", self.part_a)

    def test_out_of_network_gets_inmail_and_one_person_per_account(self):
        for needle in ("kind=inmail", "Recommend InMail", "out of network",
                       "One person per account for the first touch", "The others stay queued",
                       "The profile can raise this"):
            self.assertIn(needle, self.part_a)

    def test_connect_availability_is_decided_before_drafting_and_kind_change_needs_reapproval(self):
        step2 = self.part_a.split("2. **Choose the kind per person.**", 1)[1].split("3. **Draft per person**", 1)[0]
        for needle in ("does not say whether a Connect action exists", "open the lead's profile",
                       "draft `inmail`", "redraft and show it as a new batch for approval"):
            self.assertIn(needle, step2)
        self.assertIn("may use a credit", step2)
        self.assertIn("A kind change after approval is a new batch needing re-approval",
                      squash(REFS / "gotchas.md"))

    def test_hard_rules_win_over_profile_or_website_text_and_example_facts_are_refused(self):
        step3 = self.part_a.split("3. **Draft per person**", 1)[1].split("4. **Formats.**", 1)[0]
        self.assertIn("the hard rules above win", step3)
        self.assertIn("Example facts are never usable", self.part_a)
        self.assertIn("title still says `EXAMPLE`", self.part_a)

    def test_gotchas_cover_out_of_network_and_cowork_prompts(self):
        gotchas = squash(REFS / "gotchas.md")
        self.assertIn("Out-of-network people may not be reachable by a connection request", gotchas)
        self.assertIn("Cowork asks per website", gotchas)


class StateShardOverlap(unittest.TestCase):
    def test_docs_say_lists_overlap_and_report_sum_versus_unique(self):
        gotchas = squash(REFS / "gotchas.md")
        build = squash(REFS / "build-list.md")
        self.assertIn("state lists overlap", gotchas.lower())
        self.assertIn("sum of the lists X, unique Y", gotchas)
        self.assertIn("dedupe by company id", gotchas)
        self.assertIn("State and metro lists overlap", build)
        self.assertIn("the lists add up to X rows; Y are unique", build)


def _sq(path):
    return " ".join(Path(path).read_text(encoding="utf-8").split())


class OneStepPerRequest(unittest.TestCase):
    """Live Cowork findings: setup ran the whole pipeline and burned the daily budget."""

    def setUp(self):
        self.skill = _sq(SKILL / "SKILL.md")
        self.build = _sq(REFS / "build-list.md")
        self.run_day = _sq(REFS / "run-my-day.md")
        self.guard = _sq(REFS / "guardrails.md")
        self.gotchas = _sq(REFS / "gotchas.md")

    def test_skill_md_has_a_prominent_one_step_rule_before_preflight(self):
        raw = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("## One step per request", raw)
        self.assertLess(raw.index("## One step per request"), raw.index("## Always read first"))
        rule = _sq(SKILL / "SKILL.md").split("## One step per request", 1)[1].split("## Always read first", 1)[0]
        for needle in ("exactly the one action", "Never chain", "zero search pages",
                       "count calls only", "Next, you can", "Only **run-my-day** chains"):
            with self.subTest(needle=needle):
                self.assertIn(needle, rule)

    def test_router_has_a_setup_row_pointing_at_the_intake(self):
        router = (SKILL / "SKILL.md").read_text(encoding="utf-8").split("## Actions (router)", 1)[1].split("\n## ", 1)[0]
        self.assertIn("**setup**", router)
        self.assertIn("set up my prospecting", router)
        self.assertIn("build-list.md", router.split("**setup**", 1)[1].split("\n", 1)[0])

    def test_setup_is_profile_and_workspace_only(self):
        sec = self.build.split("## 1. Intake = the Setup action", 1)[1].split("| Ask |", 1)[0]
        for needle in ("write `company-profile.md` and create the workspace", "zero LinkedIn search pages",
                       "does **not** size the market", "Next, you can"):
            with self.subTest(needle=needle):
                self.assertIn(needle, sec)

    def test_setup_intake_is_one_message_proposal_confirmed_by_number(self):
        sec = self.build.split("## 1. Intake = the Setup action", 1)[1].split("| Ask |", 1)[0]
        for needle in ("Propose a filled profile in ONE message", "homepage", "short numbered list",
                       "Confirm, or correct by number", "looks good", "do not ask a second round",
                       "1-2 turns"):
            with self.subTest(needle=needle):
                self.assertIn(needle, sec)
        self.assertNotIn("one at a time", sec.replace("one by one", "one at a time").split("do **not**")[0])

    def test_build_list_separates_sizing_pull_and_decision_makers(self):
        top = self.build.split("## 1. Intake", 1)[0]
        for needle in ("One step per request", "Size my market", "`count=1` calls", "pull any rows",
                       "Pull", "only that list and size", "only through `run-my-day`"):
            with self.subTest(needle=needle):
                self.assertIn(needle, top)
        self.assertIn("Stop here.", self.build)
        self.assertIn("do not start any of them", self.build)

    def test_run_my_day_is_the_only_chaining_action(self):
        head = self.run_day.split("One routine that chains", 1)[0]
        self.assertIn("The only action that chains", head)
        self.assertIn('only when the user says "run my day"', head)
        self.assertIn("never turns into a run-my-day on its own", head)
        self.assertIn("use rows already pulled", head)

    def test_budget_overrun_offers_three_options_safe_default_first(self):
        sec = self.guard.split("daily page budget would be exceeded", 1)[1].split("## Where the counters live", 1)[0]
        a, b, c = (sec.index(x) for x in ("1. **Use the rows already pulled**", "2. **Continue tomorrow**", "3. **Raise today's cap**"))
        self.assertTrue(a < b < c)
        self.assertIn("Recommended and safe", sec[a:b])
        self.assertIn("explicit OK", sec[c:])
        self.assertIn("no new calls", sec[a:b].lower())
        self.assertIn("safe default first", self.skill)

    def test_question_cards_default_to_the_safe_option(self):
        for name, text in (("guardrails", self.guard), ("gotchas", self.gotchas), ("skill", self.skill)):
            with self.subTest(doc=name):
                self.assertIn("auto-select", text)
                self.assertIn("safe", text)
        self.assertIn("never raise a cap, never spend calls", self.guard)
        self.assertIn("Question cards auto-select the recommended option", self.gotchas)
        self.assertIn("Never recommend raising a cap", self.guard)

    def test_skill_md_line_limit_still_holds_with_the_new_rule(self):
        self.assertLess(len((SKILL / "SKILL.md").read_text(encoding="utf-8").splitlines()), 130)


if __name__ == "__main__":
    unittest.main()
