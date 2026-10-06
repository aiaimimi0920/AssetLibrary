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
$sessionId = [guid]::NewGuid().ToString()
$eventId = [guid]::NewGuid().ToString()
$objectKey = "quarantine/018f47d2-4a75-7fa1-a12b-9a1f19d46ea3/$artifactId/package.zip"
$fixture = Join-Path $env:TEMP "$artifactId.zip"
$sqlPath = Join-Path $env:TEMP "$artifactId.sql"
$stdout = Join-Path $env:TEMP "$artifactId.out"
$stderr = Join-Path $env:TEMP "$artifactId.err"
$processes = @()
$expectedPublishedKey = $null

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:DATABASE_URL = "postgres://assetlibrary:$($env:POSTGRES_PASSWORD)@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_NATS_URL = 'nats://127.0.0.1:4222'
$env:ASSETLIBRARY_S3_ENDPOINT = 'http://127.0.0.1:9100'
$env:ASSETLIBRARY_S3_REGION = 'us-east-1'
$env:ASSETLIBRARY_QUARANTINE_BUCKET = 'assetlibrary-quarantine'
$env:ASSETLIBRARY_PUBLISHED_BUCKET = 'assetlibrary-published'
$env:ASSETLIBRARY_S3_FORCE_PATH_STYLE = 'true'
$env:ASSETLIBRARY_CLAMAV_ADDRESS = '127.0.0.1:3310'
$env:ASSETLIBRARY_SCANNER_CONSUMER = "scanner-test-$artifactId"
$env:ASSETLIBRARY_SCANNER_DELIVER_POLICY = 'new'
$env:AWS_ACCESS_KEY_ID = $env:MINIO_ROOT_USER
$env:AWS_SECRET_ACCESS_KEY = $env:MINIO_ROOT_PASSWORD

