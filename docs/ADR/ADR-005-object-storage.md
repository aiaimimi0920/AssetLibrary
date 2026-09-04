# ADR-005: S3-compatible object storage and R2

Status: Accepted

Production defaults to Cloudflare R2 Standard through an S3-compatible storage
port. Quarantine and published bytes use distinct buckets, credentials, and
access policies. Objects are addressed by SHA-256 digest and are immutable once
published.

Upload sessions are bounded multipart operations. The service does not treat a
multipart ETag as a content digest; verification computes and records SHA-256.
The interface permits another S3-compatible provider without domain changes.
