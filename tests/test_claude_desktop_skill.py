"""Hard rules and word budgets for the slim claude-desktop skill docs.

Run from the repo root:  python3 -m pytest -q tests
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "claude-desktop"


def squash(path):
    return " ".join(Path(path).read_text(encoding="utf-8").split())


def words(path):
    return len(Path(path).read_text(encoding="utf-8").split())


class ClaudeDesktopDocs(unittest.TestCase):
    def test_skill_md_carries_the_hard_rules(self):
        text = squash(SKILL / "SKILL.md").lower()
        for phrase in (
            "unofficial",
            "claude://",                                   # deep links
            "approvals-log",                               # the approval record
            "screenshot before every click",
            "stop if the wrong window is frontmost",
            "never type secrets",
            "oauth",                                       # handed to the user
            "hand",
            "ask once",                                    # approval policy
            "--user-ok",
            "stop after 5",
            "explicit yes in chat",                        # outward-facing or destructive
            "leave the mac alone",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, text)

    def test_every_helper_command_in_the_docs_exists(self):
        script = (SKILL / "scripts" / "desktop.py").read_text(encoding="utf-8")
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        for command in ("doctor", "activate", "frontmost-check", "shot", "click", "type", "press", "scroll",
                        "wait-idle", "config-mcp", "approvals-log", "open"):
            with self.subTest(command=command):
                self.assertIn(command, text)
                self.assertIn('"%s"' % command, script)

    def test_only_the_slim_docs_remain(self):
        names = sorted(str(p.relative_to(SKILL)) for p in SKILL.rglob("*.md"))
        self.assertEqual(names, ["SKILL.md", "references/ui-map.md"])

    def test_word_budgets(self):
        self.assertLessEqual(words(SKILL / "SKILL.md"), 600)
        self.assertLessEqual(words(SKILL / "references" / "ui-map.md"), 800)
        total = sum(words(p) for p in SKILL.rglob("*.md"))
        self.assertLessEqual(total, 1400, total)

    def test_ui_map_keeps_the_hand_off_and_picker_notes(self):
        text = squash(SKILL / "references" / "ui-map.md").lower()
        for phrase in ("hand the sign-in", "never click allow", "system events", "manual"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, text)


if __name__ == "__main__":
    unittest.main()
