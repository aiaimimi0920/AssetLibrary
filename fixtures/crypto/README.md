# Frozen compatibility fixtures

All keys and seeds here are public, synthetic test values. They must never be
used for real identities, credentials, or deployments.

`ed25519-compatibility-v1.json` was frozen from the actual production verifier
and original locked ed25519-dalek 2.2.0 / PKCS8 0.10.2 at AssetLibrary commit
`3b02dae005b5922e1538e1c0a416ceea9df37401`, using Rust 1.95.0. It covers five
fixed seeds, 70 signatures, 274 verification cases, 87 DER inputs, and eight
PEM inputs. Node WebCrypto independently reproduced all five public keys and
all 70 valid signatures from those same public synthetic seeds.

Its SHA-256 is
`4c97297fb028d56c81dbd13241fe66becb41076a49b0631fe4dfac146edb442b`.
`queued-receipt-v1.json` freezes actual `QueuedReceipt` serialization from the
same commit, with SHA-256
`b92cd80c48adbcaebc3ef8c51d77da6b10b2fddb214bd17b660b5433b9f0b625`.
Do not regenerate these expected values using the dependency version under test.

The verification corpus documents existing behavior, including eight weak-key
cases accepted by ordinary verification and rejected by strict verification.
Matching the oracle is a compatibility check, not evidence that weak-key
admission is safe or fixed. Publisher registration and install challenges
currently validate canonical 32-byte encoding without rejecting weak keys;
their separate authorization and identity bindings remain required. Changing
new-key admission or migrating existing keys/verification policy requires a
separate security and compatibility decision.
