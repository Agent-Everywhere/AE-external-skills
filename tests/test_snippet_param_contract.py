"""Param contract: every page/*.js snippet declares its accepted params (`// @params ...`) and the runner
rejects an unknown or missing param BEFORE any browser session is claimed or contacted.

Run from the repo root:  python3 -m pytest -q tests
"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator"
PAGE = ENGINE / "page"
RUNTIME = ENGINE / "runtime" / "session.py"
sys.path.insert(0, str(ROOT / "packages" / "browser-runtime"))

import session  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_page_snippets import NODE, run_snippet  # noqa: E402

DUMMY_CDP = "http://127.0.0.1:1/never-contacted"  # a connect attempt here would fail loudly


def params_read(body):
    """Param names a snippet body reads off its params object (`p` or `params`): `p.x`, `p?.x`, `p['x']`,
    `p["x"]` and `const { a, b: c = 1, ...rest } = p`."""
    obj = r"\b(?:p|params)\b"
    names = set(re.findall(obj + r"\s*\??\.\s*([A-Za-z_$][\w$]*)", body))
    names |= set(re.findall(obj + r"\s*\??\.?\s*\[\s*['\"]([^'\"]+)['\"]\s*\]", body))
    for group in re.findall(r"\{([^{}]*)\}\s*=\s*(?:p|params)\b(?!\s*[.\[])", body):
        for part in group.split(","):
            part = part.strip()
            if part and not part.startswith("..."):
                names.add(re.split(r"[:=\s]", part, maxsplit=1)[0])
    return names


def plan_with(snippet, params, **extra):
    call = {"id": "c1", "snippet": snippet, "params": params}
    call.update(extra)
    return {"calls": [call]}


class Declarations(unittest.TestCase):
    def test_every_snippet_declares_its_params(self):
        files = sorted(PAGE.glob("*.js"))
        self.assertTrue(files)
        for path in files:
            with self.subTest(snippet=path.name):
                contract = session.snippet_contract(path.read_text(encoding="utf-8"))
                self.assertIsNotNone(contract, "%s needs a `// @params a b c` header line" % path.name)
                accepted, required = contract
                self.assertEqual(len(accepted), len(set(accepted)), "duplicate names in @params")
                for alts in required:
                    for name in alts:
                        self.assertIn(name, accepted, "@required %s is not in @params" % name)

    def test_declared_params_match_what_the_code_reads(self):
        """A param the snippet reads (`p.name`) but does not declare would be rejected as unknown."""
        for path in sorted(PAGE.glob("*.js")):
            with self.subTest(snippet=path.name):
                source = path.read_text(encoding="utf-8")
                accepted, _ = session.snippet_contract(source)
                body = "\n".join(l for l in source.splitlines() if not l.lstrip().startswith("//"))
                self.assertEqual(sorted(params_read(body) - set(accepted)), [], "read but not declared")

    def test_params_read_detector_covers_every_access_form(self):
        body = ("const a = p.one; const b = params.two; const c = p['three']; const d = params[\"four\"];\n"
                "const { five, six: renamed, seven = 7, ...rest } = p;\n"
                "let { eight } = params;\n"
                "const e = p?.nine;")
        self.assertEqual(params_read(body), {"one", "two", "three", "four", "five", "six", "seven", "eight", "nine"})
        self.assertEqual(params_read("const { x } = other; const y = q.z; const w = p || {};"), set())

    def test_contract_parser(self):
        src = "// x\n// @params a b\n// @params c\n// @required a b|c\nasync (p) => 1"
        self.assertEqual(session.snippet_contract(src), (["a", "b", "c"], [["a"], ["b", "c"]]))
        self.assertIsNone(session.snippet_contract("// no declaration\nasync (p) => 1"))
        # a `@params` mention after code starts is not a declaration
        self.assertIsNone(session.snippet_contract("async (p) => 1\n// @params a"))


class PlanValidation(unittest.TestCase):
    dirs = [PAGE]

    def test_unknown_key_is_rejected_with_a_suggestion(self):
        bad = session.validate_plan(plan_with("typeahead.js", {"type": "INDUSTRY", "qury": "x"}), self.dirs)
        text = "\n".join(bad)
        self.assertEqual(len(bad), 2, bad)  # the unknown key, and the term it should have been
        self.assertIn("typeahead.js", text)
        self.assertIn("'qury'", text)
        self.assertIn("did you mean 'query'", text)
        self.assertIn("accepted: type, term, terms, query, count, delayMs", text)

    def test_unknown_key_without_a_near_match_has_no_suggestion(self):
        bad = session.validate_plan(plan_with("typeahead.js", {"type": "INDUSTRY", "term": "x", "zzzz": 1}), self.dirs)
        self.assertEqual(len(bad), 1)
        self.assertNotIn("did you mean", bad[0])

    def test_missing_required_key_is_reported(self):
        bad = session.validate_plan(plan_with("typeahead.js", {"type": "INDUSTRY"}), self.dirs)
        self.assertEqual(len(bad), 1)
        self.assertIn("needs param 'term' or 'terms' or 'query'", bad[0])
        bad = session.validate_plan(plan_with("lead_search.js", {}), self.dirs)
        self.assertIn("needs param 'query'", "\n".join(bad))

    def test_ready_snippet_params_are_checked_too(self):
        plan = plan_with("csrf_ready.js", {"timeoutMs": 5000})
        plan["ready"] = {"snippet": "csrf_ready.js", "params": {"timeout": 5}}
        bad = session.validate_plan(plan, self.dirs)
        self.assertEqual(len(bad), 1)
        self.assertIn("ready", bad[0])
        self.assertIn("did you mean 'timeoutMs'", bad[0])

    def test_delayMs_is_always_accepted_as_a_runner_key(self):
        """session.py reads params.delayMs as plan-wide pacing, so a snippet need not list it in its header."""
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "paced.js").write_text("// @params a\n// @required a\nasync (p) => p.a")
            dirs = [Path(d)]
            self.assertEqual(session.validate_plan(plan_with("paced.js", {"a": 1, "delayMs": 3500}), dirs), [])
            self.assertEqual(session.check_params("x", "paced.js", {"a": 1, "delayMs": 3500}, dirs), [])
            bad = session.validate_plan(plan_with("paced.js", {"a": 1, "delayMz": 1}), dirs)
            self.assertEqual(len(bad), 1)
            self.assertIn("did you mean 'delayMs'", bad[0])
        # a real snippet whose header does not list delayMs
        self.assertNotIn("delayMs", session.snippet_contract((PAGE / "lead_search.js").read_text())[0])
        self.assertEqual(session.validate_plan(plan_with("lead_search.js", {"query": "q", "delayMs": 3500}),
                                               self.dirs), [])

    def test_undeclared_snippets_and_inline_js_are_not_checked(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "free.js").write_text("async (p) => p.anything")
            self.assertEqual(session.validate_plan(plan_with("free.js", {"whatever": 1}), [Path(d)]), [])
        plan = {"calls": [{"id": "c1", "js": "async (p) => 1", "params": {"whatever": 1}}]}
        self.assertEqual(session.validate_plan(plan, self.dirs), [])

    def test_valid_plans_still_validate(self):
        plans = [
            plan_with("typeahead.js", {"type": "INDUSTRY", "term": "motor vehicle"}),
            plan_with("typeahead.js", {"type": "INDUSTRY", "query": "motor vehicle"}),
            plan_with("typeahead.js", {"type": "BING_GEO", "terms": ["Texas", "Ohio"], "count": 5, "delayMs": 3500}),
            plan_with("account_search.js", {"query": "(filters:List())", "count": 100},
                      pages={"param": "start", "step": 25, "cap": 1000}),
            plan_with("count.js", {"kind": "account", "queries": [{"label": "a", "query": "q"}]}),
            plan_with("lists.js", {}),
            plan_with("profiles_batch.js", {"ids": ["ACoAAx"], "urlsOnly": True}),
        ]
        for plan in plans:
            with self.subTest(plan=plan["calls"][0]):
                self.assertEqual(session.validate_plan(plan, self.dirs), [])

    def test_the_documented_plan_validates(self):
        readme = (ENGINE / "runtime" / "README.md").read_text(encoding="utf-8")
        block = re.search(r"```json\n(.*?)\n```", readme, re.S).group(1)
        self.assertEqual(session.validate_plan(json.loads(block), self.dirs), [])

    def test_segments_script_plans_validate(self):
        """The plans scripts/segments.py builds use only declared params."""
        for name, params in (("count.js", {"kind": "account", "queries": [{"label": "a", "query": "q"}]}),
                             ("account_search.js", {"query": "q", "count": 25})):
            self.assertEqual(session.validate_plan(plan_with(name, params), self.dirs), [])


class CommandLine(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(RUNTIME), *args], capture_output=True, text=True, timeout=30)

    def test_emit_rejects_an_unknown_param(self):
        proc = self.run_cli("--emit", "typeahead.js", "--params", '{"type":"INDUSTRY","qury":"x"}')
        self.assertEqual(proc.returncode, session.EXIT_USAGE)
        self.assertEqual(proc.stdout, "")
        self.assertIn("qury", proc.stderr)
        self.assertIn("did you mean 'query'", proc.stderr)
        self.assertIn("typeahead.js", proc.stderr)

    def test_emit_accepts_valid_params(self):
        proc = self.run_cli("--emit", "typeahead.js", "--params", '{"type":"INDUSTRY","query":"motor vehicle"}',
                            "--compact")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('"query": "motor vehicle"', proc.stdout)

    def test_emit_rejects_malformed_params_json(self):
        proc = self.run_cli("--emit", "typeahead.js", "--params", "{not json")
        self.assertEqual(proc.returncode, session.EXIT_USAGE)
        self.assertIn("--params is not valid JSON", proc.stderr)

    def test_cdp_plan_with_a_bad_key_fails_before_connecting(self):
        with tempfile.TemporaryDirectory() as d:
            plan = Path(d) / "plan.json"
            out = Path(d) / "out.jsonl"
            plan.write_text(json.dumps(plan_with("typeahead.js", {"type": "INDUSTRY", "qury": "x"})))
            proc = self.run_cli("--runtime", "cdp", "--cdp-url", DUMMY_CDP, "--plan", str(plan), "--out", str(out))
            self.assertEqual(proc.returncode, session.EXIT_USAGE, proc.stderr)
            self.assertIn("nothing was claimed or run", proc.stderr)
            self.assertIn("'qury'", proc.stderr)
            self.assertIn("did you mean 'query'", proc.stderr)
            self.assertNotIn("local runtime", proc.stderr)  # the connect step never started
            self.assertNotIn("fatal", proc.stderr)
            self.assertFalse(out.exists())

    def test_agent_browser_plan_with_a_bad_key_fails_before_claiming(self):
        with tempfile.TemporaryDirectory() as d:
            plan = Path(d) / "plan.json"
            plan.write_text(json.dumps(plan_with("lead_search.js", {"query": "q", "cnt": 5})))
            proc = self.run_cli("--runtime", "agent-browser", "--claim", "never-used-claim-123456",
                                "--base", "https://127.0.0.1:1", "--plan", str(plan),
                                "--out", str(Path(d) / "out.jsonl"))
            self.assertEqual(proc.returncode, session.EXIT_USAGE, proc.stderr)
            self.assertIn("did you mean 'count'", proc.stderr)
            self.assertIn("nothing was claimed or run", proc.stderr)


@unittest.skipUnless(NODE, "node not installed")
class TypeaheadAlias(unittest.TestCase):
    RESP = [{"status": 200, "body": {"elements": [{"id": "1", "displayValue": "Motor Vehicle Manufacturing"}]}}]

    def test_query_is_an_alias_of_term(self):
        out = run_snippet("typeahead.js", {"type": "INDUSTRY", "query": "motor vehicle"}, self.RESP)
        self.assertNotIn("error", out["result"])
        self.assertIn("type=INDUSTRY&query=motor%20vehicle", out["calls"][0]["url"])
        self.assertEqual(out["result"]["results"][0]["term"], "motor vehicle")

    def test_term_wins_over_query_and_terms_over_both(self):
        out = run_snippet("typeahead.js", {"type": "INDUSTRY", "term": "a", "query": "b"}, self.RESP)
        self.assertIn("&query=a", out["calls"][0]["url"])
        out = run_snippet("typeahead.js", {"type": "INDUSTRY", "terms": ["c"], "term": "a", "query": "b"}, self.RESP)
        self.assertIn("&query=c", out["calls"][0]["url"])

    def test_no_term_at_all_is_still_term_required(self):
        out = run_snippet("typeahead.js", {"type": "INDUSTRY"})
        self.assertEqual(out["result"]["error"], "term_required")


if __name__ == "__main__":
    unittest.main()
