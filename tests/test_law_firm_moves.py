"""law-firm-moves plugin: a prompt-only skill (0.2.0: market discovery by default, optional watch list). Manifests agree,
the caps and run cadence are stated, the profile and output contract are pinned, and nothing but the install URL is a link.

No network. Run from the repo root:  python3 -m pytest -q tests
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "build"))
import sync_runtime  # noqa: E402

PLUGIN = ROOT / "plugins" / "law-firm-moves"
SKILL = PLUGIN / "skills" / "law-firm-moves"
SKILL_MD = SKILL / "SKILL.md"
GITHUB = "https://github.com/Agent-Everywhere"


class LawFirmMoves(unittest.TestCase):
    def test_manifests_agree_with_the_marketplace(self):
        market = {p["name"]: p for p in json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())["plugins"]}
        entry = market["law-firm-moves"]
        plugin = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
        skill = sync_runtime.load_manifest(SKILL)
        self.assertEqual(entry["source"], "./plugins/law-firm-moves")
        self.assertEqual(entry["skills"], ["./skills/law-firm-moves"])
        self.assertEqual(entry["category"], "sales")
        self.assertIs(entry["strict"], False)
        self.assertEqual(plugin["name"], "law-firm-moves")
        self.assertEqual({entry["version"], plugin["version"], skill["version"]}, {"0.2.0"})
        self.assertEqual(skill["category"], "sales")
        self.assertEqual(skill["runtimes"], [])

    def test_skill_frontmatter_name_matches(self):
        text = SKILL_MD.read_text()
        self.assertTrue(text.startswith("---\n"))
        self.assertRegex(text, r"(?m)^name: law-firm-moves$")
        self.assertRegex(text, r"(?m)^description: ")

    def test_skill_states_the_caps(self):
        text = SKILL_MD.read_text()
        self.assertIn("One practice focus per profile", text)
        self.assertRegex(text, r"(?i)at most 12 searches per run")
        self.assertRegex(text, r"(?i)at most 15 moves reported per run")
        self.assertRegex(text, r"(?i)at most 25 firms")
        self.assertRegex(text, r"(?i)at most one run a day")
        self.assertIn("3 days", text)
        self.assertIn("14 days", text)
        self.assertIn("45 days", text)
        self.assertIn("Do not split", text)
        self.assertIn("law-firm-moves-work/seen.json", text)
        self.assertIn("law-firm-moves-work/profile.json", text)
        self.assertNotIn("No timers", text)
        self.assertNotIn("at most 40 firms", text.lower())

    def test_skill_states_the_discovery_contract(self):
        text = SKILL_MD.read_text()
        self.assertRegex(text, r"(?m)^\| Firm \| Move \| Date \| Source link \| Firm leader, title \| Firm size \|")
        profile = re.search(r"law-firm-moves-work/profile\.json`:(.*?)\n\n", text, re.S).group(1)
        for field in ("offer", "practice_focus", "states", "move_types", "size_band", "exclude", "watch_list", "lookback_days"):
            self.assertIn(f"`{field}`", profile)

    def test_skill_has_no_endpoint_other_than_the_install_url(self):
        text = SKILL_MD.read_text()
        for url in re.findall(r"https?://\S+", text):
            self.assertTrue(url.startswith(GITHUB), url)

    def test_the_plugin_is_prompt_only(self):
        files = sorted(p.relative_to(PLUGIN).as_posix() for p in PLUGIN.rglob("*") if p.is_file() and p.name != ".DS_Store")
        self.assertEqual(files, [".claude-plugin/plugin.json", "skills/law-firm-moves/SKILL.md", "skills/law-firm-moves/skill.yaml"])

    def test_the_readme_lists_it_with_a_one_line_install(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("Install the law-firm-moves skill from https://github.com/Agent-Everywhere/AE-external-skills/tree/main/plugins/law-firm-moves and set it up for me.", readme)
        self.assertRegex(readme, r"(?m)^/plugin install law-firm-moves@ae-external-skills\s*$")


if __name__ == "__main__":
    unittest.main()
