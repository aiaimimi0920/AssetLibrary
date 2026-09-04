# ADR-001: External identity and PrincipalRef

Status: Accepted

AssetLibrary consumes identity assertions from an independent Account Service.
It stores only an opaque `PrincipalRef { issuer, subject }` plus store-owned
publisher memberships and roles. Registration, credentials, MFA, sessions,
profile recovery, and account lifecycle remain outside this repository.

Production accepts only configured issuers, audiences, algorithms, and signing
keys. A development identity adapter may run only when the environment is
explicitly `development`; production startup must fail if it is selected.
