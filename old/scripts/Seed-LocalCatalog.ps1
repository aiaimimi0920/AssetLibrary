$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}

$container = 'assetlibrary-postgres-1'
$tempSql = Join-Path $env:TEMP 'assetlibrary-local-fixture.sql'
$sql = @'
BEGIN;
INSERT INTO publishers (id, slug, display_name, status)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea1', 'neuro-fixture-publisher', 'Neuro Fixture Publisher', 'active')
ON CONFLICT (id) DO UPDATE SET status = 'active';

INSERT INTO publisher_members (publisher_id, principal_issuer, principal_subject, role, status)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea1', 'assetlibrary-development', 'publisher-fixture', 'owner', 'active')
ON CONFLICT (publisher_id, principal_issuer, principal_subject) DO UPDATE SET status = 'active';

INSERT INTO packages (id, publisher_id, slug, kind, status, name, summary)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea2', '018f47d2-4a75-7fa1-a12b-9a1f19d46ea1', 'neuro-starter-art', 'art', 'published', 'Neuro Starter Art', 'Local PostgreSQL integration fixture.')
ON CONFLICT (id) DO UPDATE SET status = 'published', updated_at = now();

INSERT INTO releases (id, package_id, version, status, created_by_issuer, created_by_subject)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea3', '018f47d2-4a75-7fa1-a12b-9a1f19d46ea2', '1.0.0-dev', 'draft', 'assetlibrary-development', 'publisher-fixture')
ON CONFLICT (id) DO UPDATE SET status = 'draft', updated_at = now();

INSERT INTO releases (id, package_id, version, status, created_by_issuer, created_by_subject, published_at)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea4', '018f47d2-4a75-7fa1-a12b-9a1f19d46ea2', '0.9.0-dev', 'published', 'assetlibrary-development', 'publisher-fixture', now())
ON CONFLICT (id) DO UPDATE SET status = 'published', published_at = COALESCE(releases.published_at, now()), updated_at = now();

INSERT INTO publisher_signing_keys (publisher_id, key_id, public_key, status)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea1', 'fixture-key', decode(repeat('02', 32), 'hex'), 'active')
ON CONFLICT (publisher_id, key_id) DO UPDATE SET status = 'active', revoked_at = NULL;

INSERT INTO artifacts (id, release_id, status, object_key, sha256, canonical_sha256, size_bytes,
    media_type, verified_at, published_object_key, scanner_version, rule_version, signature)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea5', '018f47d2-4a75-7fa1-a12b-9a1f19d46ea4', 'verified',
    'fixture/neuro-starter-art-0.9.0.zip', decode(repeat('01', 32), 'hex'), decode(repeat('01', 32), 'hex'),
    1024, 'application/zip', now(), 'sha256/01/' || repeat('01', 32), 'fixture-scanner', 'fixture-rules', '{"keyId":"fixture-key"}')
ON CONFLICT (id) DO UPDATE SET status = 'verified', canonical_sha256 = EXCLUDED.canonical_sha256,
published_object_key = EXCLUDED.published_object_key, verified_at = COALESCE(artifacts.verified_at, now()), updated_at = now();

INSERT INTO submissions (id, release_id, status, artifact_id)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea6', '018f47d2-4a75-7fa1-a12b-9a1f19d46ea4', 'approved', '018f47d2-4a75-7fa1-a12b-9a1f19d46ea5')
ON CONFLICT (release_id) DO UPDATE SET status = 'approved', artifact_id = EXCLUDED.artifact_id;

INSERT INTO published_release_artifacts (release_id, artifact_id, approval_submission_id, source, published_at)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea4', '018f47d2-4a75-7fa1-a12b-9a1f19d46ea5',
    '018f47d2-4a75-7fa1-a12b-9a1f19d46ea6', 'reviewed_submission', now())
ON CONFLICT (release_id, artifact_id) DO UPDATE SET approval_submission_id = EXCLUDED.approval_submission_id,
source = EXCLUDED.source
WHERE published_release_artifacts.source = 'legacy_backfill';
COMMIT;
'@
[IO.File]::WriteAllText($tempSql, $sql, (New-Object Text.UTF8Encoding($false)))
try {
    docker cp $tempSql "$container`:/tmp/local-fixture.sql"
    docker exec -e "PGPASSWORD=$env:POSTGRES_PASSWORD" $container psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f /tmp/local-fixture.sql
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output 'Local catalog fixture seeded.'
} finally {
    docker exec $container rm -f /tmp/local-fixture.sql *> $null
    Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue
}
