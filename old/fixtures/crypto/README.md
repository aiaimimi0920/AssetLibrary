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

The paired dalek 3 / PKCS8 0.11 upgrade keeps the existing ordinary verifier.
Receipt key generation uses the official `getrandom::SysRng` adapter and
`UnwrapErr`, preserving the prior OS-entropy failure behavior without a fallback.
The scanner explicitly retains dalek 2.2's `zeroize` feature for the separate
nkeys/NATS dependency, because removing the old direct dependency would otherwise
remove its existing drop guard. No old signature API is called by this feature
guard. Other NATS consumers keep their original individual feature sets.

`pkcs8-boundaries-v1.json` records 26 additional old-library DER and LF/CRLF
PEM results separately from the intended CLI policy. New dalek 3 silently
discards a non-byte-aligned embedded public key; the CLI explicitly rejects
nonzero BIT STRING unused bits before the normal keypair consistency check.
This restores the old rejection for unused bits 1-7, mismatches, and invalid
public-key lengths. Valid PKCS8 v1/v2 and constructed empty attributes remain
accepted. The original PEM whitespace and label cases also run through the
actual CLI file-import path.

Two malformed primitive attribute encodings (tag `0x80`, empty or NULL content)
were accepted by the old parser and are rejected by the new parser. This
fail-closed tightening is intentional: RFC 5958 defines Attributes as a
constructed SET OF, whose context-specific tag is `0xA0`. The fixture preserves
both the old result and the new expected CLI result; complete malformed-DER
acceptance-set equality is not claimed. See
<https://www.rfc-editor.org/rfc/rfc5958#section-2>.
