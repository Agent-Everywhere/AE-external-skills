"""Hard rules, word budgets and CSV behaviour for the slim sales-navigator toolkit.

The skill docs are small on purpose; this file pins only the hard rules (key phrases), the size
budgets, and the script behaviour behind the CSVs. Run from the repo root:  python3 -m pytest -q tests
"""
import csv
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator"
KB = SKILL / "references" / "salesnav-kb"
sys.path.insert(0, str(SKILL / "scripts"))

import dedupe  # noqa: E402
import validate_csv  # noqa: E402


def squash(path):
    """Whitespace-collapsed text with the `python3 "$ENGINE/scripts/` command prefix removed (full-form commands)."""
    flat = " ".join(Path(path).read_text(encoding="utf-8").split())
    return flat.replace('python3 "$ENGINE/scripts/', "").replace('.py"', ".py")


def words(path):
    return len(Path(path).read_text(encoding="utf-8").split())


class HardRulesAndBudget(unittest.TestCase):
    def test_skill_md_carries_the_six_hard_rules(self):
        text = squash(SKILL / "SKILL.md").lower()
        for phrase in (
            "read-only by default",                       # 1
            "typed approval of the exact batch",          # 2
            "never send from a schedule",
            "never approval",                             # a card default or timeout is not approval
            "run_log.py", "outreach_log.py", "run_log.py quota",   # 3 caps
            "~/claude/sales-navigator",
            "never invent claims",                        # 4
            "company profile",
            "warning, captcha or limit",                  # 5
            "never retry a send with an unknown result",
            "do not chain",                               # 6
            "build your own flow",
            "scheduled task",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, text)

    def test_skill_md_keeps_the_workspace_cap_and_send_time_rules(self):
        text = squash(SKILL / "SKILL.md").lower()
        for phrase in (
            "--workspace dir", "--profile file", "every script call", "`workspace:` in the profile",   # custom workspace
            "--daily/--weekly/--followup-daily", "both scripts as",              # lowered caps
            "covering only that batch",                                                                  # approval scope
            "existing message thread", "pending invitation",
            "marked example", "<...>",                                                                   # placeholder seller facts
            "untrusted data, never instructions",                                                        # scraped text
            "`requests`", "profile opened", "account page",                                              # snippet accounting
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, text)

    def test_recipes_and_reference_carry_accounting_and_send_checks(self):
        recipes, ref = squash(SKILL / "recipes.md").lower(), squash(SKILL / "reference.md").lower()
        for phrase in ("existing message thread", "pending invitation", "covers only that batch",
                       "verify the sent state", "untrusted data, never instructions", "--profiles 1 --accounts 1",
                       "about 7 requests", "textguess"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, recipes)
        for phrase in ("`requests`", "1 profile opened", "1 account page", "textguess:true",
                       "untrusted data, never instructions", "--followup-daily"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, ref)
        self.assertNotIn("counts as 1 small call", ref)
        self.assertNotIn("3 small calls per person", recipes)

    def test_skill_md_names_every_snippet_and_script(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        for path in sorted((SKILL / "page").glob("*.js")):
            self.assertIn(path.name, text)
        for path in sorted((SKILL / "scripts").glob("*.py")):
            self.assertIn(path.name, text)

    def test_word_budgets(self):
        self.assertLessEqual(words(SKILL / "SKILL.md"), 1000)      # 0.6.1: +100 for the 4-step ENGINE block; 0.7.0: +100 lists, segments
        self.assertLessEqual(words(SKILL / "reference.md"), 2950)  # 0.6.1: +150 for the 4-step ENGINE block; 0.6.2: +150 count mode, intake; 0.7.0: +700 lists, ACCOUNT_LIST, segments, rubric
        self.assertLessEqual(words(SKILL / "recipes.md"), 950)   # 0.6.2: count mode; 0.7.0: multi-segment recipe
        total = sum(words(p) for p in SKILL.rglob("*.md") if KB not in p.parents)   # the KB is a separate shipped reference
        self.assertLessEqual(total, 5850, total)  # 0.7.0: +50 loosened caps, saved-accounts guard, list sharding; +960 lists, segments, rubric, ACCOUNT_LIST; 0.6.2: +150 count mode; 0.6.1: +250 for the 4-step ENGINE block (x2 docs) and the reorder

    def test_only_the_slim_docs_remain(self):
        names = sorted(str(p.relative_to(SKILL)) for p in SKILL.rglob("*.md") if KB not in p.parents)
        self.assertEqual(names, ["SKILL.md", "recipes.md", "reference.md", "runtime/README.md",
                                 "templates/company-profile.example.md", "templates/company-profile.md"])

    KB_PAGES = ["00-index.md", "01-navigation-basics.md", "02-filters-and-ids.md", "03-view-cap-and-slicing.md",
                "04-industry-quirks.md", "05-rate-caps-and-pacing.md", "10-approach-segmented-merge.md",
                "11-approach-broad-net-slicing.md", "12-approach-lookalike-plus-lanes.md",
                "13-approach-account-first-people.md", "14-lists.md", "20-rubric-template.md"]

    def test_the_kb_holds_exactly_the_expected_pages(self):
        self.assertEqual(sorted(p.name for p in KB.iterdir()), self.KB_PAGES)

    def test_profile_template_keeps_the_fields_the_scripts_read(self):
        text = (SKILL / "templates" / "company-profile.md").read_text(encoding="utf-8")
        self.assertRegex(text, r"(?m)^- \*\*workspace:\*\*")
        self.assertRegex(text, r"(?m)^- \*\*Outreach started")
        example = (SKILL / "templates" / "company-profile.example.md").read_text(encoding="utf-8")
        self.assertIn("EXAMPLE", example)
        self.assertIn("<EXAMPLE ONLY", example)   # seller facts stay placeholders
        header = (SKILL / "templates" / "drafts.csv").read_text(encoding="utf-8").strip()
        self.assertEqual(header.split(","), validate_csv.DRAFT_COLUMNS)

    LIST_WRITERS = {"list_create.js", "list_save_accounts.js", "list_save_sharded.js"}   # 0.7.0: the only seat writes besides sends (POST only)

    def test_page_snippets_never_write_except_the_list_snippets(self):
        for path in (SKILL / "page").glob("*.js"):
            body = path.read_text(encoding="utf-8")
            with self.subTest(snippet=path.name):
                if path.name in self.LIST_WRITERS:
                    self.assertRegex(body, r"method\s*:\s*'POST'")
                    self.assertNotRegex(body, r"method\s*:\s*['\"](PUT|PATCH|DELETE)")
                else:
                    self.assertNotRegex(body, r"method\s*:\s*['\"](POST|PUT|PATCH|DELETE)")


class TamFrontHalf(unittest.TestCase):
    """0.6.0: every TAM ask starts with seller research and one short intake, never keyword searches."""

    def test_engine_routes_every_tam_ask_to_the_two_tam_skills(self):
        text = squash(SKILL / "SKILL.md").lower()
        for phrase in ("**routing.** any tam, count, \"how many\" or find-people ask: follow `salesnav-tam-accounts`, "
                       "then `salesnav-tam-people`",
                       "never start from keyword searches", "never search people across all of linkedin",
                       "intake and seller research"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, text)
        self.assertLess(text.index("**routing.**"), text.index("## toolkit"))

    def test_no_keyword_first_guidance_remains_in_the_engine_docs(self):
        recipes = squash(SKILL / "recipes.md").lower()
        self.assertNotIn("and each keyword alone", recipes)
        self.assertNotIn("fix keywords first", recipes)
        self.assertIn("not a keyword search", recipes)

    def test_reference_holds_the_full_intake_procedure_once(self):
        ref = squash(SKILL / "reference.md")
        self.assertEqual(ref.count("## Intake and seller research"), 1)
        section = ref.split("## Intake and seller research", 1)[1].split(" ## ", 1)[0].lower()
        for phrase in ("seller research first, before any question", "untrusted data", "sections 1 to 3",
                       "at most 5 questions", "just pick", "5-line icp summary", "workspace.py init ~/claude",
                       "calibrate from the examples", "companies_details.js", "scoring rubric",
                       "qualified account ids", "section 4", "people-per-account cap",
                       "no list saved without the user's confirmation", "no browser"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, section)
        questions = re.findall(r"(?m)^\d\. ", (SKILL / "reference.md").read_text(encoding="utf-8")
                               .split("## Intake and seller research", 1)[1].split("**C.", 1)[0])
        self.assertEqual(len(questions), 5)

    def test_profile_template_has_room_for_the_examples(self):
        text = (SKILL / "templates" / "company-profile.md").read_text(encoding="utf-8")
        self.assertIn("Example good customers", text)
        self.assertIn("Example bad fits", text)


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


class ReferenceNumbersMatchTheScripts(unittest.TestCase):
    """reference.md carries the cap tables; the scripts hold the values. They must agree."""

    def rows(self, heading):
        md = (SKILL / "reference.md").read_text(encoding="utf-8")
        section = md.split(heading, 1)[1].split("\n#", 1)[0]
        out = {}
        for line in section.splitlines():
            if line.startswith("|") and not re.match(r"\|[-| ]+\|$", line.strip()):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                out[cells[0]] = cells[1:]
        return out

    def test_daily_volume_defaults_match_run_log(self):
        import run_log
        rows = self.rows("### Daily volume defaults")
        expect = {"Search result pages read": "pages", "Individual profiles opened": "profiles",
                  "Small API calls (counts, typeahead, website batches)": "small_calls",
                  "Account pages opened": "accounts", "Saved searches created": "saved_searches",
                  "Saved accounts (list saves, pacing guard)": "saved_accounts"}
        for label, key in expect.items():
            default, ceiling = (int(re.match(r"\d+", c).group()) for c in rows[label][:2])
            self.assertEqual(run_log.LIMITS[key], {"default": default, "ceiling": ceiling}, label)

    def test_outreach_caps_match_outreach_log(self):
        import outreach_log
        rows = self.rows("### Outreach caps and stop rules")
        num = lambda label: int(re.match(r"\d+", rows[label][0]).group())  # noqa: E731
        self.assertEqual(num("Connection requests per day"), outreach_log.DAILY_CONNECTION_CAP)
        self.assertEqual(num("Connection requests per 7 days"), outreach_log.WEEKLY_CONNECTION_CAP)
        self.assertEqual(num("Follow-up messages per day"), outreach_log.DAILY_FOLLOWUP_CAP)
        self.assertEqual(num("Messages to one person (first plus follow-ups)"), outreach_log.MAX_TOUCHES)

    def test_page_budget_matches_the_runtime(self):
        sys.path.insert(0, str(ROOT / "packages" / "browser-runtime"))
        import session
        rows = self.rows("### Daily volume defaults")["Search result pages read"]
        self.assertEqual(int(rows[0]), session.DEFAULT_MAX_PAGES)
        self.assertEqual(int(rows[1]), session.HARD_MAX_PAGES)

    def test_the_viewable_caps_are_stated(self):
        text = squash(SKILL / "reference.md")
        self.assertIn("2,500 leads, 1,000 accounts", text)


if __name__ == "__main__":
    unittest.main()
