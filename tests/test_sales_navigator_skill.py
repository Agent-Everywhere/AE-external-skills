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
                        "Exclusions", "Sub-list plan", "Tone and voice", "Caps and permissions"):
            with self.subTest(heading=heading):
                self.assertRegex(text, r"(?im)^## \d+\. .*%s" % re.escape(heading))

    def test_actions_mention_the_profile(self):
        for name in ("SKILL.md",):
            self.assertIn("templates/company-profile.md", (SKILL / name).read_text(encoding="utf-8"))
        self.assertIn("Company Profile", (REFS / "qualify.md").read_text(encoding="utf-8"))


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
