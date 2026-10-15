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
BARE = re.compile(r"(?<!ENGINE/)(?<!ENGINE\}/)(?<!ENGINE%/)(?<!sales-navigator/)(?<![\w.$-])(?:scripts|page|runtime|templates)/[\w.<>*-]+")
# python3 followed by anything except a quoted $ENGINE path
BARE_PYTHON = re.compile(r'python3\s+(?!"\$\{?ENGINE\}?/)\S+')

COWORK = "/mnt/skills/plugin-files/sales-navigator/skills/sales-navigator"   # where Cowork mounts the plugin files
# 0.6.1: four steps, each only if the previous left no scripts/doctor.py. CLAUDE_PLUGIN_ROOT is empty in Cowork.
RESOLVE = ('ENGINE="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/sales-navigator}"\n'
           '[ -f "$ENGINE/scripts/doctor.py" ] || ENGINE="' + COWORK + '"\n'
           '[ -f "$ENGINE/scripts/doctor.py" ] || ENGINE="%s"\n'
           '[ -f "$ENGINE/scripts/doctor.py" ] || { ENGINE="$(find -L /mnt/skills "$HOME/.claude/plugins" -maxdepth 8 '
           "-path '*sales-navigator/scripts/doctor.py' 2>/dev/null | head -1)\"; ENGINE=\"${ENGINE%%/scripts/doctor.py}\"; }")
