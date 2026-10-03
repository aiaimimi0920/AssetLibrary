"""Synthetic OSV failures must never become advisory findings."""
import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from security_scan_summary import classify_osv, classify_audit
import test_sarif_coverage as coverage_fixtures

def audit_document(high=0, moderate=0, low=0):
    counts = dict.fromkeys(("info", "low", "moderate", "high", "critical"), 0)
    counts.update(high=high, moderate=moderate, low=low)
    rows = {}
    for severity, count in counts.items():
        for _ in range(count):
            number = 10000 + len(rows)
            rows[str(number)] = {"id": number, "severity": severity, "module_name": "fixture-package",
                "title": "Synthetic advisory", "vulnerable_versions": "<2.0.0", "patched_versions": ">=2.0.0",
                "github_advisory_id": "GHSA-2222-3333-4444", "created": "2020-01-01T00:00:00Z",
                "updated": "2020-01-01T00:00:00Z", "findings": [{"version": "1.0.0",
                    "paths": ["fixture>fixture-package"], "dev": False, "optional": False, "bundled": False}]}
    return {"actions": [], "advisories": rows, "muted": [],
            "metadata": {"dependencies": 3, "devDependencies": 0, "optionalDependencies": 0,
                         "totalDependencies": 3, "vulnerabilities": counts}}

def audit_projects(first=None):
    return [first or audit_document(), audit_document(), audit_document()]

class SummaryTests(unittest.TestCase):
    def fixture(self):
        return coverage_fixtures.CoverageTests().fixture()
    def classify(self, document, sarif, scan=1, report=1, advisory=True):
        return classify_osv(document, sarif, scan, report,
                            ["package-lock.json", "scripts/package-lock.json"], advisory)
    def test_valid_findings_are_retained_in_advisory(self):
        document, sarif = self.fixture()
        facts, status = self.classify(document, sarif)
        self.assertEqual(status, 0)
        self.assertEqual(facts["scanner_exit"], 1)
        self.assertEqual(facts["vulnerability_records"], 2)
        self.assertEqual(facts["sarif_result_count"], 2)
        self.assertTrue(facts["analysis_complete"])
        self.assertEqual(self.classify(document, sarif, advisory=False)[1], 1)
    def test_raw_execution_error_stays_error(self):
        document, sarif = self.fixture()
        for status in (2, 124, -1):
            with self.assertRaises(ValueError):
                self.classify(document, sarif, scan=status)
    def test_zero_status_with_findings_is_error(self):
        document, sarif = self.fixture()
        with self.assertRaises(ValueError):
            self.classify(document, sarif, scan=0, report=0)
    def test_reporter_failure_stays_error(self):
        document, sarif = self.fixture()
        with self.assertRaises(ValueError):
            self.classify(document, sarif, report=2)
    def test_missing_selected_lock_stays_error(self):
        document, sarif = self.fixture()
        document["results"].pop()
        with self.assertRaises(ValueError):
            self.classify(document, sarif)
    def test_same_count_different_package_stays_error(self):
        document, sarif = self.fixture()
        sarif["runs"][0]["results"][0]["partialFingerprints"]["primaryLocationLineHash"] = "0" * 64
        with self.assertRaises(ValueError):
            self.classify(document, sarif)
    def test_sarif_failed_invocation_stays_error(self):
        document, sarif = self.fixture()
        sarif["runs"][0]["invocations"] = [{"executionSuccessful": False}]
        with self.assertRaises(ValueError):
            self.classify(document, sarif)
    def test_audit_findings_advisory_and_strict(self):
        document = audit_document(high=2)
        facts, status = classify_audit(audit_projects(document), [1, 0, 0], True)
        self.assertEqual(status, 0)
        self.assertEqual(facts["gate_findings"], 2)
        self.assertEqual(classify_audit(audit_projects(document), [1, 0, 0], False)[1], 1)
    def test_audit_api_failure_is_never_advisory(self):
        with self.assertRaises(ValueError):
            classify_audit([{"error": {"code": "FIXTURE"}}, audit_document(), audit_document()], [1, 0, 0], True)
    def test_audit_timeout_is_never_advisory(self):
        with self.assertRaises(ValueError):
            classify_audit(audit_projects(), [124, 0, 0], True)
    def test_audit_exit_report_mismatch_is_error(self):
        with self.assertRaises(ValueError):
            classify_audit(audit_projects(audit_document(high=1)), [0, 0, 0], True)
    def test_empty_audit_object_is_not_a_clean_scan(self):
        with self.assertRaises(ValueError):
            classify_audit([{}, audit_document(), audit_document()], [0, 0, 0], True)
    def test_positive_count_without_advisories_is_invalid(self):
        document = audit_document(high=2)
        document["advisories"] = {}
        with self.assertRaises(ValueError):
            classify_audit(audit_projects(document), [1, 0, 0], True)
    def test_severity_substitution_with_same_count_is_invalid(self):
        document = audit_document(high=2)
        document["metadata"]["vulnerabilities"].update(high=0, moderate=2)
        with self.assertRaises(ValueError):
            classify_audit(audit_projects(document), [1, 0, 0], True)
    def test_missing_advisory_paths_is_invalid(self):
        document = audit_document(high=1)
        document["advisories"]["10000"]["findings"][0]["paths"] = []
        with self.assertRaises(ValueError):
            classify_audit(audit_projects(document), [1, 0, 0], True)
    def test_each_project_exit_remains_distinct(self):
        facts, status = classify_audit([audit_document(high=1), audit_document(), audit_document(moderate=1)],
                                      [1, 0, 1], True)
        self.assertEqual(status, 0)
        self.assertEqual(facts["raw_exits"], {"web": 1, "client": 0, "edge": 1})
        self.assertEqual(len(facts["project_reports"]), 3)
    def test_sarif_error_notification_is_invalid(self):
        for field in ("toolExecutionNotifications", "toolConfigurationNotifications"):
            document, sarif = self.fixture()
            sarif["runs"][0]["invocations"] = [{"executionSuccessful": True,
                field: [{"level": "error", "message": {"text": "FIXTURE"}}]}]
            with self.assertRaises(ValueError):
                self.classify(document, sarif)
    def test_sarif_execution_flag_must_be_boolean_true(self):
        for invocation in ({}, {"executionSuccessful": "true"}, {"executionSuccessful": 1}):
            document, sarif = self.fixture()
            sarif["runs"][0]["invocations"] = [invocation]
            with self.assertRaises(ValueError):
                self.classify(document, sarif)
    def test_sarif_invocations_can_be_absent_or_valid(self):
        document, sarif = self.fixture()
        self.assertEqual(self.classify(document, sarif)[1], 0)
        sarif["runs"][0]["invocations"] = [{"executionSuccessful": True,
            "toolExecutionNotifications": [{"level": "warning"}]}]
        self.assertEqual(self.classify(document, sarif)[1], 0)
    def test_clean_complete_inventory_is_zero(self):
        document, sarif = self.fixture()
        for source in document["results"]:
            for entry in source["packages"]:
                entry["vulnerabilities"] = []
                entry["groups"] = []
        sarif["runs"][0]["results"] = []
        sarif["runs"][0]["tool"]["driver"]["rules"] = []
        self.assertEqual(self.classify(document, sarif, scan=0, report=0)[1], 0)

if __name__ == "__main__":
    unittest.main()
