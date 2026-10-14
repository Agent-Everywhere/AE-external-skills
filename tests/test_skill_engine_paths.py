"""Every doc in the sales-navigator plugin reaches the shared engine through ENGINE, never a bare path.

A bare `scripts/x.py` or `page/x.js` resolves against the user's project folder, not the skill folder, which
is how a Cowork run once reported "scripts not on this machine" and fell back to clicking the Sales Nav UI.

Run from the repo root:  python3 -m pytest -q tests
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "sales-navigator"
PLUGIN_SKILLS = PLUGIN / "skills"
ENGINE_DIR = PLUGIN_SKILLS / "sales-navigator"
SKILLS = ("sales-navigator", "salesnav-tam-accounts", "salesnav-tam-people", "salesnav-tam-tracker",
          "salesnav-outreach")
PURPOSE = SKILLS[1:]

# a folder reference that is not prefixed by $ENGINE/ or ${ENGINE}/ (and not the tail of a longer word)
BARE = re.compile(r"(?<!ENGINE/)(?<!ENGINE\}/)(?<![\w.$-])(?:scripts|page|runtime|templates)/[\w.<>*-]+")
# python3 followed by anything except a quoted $ENGINE path
BARE_PYTHON = re.compile(r'python3\s+(?!"\$\{?ENGINE\}?/)\S+')

RESOLVE = ('ENGINE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/sales-navigator}"; '
           '[ -f "$ENGINE/scripts/doctor.py" ] || ENGINE="%s"')
PURPOSE_BLOCK = RESOLVE % "<absolute folder of this SKILL.md>/../sales-navigator"
ENGINE_BLOCK = RESOLVE % "<absolute folder of this SKILL.md>"
NO_SNIPPET = ("If you cannot run a page snippet (no browser JS tool, no Agent Browser, no CDP), stop and tell "
              "the user; never click through the UI.")


def body(name):
    return (PLUGIN_SKILLS / name / "SKILL.md").read_text(encoding="utf-8")


def flat(name):
    return " ".join(body(name).replace("**", "").split())


def bare_paths(text):
    return BARE.findall(text)


def sh_blocks(text):
    return re.findall(r"```sh\n(.*?)\n```", text, re.S)


def doc_files():
    """Every markdown doc the plugin ships (SKILL.md files, the engine's reference, recipes, runtime and templates)."""
    return sorted(p for p in PLUGIN.rglob("*.md") if "__pycache__" not in p.parts)


class DetectorSelfTest(unittest.TestCase):
    def test_flags_bare_paths_and_accepts_engine_prefixed_ones(self):
        bad = ["python3 scripts/workspace.py locate", "`page/count.js`", "run runtime/session.py --emit x",
               "cat templates/drafts.csv", "python3 ./scripts/run_log.py", "(`page/*.js`: one snippet)"]
        for text in bad:
            with self.subTest(text=text):
                self.assertTrue(bare_paths(text) or BARE_PYTHON.search(text), text)
        good = ['python3 "$ENGINE/scripts/workspace.py" locate', '"$ENGINE/page/count.js"',
                '${ENGINE}/runtime/session.py', 'python3 "${ENGINE}/scripts/run_log.py" quota',
                "results/<list_id>/ and drafts/<date>.csv", "`$ENGINE/page/*.js`"]
        for text in good:
            with self.subTest(text=text):
                self.assertEqual(bare_paths(text), [], text)
                self.assertIsNone(BARE_PYTHON.search(text), text)


class NoBareCommandPaths(unittest.TestCase):
    def test_no_bare_folder_paths_in_any_shipped_doc(self):
        docs = doc_files()
        names = {p.name for p in docs}
        self.assertTrue({"SKILL.md", "reference.md", "recipes.md", "README.md", "company-profile.md"} <= names)
        for path in docs:
            with self.subTest(doc=path.relative_to(PLUGIN).as_posix()):
                self.assertEqual(bare_paths(path.read_text(encoding="utf-8")), [])

    def test_every_python_command_runs_a_script_through_engine(self):
        for name in SKILLS:
            with self.subTest(skill=name):
                self.assertEqual(BARE_PYTHON.findall(flat(name)), [])

    def test_the_bare_script_name_shorthand_is_gone(self):
        for name in SKILLS:
            with self.subTest(skill=name):
                self.assertNotIn("a bare script name", flat(name))
                self.assertNotIn("means `python3", flat(name))


class EngineBlock(unittest.TestCase):
    """The ENGINE resolution is a literal shell block in every SKILL.md, and it works."""

    def test_every_skill_carries_the_literal_block(self):
        for name in SKILLS:
            with self.subTest(skill=name):
                blocks = sh_blocks(body(name))
                self.assertEqual(blocks, [ENGINE_BLOCK if name == "sales-navigator" else PURPOSE_BLOCK])

    def test_every_skill_says_to_quote_paths_and_to_stop_when_unresolved(self):
        for name in SKILLS:
            text = flat(name)
            with self.subTest(skill=name):
                self.assertIn("quote every path", text)
                self.assertIn("spaces", text)
                self.assertIn("If neither resolves, stop and tell the user", text)
                self.assertIn("`ENGINE` is `${CLAUDE_PLUGIN_ROOT}/skills/sales-navigator` when that variable is set", text)

    def _run_block(self, name, installed, plugin_root=None):
        block = sh_blocks(body(name))[0]
        skill_dir = installed / "skills" / name
        block = block.replace("<absolute folder of this SKILL.md>", str(skill_dir))
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PLUGIN_ROOT"}
        if plugin_root:
            env["CLAUDE_PLUGIN_ROOT"] = str(plugin_root)
        script = block + '\npython3 "$ENGINE/scripts/doctor.py" --workspace "$PWD" >/dev/null && printf %s "$ENGINE"'
        return subprocess.run(["sh", "-c", script], capture_output=True, text=True, env=env,
                              cwd=str(installed.parent))

    def test_the_block_resolves_with_and_without_the_plugin_variable_even_with_spaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            installed = Path(tmp) / "my plugins" / "sales navigator"
            shutil.copytree(PLUGIN, installed, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for name in SKILLS:
                for use_var in (True, False):
                    with self.subTest(skill=name, plugin_variable=use_var):
                        r = self._run_block(name, installed, installed if use_var else None)
                        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                        resolved = Path(r.stdout).resolve()
                        self.assertEqual(resolved, (installed / "skills" / "sales-navigator").resolve())

    def test_the_block_leaves_engine_unusable_when_neither_path_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            installed = Path(tmp) / "plugin"
            (installed / "skills" / "salesnav-outreach").mkdir(parents=True)
            r = self._run_block("salesnav-outreach", installed)
            self.assertNotEqual(r.returncode, 0)   # doctor can't run: the flow stops there


class FailClosedFlow(unittest.TestCase):
    def test_step_zero_runs_doctor_and_fails_closed(self):
        for name in SKILLS:
            text = flat(name)
            with self.subTest(skill=name):
                self.assertIn('Run `python3 "$ENGINE/scripts/doctor.py"`', text)
                self.assertIn("If doctor fails or the engine can't be found, stop and tell the user", text)
                self.assertIn("Never fall back to driving the Sales Navigator UI by hand "
                              "(clicking filters, scrolling results, saving lists)", text)

    def test_doctor_is_the_first_command_of_each_flow(self):
        for name in PURPOSE:
            flow = body(name).split("## Flow", 1)[1]
            with self.subTest(skill=name):
                self.assertTrue(re.match(r"\s*0\. Run `python3 \"\$ENGINE/scripts/doctor\.py\"`", flow), flow[:120])
                first_python = re.search(r"python3\s+\"\$ENGINE/scripts/(\w+)\.py\"", flow).group(1)
                self.assertEqual(first_python, "doctor")

    def test_the_engine_skill_has_the_step_zero_before_its_toolkit(self):
        text = body("sales-navigator")
        self.assertLess(text.index("doctor.py"), text.index("## Toolkit"))

    def test_purpose_flows_stop_when_no_page_snippet_can_run(self):
        for name in PURPOSE:
            with self.subTest(skill=name):
                self.assertIn(NO_SNIPPET, flat(name))

    def test_account_and_people_flows_stop_at_the_daily_page_cap(self):
        sentence = ('Stop when `python3 "$ENGINE/scripts/run_log.py" quota` shows the daily page cap; '
                    'resume next day via `salesnav-tam-tracker`.')
        for name in ("salesnav-tam-accounts", "salesnav-tam-people"):
            with self.subTest(skill=name):
                self.assertIn(sentence, flat(name))

    def test_skills_stay_short(self):
        for name in PURPOSE:
            with self.subTest(skill=name):
                self.assertLessEqual(len(body(name).splitlines()), 70)
        self.assertLessEqual(len(body("sales-navigator").splitlines()), 90)


if __name__ == "__main__":
    unittest.main()
