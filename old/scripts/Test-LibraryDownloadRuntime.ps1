param([int] $Port = 18085)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}

Push-Location $root
try {
    & cargo build -p assetlibrary-api --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

$publisherId = [guid]::NewGuid().ToString()
$artPackageId = [guid]::NewGuid().ToString()
$capPackageId = [guid]::NewGuid().ToString()
$privatePackageId = [guid]::NewGuid().ToString()
$artReleaseId = [guid]::NewGuid().ToString()
$capReleaseId = [guid]::NewGuid().ToString()
$privateReleaseId = [guid]::NewGuid().ToString()
$artArtifactId = [guid]::NewGuid().ToString()
$capArtifactId = [guid]::NewGuid().ToString()
$privateArtifactId = [guid]::NewGuid().ToString()
$shadowArtifactId = [guid]::NewGuid().ToString()
$artSubmissionId = [guid]::NewGuid().ToString()
$capSubmissionId = [guid]::NewGuid().ToString()
$privateSubmissionId = [guid]::NewGuid().ToString()
$moderationCaseId = [guid]::NewGuid().ToString()
$moderationActionId = [guid]::NewGuid().ToString()
$issuer = 'assetlibrary-development'
$sqlPath = Join-Path $env:TEMP "assetlibrary-p5-$Port.sql"
$sql = @"
BEGIN;
INSERT INTO publishers (id,slug,display_name,status) VALUES
('$publisherId','p5-publisher-$Port','P5 Runtime Publisher','active');
INSERT INTO publisher_members (publisher_id,principal_issuer,principal_subject,role,status) VALUES
('$publisherId','$issuer','p5-owner-$Port','owner','active');
INSERT INTO packages (id,publisher_id,slug,kind,status,name,summary,visibility) VALUES
('$artPackageId','$publisherId','p5-art-$Port','art','published','P5 Art','Public Art','public'),
('$capPackageId','$publisherId','p5-capability-$Port','capability','published','P5 Capability','Restricted Capability','public'),
('$privatePackageId','$publisherId','p5-private-$Port','art','published','P5 Private','Private Art','private');
INSERT INTO releases (id,package_id,version,status,created_by_issuer,created_by_subject,published_at) VALUES
('$artReleaseId','$artPackageId','1.0.0','published','$issuer','p5-owner-$Port',now()),
('$capReleaseId','$capPackageId','2.0.0','published','$issuer','p5-owner-$Port',now()),
('$privateReleaseId','$privatePackageId','3.0.0','published','$issuer','p5-owner-$Port',now());
INSERT INTO publisher_signing_keys (publisher_id,key_id,public_key,status) VALUES
('$publisherId','p5-runtime-key',decode(repeat('11',32),'hex'),'active');
INSERT INTO artifacts (id,release_id,status,object_key,sha256,canonical_sha256,size_bytes,media_type,
verified_at,published_object_key,scanner_version,rule_version,scan_evidence,signature) VALUES
('$artArtifactId','$artReleaseId','verified','fixture/$artArtifactId.zip',decode(repeat('aa',32),'hex'),decode(repeat('aa',32),'hex'),1024,'application/zip',now(),'sha256/aa/' || repeat('aa',32),'scanner-runtime','rules-runtime','{}','{"keyId":"p5-runtime-key"}'),
('$capArtifactId','$capReleaseId','verified','fixture/$capArtifactId.zip',decode(repeat('bb',32),'hex'),decode(repeat('bb',32),'hex'),2048,'application/zip',now(),'sha256/bb/' || repeat('bb',32),'scanner-runtime','rules-runtime','{}','{"keyId":"p5-runtime-key"}'),
('$privateArtifactId','$privateReleaseId','verified','fixture/$privateArtifactId.zip',decode(repeat('cc',32),'hex'),decode(repeat('cc',32),'hex'),4096,'application/zip',now(),'sha256/cc/' || repeat('cc',32),'scanner-runtime','rules-runtime','{}','{"keyId":"p5-runtime-key"}'),
('$shadowArtifactId','$capReleaseId','verified','fixture/$shadowArtifactId.zip',decode(repeat('dd',32),'hex'),decode(repeat('dd',32),'hex'),8192,'application/zip',now(),'sha256/dd/' || repeat('dd',32),'scanner-runtime','rules-runtime','{}','{"keyId":"p5-runtime-key"}');
INSERT INTO submissions(id,release_id,status,artifact_id) VALUES
('$artSubmissionId','$artReleaseId','approved','$artArtifactId'),
('$capSubmissionId','$capReleaseId','approved','$capArtifactId'),
('$privateSubmissionId','$privateReleaseId','approved','$privateArtifactId');
INSERT INTO published_release_artifacts(release_id,artifact_id,approval_submission_id,source,published_at) VALUES
('$artReleaseId','$artArtifactId','$artSubmissionId','reviewed_submission',now()),
('$capReleaseId','$capArtifactId','$capSubmissionId','reviewed_submission',now()),
('$privateReleaseId','$privateArtifactId','$privateSubmissionId','reviewed_submission',now());
COMMIT;
"@
[IO.File]::WriteAllText($sqlPath, $sql, (New-Object Text.UTF8Encoding($false)))
docker cp $sqlPath "assetlibrary-postgres-1:/tmp/p5-runtime.sql" | Out-Null
docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f /tmp/p5-runtime.sql | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$secret = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secret)
$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:ASSETLIBRARY_BIND = "127.0.0.1:$Port"
$env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL = 'http://downloads.local'
$env:ASSETLIBRARY_RESTRICTED_DOWNLOAD_BASE_URL = 'http://downloads.local'
$env:ASSETLIBRARY_DOWNLOAD_TICKET_ISSUER = 'assetlibrary-runtime'
$env:ASSETLIBRARY_DOWNLOAD_TICKET_AUDIENCE = 'edge-runtime'
$env:ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64 = [Convert]::ToBase64String($secret).TrimEnd('=').Replace('+','-').Replace('/','_')
$env:ASSETLIBRARY_DOWNLOAD_TICKET_TTL_SECONDS = '300'
$executable = Join-Path $root 'target/debug/assetlibrary-api.exe'
$stdout = Join-Path $env:TEMP "assetlibrary-p5-$Port.stdout.log"
$stderr = Join-Path $env:TEMP "assetlibrary-p5-$Port.stderr.log"
$process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr

function Headers([string] $Subject, [string] $Key) {
    return @{ Authorization = "Bearer dev-$Subject"; 'Idempotency-Key' = $Key; 'Content-Type' = 'application/json' }
}
function Expect-Status([scriptblock] $Action, [int] $Expected) {
    try { & $Action | Out-Null; throw "Request unexpectedly succeeded; expected HTTP $Expected." }
    catch { if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne $Expected) { throw } }
}

try {
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        try { $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 }
        catch { $health = $null }
    } while (-not $health -and (Get-Date) -lt $deadline)
    if (-not $health) { throw 'P5 API did not become healthy.' }

    $public = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/v1/public/artifacts/$artArtifactId/download"
    if ($public.download_url -ne "http://downloads.local/public/sha256/$('aa' * 32)/p5-art-$Port-1.0.0.zip") {
        throw 'Public Art did not resolve to its immutable digest URL.'
    }
    Expect-Status { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/public/artifacts/$capArtifactId/download" -ErrorAction Stop } 404
    Expect-Status { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/public/artifacts/$privateArtifactId/download" -ErrorAction Stop } 404

    $downloadUri = "http://127.0.0.1:$Port/v1/me/artifacts/$capArtifactId/download-sessions"
    $downloadBody = @{ client_type = 'loom' } | ConvertTo-Json
    $downloadHeaders = Headers "p5-user-$Port" "p5-download-$Port"
    $issuedResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $downloadUri -Headers $downloadHeaders -Body $downloadBody
    $issued = $issuedResponse.Content | ConvertFrom-Json
    $replayed = Invoke-RestMethod -Method Post -Uri $downloadUri -Headers $downloadHeaders -Body $downloadBody
    if ($issuedResponse.Headers['Cache-Control'] -ne 'no-store' -or $issued.session_id -ne $replayed.session_id -or $issued.access_token -ne $replayed.access_token) {
        throw 'Restricted ticket response was cacheable or not deterministic under idempotent replay.'
    }
    if ($issued.download_url -match 'access_token|ticket=' -or $issued.access_token -notmatch '^v1\.') {
        throw 'Restricted ticket leaked into URL or used an unexpected format.'
    }
    $payload = $issued.access_token.Split('.')[1].Replace('-','+').Replace('_','/')
    while (($payload.Length % 4) -ne 0) { $payload += '=' }
    $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    if ($claims.PSObject.Properties.Name -contains 'principal' -or $claims.artifact_id -ne $capArtifactId -or $claims.purpose -ne 'download') {
        throw 'Edge ticket claims leaked identity or were not bound to the requested artifact.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $downloadUri -Headers $downloadHeaders `
            -Body (@{ client_type = 'hook' } | ConvertTo-Json) -ErrorAction Stop
    } 409
    $shadowUri = "http://127.0.0.1:$Port/v1/me/artifacts/$shadowArtifactId/download-sessions"
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $shadowUri -Headers (Headers "p5-user-$Port" "shadow-download-$Port") `
            -Body (@{ client_type = 'loom' } | ConvertTo-Json) -ErrorAction Stop
    } 404

    $privateUri = "http://127.0.0.1:$Port/v1/me/artifacts/$privateArtifactId/download-sessions"
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $privateUri -Headers (Headers "p5-user-$Port" "private-denied-$Port") `
            -Body (@{ client_type = 'web' } | ConvertTo-Json) -ErrorAction Stop
    } 404
    $privateSession = Invoke-RestMethod -Method Post -Uri $privateUri -Headers (Headers "p5-owner-$Port" "private-owner-$Port") `
        -Body (@{ client_type = 'web' } | ConvertTo-Json)
    if (-not $privateSession.session_id) { throw 'Private publisher member did not receive a ticket.' }

    $libraryBody = @{ status='listed'; favorite=$true; installed_release_id=$capReleaseId; installed_artifact_id=$capArtifactId } | ConvertTo-Json
    $libraryHeaders = Headers "p5-user-$Port" "library-cap-$Port"
    $entry = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/v1/me/library/$capPackageId" -Headers $libraryHeaders -Body $libraryBody
    $entryAgain = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/v1/me/library/$capPackageId" -Headers $libraryHeaders -Body $libraryBody
    if (-not $entry.favorite -or $entry.package.id -ne $entryAgain.package.id) { throw 'Library update was not persisted idempotently.' }
    $shadowLibraryBody = @{ status='listed'; favorite=$false; installed_release_id=$capReleaseId; installed_artifact_id=$shadowArtifactId } | ConvertTo-Json
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Put -Uri "http://127.0.0.1:$Port/v1/me/library/$capPackageId" `
            -Headers (Headers "p5-shadow-$Port" "library-shadow-$Port") -Body $shadowLibraryBody -ErrorAction Stop
    } 404
    $artBody = @{ status='listed'; favorite=$true; installed_release_id=$null; installed_artifact_id=$null } | ConvertTo-Json
    Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/v1/me/library/$artPackageId" `
        -Headers (Headers "p5-user-$Port" "library-art-$Port") -Body $artBody | Out-Null
    $firstPage = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/v1/me/library?limit=1" `
        -Headers @{ Authorization = "Bearer dev-p5-user-$Port" }
    if ($firstPage.items.Count -ne 1 -or -not $firstPage.next_cursor) { throw 'Library stable cursor was not returned.' }
    $secondPage = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/v1/me/library?limit=1&cursor=$($firstPage.next_cursor)" `
        -Headers @{ Authorization = "Bearer dev-p5-user-$Port" }
    if ($secondPage.items.Count -ne 1 -or $secondPage.items[0].package.id -eq $firstPage.items[0].package.id) { throw 'Library cursor did not advance.' }
    $otherLibrary = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/v1/me/library" `
        -Headers @{ Authorization = "Bearer dev-p5-other-$Port" }
    if ($otherLibrary.items.Count -ne 0) { throw 'Library entries crossed the external-principal boundary.' }

    $revokeSql = "INSERT INTO moderation_cases(id,package_id,status,reason,reporter_issuer,reporter_subject) VALUES ('$moderationCaseId','$capPackageId','actioned','runtime revoke','$issuer','p5-user-$Port'); INSERT INTO moderation_actions(id,case_id,action,target_type,target_ref,reason,status,requested_by_issuer,requested_by_subject,approved_by_issuer,approved_by_subject,applied_at) VALUES ('$moderationActionId','$moderationCaseId','block','artifact','$capArtifactId','runtime revoke','applied','$issuer','p5-moderator-1-$Port','$issuer','p5-moderator-2-$Port',now()); INSERT INTO blocklist_entries(target_type,target_ref,status,reason,source_action_id) VALUES ('artifact','$capArtifactId','active','runtime revoke','$moderationActionId');"
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c $revokeSql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to seed the active artifact revocation.' }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $downloadUri -Headers $downloadHeaders -Body $downloadBody -ErrorAction Stop
    } 404
    $stored = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc "SELECT octet_length(ticket_hash) || ':' || status FROM download_sessions WHERE id='$($issued.session_id)'"
    if ($stored.Trim() -ne '32:issued') { throw "Download session stored unexpected ticket material: $stored" }
    Write-Output "P5 runtime passed: immutable URL, approved-artifact binding, restricted replay, private ACL, revocation, and library cursor."
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    $cleanup = "BEGIN; DELETE FROM blocklist_entries WHERE target_ref IN ('$capArtifactId','$privateArtifactId','$artArtifactId','$shadowArtifactId'); DELETE FROM moderation_actions WHERE id='$moderationActionId'; DELETE FROM moderation_cases WHERE id='$moderationCaseId'; DELETE FROM idempotency_keys WHERE principal_issuer='$issuer' AND principal_subject LIKE 'p5-%-$Port'; DELETE FROM library_entries WHERE package_id IN ('$artPackageId','$capPackageId','$privatePackageId'); DELETE FROM download_sessions WHERE artifact_id IN ('$artArtifactId','$capArtifactId','$privateArtifactId','$shadowArtifactId'); DELETE FROM audit_events WHERE resource_id IN ('$artPackageId','$capPackageId','$privatePackageId') OR resource_type='download_session' AND details->>'artifact_id' IN ('$artArtifactId','$capArtifactId','$privateArtifactId','$shadowArtifactId'); DELETE FROM outbox_events WHERE aggregate_type='download_session' AND payload->>'artifact_id' IN ('$artArtifactId','$capArtifactId','$privateArtifactId','$shadowArtifactId'); DELETE FROM published_release_artifacts WHERE release_id IN ('$artReleaseId','$capReleaseId','$privateReleaseId'); DELETE FROM submissions WHERE release_id IN ('$artReleaseId','$capReleaseId','$privateReleaseId'); DELETE FROM artifacts WHERE id IN ('$artArtifactId','$capArtifactId','$privateArtifactId','$shadowArtifactId'); DELETE FROM releases WHERE id IN ('$artReleaseId','$capReleaseId','$privateReleaseId'); DELETE FROM packages WHERE id IN ('$artPackageId','$capPackageId','$privatePackageId'); DELETE FROM publisher_signing_keys WHERE publisher_id='$publisherId'; DELETE FROM publisher_members WHERE publisher_id='$publisherId'; DELETE FROM publishers WHERE id='$publisherId'; COMMIT;"
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c $cleanup *> $null
    docker exec assetlibrary-postgres-1 rm -f /tmp/p5-runtime.sql *> $null
    Remove-Item -LiteralPath $sqlPath,$stdout,$stderr -Force -ErrorAction SilentlyContinue
}
