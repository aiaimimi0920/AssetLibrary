# ZIP 8 compatibility and rollback

All four ZIP consumers (supply-chain, Loom client, Publisher CLI and scanner)
upgrade together from 2.4.2 to 8.6.0 with the existing deflate-only feature set.
The manifest, digest framing and Ed25519 signature format are unchanged.

zip 8 indexes filenames by raw bytes; zip 2 indexed their decoded strings.
Calling `by_name` with a manifest's UTF-8 name therefore stopped finding CP437
entries. The shared file lookup now scans at most 10,000 entry metadata records,
without decompressing unrelated entries, and selects the exact decoded name.
Compressed size and entry count are bounded before this lookup; entry reads
retain bounded allocation/decompression and reject symlinks/encryption.
The requested read bound is capped at the existing entry limit, avoiding
`maximum_bytes + 1` overflow for `u64::MAX`.

Frozen stored-header fixtures prove CP437, UTF-8 and Info-ZIP Unicode Path extra
fields resolve to the same decoded identity and historical canonical SHA-256.
Signatures over that frozen old digest still verify through byte and file APIs.
Existing crypto-wire fixtures, manifest tests, client verification and
deterministic publisher packaging remain part of the gates.

Different raw names which decode to the same name are deliberately rejected,
not folded into zip 2's last-wins entry. ASCII case collisions are likewise
rejected by both canonicalization and lookup. A package relying on the old
ambiguous-name behavior must be rebuilt with unique safe paths and undergo
normal verification/review. This is fail-closed compatibility tightening; it
does not rewrite historical objects, signatures or database facts. Do not claim
that library-hidden identical raw-name duplicates are detected by this change.

Rollback is a source release rollback of the four manifests, shared lookup and
Cargo.lock together; no schema or data migration exists. During mixed-version
rollout, normal historical packages keep the same digest and signature, while
ambiguous packages are not a supported interoperability case. Do not bypass
verification or permit production App Update to compensate for a rejected ZIP.
