# ADR-003: Rust control plane

Status: Accepted

The API and asynchronous workers use Rust, Tokio, Axum, Tower, and SQLx. Rust
provides predictable memory use and strong correctness properties for high
concurrency. Axum/Tower provide composable HTTP middleware without a custom
runtime. SQLx keeps SQL explicit and compile-checkable.

Domain and application code depend on ports, not cloud SDKs. Provider and
database adapters are replaceable without changing state-machine rules.
