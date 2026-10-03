# Security scanning

The Security workflow runs on pull requests, main, weekly, and manual dispatch.
Its OSV and pnpm scans report validated findings as development advisories.
Finding counts remain in the job summary and evidence. Each pnpm project's
raw exit is retained in the classifier's JSON log output.
Tool errors, timeouts, invalid JSON/SARIF, missing locks, and mismatched reports
remain failures. Available validated SARIF is uploaded even if strict findings
fail a release scan.

Release callers retain the shared policy's strict default. Tag scans are strict.
Dependency-review's moderate gate, secrets, and IaC gates remain in place.
CodeQL runs security-extended queries for Rust, JavaScript/TypeScript, and Actions
without a product build. Its bounded report distinguishes completion,
diagnostics, and findings; counts are SARIF rows, not native open-alert counts.

The four existing locks and the existing advisory exception are unchanged.
Dependabot is weekly, bounded, and groups only minor/patch OpenTelemetry updates.
Major changes require separate review; this configuration approves nothing.
Native security settings are separate from these files and are not changed here.
