"""Tests for scripts/company_chunks.py: company ids -> CURRENT_COMPANY lead-search queries, at most 400 ids each.

Run from the repo root:  python3 -m pytest -q tests
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "plugins" / "sales-navigator" / "skills" / "sales-navigator" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import company_chunks  # noqa: E402


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = company_chunks.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


def item(i):
    return "(id:urn%%3Ali%%3Aorganization%%3A%s,selectionType:INCLUDED)" % i


class CompanyChunksCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_exact_query_shape(self):
        code, out, err = run(["--ids", "11,22"])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(out), [{"chunk": 1, "ids": 2, "query":
            "(filters:List((type:CURRENT_COMPANY,values:List(%s,%s))))" % (item(11), item(22))}])

    def test_401_ids_make_two_chunks_of_400_and_1(self):
        csv_path = self.dir / "accounts.csv"
        csv_path.write_text("name,company_id\n" + "".join("co%d,%d\n" % (n, n) for n in range(1, 402)), encoding="utf-8")
        code, out, _ = run(["--csv", str(csv_path)])
        self.assertEqual(code, 0)
        chunks = json.loads(out)
        self.assertEqual([(c["chunk"], c["ids"]) for c in chunks], [(1, 400), (2, 1)])
        self.assertEqual(chunks[0]["query"].count("selectionType:INCLUDED"), 400)
        self.assertTrue(chunks[1]["query"].startswith("(filters:List((type:CURRENT_COMPANY,values:List(%s)" % item(401)))
        self.assertLess(len(chunks[0]["query"]), 30000)  # the 414 limit is about 34K characters

    def test_dedupe_blank_cells_and_custom_column(self):
        csv_path = self.dir / "a.csv"
        csv_path.write_text("org\n5\n\n5\n 6 \n", encoding="utf-8")
        code, out, _ = run(["--csv", str(csv_path), "--column", "org"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)[0]["ids"], 2)
        code, _, err = run(["--csv", str(csv_path)])  # default column company_id is absent
        self.assertEqual(code, 2)
        self.assertIn("company_id", err)

    def test_non_numeric_ids_are_rejected(self):
        for bad in ("12,abc", "12,1x", "12,-3", "12,1.5"):
            code, out, err = run(["--ids", bad])
            self.assertEqual((code, out), (2, ""), bad)
            self.assertIn("not numeric", err)

    def test_chunk_over_400_errors_and_smaller_chunk_works(self):
        code, out, err = run(["--ids", "1,2", "--chunk", "500"])
        self.assertEqual((code, out), (2, ""))
        self.assertIn("--chunk must be 1..400", err)
        code, out, _ = run(["--ids", "1,2,3", "--chunk", "2"])
        self.assertEqual([c["ids"] for c in json.loads(out)], [2, 1])

    def test_seniority_and_extra_filters_append_inside_the_filters_list(self):
        code, out, _ = run(["--ids", "7", "--seniority", "320,310", "--extra-filters", ",(type:REGION,values:List((id:1,selectionType:INCLUDED)))"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)[0]["query"],
                         "(filters:List((type:CURRENT_COMPANY,values:List(%s))"
                         ",(type:SENIORITY_LEVEL,values:List((id:320,selectionType:INCLUDED),(id:310,selectionType:INCLUDED)))"
                         ",(type:REGION,values:List((id:1,selectionType:INCLUDED)))))" % item(7))
        self.assertEqual(run(["--ids", "7", "--seniority", "x"])[0], 2)

    def test_requires_exactly_one_source_and_out_writes_a_file(self):
        self.assertEqual(run([])[0], 2)
        self.assertEqual(run(["--ids", "1", "--csv", "x.csv"])[0], 2)
        target = self.dir / "chunks.json"
        code, out, _ = run(["--ids", "1,2", "--out", str(target)])
        self.assertEqual(code, 0)
        self.assertIn("wrote 1 chunk(s) for 2 ids", out)
        self.assertEqual(json.loads(target.read_text())[0]["ids"], 2)


if __name__ == "__main__":
    unittest.main()
