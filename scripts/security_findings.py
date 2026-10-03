"""Validate scanner reports before treating findings as development advisories."""
import argparse
import hashlib
import json
import os
from pathlib import Path


def require(value, message):
    if not value:
        raise ValueError(message)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def read(path):
    require(path.is_file() and not path.is_symlink()
            and 0 < path.stat().st_size <= 32 * 1024 * 1024, "missing or oversized report")
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique)


def classify(kind, data, status):
    require(type(status) is int, "missing scanner exit")
    findings = []
    if kind == "gitleaks":
        require(status in (0, 42), "Gitleaks execution failed")
        require(isinstance(data, list), "invalid Gitleaks inventory")
        for row in data:
            require(all(row.get(k) for k in ("RuleID", "File", "Fingerprint")),
                    "incomplete Gitleaks finding")
            require(type(row.get("StartLine")) is int, "invalid finding location")
            require(row.get("Secret") in ("", "REDACTED") and
                    row.get("Match") in ("", "REDACTED"), "unredacted secret report")
            findings.append({"rule": row["RuleID"], "file": row["File"],
                             "line": row["StartLine"], "identity": row["Fingerprint"]})
    elif kind == "trivy":
        require(status in (0, 42), "Trivy execution failed")
        require(isinstance(data, dict) and data.get("SchemaVersion") == 2,
                "invalid Trivy report")
        results = data.get("Results")
        require(isinstance(results, list) and len(results) > 0, "empty IaC scan coverage")
        executed = 0
        for result in results:
            require(result.get("Target") and result.get("Class") == "config",
                    "unexpected IaC result")
            summary = result.get("MisconfSummary")
            require(isinstance(summary, dict) and
                    all(type(summary.get(k)) is int for k in ("Successes", "Failures")),
                    "missing IaC check inventory")
            require(all(v >= 0 for v in summary.values()), "invalid IaC counts")
            executed += sum(summary.values())
            rows = result.get("Misconfigurations", [])
            require(isinstance(rows, list), "invalid IaC findings")
            for row in rows:
                require(row.get("ID") and row.get("Status") in ("FAIL", "PASS", "EXCEPTION"),
                        "invalid IaC finding")
                if row["Status"] == "FAIL":
                    findings.append({"rule": row["ID"], "file": result["Target"],
                                     "severity": row.get("Severity", "UNKNOWN")})
        require(executed > 0, "no IaC checks executed")
    elif kind == "review":
        require(status == 0 and isinstance(data, dict), "Dependency Review execution failed")
        changes, vulnerable = data.get("changes"), data.get("vulnerable")
        require(isinstance(changes, list) and isinstance(vulnerable, list),
                "missing Dependency Review outputs")
        require(isinstance(data.get("summary"), str) and data["summary"].strip(),
                "missing Dependency Review summary")
        require("snapshot warning" not in data["summary"].lower(),
                "incomplete dependency snapshots")
        for row in vulnerable:
            require(row.get("manifest") and row.get("name") and row.get("version")
                    and isinstance(row.get("vulnerabilities"), list),
                    "invalid dependency finding")
            for vuln in row["vulnerabilities"]:
                require(vuln.get("advisory_url"), "missing advisory identity")
                findings.append({"rule": vuln["advisory_url"], "file": row["manifest"],
                                 "package": row["name"], "version": row["version"]})
    else:
        raise ValueError("unknown scanner")
    if kind != "review":
        require(bool(findings) == (status == 42), "scanner exit/report mismatch")
    require(len(findings) <= 100000, "finding limit exceeded")
    dedup = {}
    for finding in findings:
        key = hashlib.sha256(json.dumps(finding, sort_keys=True).encode()).hexdigest()
        dedup[key] = {"fingerprint": key, **finding}
    return {"schema": 1, "tool": kind, "report_valid": True, "scanner_exit": status,
            "finding_count": len(dedup), "findings": list(dedup.values())}


def write_summary(report, path):
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    destination = os.environ.get("GITHUB_STEP_SUMMARY")
    if destination:
        with open(destination, "a", encoding="utf-8") as stream:
            stream.write("### " + report["tool"] + " development report\n\n")
            stream.write("Validated findings: **" + str(report["finding_count"]) + "**. ")
            stream.write("This check report is keyed by scanner and stable finding fingerprint; ")
            stream.write("repeated findings do not create repeated Issues. ")
            stream.write("Complete findings and raw evidence are retained in this run's artifact.\n\n")
            stream.write("Findings are advisory only in development; execution, parsing, ")
            stream.write("coverage and upload errors remain failures. Release policy is unchanged.\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("gitleaks", "trivy", "review"))
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    try:
        if args.kind == "review":
            data = {"changes": json.loads(os.environ["REVIEW_CHANGES"]),
                    "vulnerable": json.loads(os.environ["REVIEW_VULNERABLE"]),
                    "summary": os.environ["REVIEW_SUMMARY"]}
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        report = classify(args.kind, read(args.report), args.exit_code)
        write_summary(report, args.report.with_suffix(".validated.json"))
        print(json.dumps({k: v for k, v in report.items() if k != "findings"}))
        return 1 if args.strict and report["finding_count"] else 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print("::error::Scanner execution or report validation failed: " + type(error).__name__
              + (": " + str(error) if type(error) is ValueError else ""))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
