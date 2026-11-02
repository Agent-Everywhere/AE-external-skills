"""Public-repo hygiene: these skills are handed to outside users, so they run only on the vendor's own endpoints from
the user's own browser, and never through Agent Everywhere infrastructure or under our product names.

Scans every file in the repo outside tests/ (and outside .git, dist/ builds, node_modules and caches).
Run from the repo root:  python3 -m pytest -q tests
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".pytest_cache", "tests"}


def shipped_files():
    """Every file outside tests/, caches and the top-level dist/ output folder (gitignored build artifacts)."""
    out = []
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT)
        if not path.is_file() or (set(rel.parts) & SKIP_DIRS) or rel.parts[0] == "dist":
            continue
        out.append(path)
    return out


def hits(pattern):
    regex = re.compile(pattern, re.I)
    found = []
    for path in shipped_files():
        text = path.read_bytes().decode("utf-8", errors="ignore")
        for number, line in enumerate(text.splitlines(), 1):
            if regex.search(line):
                found.append("%s:%d" % (path.relative_to(ROOT), number))
    return found


class PublicHygiene(unittest.TestCase):
    def test_scanner_sees_the_repo(self):
        names = {p.name for p in shipped_files()}
        self.assertTrue({"README.md", "marketplace.json", "session.py", "qbo.mjs"} <= names)

    def test_no_hosted_browser_connector_or_railway_host_anywhere(self):
        self.assertEqual(hits(r"browser-mcp-production|railway\.app"), [])

    def test_no_agent_everywhere_browser_option_anywhere(self):
        self.assertEqual(hits(r"agent[ _-]?browser|AB_CLAIM|browser/claim"), [])

    def test_no_internal_product_names_anywhere(self):
        self.assertEqual(hits(r"lireach"), [])

    def test_no_internal_design_docs_ship(self):
        self.assertEqual(hits(r"design-plan"), [])
        self.assertFalse(list(ROOT.rglob("design-plan.md")))


if __name__ == "__main__":
    unittest.main()
