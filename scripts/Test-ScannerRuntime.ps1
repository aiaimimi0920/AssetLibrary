$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:DATABASE_URL = "postgres://assetlibrary:$($env:POSTGRES_PASSWORD)@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_NATS_URL = 'nats://127.0.0.1:4222'
$env:ASSETLIBRARY_S3_ENDPOINT = 'http://127.0.0.1:9100'
$env:ASSETLIBRARY_S3_REGION = 'us-east-1'
$env:ASSETLIBRARY_QUARANTINE_BUCKET = 'assetlibrary-quarantine'
$env:ASSETLIBRARY_PUBLISHED_BUCKET = 'assetlibrary-published'
$env:ASSETLIBRARY_S3_FORCE_PATH_STYLE = 'true'
$env:ASSETLIBRARY_SCANNER_DELIVER_POLICY = 'new'
$env:AWS_ACCESS_KEY_ID = $env:MINIO_ROOT_USER
$env:AWS_SECRET_ACCESS_KEY = $env:MINIO_ROOT_PASSWORD

$artifactId = [guid]::NewGuid().ToString()
$env:ASSETLIBRARY_SCANNER_CONSUMER = "scanner-test-$artifactId"
$sessionId = [guid]::NewGuid().ToString()
$eventId = [guid]::NewGuid().ToString()
$objectKey = "quarantine/018f47d2-4a75-7fa1-a12b-9a1f19d46ea3/$artifactId/package.zip"
$fixture = Join-Path $env:TEMP "$artifactId.zip"
$sqlPath = Join-Path $env:TEMP "$artifactId.sql"
$stdout = Join-Path $env:TEMP "$artifactId.out"
$stderr = Join-Path $env:TEMP "$artifactId.err"
$processes = @()

try {
    $stream = [IO.File]::Open($fixture, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $stream.SetLength(1MB) } finally { $stream.Dispose() }
    $digest = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
    docker cp $fixture "assetlibrary-object-store-1:/tmp/$artifactId.zip"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    docker exec assetlibrary-object-store-1 mc cp "/tmp/$artifactId.zip" "local/assetlibrary-quarantine/$objectKey" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $sql = @"
INSERT INTO artifacts (id,release_id,status,object_key,size_bytes,media_type)
VALUES ('$artifactId','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','uploaded','$objectKey',1048576,'application/zip');
INSERT INTO upload_sessions
    (id,release_id,artifact_id,principal_issuer,principal_subject,idempotency_key,
     request_digest,object_key,part_size_bytes,max_parts,expires_at,status,expected_digest)
VALUES
    ('$sessionId','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','$artifactId',
     'assetlibrary-development','publisher-fixture','scanner-$sessionId',decode(repeat('00',32),'hex'),
     '$objectKey',5242880,1,now()+interval '1 hour','uploaded',
     '{"algorithm":"sha256","value":"sha256:$digest"}'::jsonb);
INSERT INTO outbox_events (id,subject,schema_version,aggregate_type,aggregate_id,payload)
VALUES ('$eventId','assetlibrary.artifact.verification_requested.v1','1.0','artifact','$artifactId',
        jsonb_build_object('event_id','$eventId','occurred_at',now(),'schema_version','1.0',
        'actor',jsonb_build_object('type','system','id','scanner-runtime-test'),
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
    for ($index = 0; $index -lt 60; $index++) {
        Start-Sleep -Milliseconds 500
        $status = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT status FROM artifacts WHERE id='$artifactId'").Trim()
        if ($status -eq 'quarantined') { break }
    }
    if ($status -ne 'quarantined') {
        $safeLog = (Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue | Select-Object -Last 20) -join [Environment]::NewLine
        throw "Scanner did not quarantine the invalid archive; status=$status; log=$safeLog"
    }
    $attempts = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT count(*) FROM artifact_scan_attempts WHERE artifact_id='$artifactId' AND result='quarantined'").Trim()
    $events = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT count(*) FROM outbox_events WHERE aggregate_id='$artifactId' AND subject='assetlibrary.artifact.quarantined.v1'").Trim()
    if ($attempts -ne '1' -or $events -ne '1') { throw "Unexpected scanner evidence: attempts=$attempts events=$events" }

    $duplicateEvent = [guid]::NewGuid().ToString()
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c "INSERT INTO outbox_events (id,subject,schema_version,aggregate_type,aggregate_id,payload) VALUES ('$duplicateEvent','assetlibrary.artifact.verification_requested.v1','1.0','artifact','$artifactId',jsonb_build_object('event_id','$duplicateEvent','occurred_at',now(),'schema_version','1.0','actor',jsonb_build_object('type','system','id','scanner-runtime-test'),'package_id','018f47d2-4a75-7fa1-a12b-9a1f19d46ea2','release_id','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','artifact_id','$artifactId','object_key','$objectKey','digest','sha256:$digest'));" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    for ($index = 0; $index -lt 20; $index++) {
        Start-Sleep -Milliseconds 500
        $published = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT published_at IS NOT NULL FROM outbox_events WHERE id='$duplicateEvent'").Trim()
        if ($published -eq 't') { break }
    }
    Start-Sleep -Seconds 1
    $eventsAfterReplay = (docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -Atc "SELECT count(*) FROM outbox_events WHERE aggregate_id='$artifactId' AND subject='assetlibrary.artifact.quarantined.v1'").Trim()
    if ($eventsAfterReplay -ne '1') { throw "Duplicate scan created $eventsAfterReplay quarantine events" }
    Write-Output "Scanner runtime passed: status=$status attempts=$attempts quarantine_events=$eventsAfterReplay"
} finally {
    foreach ($process in $processes) {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }
    }
    docker exec assetlibrary-object-store-1 rm -f "/tmp/$artifactId.zip" *> $null
    docker exec assetlibrary-postgres-1 rm -f "/tmp/$artifactId.sql" *> $null
    Remove-Item -LiteralPath $fixture,$sqlPath,$stdout,$stderr -Force -ErrorAction SilentlyContinue
}
