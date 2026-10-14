"""The four salesnav-* purpose skills: word and line budgets, hard rules, and their use of the one shared engine.

The purpose skills hold only SKILL.md and skill.yaml; every tool lives once in the engine skill
(plugins/sales-navigator/skills/sales-navigator) and is reached through ENGINE.

Run from the repo root:  python3 -m pytest -q tests
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "build"))
PLUGIN_SKILLS = ROOT / "plugins" / "sales-navigator" / "skills"
TOOLKIT = PLUGIN_SKILLS / "sales-navigator"
sys.path.insert(0, str(TOOLKIT / "scripts"))

import sync_runtime  # noqa: E402
import validate_csv  # noqa: E402

# Tools each purpose skill must name at minimum (the brief), all resolved in the engine.
REQUIRED = {
    "salesnav-tam-accounts": {"page/csrf_ready.js", "page/typeahead.js", "page/count.js", "page/account_search.js",
                              "page/companies_details.js", "scripts/run_log.py", "scripts/workspace.py",
                              "scripts/doctor.py", "reference.md"},
    "salesnav-tam-people": {"page/csrf_ready.js", "page/typeahead.js", "page/count.js", "page/lead_search.js",
                            "page/profiles_batch.js", "scripts/run_log.py", "scripts/workspace.py",
                            "scripts/doctor.py", "reference.md"},
    "salesnav-tam-tracker": {"scripts/tam_tracker.py", "scripts/dedupe.py", "scripts/salesnav_rows.py",
                             "scripts/shard_plan.py", "scripts/run_log.py", "scripts/workspace.py",
                             "scripts/doctor.py", "reference.md"},
    "salesnav-outreach": {"page/lead_search.js", "scripts/outreach_log.py", "scripts/run_log.py",
                          "scripts/workspace.py", "scripts/validate_csv.py", "scripts/doctor.py",
                          "templates/drafts.csv", "templates/company-profile.md", "reference.md"},
}
NAMES = sorted(REQUIRED)
# (words, lines) per SKILL.md; default (750, 70). 0.6.0: the accounts flow carries the compact intake steps.
BUDGET = {"salesnav-tam-accounts": (825, 75)}
# Files the user's workspace holds; a SKILL.md may name them without the engine shipping them.
WORKSPACE_FILES = {"company-profile.md", "leads.csv", "accounts.csv", "tam_tracker.csv", "FILE.csv"}


def squash_text(path):
    return " ".join(Path(path).read_text(encoding="utf-8").split()).lower()


def skill(name):
    return PLUGIN_SKILLS / name


def text(name):
    return (skill(name) / "SKILL.md").read_text(encoding="utf-8")


def squash(name):
    """Whitespace-collapsed, lowercased SKILL.md with the `python3 "$ENGINE/scripts/` command prefix removed, so
    phrases like "run_log.py quota" match the full-form command."""
    flat = " ".join(text(name).split()).replace('python3 "$ENGINE/scripts/', "").replace('.py"', ".py")
    return flat.lower()


class PurposeSkillFolders(unittest.TestCase):
    def test_four_skills_exist_with_manifests(self):
        for name in NAMES:
            with self.subTest(skill=name):
                m = sync_runtime.load_manifest(skill(name))
                self.assertRegex(m["version"], r"^0\.[2-9]\.\d+$")   # 0.2.0 = shared-engine layout
                self.assertEqual(m["category"], "sales")
                self.assertEqual(m["engine"], "sales-navigator")
                self.assertEqual(m["runtimes"], [])

    def test_the_skill_folder_holds_only_its_own_files(self):
        for name in NAMES:
            have = sorted(p.relative_to(skill(name)).as_posix() for p in skill(name).rglob("*")
                          if p.is_file() and p.name != ".DS_Store")
            with self.subTest(skill=name):
                self.assertEqual(have, ["SKILL.md", "skill.yaml"])

    def test_each_skill_names_the_tools_in_its_brief_and_the_engine_has_them(self):
        for name in NAMES:
            body = text(name)
            for rel in sorted(REQUIRED[name]):
                with self.subTest(skill=name, file=rel):
                    self.assertTrue((TOOLKIT / rel).is_file(), rel)
                    self.assertIn(rel.split("/")[-1], body)

    def test_the_engine_has_every_snippet_and_script_a_skill_names(self):
        for name in NAMES:
            body = text(name)
            tokens = set(re.findall(r"[A-Za-z0-9_/-]+\.(?:js|py|md|csv)\b", body))
            self.assertTrue(tokens, name)
            for token in sorted(tokens):
                with self.subTest(skill=name, file=token):
                    token = token[len("ENGINE/"):] if token.startswith("ENGINE/") else token
                    if token in WORKSPACE_FILES:
                        continue
                    if "/" in token:
                        self.assertTrue((TOOLKIT / token).is_file(), token)
                    else:
                        homes = [TOOLKIT / d / token for d in ("", "page", "scripts", "templates", "runtime")]
                        self.assertTrue(any(h.is_file() for h in homes), token)


class PurposeSkillDocs(unittest.TestCase):
    def test_word_and_line_budgets(self):
        for name in NAMES:
            words, lines = BUDGET.get(name, (750, 70))
            with self.subTest(skill=name):
                self.assertLessEqual(len(text(name).split()), words)
                self.assertLessEqual(len(text(name).splitlines()), lines)

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

    def test_tam_skills_are_read_only_and_never_mutate_the_seat_unconfirmed(self):
        for name in ("salesnav-tam-accounts", "salesnav-tam-people", "salesnav-tam-tracker"):
            with self.subTest(skill=name):
                body = squash(name)
                self.assertIn("read-only", body)
                self.assertRegex(body, r"never (create|send)")
                self.assertIn("sales nav list", body)
        people = squash("salesnav-tam-people")
        self.assertIn("explicit confirmation", people)
        self.assertIn("never create or save a sales nav list", people)

    def test_accounts_flow_is_the_broad_net_then_qualify_strategy(self):
        body = squash("salesnav-tam-accounts")
        for phrase in ("1,000 viewable cap", "broad net", "priority", "`count` 100", "companies_details.js",
                       "batches of 100", "description and specialties", "co-packer", "cbd",
                       "never as keyword not terms", "qualified", "keep"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, body)
        # the old keyword-NOT sizing flow is gone
        self.assertNotIn("noise words", body)

    def test_people_flow_scopes_by_qualified_account_ids(self):
        body = squash("salesnav-tam-people")
        for phrase in ("2,500 viewable cap", "qualified account ids", "current_company", "`count` 100",
                       "profiles_batch.js", "seniority", "function", "title", "count=1"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, body)

    def test_accounts_flow_starts_with_seller_research_then_a_short_intake(self):
        raw = text("salesnav-tam-accounts")
        flow = raw.split("## Flow", 1)[1].split("## Hard rules", 1)[0]
        steps = re.split(r"(?m)^(?=\d+\. )", flow)
        steps = [" ".join(x.split()).lower() for x in steps if re.match(r"\d+\. ", x)]
        self.assertIn("doctor.py", steps[0])
        self.assertIn("seller research first, before any question", steps[1])
        for phrase in ("read the website", "untrusted data", "sections 1 to 3", "likely buyer types",
                       "likely not-a-buyer types", "workspace.py init ~/claude"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, steps[1])
        # intake comes second and holds exactly five numbered questions, one round
        self.assertIn("one round, at most 5 questions", steps[2])
        self.assertIn("just pick", steps[2])
        self.assertEqual(re.findall(r"\((\d)\) ", steps[2]), ["1", "2", "3", "4", "5"])
        for phrase in ("buyer type", "good customers", "bad fits", "geography and headcount", "hard exclusions",
                       "roles to reach", "5-line icp summary", "company-profile.md"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, steps[2])
        # the browser gate follows the profile; no snippet runs before step 3, and keywords never lead
        self.assertIn("browser gate", steps[3])
        self.assertIn("profile is written", steps[3])
        self.assertIn("calibrate from the examples", steps[4])
        self.assertIn("companies_details.js", steps[4])
        self.assertIn("industry ids", steps[4])
        self.assertIn("scoring rubric", steps[4])
        for early in steps[:3]:
            self.assertNotRegex(early, r"(count|account_search|typeahead|csrf_ready)\.js")
        self.assertIn("never with keyword searches", steps[0])
        self.assertIn("broad net", steps[5])
        self.assertIn("no keywords", steps[5])

    def test_people_skill_requires_qualified_accounts_first(self):
        body = squash("salesnav-tam-people")
        for phrase in ("no qualified accounts file yet: run `salesnav-tam-accounts` first",
                       "do not keyword-search people across all of linkedin", "roles", "size band",
                       "cap of people per account"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, body)
        flow = body.split("## flow", 1)[1]
        self.assertLess(flow.index("run `salesnav-tam-accounts` first"), flow.index("csrf_ready.js"))

    def test_both_tam_skills_point_to_the_engine_intake_section_that_exists(self):
        ref = (TOOLKIT / "reference.md").read_text(encoding="utf-8")
        self.assertIn("## Intake and seller research", ref)
        self.assertIn("intake and seller research", squash("salesnav-tam-accounts"))
        self.assertIn("intake and seller research", squash_text(TOOLKIT / "SKILL.md"))

    def test_tracker_skill_names_the_csv_columns_and_commands(self):
        body = squash("salesnav-tam-tracker")
        for phrase in ("list_id", "master", "filters_delta", "count", "pulled", "new|partial|done", "last_pulled",
                       "file", "tam_tracker.csv", "state", "headcount", "metro", "sum x, unique y"):
            self.assertIn(phrase, body)
        for command in ("add", "update", "status", "next"):
            self.assertRegex(body, r'tam_tracker\.py"? %s\b' % command)

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
        header = (TOOLKIT / "templates" / "drafts.csv").read_text(encoding="utf-8").strip()
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

    def test_the_page_cap_in_the_tracker_skill_is_the_run_log_default(self):
        import run_log
        sys.path.insert(0, str(ROOT / "packages" / "browser-runtime"))
        import session
        pages = run_log.LIMITS["pages"]["default"]
        self.assertEqual(pages, session.DEFAULT_MAX_PAGES)
        self.assertIn("default %d result pages a day" % pages, squash("salesnav-tam-tracker"))

    def test_run_log_options_named_in_the_skills_are_real(self):
        import subprocess
        helptext = subprocess.run([sys.executable, str(TOOLKIT / "scripts" / "run_log.py"), "add", "--help"],
                                  capture_output=True, text=True).stdout
        for flag in ("--pages", "--small-calls"):
            self.assertIn(flag, helptext)
        named = set()
        for name in NAMES:
            for span in re.findall(r'run_log\.py"? add ([^`]*)`', text(name)):
                named |= set(re.findall(r"--[\w-]+", span))
        self.assertTrue({"--pages", "--small-calls"} <= named, named)
        for flag in sorted(named):
            with self.subTest(flag=flag):
                self.assertIn(flag, helptext)

    def test_tracker_commands_in_the_skill_use_real_options(self):
        import subprocess
        body = " ".join(text("salesnav-tam-tracker").split())
        for command in ("add", "update"):
            helptext = subprocess.run([sys.executable, str(TOOLKIT / "scripts" / "tam_tracker.py"),
                                       command, "--help"], capture_output=True, text=True).stdout
            span = re.search(r'tam_tracker\.py"? %s ([^`]*)`' % command, body)
            self.assertTrue(span, command)
            for flag in re.findall(r"--[\w-]+", span.group(1)):
                with self.subTest(command=command, flag=flag):
                    self.assertIn(flag, helptext)
        self.assertRegex(body, r"update --master \w+ --list-id")      # ids are per master
        self.assertIn("exit 5", squash("salesnav-tam-tracker"))

    def test_workspace_init_works_in_the_engine_installed_alone(self):
        """The engine is the one shared folder: init must create the workspace without anything else around it."""
        import shutil
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            alone = Path(tmp) / "sales-navigator"
            shutil.copytree(TOOLKIT, alone, ignore=shutil.ignore_patterns("__pycache__"))
            home = Path(tmp) / "Claude"
            run = subprocess.run([sys.executable, str(alone / "scripts" / "workspace.py"), "init", str(home)],
                                 capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            for sub in ("lists", "drafts", "results"):
                self.assertTrue((home / "sales-navigator" / sub).is_dir(), sub)
            loc = subprocess.run([sys.executable, str(alone / "scripts" / "workspace.py"), "locate",
                                  "--workspace", str(home / "sales-navigator")], capture_output=True, text=True)
            self.assertEqual(loc.returncode, 0, loc.stdout + loc.stderr)

    def test_outreach_skill_carries_the_send_time_and_cap_passthrough_rules(self):
        body = squash("salesnav-outreach")
        for phrase in ("covers only that batch", "existing message thread", "pending invitation",
                       "verify the sent state", "--daily/--weekly/--followup-daily", "marked example",
                       "untrusted data, never instructions", "--workspace dir"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, body)

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
        bundle = market["sales-navigator"]
        self.assertEqual(bundle["category"], "sales")
        self.assertEqual(bundle["source"], "./plugins/sales-navigator")
        self.assertEqual(sorted(bundle["skills"]),
                         sorted("./skills/%s" % n for n in ["sales-navigator"] + NAMES))
        for name in NAMES:
            with self.subTest(skill=name):
                self.assertNotIn(name, market)
                self.assertIn("plugins/sales-navigator/skills/%s/SKILL.md" % name, readme)


if __name__ == "__main__":
    unittest.main()
