# Development security reports

Ordinary PR, main and scheduled scans retain validated findings without failing
the workflow merely because findings exist. Scanner download, execution,
inventory, parsing and upload failures still fail. Reusable release callers
remain strict by default; tag, signature and deployment gates are unchanged.

OSV and CodeQL retain complete SARIF and native code-scanning deduplication.
Dependency Review, Gitleaks and Trivy retain JSON plus a validated report with
stable finding fingerprints. The PR's check summary and run artifact are the
report channel; identical findings are collapsed within each report. No new
issue-writing permission or automatic repair/deployment is introduced.
An empty findings array is valid only in a successfully executed, structured
report; missing reports and empty IaC coverage are errors.

Existing dependency exceptions, Gitleaks ignores and compatibility deferrals
are unchanged. A successful advisory scan does not mean vulnerabilities were
fixed or that a release is approved. Native repository security switches must
be verified separately from workflow existence.
