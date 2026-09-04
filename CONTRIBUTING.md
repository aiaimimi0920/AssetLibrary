# Contributing

1. Read `AGENTS.md` and `DEVELOPMENT_PLAN.md` before changing architecture.
2. Keep account concerns behind `PrincipalRef`; do not add account storage or
   authentication flows to this repository.
3. Update the OpenAPI/AsyncAPI contract and JSON Schemas with behavior changes.
4. Add a focused regression test for each non-trivial behavior change.
5. Run the applicable Rust, web, contract, and security checks locally.
6. Keep commits scoped to one subsystem and explain security or migration
   implications in the commit body.

Pull requests must describe API compatibility, storage changes, rollout and
rollback steps, observability changes, and any residual risk.