PURPOSE_BLOCK = RESOLVE % "<absolute folder of this SKILL.md>/../sales-navigator"
ENGINE_BLOCK = RESOLVE % "<absolute folder of this SKILL.md>"
NO_SUBSTITUTE = ("Never substitute another data source (other MCP datasets, web estimates) for the Sales Nav "
                 "count without asking the user.")
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
    """The ENGINE resolution is a literal shell block in every SKILL.md, and it works under plain sh."""

    def test_every_skill_carries_the_literal_block(self):
        for name in SKILLS:
            with self.subTest(skill=name):
                blocks = sh_blocks(body(name))
                self.assertEqual(blocks, [ENGINE_BLOCK if name == "sales-navigator" else PURPOSE_BLOCK])

    def test_reference_carries_the_purpose_block(self):
        self.assertEqual(sh_blocks((ENGINE_DIR / "reference.md").read_text(encoding="utf-8")), [PURPOSE_BLOCK])

    def test_every_skill_says_to_quote_paths_and_to_stop_when_unresolved(self):
        for name in SKILLS:
            text = flat(name)
            with self.subTest(skill=name):
                self.assertIn("quote every path", text)
                self.assertIn("spaces", text)
                self.assertIn("If none resolves, stop and tell the user", text)
                self.assertIn("`ENGINE` is `${CLAUDE_PLUGIN_ROOT}/skills/sales-navigator` when that variable is set "
                              "(Cowork leaves it empty), else the Cowork copy "
                              "`/mnt/skills/plugin-files/sales-navigator/skills/sales-navigator`", text)
                self.assertIn("never guess it", text)

    # Behaviour. The Cowork mount and the search root are injected by substituting the literal /mnt/skills.

    def _engine_copy(self, dest):
        shutil.copytree(PLUGIN, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    def _run_block(self, name, skill_dir, mnt, home, plugin_root=None):
        """Run the block under sh; returns (resolved ENGINE or None when empty/unusable, doctor exit code)."""
        block = sh_blocks(body(name))[0]
        block = block.replace("<absolute folder of this SKILL.md>", str(skill_dir)).replace("/mnt/skills", str(mnt))
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_PLUGIN_ROOT", "HOME")}
        env["HOME"] = str(home)
        if plugin_root is not None:
            env["CLAUDE_PLUGIN_ROOT"] = str(plugin_root)   # "" models Cowork
        script = block + ('\nprintf "ENGINE=%s\\n" "$ENGINE"'
                          '\npython3 "$ENGINE/scripts/doctor.py" --workspace "$PWD" >/dev/null 2>&1; echo "RC=$?"')
        r = subprocess.run(["sh", "-c", script], capture_output=True, text=True, env=env, cwd=str(home))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        engine = re.search(r"(?m)^ENGINE=(.*)$", r.stdout).group(1)
        rc = int(re.search(r"(?m)^RC=(\d+)$", r.stdout).group(1))
        return (Path(engine).resolve() if engine else None), rc

    def test_the_plugin_variable_wins_even_with_spaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            installed = tmp / "my plugins" / "sales navigator"
            self._engine_copy(installed)
            self._engine_copy(tmp / "mnt" / "plugin-files" / "sales-navigator")
            for name in SKILLS:
                with self.subTest(skill=name):
                    engine, rc = self._run_block(name, installed / "skills" / name, tmp / "mnt", tmp, installed)
                    self.assertEqual((engine, rc), ((installed / "skills" / "sales-navigator").resolve(), 0))

    def test_sibling_folder_resolves_when_the_variable_is_unset_or_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            installed = tmp / "my plugins" / "sales navigator"
            self._engine_copy(installed)
            for name in SKILLS:
                for root in (None, ""):
                    with self.subTest(skill=name, plugin_root=root):
                        engine, rc = self._run_block(name, installed / "skills" / name, tmp / "nomnt", tmp, root)
                        self.assertEqual((engine, rc), ((installed / "skills" / "sales-navigator").resolve(), 0))

    def test_cowork_mount_resolves_with_an_empty_variable_and_a_wrong_skill_folder(self):
        """The live failure: CLAUDE_PLUGIN_ROOT empty and a guessed SKILL.md folder that does not exist."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            mnt = tmp / "mnt"
            self._engine_copy(mnt / "plugin-files" / "sales-navigator")
            want = (mnt / "plugin-files" / "sales-navigator" / "skills" / "sales-navigator").resolve()
            guessed = mnt / "plugins" / "sales-navigator:salesnav-tam-accounts"
            for name in SKILLS:
                with self.subTest(skill=name):
                    self.assertEqual(self._run_block(name, guessed, mnt, tmp, ""), (want, 0))

    def test_cowork_mount_beats_the_sibling_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            mnt = tmp / "mnt"
            self._engine_copy(mnt / "plugin-files" / "sales-navigator")
            sibling = tmp / "elsewhere"
            self._engine_copy(sibling)
            want = (mnt / "plugin-files" / "sales-navigator" / "skills" / "sales-navigator").resolve()
            r = self._run_block("salesnav-outreach", sibling / "skills" / "salesnav-outreach", mnt, tmp, "")
            self.assertEqual(r, (want, 0))

    def test_the_search_fallback_finds_the_engine_under_the_mount_or_the_claude_plugins_dir(self):
        for where in ("mount", "home"):
            with self.subTest(where=where), tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                mnt = tmp / "mnt"
                mnt.mkdir()
                dest = (mnt / "odd layout" / "sales-navigator" if where == "mount"
                        else tmp / ".claude" / "plugins" / "cache" / "ae" / "sales-navigator" / "0.6.1")
                self._engine_copy(dest)
                r = self._run_block("salesnav-tam-people", tmp / "nowhere" / "salesnav-tam-people", mnt, tmp, "")
                self.assertEqual(r, ((dest / "skills" / "sales-navigator").resolve(), 0))

    def test_the_block_leaves_engine_unusable_when_nothing_resolves(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "mnt").mkdir()
            engine, rc = self._run_block("salesnav-outreach", tmp / "plugin" / "skills" / "salesnav-outreach",
                                         tmp / "mnt", tmp, "")
            self.assertIsNone(engine)
            self.assertNotEqual(rc, 0)   # doctor can't run: the flow stops there


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
            if name == "salesnav-tam-accounts":
                continue   # 0.6.1: seller research and intake come first (see AccountsFlowOrder)
            flow = body(name).split("## Flow", 1)[1]
            with self.subTest(skill=name):
                self.assertTrue(re.match(r"\s*0\. Run `python3 \"\$ENGINE/scripts/doctor\.py\"`", flow), flow[:120])
                first_python = re.search(r"python3\s+\"\$ENGINE/scripts/(\w+)\.py\"", flow).group(1)
                self.assertEqual(first_python, "doctor")

    def test_accounts_flow_does_research_and_intake_before_the_doctor_gate(self):
        """0.6.1: a missing engine must not cost the user the seller research, the intake or the written profile."""
        flow = flat("salesnav-tam-accounts").split("## Flow", 1)[1]
        research = flow.index("0. Seller research first, before any question; no engine needed")
        intake = flow.index("1. Intake: one round, at most 5 questions")
        gate = flow.index("2. Engine gate. Run `python3 \"$ENGINE/scripts/doctor.py\"`")
        browser = flow.index("3. Browser gate.")
        self.assertLess(research, intake)
        self.assertLess(intake, gate)
        self.assertLess(gate, browser)
        self.assertEqual(flow.count("doctor.py"), 1)
        # the profile is written even with no engine, and the doctor gate still fails closed
        self.assertIn("or with no engine directly at `~/Claude/company-profile.md`", flow[intake:gate])
        self.assertIn("(the profile is already written)", flow[gate:browser])
        self.assertIn("Only the browser steps below need the engine.", flow[gate:browser])
        self.assertNotIn("csrf_ready", flow[:gate])
        self.assertNotIn("count.js", flow[:gate])

    def test_never_substitute_another_data_source_for_the_sales_nav_count(self):
        for name in ("sales-navigator", "salesnav-tam-accounts", "salesnav-tam-people", "salesnav-tam-tracker"):
            with self.subTest(skill=name):
                self.assertIn(NO_SUBSTITUTE, flat(name))
        ref = " ".join((ENGINE_DIR / "reference.md").read_text(encoding="utf-8").split())
        self.assertIn("Never substitute another data source (other MCP datasets, web estimates) for the Sales Nav "
                      "count without asking.", ref)
        section = ref.split("## Intake and seller research", 1)[1].split("## TAM recipe", 1)[0]
        self.assertIn("A and B need no browser and no engine", section)

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
                # 0.6.0: the accounts flow carries the intake steps; 0.6.1: the 4-line ENGINE block; 0.6.2: count mode
                self.assertLessEqual(len(body(name).splitlines()), 90 if name == "salesnav-tam-accounts" else 76)
        self.assertLessEqual(len(body("sales-navigator").splitlines()), 98)


if __name__ == "__main__":
    unittest.main()
