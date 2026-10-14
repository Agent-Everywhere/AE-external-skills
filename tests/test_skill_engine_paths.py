"""Every SKILL.md in the sales-navigator plugin reaches the shared engine through ENGINE, never a bare path.

A bare `scripts/x.py` or `page/x.js` resolves against the user's project folder, not the skill folder, which
is how a Cowork run once reported "scripts not on this machine" and fell back to clicking the Sales Nav UI.

Run from the repo root:  python3 -m pytest -q tests
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_SKILLS = ROOT / "plugins" / "sales-navigator" / "skills"
SKILLS = ("sales-navigator", "salesnav-tam-accounts", "salesnav-tam-people", "salesnav-tam-tracker",
          "salesnav-outreach")

# a folder reference that is not prefixed by $ENGINE/ or ${ENGINE}/ (and not the tail of a longer word)
BARE = re.compile(r"(?<!ENGINE/)(?<!ENGINE\}/)(?<![\w.$-])(?:scripts|page|runtime|templates)/[\w.<>*-]+")
# python3 followed by anything except a quoted $ENGINE path
BARE_PYTHON = re.compile(r'python3\s+(?!"\$\{?ENGINE\}?/)\S+')


def body(name):
    return (PLUGIN_SKILLS / name / "SKILL.md").read_text(encoding="utf-8")


def flat(name):
    return " ".join(body(name).replace("**", "").split())


def bare_paths(text):
    return BARE.findall(text)


class DetectorSelfTest(unittest.TestCase):
    def test_flags_bare_paths_and_accepts_engine_prefixed_ones(self):
        bad = ["python3 scripts/workspace.py locate", "`page/count.js`", "run runtime/session.py --emit x",
               "cat templates/drafts.csv", "python3 ./scripts/run_log.py"]
        for text in bad:
            with self.subTest(text=text):
                self.assertTrue(bare_paths(text) or BARE_PYTHON.search(text), text)
        good = ['python3 "$ENGINE/scripts/workspace.py" locate', '"$ENGINE/page/count.js"',
                '${ENGINE}/runtime/session.py', 'python3 "${ENGINE}/scripts/run_log.py" quota',
                "results/<list_id>/ and drafts/<date>.csv"]
        for text in good:
            with self.subTest(text=text):
                self.assertEqual(bare_paths(text), [], text)
                self.assertIsNone(BARE_PYTHON.search(text), text)


class NoBareCommandPaths(unittest.TestCase):
    def test_no_bare_scripts_page_runtime_or_templates_paths(self):
        for name in SKILLS:
            with self.subTest(skill=name):
                self.assertEqual(bare_paths(body(name)), [])

    def test_every_python_command_runs_a_script_through_engine(self):
        for name in SKILLS:
            with self.subTest(skill=name):
                self.assertEqual(BARE_PYTHON.findall(flat(name)), [])


class EnginePathAndDoctorStep(unittest.TestCase):
    def test_each_skill_states_how_engine_is_resolved(self):
        for name in SKILLS:
            text = flat(name)
            with self.subTest(skill=name):
                self.assertIn("Engine path", text)
                self.assertIn("`ENGINE` is `${CLAUDE_PLUGIN_ROOT}/skills/sales-navigator` when `CLAUDE_PLUGIN_ROOT` is set",
                              text)
                if name == "sales-navigator":
                    self.assertIn("else this SKILL.md's own folder", text)
                else:
                    self.assertIn("else the `sales-navigator` folder next to this skill's folder", text)

    def test_step_zero_runs_doctor_and_fails_closed(self):
        for name in SKILLS:
            text = flat(name)
            with self.subTest(skill=name):
                self.assertIn('Run `python3 "$ENGINE/scripts/doctor.py"`', text)
                self.assertIn("If doctor fails or the engine can't be found, stop and tell the user", text)
                self.assertIn("Never fall back to driving the Sales Navigator UI by hand "
                              "(clicking filters, scrolling results, saving lists)", text)

    def test_doctor_is_the_first_command_of_each_flow(self):
        for name in SKILLS[1:]:
            text = body(name)
            flow = text.split("## Flow", 1)[1]
            with self.subTest(skill=name):
                self.assertTrue(re.match(r"\s*0\. Run `python3 \"\$ENGINE/scripts/doctor\.py\"`", flow), flow[:120])
                first_python = re.search(r"python3\s+\"\$ENGINE/scripts/(\w+)\.py\"", flow).group(1)
                self.assertEqual(first_python, "doctor")

    def test_the_engine_skill_has_the_step_zero_before_its_toolkit(self):
        text = body("sales-navigator")
        self.assertLess(text.index("doctor.py"), text.index("## Toolkit"))

    def test_purpose_skills_stay_short(self):
        for name in SKILLS[1:]:
            with self.subTest(skill=name):
                self.assertLessEqual(len(body(name).splitlines()), 70)
        self.assertLessEqual(len(body("sales-navigator").splitlines()), 85)


if __name__ == "__main__":
    unittest.main()