try {
    $metadataText = cargo run --quiet -p assetlibrary-scanner-worker --example build_signed_fixture -- $fixture
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $metadata = $metadataText | ConvertFrom-Json
    $digest = [string] $metadata.digest
    $canonicalDigest = [string] $metadata.canonical_digest
    $publicKey = [string] $metadata.public_key
    $sizeBytes = [long] $metadata.size_bytes
    if ($digest.Length -ne 64 -or $canonicalDigest.Length -ne 64 -or
        $publicKey.Length -ne 64 -or $sizeBytes -le 0 -or $digest -eq $canonicalDigest) {
        throw 'Signed fixture metadata is invalid.'
    }
    docker cp $fixture "assetlibrary-object-store-1:/tmp/$artifactId.zip"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    docker exec assetlibrary-object-store-1 mc cp "/tmp/$artifactId.zip" "local/assetlibrary-quarantine/$objectKey" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $sql = @"
INSERT INTO publisher_signing_keys (publisher_id,key_id,public_key,status)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea1','local-test-key',decode('$publicKey','hex'),'active')
ON CONFLICT (publisher_id,key_id) DO UPDATE SET public_key=EXCLUDED.public_key,status='active',revoked_at=NULL;
INSERT INTO artifacts (id,release_id,status,object_key,size_bytes,media_type)
VALUES ('$artifactId','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','uploaded','$objectKey',$sizeBytes,'application/zip');
INSERT INTO upload_sessions
    (id,release_id,artifact_id,principal_issuer,principal_subject,idempotency_key,
     request_digest,object_key,part_size_bytes,max_parts,expires_at,status,expected_digest)
VALUES
    ('$sessionId','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','$artifactId',
     'assetlibrary-development','publisher-fixture','verified-$sessionId',decode(repeat('00',32),'hex'),
     '$objectKey',5242880,1,now()+interval '1 hour','uploaded',
     '{"algorithm":"sha256","value":"sha256:$digest"}'::jsonb);
INSERT INTO outbox_events (id,subject,schema_version,aggregate_type,aggregate_id,payload)
VALUES ('$eventId','assetlibrary.artifact.verification_requested.v1','1.0','artifact','$artifactId',
        jsonb_build_object('event_id','$eventId','occurred_at',now(),'schema_version','1.0',
        'actor',jsonb_build_object('type','system','id','scanner-verified-runtime-test'),
        'package_id','018f47d2-4a75-7fa1-a12b-9a1f19d46ea2','release_id','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3',
        'artifact_id','$artifactId','object_key','$objectKey','digest','sha256:$digest'));
"@
    [IO.File]::WriteAllText($sqlPath, $sql, (New-Object Text.UTF8Encoding($false)))
    docker cp $sqlPath "assetlibrary-postgres-1:/tmp/$artifactId.sql"
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f "/tmp/$artifactId.sql" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    cargo build --quiet -p assetlibrary-outbox-worker -p assetlibrary-scanner-worker
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $scanner = Start-Process -FilePath (Join-Path $root 'target/debug/assetlibrary-scanner-worker.exe') -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $processes += $scanner
    Start-Sleep -Seconds 2
    if ($scanner.HasExited) { throw 'Scanner exited before creating its durable consumer.' }
    $outbox = Start-Process -FilePath (Join-Path $root 'target/debug/assetlibrary-outbox-worker.exe') -PassThru -WindowStyle Hidden
    $processes += $outbox

    $status = ''
    for ($index = 0; $index -lt 120; $index++) {
        Start-Sleep -Milliseconds 500
        $status = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT status FROM artifacts WHERE id='$artifactId'").Trim()
        if ($status -in @('verified', 'quarantined')) { break }
    }
    if ($status -ne 'verified') {
        $failure = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT coalesce(last_scan_error,'none') FROM artifacts WHERE id='$artifactId'").Trim()
        $safeLog = (Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue | Select-Object -Last 20) -join [Environment]::NewLine
        throw "Scanner did not verify the signed archive; status=$status failure=$failure log=$safeLog"
    }
    $expectedPublishedKey = "sha256/$($canonicalDigest.Substring(0,2))/$canonicalDigest"
    $evidence = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT encode(sha256,'hex')='$digest' AND encode(canonical_sha256,'hex')='$canonicalDigest' AND published_object_key='$expectedPublishedKey' AND manifest IS NOT NULL AND signature IS NOT NULL AND sbom_digest IS NOT NULL AND provenance_digest IS NOT NULL AND verified_at IS NOT NULL FROM artifacts WHERE id='$artifactId'").Trim()
    if ($evidence -ne 't') { throw 'Verified artifact evidence is incomplete.' }
    docker exec assetlibrary-object-store-1 mc stat "local/assetlibrary-published/$expectedPublishedKey" *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Published content-addressed object is missing.' }

    $duplicateEvent = [guid]::NewGuid().ToString()
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c "INSERT INTO outbox_events (id,subject,schema_version,aggregate_type,aggregate_id,payload) VALUES ('$duplicateEvent','assetlibrary.artifact.verification_requested.v1','1.0','artifact','$artifactId',jsonb_build_object('event_id','$duplicateEvent','occurred_at',now(),'schema_version','1.0','actor',jsonb_build_object('type','system','id','scanner-verified-runtime-test'),'package_id','018f47d2-4a75-7fa1-a12b-9a1f19d46ea2','release_id','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','artifact_id','$artifactId','object_key','$objectKey','digest','sha256:$digest'));" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Start-Sleep -Seconds 3
    $verifiedEvents = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT count(*) FROM outbox_events WHERE aggregate_id='$artifactId' AND subject='assetlibrary.artifact.verified.v1'").Trim()
    if ($verifiedEvents -ne '1') { throw "Duplicate scan created $verifiedEvents verified events." }
    Write-Output "Scanner verified runtime passed: status=$status published_key=$expectedPublishedKey verified_events=$verifiedEvents"
} finally {
    foreach ($process in $processes) {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }
    }
    docker exec assetlibrary-object-store-1 rm -f "/tmp/$artifactId.zip" *> $null
    docker exec assetlibrary-object-store-1 mc rm --force "local/assetlibrary-quarantine/$objectKey" *> $null
    if ($expectedPublishedKey) {
        docker exec assetlibrary-object-store-1 mc rm --force "local/assetlibrary-published/$expectedPublishedKey" *> $null
    }
    docker exec assetlibrary-postgres-1 rm -f "/tmp/$artifactId.sql" *> $null
    Remove-Item -LiteralPath $fixture,$sqlPath,$stdout,$stderr -Force -ErrorAction SilentlyContinue
}
