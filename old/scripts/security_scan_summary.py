"""Classify validated scan findings separately from execution/report failures."""
import argparse
import json
import os
from pathlib import Path
from sarif_coverage import expected_row_count, validate_coverage

LIMIT = 100000
LEVELS = ('info', 'low', 'moderate', 'high', 'critical')

def classify_audit(documents, statuses, advisory):
    require(len(documents) == len(statuses) == 3, "missing_project_audit_evidence")
    totals = dict.fromkeys(LEVELS, 0)
    project_reports = []
    for project, document, status in zip(("web", "client", "edge"), documents, statuses):
        require(type(status) is int and status in {0, 1} and isinstance(document, dict),
                "audit_execution_failed")
        require("error" not in document and {"actions", "advisories", "muted", "metadata"} <= set(document),
                "incomplete_audit_report")
        require(isinstance(document["actions"], list) and isinstance(document["muted"], list)
                and isinstance(document["advisories"], dict), "invalid_audit_structure")
        metadata = document["metadata"]
        require(isinstance(metadata, dict), "invalid_audit_metadata")
        for field in ("dependencies", "devDependencies", "optionalDependencies", "totalDependencies"):
            require(type(metadata.get(field)) is int and 0 <= metadata[field] <= LIMIT,
                    "invalid_audit_dependency_count")
        counts = metadata.get("vulnerabilities")
        require(isinstance(counts, dict) and set(LEVELS) <= set(counts), "incomplete_severity_counts")
        actual = dict.fromkeys(LEVELS, 0)
        identities = set()
        require(len(document["advisories"]) <= LIMIT, "audit_inventory_limit")
        for key, row in document["advisories"].items():
            require(isinstance(row, dict) and type(row.get("id")) is int and row["id"] > 0
                    and key == str(row["id"]) and row["id"] not in identities, "invalid_audit_identity")
            identities.add(row["id"])
            severity = row.get("severity")
            require(severity in LEVELS[1:], "invalid_advisory_severity")
            for field in ("module_name", "title", "vulnerable_versions", "patched_versions",
                          "github_advisory_id", "created", "updated"):
                require(isinstance(row.get(field), str) and len(row[field]) <= 4096,
                        "incomplete_advisory_detail")
            require(bool(row["module_name"]) and bool(row["title"])
                    and bool(row["vulnerable_versions"]) and bool(row["github_advisory_id"]),
                    "empty_advisory_identity")
            findings = row.get("findings")
            require(isinstance(findings, list) and 0 < len(findings) <= LIMIT, "missing_advisory_findings")
            for finding in findings:
                require(isinstance(finding, dict) and isinstance(finding.get("version"), str)
                        and bool(finding["version"]), "invalid_advisory_finding")
                paths = finding.get("paths")
                require(isinstance(paths, list) and 0 < len(paths) <= LIMIT
                        and all(isinstance(path, str) and 0 < len(path) <= 4096 for path in paths),
                        "missing_advisory_paths")
                for field in ("dev", "optional", "bundled"):
                    require(type(finding.get(field)) is bool, "invalid_advisory_finding_flags")
            actual[severity] += 1
        require(all(type(counts[level]) is int and 0 <= counts[level] <= LIMIT for level in LEVELS),
                "invalid_audit_count")
        require({level: counts[level] for level in LEVELS} == actual,
                "advisory_severity_count_mismatch")
        gate_count = sum(actual[level] for level in LEVELS[2:])
        require(bool(gate_count) == (status == 1), "audit_exit_result_mismatch")
        for level in LEVELS:
            totals[level] += actual[level]
        project_reports.append({"project": project, "scanner_exit": status,
                                "severity_counts": actual, "advisory_records": sum(actual.values())})
    gate = sum(totals[level] for level in LEVELS[2:])
    facts = {"analysis_complete": True, "report_valid": True,
             "vulnerability_records": sum(totals.values()), "severity_counts": totals,
             "project_reports": project_reports,
             "raw_exits": {row["project"]: row["scanner_exit"] for row in project_reports},
             "findings_observed": bool(sum(totals.values())), "gate_findings": gate,
             "development_advisory": advisory, "report_success": advisory or gate == 0}
    return facts, 0 if advisory or gate == 0 else 1

def require(condition, code):
    if not condition:
        raise ValueError(code)

def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_json_key")
        result[key] = value
    return result

def read_json(path):
    require(path.is_file() and not path.is_symlink()
            and path.stat().st_size <= 20 * 1024 * 1024, "invalid_scan_artifact")
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique)

