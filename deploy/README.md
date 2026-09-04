# Deployment

`local/compose.yaml` runs the same service categories used by production, with
MinIO acting only as the local S3-compatible endpoint. It binds every management
port to loopback and requires generated credentials. Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Start-LocalDependencies.ps1
```

Community MinIO exposes cluster-wide rather than per-bucket CORS configuration.
The Compose service therefore maps `ASSETLIBRARY_BROWSER_ORIGINS` to MinIO's
comma-separated allowlist; its local default contains only the normal Next
development and Publisher runtime origins. Keep this browser-origin setting
separate from `ASSETLIBRARY_UPLOAD_ORIGINS`, which is the Next server's allowlist
for presigned object-store destinations. Production object storage must use exact
HTTPS web origins and must never use a wildcard.

Production uses the Helm chart and OpenTofu environment modules. CI may run
format, initialization without a backend, validation, rendering, and policy
checks. It must never run a real plan or apply without an explicit operator
workflow and environment approval. Staging and production use separate remote
state prefixes, namespaces, bucket prefixes, credentials, and signing keys.
