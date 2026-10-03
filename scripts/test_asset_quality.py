"""AssetLibrary adapter and release-boundary regressions; no product builds."""
import argparse
import copy
import os
import sys
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("quality", ROOT / "scripts/development_quality.py")
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


class AssetQualityTests(unittest.TestCase):
    def reject(self, *args):
        with self.assertRaises((ValueError, TypeError, KeyError)):
            quality.classify(*args)

    def test_openapi_clean_findings_and_incomplete_reports(self):
        report = dict(version="2.54.3", totals=dict(errors=1, warnings=0, ignored=0),
                      problems=[dict(ruleId="no-empty-servers", severity="error",
                                     message="Servers must be present.", location=[{"source": {"ref": "x.yaml"}}])])
        err = "validating x.yaml...\nx.yaml: validated in 10ms\n"
        self.assertEqual(quality.classify("openapi", 1, json.dumps(report), err), 1)
        self.reject("openapi", 0, json.dumps(report), err)
        self.reject("openapi", 1, json.dumps(report), err + "unknown tool failure")
        for rule in ("no-unresolved-refs", "spec"):
            bad = copy.deepcopy(report)
            bad["problems"][0]["ruleId"] = rule
            self.reject("openapi", 1, json.dumps(bad), err)
        report["problems"] = []
        self.reject("openapi", 1, json.dumps(report), err)
        report["totals"]["errors"] = 0
        self.assertEqual(quality.classify("openapi", 0, json.dumps(report), err), 0)
        self.reject("openapi", 0, json.dumps(report), "")
        for raw in ("", "{}", "[]", "not JSON"):
            self.reject("openapi", 1, raw, "Please provide a valid path.")

    def test_strict_preserves_warning_only_original_success(self):
        report = json.dumps([dict(filePath="x.js", errorCount=0, warningCount=1,
                                 fatalErrorCount=0, messages=[{"ruleId": "no-unused-vars"}])])
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"QUALITY_STRICT": "true"}):
            args = argparse.Namespace(kind="eslint", output=str(Path(temp) / "report"),
                                      report=None, timeout=10,
                                      command=[sys.executable, "-c", "print(" + repr(report) + ")"])
            self.assertEqual(quality.run(args), 0)
            result = json.loads((Path(temp) / "report/result.json").read_text())
            self.assertEqual(result["findings"], 1)
            self.assertEqual(result["status"], "findings")

    def test_tofu_coverage_excludes_hidden_and_editor_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".terraform").mkdir()
            (root / ".terraform/cache.tf").write_text("ignored", encoding="utf-8")
            (root / ".hidden.tf").write_text("ignored", encoding="utf-8")
            (root / "backup~").mkdir()
            (root / "backup~/main.tf").write_text("ignored", encoding="utf-8")
            (root / "#swap#").mkdir()
            (root / "#swap#/main.tf").write_text("ignored", encoding="utf-8")
            self.assertEqual(quality.tofu_sources(root), [])
            for name in ("main.tf", "alt.tofu", "vars.tfvars", "case.tftest.hcl", "case.tofutest.hcl"):
                (root / name).write_text("", encoding="utf-8")
            self.assertEqual(len(quality.tofu_sources(root)), 5)

    def test_tofu_specific_exit_and_existing_paths(self):
        with patch.object(Path, "is_file", return_value=True):
            self.assertEqual(quality.classify("tofu-fmt", 3, "deploy/tofu/main.tf\n", ""), 1)
            for code, output, err in [
                (3, "", ""), (2, "deploy/tofu/main.tf\n", ""),
                (0, "deploy/tofu/main.tf\n", ""), (3, "error: bad\n", ""),
                (3, "deploy/tofu/main.tf\n", "Error: invalid input"),
                (3, "deploy/tofu/../escape.tf\n", ""),
            ]:
                self.reject("tofu-fmt", code, output, err)
        with patch.object(Path, "is_file", return_value=False):
            self.reject("tofu-fmt", 3, "deploy/tofu/main.tf\n", "")
        self.assertEqual(quality.classify("tofu-fmt", 0, "", ""), 0)

    def test_real_source_scanner_complete_findings_and_io_failures(self):
        shell = shutil.which("pwsh") or shutil.which("powershell")
        self.assertIsNotNone(shell, "PowerShell is required to prove scanner behavior")
        roots = ["apps", "crates", "services", "workers", "packages", "scripts", "deploy", ".github"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in roots:
                (root / name).mkdir()
                (root / name / "sample.rs").write_text("fn sample() {}\n", encoding="utf-8")
            scanner = root / "scripts/Test-SourceSize.ps1"
            shutil.copyfile(ROOT / "scripts/Test-SourceSize.ps1", scanner)

            def run():
                report = root / "report.json"
                if report.exists():
                    report.unlink()
                p = subprocess.run([shell, "-NoProfile", "-File", str(scanner),
                                    "-JsonOutput", str(report)], capture_output=True)
                data = json.loads(report.read_bytes()) if report.exists() else None
                return p, data

            p, data = run()
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(quality.classify("asset-lines", 0, p.stdout.decode(),
                                             p.stderr.decode(), data), 0)
            for name in ("apps", "crates"):
                (root / name / "sample.rs").write_text("let x = 1;\n" * 701, encoding="utf-8")
            p, data = run()
            self.assertEqual(p.returncode, 1, p.stderr)
            self.assertEqual(len(data["violations"]), 2)
            self.assertEqual(quality.classify("asset-lines", 1, p.stdout.decode(),
                                             p.stderr.decode(), data), 2)
            broken = copy.deepcopy(data)
            broken["files"] = []
            self.reject("asset-lines", 1, p.stdout.decode(), "", broken)
            (root / "apps/sample.rs").write_bytes(b"\xff\xfe\xff")
            p, data = run()
            self.assertEqual(p.returncode, 2)
            self.assertIsNone(data)
            (root / "apps/sample.rs").write_text("ok\n", encoding="utf-8")
            (root / "workers").rename(root / "workers-missing")
            p, data = run()
            self.assertEqual(p.returncode, 2)
            self.assertIsNone(data)

    def test_reusable_release_defaults_remain_strict(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        release = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        reports = (ROOT / ".github/workflows/development-quality.yml").read_text(encoding="utf-8")
        self.assertRegex(ci, r"(?s)strict-quality:.*?type: boolean\s+default: true")
        self.assertIn("QUALITY_STRICT: $" + "{{ inputs.strict-quality || inputs.source_ref != ''", ci)
        self.assertEqual(ci.count("if: env.QUALITY_STRICT == 'true'"), 4)
        self.assertIn("uses: ./.github/workflows/ci.yml", release)
        self.assertNotIn("strict-quality: false", release)
        self.assertIn("node --test tests/lint-glob-contract.mjs", ci)
        self.assertIn("cargo test --workspace --locked", ci)
        self.assertIn("validate -no-color", ci)
        self.assertIn("init -backend=false -input=false -lockfile=readonly", ci)
        self.assertNotIn("continue-on-error", ci + reports)
        self.assertIn("schedule:", reports)
        self.assertIn("kind: [rustfmt, asset-lines, eslint, openapi, tofu-fmt]", reports)
        self.assertIn("if-no-files-found: error", reports)


if __name__ == "__main__":
    unittest.main()