def classify_osv(document, sarif, scan_exit, report_exit, lockfiles, advisory):
    require(type(scan_exit) is int and type(report_exit) is int
            and scan_exit in {0, 1} and report_exit in {0, 1}, "scan_execution_failed")
    sources = document.get("results")
    require(isinstance(sources, list) and 0 < len(sources) <= 100, "missing_inventory")
    expected = {"/github/workspace/" + path for path in lockfiles}
    require(len(expected) == len(lockfiles) and bool(expected), "invalid_selected_inputs")
    seen, packages, vulnerabilities = set(), 0, 0
    for source in sources:
        location = source.get("source", {})
        require(location.get("type") == "lockfile" and location.get("path") in expected,
                "unexpected_scanned_input")
        seen.add(location["path"])
        entries = source.get("packages")
        require(isinstance(entries, list) and bool(entries), "missing_package_inventory")
        packages += len(entries)
        require(packages <= LIMIT, "inventory_limit")
        for entry in entries:
            package = entry.get("package", {})
            require(all(isinstance(package.get(key), str) and 0 < len(package[key]) <= 512
                        for key in ("name", "version", "ecosystem")), "invalid_package_identity")
            vulns = entry.get("vulnerabilities", [])
            require(isinstance(vulns, list), "invalid_vulnerability_inventory")
            ids = {row["id"] for row in vulns}
            require(all(isinstance(value, str) and 0 < len(value) <= 160 for value in ids),
                    "invalid_vulnerability_id")
            vulnerabilities += len(ids)
    require(seen == expected, "missing_selected_lock")
    require(vulnerabilities <= LIMIT and bool(vulnerabilities) == (scan_exit == 1),
            "scan_exit_inventory_mismatch")
    require(report_exit == scan_exit, "report_exit_mismatch")
    require(sarif.get("version") == "2.1.0" and len(sarif.get("runs", [])) == 1,
            "invalid_sarif")
    run = sarif["runs"][0]
    driver = run.get("tool", {}).get("driver", {})
    require(driver.get("name") == "osv-scanner" and driver.get("version") == "2.5.1",
            "unexpected_sarif_tool")
    require(len(run.get("results", [])) == expected_row_count(document), "sarif_count_mismatch")
    if "invocations" in run:
        require(isinstance(run["invocations"], list), "invalid_sarif_invocations")
        for invocation in run["invocations"]:
            require(isinstance(invocation, dict)
                    and type(invocation.get("executionSuccessful")) is bool
                    and invocation["executionSuccessful"], "sarif_execution_failure")
            for field in ("toolExecutionNotifications", "toolConfigurationNotifications"):
                notifications = invocation.get(field, [])
                require(isinstance(notifications, list), "invalid_sarif_notifications")
                for notification in notifications:
                    require(isinstance(notification, dict)
                            and notification.get("level", "warning") in {"note", "warning", "error"},
                            "invalid_sarif_notification")
                    require(notification.get("level") != "error", "sarif_error_diagnostic")
    coverage = validate_coverage(document, sarif)
    facts = {"analysis_complete": True, "report_valid": True,
             "package_count": packages, "selected_lockfiles": len(seen),
             "vulnerability_records": vulnerabilities, "sarif_result_count": len(run["results"]),
             "scanner_exit": scan_exit, "reporter_exit": report_exit,
             "findings_observed": vulnerabilities > 0, "development_advisory": advisory,
             "existing_exception_policy_unchanged": True, **coverage}
    return facts, 0 if advisory else scan_exit

def summarize(facts):
    destination = os.environ.get("GITHUB_STEP_SUMMARY")
    if destination:
        fields = ("analysis_complete", "report_valid", "selected_lockfiles", "package_count",
                  "vulnerability_records", "sarif_result_count", "scanner_exit", "reporter_exit",
                  "development_advisory")
        lines = ["### Dependency security report", "", "| Field | Value |", "| --- | --- |"]
        lines.extend("| " + key + " | " + str(facts[key]) + " |" for key in fields if key in facts)
        with open(destination, "a", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")

def output(valid):
    destination = os.environ.get("GITHUB_OUTPUT")
    if destination:
        with open(destination, "a", encoding="utf-8") as stream:
            stream.write("report_valid=" + str(valid).lower() + "\n")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="tool", required=True)
    osv = subparsers.add_parser("osv")
    osv.add_argument("--json", type=Path, required=True)
    osv.add_argument("--sarif", type=Path, required=True)
    osv.add_argument("--scan-exit", type=int, required=True)
    osv.add_argument("--report-exit", type=int, required=True)
    osv.add_argument("--lockfile", action="append", required=True)
    osv.add_argument("--advisory", action="store_true")
    audit = subparsers.add_parser("audit")
    audit.add_argument("--evidence", type=Path, required=True)
    audit.add_argument("--statuses", required=True)
    audit.add_argument("--advisory", action="store_true")
    args = parser.parse_args()
    try:
        output(False)
        if args.tool == "osv":
            facts, status = classify_osv(read_json(args.json), read_json(args.sarif),
                args.scan_exit, args.report_exit, args.lockfile, args.advisory)
        else:
            files = [args.evidence / ("pnpm-audit-" + name + ".json") for name in ("web", "client", "edge")]
            facts, status = classify_audit([read_json(path) for path in files],
                [int(value) for value in args.statuses.split(",")], args.advisory)
        summarize(facts)
        output(True)
        print(json.dumps(facts, sort_keys=True))
        return status
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
        print(json.dumps({"analysis_complete": False, "report_valid": False,
                          "error_kind": "scan_execution_or_report_failure"}))
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
