"""fb-marketplace-inbox: GraphQL map stays UNTESTED, and scripts do not print tokens.

Run from the repo root:  python3 -m unittest tests.test_fb_marketplace_inbox
"""
import json
import os
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "fb-marketplace-inbox"
SCRIPTS = SKILL / "scripts"
ENDPOINTS = SKILL / "references" / "fb-marketplace-endpoints.md"


class FbMarketplaceInboxTests(unittest.TestCase):
    def test_redact_self_test(self):
        proc = subprocess.run(
            ["node", str(SCRIPTS / "graphql_redact.mjs"), "--self-test"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("ok", proc.stdout)
        self.assertNotIn("NAftestDTSGTOKEN", proc.stdout)

    def test_discover_refuses_a_closed_port_without_a_stack(self):
        env = dict(os.environ)
        env["CDP_PORT"] = "1"
        proc = subprocess.run(
            ["node", str(SCRIPTS / "discover_graphql.mjs")],
            capture_output=True, text=True, check=False, env=env, timeout=15,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertEqual(proc.stderr, "")
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["error"], "cdp_unreachable")
        self.assertNotIn("fb_dtsg", proc.stdout)

    def test_read_falls_back_while_rows_are_untested(self):
        proc = subprocess.run(
            ["node", str(SCRIPTS / "read_inbox_graphql.mjs")],
            capture_output=True, text=True, check=False, timeout=15,
        )
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertEqual(proc.stderr, "")
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["fallback"])
        self.assertEqual(payload["reason"], "no_verified_rows")
        self.assertIn("read_inbox.mjs", payload["ui"])

    def test_endpoints_map_is_untested_and_has_no_send(self):
        text = ENDPOINTS.read_text(encoding="utf-8")
        for phrase in (
            "Common request rules",
            "/api/graphql/",
            "performance.getEntriesByType('resource')",
            "fb_dtsg",
            "Own viewer id",
            "Selling inbox thread list",
            "message history",
            "Listing context",
            "Buying inbox",
            "Own selling listings",
            "No programmatic send is documented",
            "references/send-procedure.md",
            "6 an hour",
            "discover_graphql.mjs",
        ):
            self.assertIn(phrase, text, phrase)
        for line in text.splitlines():
            if not line.startswith("| ") or line.startswith("|---") or line.startswith("| Capability") or line.startswith("| Marker") or line.startswith("| A hosted") or line.startswith("| Action"):
                continue
            if "Send a reply" in line or "Programmatic send" in line:
                self.assertIn("UI only", line) if "Send a reply" in line else None
                self.assertNotIn("VERIFIED", line)
            elif line.startswith("| **"):
                continue
            else:
                self.assertTrue(line.rstrip().endswith("UNTESTED |") or line.rstrip().endswith("UI only |") or "DIY reality" in line or line.startswith("| Inbox") or line.startswith("| Discovery") or line.startswith("| GraphQL") or line.startswith("| Sends") or line.startswith("| Stop") or line.startswith("| Webhooks") or line.startswith("| An always") or line.startswith("| Stable") or line.startswith("| Message text") or line.startswith("| Cookie"), line)
        blocks = re.findall(r"```json\n(.*?)\n```", text, re.S)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(json.loads(blocks[0])["rows"], [])
        self.assertIsNone(re.search(r"\b\d{8,}\b", text), "no hard-coded doc_id in the map")

    def test_skill_prefers_graphql_then_ui_and_keeps_typed_sends(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        flow = text.split("## Flow", 1)[1].split("## Hard", 1)[0]
        self.assertLess(flow.index("read_inbox_graphql.mjs"), flow.index("UNTESTED"))
        self.assertIn("read_inbox.mjs", flow)
        self.assertIn("references/send-procedure.md", flow)
        self.assertIn("typed approval", text)
        self.assertIn("fb-marketplace-endpoints.md", text)
        self.assertIn("untrusted", text.lower())

    def test_scripts_do_not_log_raw_secrets(self):
        for path in SCRIPTS.glob("*.mjs"):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if "console.log" not in line and "console.error" not in line:
                    continue
                with self.subTest(script=path.name, line=number):
                    self.assertNotIn("postData", line)
                    self.assertNotIn("fb_dtsg", line)
                    self.assertNotIn("cookie", line.lower())
                    self.assertNotIn("jazoest", line)


if __name__ == "__main__":
    unittest.main()
