"""Every SKILL.md in the repo carries the same "stay inside this skill" guardrail, word for word.

Covers plugins/ and skills/, generated standalone copies included (they are byte copies of their sources).
Run from the repo root:  python3 -m pytest -q tests
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GUARDRAIL = (
    "**Stay inside this skill.** Use only the commands, pages and endpoints this skill documents. Do not probe, "
    "guess or test other endpoints, URLs or parameters on the same service, and do not raise the pace or volume "
    "beyond what is written here: that is how accounts get rate-limited or blocked. If the user needs something "
    "this skill does not cover, say so and suggest they ask Agent Everywhere, the publisher, instead of improvising."
)


def skill_files():
    return sorted(p for top in ("plugins", "skills") for p in (ROOT / top).rglob("SKILL.md")
                  if "node_modules" not in p.parts)


class StayInsideGuardrail(unittest.TestCase):
    def test_the_scan_sees_every_skill(self):
        rel = {p.relative_to(ROOT).as_posix() for p in skill_files()}
        self.assertGreaterEqual(len(rel), 20)
        for expected in ("plugins/linkedin/skills/linkedin-job-signals/SKILL.md",
                         "plugins/linkedin-job-signals/skills/linkedin-job-signals/SKILL.md",   # generated standalone copy
                         "plugins/sales-navigator/skills/sales-navigator/SKILL.md",
                         "skills/grokbot/SKILL.md", "skills/claude-desktop/SKILL.md"):
            self.assertIn(expected, rel)

    def test_every_skill_has_the_exact_paragraph_once(self):
        for path in skill_files():
            text = path.read_text(encoding="utf-8")
            with self.subTest(skill=path.relative_to(ROOT).as_posix()):
                self.assertEqual(text.count("**Stay inside this skill.**"), 1)
                self.assertIn("\n" + GUARDRAIL + "\n", text)

    def test_it_sits_after_the_title_and_before_the_first_section(self):
        for path in skill_files():
            text = path.read_text(encoding="utf-8")
            body = text.split("\n---\n", 1)[1]   # past the frontmatter
            at = body.index(GUARDRAIL)
            with self.subTest(skill=path.relative_to(ROOT).as_posix()):
                self.assertTrue(body.lstrip().startswith("# "), "the first thing after the frontmatter is the title")
                self.assertLess(body.index("\n# "), at)
                first_section = body.find("\n## ")
                self.assertTrue(first_section == -1 or at < first_section, "guardrail must come before the first ## section")


if __name__ == "__main__":
    unittest.main()
