"""The four salesnav-* purpose skills: word budget, hard rules, self-contained bundles, drift against the toolkit.

Run from the repo root:  python3 -m pytest -q tests
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "build"))
sys.path.insert(0, str(ROOT / "skills" / "sales-navigator" / "scripts"))

import sync_runtime  # noqa: E402
import validate_csv  # noqa: E402

TOOLKIT = ROOT / "skills" / "sales-navigator"
# What each purpose skill must bundle at minimum (the brief); sibling scripts a listed script imports are added too.
REQUIRED = {
    "salesnav-tam-accounts": {"page/csrf_ready.js", "page/typeahead.js", "page/count.js", "page/account_search.js",
                              "scripts/run_log.py", "scripts/workspace.py", "reference.md"},
    "salesnav-tam-people": {"page/csrf_ready.js", "page/typeahead.js", "page/count.js", "page/lead_search.js",
                            "scripts/run_log.py", "scripts/workspace.py", "reference.md"},
    "salesnav-tam-tracker": {"scripts/tam_tracker.py", "scripts/dedupe.py", "scripts/salesnav_rows.py",
                             "scripts/shard_plan.py", "scripts/run_log.py", "scripts/workspace.py", "reference.md"},
    "salesnav-outreach": {"page/lead_search.js", "scripts/outreach_log.py", "scripts/run_log.py",
                          "scripts/workspace.py", "scripts/validate_csv.py", "templates/drafts.csv",
                          "templates/company-profile.md", "reference.md"},
}
NAMES = sorted(REQUIRED)
# Files the user's workspace holds; a SKILL.md may name them without the skill shipping them.
WORKSPACE_FILES = {"company-profile.md", "leads.csv", "tam_tracker.csv", "FILE.csv"}


def skill(name):
    return ROOT / "skills" / name


def text(name):
    return (skill(name) / "SKILL.md").read_text(encoding="utf-8")


def squash(name):
    return " ".join(text(name).split()).lower()


def local_imports(path):
    """Names of sibling scripts a script imports (import X / from X import ...), if they exist in the toolkit."""
    found = set()
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*(?:import|from)\s+([A-Za-z_]\w*)", line)
        if m and (TOOLKIT / "scripts" / (m.group(1) + ".py")).is_file():
            found.add("scripts/%s.py" % m.group(1))
    return found


class PurposeSkillBundles(unittest.TestCase):
    def test_four_skills_exist_with_manifests(self):
        for name in NAMES:
            with self.subTest(skill=name):
                m = sync_runtime.load_manifest(skill(name))
                self.assertEqual(m["version"], "0.1.0")
                self.assertEqual(m["category"], "sales")
                self.assertEqual(m["runtimes"], ["local", "agent-browser"])
                self.assertTrue(m["uses_toolkit"])
                self.assertTrue((skill(name) / "runtime" / "session.py").is_file())

    def test_each_skill_lists_the_tools_in_its_brief(self):
        for name in NAMES:
            with self.subTest(skill=name):
                listed = set(sync_runtime.load_manifest(skill(name))["uses_toolkit"])
                self.assertLessEqual(REQUIRED[name], listed)

    def test_listed_scripts_bring_the_scripts_they_import(self):
        for name in NAMES:
            listed = set(sync_runtime.load_manifest(skill(name))["uses_toolkit"])
            for rel in sorted(r for r in listed if r.startswith("scripts/")):
                with self.subTest(skill=name, script=rel):
                    self.assertLessEqual(local_imports(TOOLKIT / rel), listed)

    def test_bundled_files_are_byte_identical_to_the_toolkit(self):
        for name in NAMES:
            for rel in sync_runtime.load_manifest(skill(name))["uses_toolkit"]:
                with self.subTest(skill=name, file=rel):
                    self.assertEqual((skill(name) / rel).read_bytes(), (TOOLKIT / rel).read_bytes())

    def test_the_skill_folder_holds_only_what_it_lists(self):
        for name in NAMES:
            listed = set(sync_runtime.load_manifest(skill(name))["uses_toolkit"])
            have = {p.relative_to(skill(name)).as_posix() for p in skill(name).rglob("*")
                    if p.is_file() and "__pycache__" not in p.parts}
            with self.subTest(skill=name):
                self.assertEqual(have - listed, {"SKILL.md", "skill.yaml", "runtime/README.md", "runtime/session.py"})

    def test_sync_check_covers_the_bundles(self):
        for name in NAMES:
            self.assertEqual(sync_runtime.toolkit_drift(ROOT, skill(name)), [], name)
        self.assertEqual([p.name for p in sync_runtime.skills_with_toolkit(ROOT)], NAMES)


class PurposeSkillDocs(unittest.TestCase):
    def test_word_budget(self):
        for name in NAMES:
            with self.subTest(skill=name):
                self.assertLessEqual(len(text(name).split()), 600)

    def test_skill_md_references_only_files_the_folder_contains(self):
        for name in NAMES:
            body = text(name)
            tokens = set(re.findall(r"[A-Za-z0-9_/-]+\.(?:js|py|md|csv)\b", body))
            self.assertTrue(tokens, name)
            for token in sorted(tokens):
                with self.subTest(skill=name, file=token):
                    if token in WORKSPACE_FILES:
                        continue
                    if "/" in token:
                        self.assertTrue((skill(name) / token).is_file(), token)
                    else:
                        homes = [skill(name) / d / token for d in ("", "page", "scripts", "templates", "runtime")]
                        self.assertTrue(any(h.is_file() for h in homes), token)

    def test_skill_md_names_every_bundled_snippet_and_script(self):
        for name in NAMES:
            body = text(name)
            for folder in ("page", "scripts"):
                for path in sorted((skill(name) / folder).iterdir()):
                    with self.subTest(skill=name, file=path.name):
                        self.assertIn(path.name, body)

    def test_frontmatter_has_a_description_and_triggers(self):
        for name in NAMES:
            with self.subTest(skill=name):
                head = text(name).split("---")[1]
                self.assertRegex(head, r"(?m)^name: %s$" % re.escape(name))
                self.assertIn("Use for", head)
                self.assertIn("description:", head)

    def test_every_skill_keeps_the_read_only_and_cap_rules(self):
        for name in NAMES:
            body = squash(name)
            with self.subTest(skill=name):
                for phrase in ("hard rules", "never raise a cap", "run_log.py quota", "captcha", "never invent",
                               "reference.md", "runtime/session.py"):
                    self.assertIn(phrase, body)

    def test_tam_skills_pace_and_stop_on_errors(self):
        for name in ("salesnav-tam-accounts", "salesnav-tam-people", "salesnav-tam-tracker"):
            with self.subTest(skill=name):
                for phrase in ("respect caps", "3 to 5 seconds", "403/429", "limit banner"):
                    self.assertIn(phrase, squash(name))

    def test_tam_skills_are_read_only_and_never_send(self):
        for name in ("salesnav-tam-accounts", "salesnav-tam-people", "salesnav-tam-tracker"):
            with self.subTest(skill=name):
                self.assertIn("read-only by default", squash(name))
                self.assertIn("never send from here", squash(name))

    def test_account_and_people_skills_state_their_viewable_caps(self):
        self.assertIn("1,000 viewable cap", squash("salesnav-tam-accounts"))
        self.assertIn("2,500 viewable cap", squash("salesnav-tam-people"))
        self.assertIn("noise", squash("salesnav-tam-accounts"))
        self.assertIn("count=1", squash("salesnav-tam-accounts"))
        for word in ("seniority", "function", "headcount", "title"):
            self.assertIn(word, squash("salesnav-tam-people"))

    def test_tracker_skill_names_the_csv_columns_and_commands(self):
        body = squash("salesnav-tam-tracker")
        for phrase in ("list_id", "master", "filters_delta", "count", "pulled", "new|partial|done", "last_pulled",
                       "file", "tam_tracker.csv", "state", "headcount", "metro", "sum x, unique y"):
            self.assertIn(phrase, body)
        for command in ("add", "update", "status", "next"):
            self.assertIn("tam_tracker.py %s" % command, body)

    def test_outreach_skill_carries_the_hard_rules(self):
        body = squash("salesnav-outreach")
        for phrase in (
            "typed approval of the exact batch",
            "never send from a schedule",
            "never approval",                       # a card default, timeout or silence is not approval
            "sources",
            "outreach_log.py check", "outreach_log.py caps", "add --pending", "status --status sent",
            "run_log.py quota",
            "20 connection requests a day", "100 per 7 days",
            "never raise a cap",
            "never invent claims", "company profile",
            "warning, captcha or limit",
            "never retry a send with an unknown result",
            "exit 4", "300 characters",
            "drafts by default",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, body)

    def test_outreach_template_header_matches_the_validator(self):
        header = (skill("salesnav-outreach") / "templates" / "drafts.csv").read_text(encoding="utf-8").strip()
        self.assertEqual(header.split(","), validate_csv.DRAFT_COLUMNS)
        for column in validate_csv.DRAFT_COLUMNS:
            self.assertIn(column, text("salesnav-outreach"))

    def test_outreach_caps_in_the_skill_match_the_ledger_script(self):
        import outreach_log
        body = squash("salesnav-outreach")
        self.assertIn("%d connection requests a day" % outreach_log.DAILY_CONNECTION_CAP, body)
        self.assertIn("%d per 7 days" % outreach_log.WEEKLY_CONNECTION_CAP, body)
        self.assertIn("%d follow-ups a day" % outreach_log.DAILY_FOLLOWUP_CAP, body)
        self.assertIn("%d messages to one person" % outreach_log.MAX_TOUCHES, body)

    def test_sales_navigator_points_to_the_purpose_skills(self):
        body = (TOOLKIT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("## Purpose skills", body)
        for name in NAMES:
            self.assertIn(name, body)
        self.assertIn("tam_tracker.py", body)

    def test_marketplace_and_readme_list_the_new_skills(self):
        market = {p["name"]: p for p in json.loads((ROOT / ".claude-plugin" / "marketplace.json")
                                                   .read_text(encoding="utf-8"))["plugins"]}
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for name in NAMES:
            with self.subTest(skill=name):
                self.assertEqual(market[name]["category"], "sales")
                self.assertEqual(market[name]["skills"], ["."])
                self.assertIn("skills/%s/SKILL.md" % name, readme)
                self.assertIn("/plugin install %s@ae-external-skills" % name, readme)
                self.assertIn("local", market[name]["description"].lower())


if __name__ == "__main__":
    unittest.main()
