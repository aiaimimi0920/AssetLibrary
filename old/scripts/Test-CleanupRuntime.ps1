$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}

$artifactId = [guid]::NewGuid().ToString()
$orphanArtifactId = [guid]::NewGuid().ToString()
$sessionId = [guid]::NewGuid().ToString()
$releaseId = '018f47d2-4a75-7fa1-a12b-9a1f19d46ea3'
$objectKey = "quarantine/$releaseId/$artifactId/expired-package.zip"
$orphanKey = "quarantine/$releaseId/$orphanArtifactId/orphan-package.zip"
$fixture = Join-Path $env:TEMP "$artifactId.zip"
$sqlPath = Join-Path $env:TEMP "$artifactId.sql"

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:DATABASE_URL = "postgres://assetlibrary:$($env:POSTGRES_PASSWORD)@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_S3_ENDPOINT = 'http://127.0.0.1:9100'
$env:ASSETLIBRARY_S3_REGION = 'us-east-1'
$env:ASSETLIBRARY_QUARANTINE_BUCKET = 'assetlibrary-quarantine'
$env:ASSETLIBRARY_PUBLISHED_BUCKET = 'assetlibrary-published'
$env:ASSETLIBRARY_S3_FORCE_PATH_STYLE = 'true'
$env:AWS_ACCESS_KEY_ID = $env:MINIO_ROOT_USER
$env:AWS_SECRET_ACCESS_KEY = $env:MINIO_ROOT_PASSWORD
$env:ASSETLIBRARY_CLEANUP_BATCH_SIZE = '1'
$env:ASSETLIBRARY_CLEANUP_CLAIM_TIMEOUT_SECONDS = '60'
$env:ASSETLIBRARY_ORPHAN_MULTIPART_GRACE_SECONDS = '1'
$env:ASSETLIBRARY_ORPHAN_MULTIPART_SCAN_LIMIT = '100'
$env:ASSETLIBRARY_ORPHAN_MULTIPART_BATCH_SIZE = '100'

try {
    [IO.File]::WriteAllBytes($fixture, [byte[]](1, 2, 3, 4))
    docker cp $fixture "assetlibrary-object-store-1:/tmp/$artifactId.zip"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    docker exec assetlibrary-object-store-1 mc cp "/tmp/$artifactId.zip" "local/assetlibrary-quarantine/$objectKey" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $sql = @"
INSERT INTO artifacts (id,release_id,status,object_key,size_bytes,media_type)
VALUES ('$artifactId','$releaseId','uploaded','$objectKey',4,'application/zip');
INSERT INTO upload_sessions
    (id,release_id,artifact_id,principal_issuer,principal_subject,idempotency_key,
     request_digest,object_key,part_size_bytes,max_parts,expires_at,status,expected_digest,
     storage_upload_id)
VALUES
    ('$sessionId','$releaseId','$artifactId','assetlibrary-development','cleanup-fixture',
     'cleanup-$sessionId',decode(repeat('00',32),'hex'),'$objectKey',5242880,1,
     now()-interval '100 days','uploaded',
     '{"algorithm":"sha256","value":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}'::jsonb,
     'already-absent-upload');
"@
    [IO.File]::WriteAllText($sqlPath, $sql, (New-Object Text.UTF8Encoding($false)))
    docker cp $sqlPath "assetlibrary-postgres-1:/tmp/$artifactId.sql"
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f "/tmp/$artifactId.sql" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    cargo run --quiet -p assetlibrary-object-store --example create_orphan_upload -- $orphanKey
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Start-Sleep -Seconds 2

    cargo run --quiet -p assetlibrary-cleanup-worker
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $evidence = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT a.status='deleted' AND us.status='deleted' AND us.cleaned_at IS NOT NULL AND us.cleanup_attempts=1 AND EXISTS (SELECT 1 FROM audit_events e WHERE e.resource_id=a.id AND e.action='artifact.quarantine.cleaned') FROM artifacts a JOIN upload_sessions us ON us.artifact_id=a.id WHERE a.id='$artifactId'").Trim()
    if ($evidence -ne 't') { throw 'Cleanup database evidence is incomplete.' }
    docker exec assetlibrary-object-store-1 sh -c "mc stat 'local/assetlibrary-quarantine/$objectKey' >/dev/null 2>&1"
    if ($LASTEXITCODE -eq 0) { throw 'Expired quarantine object still exists.' }
    $orphanEvidence = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT EXISTS (SELECT 1 FROM audit_events WHERE resource_id='$orphanArtifactId' AND action='multipart.orphan.aborted')").Trim()
    if ($orphanEvidence -ne 't') { throw 'Orphan multipart cleanup audit evidence is missing.' }
    $incomplete = docker exec assetlibrary-object-store-1 mc ls --incomplete --recursive local/assetlibrary-quarantine
    if ($incomplete -match [regex]::Escape($orphanKey)) { throw 'Unreferenced orphan multipart upload still exists.' }
    Write-Output 'Cleanup runtime passed: expired objects and unreferenced orphan multipart uploads were removed.'
} finally {
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -c "DELETE FROM audit_events WHERE resource_id IN ('$artifactId','$orphanArtifactId'); DELETE FROM upload_sessions WHERE id='$sessionId'; DELETE FROM artifacts WHERE id='$artifactId';" *> $null
    docker exec assetlibrary-object-store-1 mc rm --incomplete --recursive --force "local/assetlibrary-quarantine/quarantine/$releaseId/$orphanArtifactId/" *> $null
    docker exec assetlibrary-object-store-1 rm -f "/tmp/$artifactId.zip" *> $null
    docker exec assetlibrary-postgres-1 rm -f "/tmp/$artifactId.sql" *> $null
    Remove-Item -LiteralPath $fixture,$sqlPath -Force -ErrorAction SilentlyContinue
}
