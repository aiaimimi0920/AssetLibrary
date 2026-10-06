# Production promotion evidence workspace

This directory tracks only the production-promotion evidence policy. Collected
`evidence/` and the generated `verification-report.json` are ignored runtime
artifacts; retain them in the approved immutable evidence system, not Git.

The bundle contract is
`schemas/production-promotion-evidence.schema.json`. Validate a redacted bundle
from the repository root with:

```powershell
node scripts/verify-production-promotion.mjs `
  --evidence promotion/evidence/promotion.json `
  --report promotion/verification-report.json
```

Passing proves bounded structure, file integrity, and cross-record consistency.
It never authenticates cloud/controller/reviewer identities and never grants a
production release. Those gates require the separately controlled external
attestor described in `docs/operations/RELEASE_SECURITY_RUNBOOK.md`.
