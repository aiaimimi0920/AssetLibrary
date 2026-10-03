"""Classify development quality reports without masking tool failures."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def classify(kind, code, stdout, stderr, report=None):
    # rust-toolchain enables ANSI color in hosted CI; retain raw logs unchanged.
    stdout = re.sub(r"\x1b\[[0-9;]*m", "", stdout)
    stderr = re.sub(r"\x1b\[[0-9;]*m", "", stderr)

    if kind == "openapi":
        require(code in (0, 1), "Redocly execution failed")
        data = json.loads(stdout)
        require(isinstance(data, dict) and data.get("version") == "2.54.3",
                "unexpected Redocly version/schema")
        totals, problems = data.get("totals"), data.get("problems")
        require(isinstance(totals, dict) and isinstance(problems, list),
                "missing Redocly report")
        for key in ("errors", "warnings", "ignored"):
            require(type(totals.get(key)) is int and totals[key] >= 0, "invalid Redocly totals")
        require(totals["errors"] + totals["warnings"] == len(problems),
                "Redocly report is incomplete")
        for p in problems:
            require(isinstance(p, dict) and p.get("ruleId") and p.get("message")
                    and p.get("location") and p.get("severity") in ("error", "warn"),
                    "invalid Redocly problem")
            require(p["ruleId"] not in ("no-unresolved-refs", "spec"),
                    "Redocly input/reference parsing failed")
        require(sum(p["severity"] == "error" for p in problems) == totals["errors"]
                and sum(p["severity"] == "warn" for p in problems) == totals["warnings"],
                "Redocly severity counts disagree")
        require((code == 1) == (totals["errors"] > 0), "Redocly exit/report mismatch")
        allowed = (
            r"No configurations were provided -- using built in recommended configuration by default\.",
            r"validating .+\.\.\.", r".+: validated in \d+ms",
            r"❌ Validation failed with \d+ errors?(?: and \d+ warnings?)?\.",
            r"Woohoo! Your API description is valid\. 🎉", r"You have \d+ warnings?\.",
            r"run \x60redocly lint --generate-ignore-file\x60 to add all problems to the ignore file\.",
        )
        require(any(re.fullmatch(r".+: validated in \d+ms", s.strip())
                    for s in stderr.splitlines()), "Redocly did not validate an input")
        require(all(not s.strip() or any(re.fullmatch(p, s.strip()) for p in allowed)
                    for s in stderr.splitlines()), "unknown Redocly diagnostic")
        return len(problems)
    if kind == "tofu-fmt":
        require(code in (0, 3) and not stderr.strip(), "OpenTofu parsing or execution failed")
        paths = stdout.splitlines()
        require((code == 3) == bool(paths), "OpenTofu exit/diff mismatch")
        require(all(re.fullmatch(r"deploy/tofu/[A-Za-z0-9_./-]+\.(tf|tfvars)", p)
                    and ".." not in p.split("/") and Path(p).is_file() for p in paths),
                "unknown OpenTofu diff output")
        return len(paths)
    if kind == "asset-lines":
        require(code in (0, 1) and not stderr.strip(), "source size scanner failed")
        require(isinstance(report, dict) and report.get("schemaVersion") == 1
                and report.get("threshold") == 700, "invalid source size schema")
        roots = ("apps", "crates", "services", "workers", "packages", "scripts", "deploy", ".github")
        require(report.get("roots") == list(roots), "incomplete source root coverage")
        files, violations = report.get("files"), report.get("violations")
        require(isinstance(files, list) and files and report.get("scanned") == len(files),
                "empty/incomplete source size report")
        require(isinstance(violations, list), "missing source size findings")
        require(all(isinstance(f, dict) and f.get("path")
                    and type(f.get("effective")) is int and f["effective"] >= 0 for f in files),
                "invalid source file entry")
        require(len({f["path"] for f in files}) == len(files), "duplicate source entries")
        require({f["path"].split("/")[0] for f in files} == set(roots),
                "source root scanned no files")
        expected = [f'{f["path"]}: {f["effective"]} effective lines (hard limit 700)'
                    for f in files if f["effective"] > 700]
        require(violations == expected and (code == 1) == bool(violations),
                "source size findings/exit mismatch")
        expected_stdout = "\n".join(violations) if violations else "Source size contract passed."
        require(stdout.strip().splitlines() == expected_stdout.splitlines(), "unknown source size output")
        return len(violations)

    if kind == "rustfmt":
        require(code in (0, 1), "rustfmt execution failed")
        require(not stderr.strip(), "rustfmt emitted diagnostics on stderr")
        if code == 0:
            require(not stdout.strip(), "unexpected rustfmt success output")
            return 0
        diffs = re.findall(r"(?m)^Diff in .+:\d+:\s*$", stdout)
        require(diffs, "rustfmt failed without a formatting diff")
        require(all(not line or line[0] in " +-" or
                    re.fullmatch(r"Diff in .+:\d+:\s*", line)
                    for line in stdout.splitlines()),
                "rustfmt emitted output outside the diff format")
        return len(diffs)
    if kind == "eslint":
        require(not stderr.strip(), "ESLint emitted an unexpected diagnostic")
        require(code in (0, 1), "ESLint execution failed")
        rows = json.loads(stdout)
        require(isinstance(rows, list) and rows, "ESLint report is empty")
        errors = warnings = 0
        for row in rows:
            require(isinstance(row, dict) and row.get("filePath"),
                    "invalid ESLint file entry")
            for key in ("errorCount", "warningCount", "fatalErrorCount"):
                require(type(row.get(key)) is int and row[key] >= 0,
                        "invalid ESLint counts")
            require(row["fatalErrorCount"] == 0, "ESLint parsing failed")
            require(isinstance(row.get("messages"), list), "missing ESLint messages")
            require(not any(m.get("fatal") for m in row["messages"]),
                    "ESLint parsing failed")
            require(len(row["messages"]) == row["errorCount"] + row["warningCount"],
                    "ESLint report counts disagree")
            errors += row["errorCount"]
            warnings += row["warningCount"]
        require((code == 1) == (errors > 0), "ESLint exit/report mismatch")
        return errors + warnings
    if kind == "clippy":
        require(code == 0, "Clippy compilation or execution failed")
        require(all(not line.strip() or re.match(
            r"^\s*(Checking|Compiling|Finished|Fresh|Updating|Downloading|Downloaded|Locking|Adding|Blocking|warning:)(?:\s|:)", line)
                    for line in stderr.splitlines()), "unknown Cargo/Clippy diagnostic")
        events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
        require(events and events[-1].get("reason") == "build-finished"
                and events[-1].get("success") is True, "incomplete Clippy build report")
        messages = [x["message"] for x in events if x.get("reason") == "compiler-message"]
        require(not any(m.get("level") == "error" for m in messages),
                "Clippy compiler error")
        return sum(m.get("level") == "warning" for m in messages)
    require(kind in ("loom-lines", "beaver-lines"), "unknown report kind")
    require(code in (0, 1), "line scanner execution failed")
    require(isinstance(report, dict), "missing line report")
    violations = report.get("violations")
    require(isinstance(violations, list) and all(isinstance(v, str) for v in violations),
            "invalid line findings")
    require((code == 1) == bool(violations), "line exit/report mismatch")
    if kind == "loom-lines":
        require(report.get("schemaVersion") == 1 and report.get("mode") == "ratchet",
                "unexpected Loom report schema/mode")
        require(report.get("summary", {}).get("scanned", 0) > 0,
                "Loom scanned no sources")
        # Fail closed on scanner diagnostics and on future unknown finding forms.
        patterns = (
            r".+: oversized baseline file changed before reaching 700 lines",
            r".+: \d+ lines requires a current 501-700 exception",
        )
        require(all(any(re.fullmatch(p, v) for p in patterns) for v in violations),
                "Loom scan completeness/configuration diagnostic")
        require(isinstance(report.get("warnings"), list), "missing Loom debt report")
        return len(violations) + len(report["warnings"])
    require(isinstance(report.get("files"), list) and report["files"],
            "Beaver scanned no sources")
    require(type(report.get("ok")) is bool and report["ok"] == (code == 0),
            "Beaver report status mismatch")
    require(all(re.fullmatch(
        r".+: \d+ effective lines; (split into responsibility-owned modules \(no exception above 700\)|"
        r"split, or document a current 501-700 line exception with protective tests)", v)
                for v in violations), "Beaver scan configuration diagnostic")
    return len(violations) + sum(f.get("status") == "legacy" for f in report["files"])


def run(args):
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    result = {"kind": args.kind, "command": args.command, "status": "tool_error",
              "commit": os.environ.get("GITHUB_SHA"), "exit_code": None}
    exit_code = 2
    try:
        if args.report:
            require(not Path(args.report).exists(), "refusing a stale report")
        require(bool(args.command), "missing scanner command")
        if args.kind == "tofu-fmt":
            require(any(Path("deploy/tofu").rglob("*.tf")), "OpenTofu scanned no sources")
        process = subprocess.run(args.command, capture_output=True, timeout=args.timeout,
                                 check=False)
        result["exit_code"] = process.returncode
        # Raw bytes survive even when decoding/parsing fails.
        (output / "stdout.log").write_bytes(process.stdout)
        (output / "stderr.log").write_bytes(process.stderr)
        stdout = process.stdout.decode("utf-8-sig")
        stderr = process.stderr.decode("utf-8-sig")
        report = None
        if args.report:
            raw = Path(args.report).read_bytes()
            (output / "report.json").write_bytes(raw)
            report = json.loads(raw)
        count = classify(args.kind, process.returncode, stdout, stderr, report)
        result.update(status="findings" if count else "clean", findings=count)
        # ESLint/Redocly warnings were non-blocking even in the original strict CI.
        strict_failure = process.returncode != 0 if args.kind in ("eslint", "openapi") else bool(count)
        exit_code = 1 if strict_failure and os.environ.get("QUALITY_STRICT") == "true" else 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        if isinstance(error, subprocess.TimeoutExpired):
            (output / "stdout.log").write_bytes(error.stdout or b"")
            (output / "stderr.log").write_bytes(error.stderr or b"")
        result["error"] = str(error)
        print(f"Quality reporting failed: {error}", file=sys.stderr)
    (output / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    summary = f"### {args.kind}: {result['status']}\n\n"
    summary += f"Original exit: {result['exit_code']}; findings/debt: {result.get('findings', 'unknown')}.\n"
    summary += "Raw output and structured evidence are retained in the quality artifact.\n"
    (output / "summary.md").write_text(summary, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(summary)
    print(summary)
    return exit_code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("rustfmt", "eslint", "clippy", "loom-lines", "beaver-lines", "openapi", "tofu-fmt", "asset-lines"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--report")
    parser.add_argument("--timeout", type=int, default=1200)
    before, command = sys.argv[1:], []
    if "--" in before:
        index = before.index("--")
        before, command = before[:index], before[index + 1:]
    args = parser.parse_args(before)
    args.command = command
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
