"""Regression proof for advisory vs broken scanner/report classification."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from security_findings import classify


class ReportContract(unittest.TestCase):
    def test_clean_gitleaks(self):
        self.assertEqual(classify("gitleaks", [], 0)["finding_count"], 0)

    def test_redacted_finding_deduplicated(self):
        row = {"RuleID": "token", "File": "fixture", "StartLine": 1,
               "Fingerprint": "stable", "Secret": "REDACTED", "Match": "REDACTED"}
        self.assertEqual(classify("gitleaks", [row, row], 42)["finding_count"], 1)
        for status in (0, 1, 2, 124):
            with self.assertRaises(ValueError):
                classify("gitleaks", [row], status)
        row["Secret"] = "not-redacted"
        with self.assertRaises(ValueError):
            classify("gitleaks", [row], 42)

    def test_gitleaks_empty_finding_exit_rejected(self):
        with self.assertRaises(ValueError):
            classify("gitleaks", [], 42)

    def test_iac_inventory_and_exits(self):
        data = {"SchemaVersion": 2, "Results": [{
            "Target": "deploy/example.yaml", "Class": "config",
            "MisconfSummary": {"Successes": 1, "Failures": 1},
            "Misconfigurations": [{"ID": "AVD-test", "Status": "FAIL"}]}]}
        self.assertEqual(classify("trivy", data, 42)["finding_count"], 1)
        for bad in ({}, {"SchemaVersion": 2, "Results": []}):
            with self.assertRaises(ValueError):
                classify("trivy", bad, 0)
        with self.assertRaises(ValueError):
            classify("trivy", data, 1)
        bad = copy.deepcopy(data)
        del bad["Results"][0]["MisconfSummary"]
        with self.assertRaises(ValueError):
            classify("trivy", bad, 42)

    def test_review_reports_required_even_when_clean(self):
        self.assertEqual(classify("review", {"changes": [], "vulnerable": [],
                                             "summary": "No changes"}, 0)["finding_count"], 0)
        for bad in ({}, {"changes": [], "vulnerable": [], "summary": ""},
                    {"changes": [], "vulnerable": [], "summary": "Snapshot warnings"}):
            with self.assertRaises(ValueError):
                classify("review", bad, 0)


if __name__ == "__main__":
    unittest.main()
