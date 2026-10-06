param([int] $Port = 18087)

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
$packageId = [guid]::NewGuid().ToString()
$releaseId = [guid]::NewGuid().ToString()
$artifactId = [guid]::NewGuid().ToString()
$submissionId = [guid]::NewGuid().ToString()
$secondReleaseId = [guid]::NewGuid().ToString()
$secondArtifactId = [guid]::NewGuid().ToString()
$secondSubmissionId = [guid]::NewGuid().ToString()
$receiptId = [guid]::NewGuid().ToString()
$secondReceiptId = [guid]::NewGuid().ToString()
$clientId = [guid]::NewGuid().ToString()
$issuer = 'assetlibrary-development'
$subject = "p7-user-$Port"
$sqlPath = Join-Path $env:TEMP "assetlibrary-p7-$Port.sql"
$privateKey = Join-Path $env:TEMP "assetlibrary-p7-$Port.pem"
$challengePath = Join-Path $env:TEMP "assetlibrary-p7-$Port-challenge.json"
$secondChallengePath = Join-Path $env:TEMP "assetlibrary-p7-$Port-challenge-2.json"
$stdout = Join-Path $env:TEMP "assetlibrary-p7-$Port.stdout.log"
$stderr = Join-Path $env:TEMP "assetlibrary-p7-$Port.stderr.log"
$passed = $false

$sql = @"
BEGIN;
INSERT INTO publishers (id,slug,display_name,status) VALUES
('$publisherId','p7-publisher-$Port','P7 Runtime Publisher','active');
INSERT INTO packages (id,publisher_id,slug,kind,status,name,summary,visibility) VALUES
('$packageId','$publisherId','p7-capability-$Port','capability','published','P7 Capability','Receipt runtime','public');
INSERT INTO releases (id,package_id,version,status,compatibility,permissions,created_by_issuer,created_by_subject,published_at) VALUES
('$releaseId','$packageId','1.0.0','published','{"products":[{"name":"loom","version_requirement":">=0.1.0"},{"name":"hook","version_requirement":">=0.1.0"}]}','[]','$issuer','$subject',now()),
('$secondReleaseId','$packageId','1.1.0','published','{"products":[{"name":"loom","version_requirement":">=0.1.0"},{"name":"hook","version_requirement":">=0.1.0"}]}','[]','$issuer','$subject',now());
INSERT INTO publisher_signing_keys (publisher_id,key_id,public_key,status) VALUES
('$publisherId','p7-runtime-key',decode(repeat('11',32),'hex'),'active');
INSERT INTO artifacts (id,release_id,status,object_key,sha256,canonical_sha256,size_bytes,media_type,
verified_at,published_object_key,scanner_version,rule_version,scan_evidence,signature) VALUES
('$artifactId','$releaseId','verified','fixture/$artifactId.zip',decode(repeat('aa',32),'hex'),decode(repeat('bb',32),'hex'),1024,'application/zip',now(),'sha256/bb/' || repeat('bb',32),'scanner-runtime','rules-runtime','{}','{"keyId":"p7-runtime-key"}'),
('$secondArtifactId','$secondReleaseId','verified','fixture/$secondArtifactId.zip',decode(repeat('cc',32),'hex'),decode(repeat('dd',32),'hex'),2048,'application/zip',now(),'sha256/dd/' || repeat('dd',32),'scanner-runtime','rules-runtime','{}','{"keyId":"p7-runtime-key"}');
INSERT INTO submissions(id,release_id,status,artifact_id) VALUES
('$submissionId','$releaseId','approved','$artifactId'),
('$secondSubmissionId','$secondReleaseId','approved','$secondArtifactId');
INSERT INTO published_release_artifacts(release_id,artifact_id,approval_submission_id,source,published_at) VALUES
('$releaseId','$artifactId','$submissionId','reviewed_submission',now()),
('$secondReleaseId','$secondArtifactId','$secondSubmissionId','reviewed_submission',now());
COMMIT;
"@
[IO.File]::WriteAllText($sqlPath, $sql, (New-Object Text.UTF8Encoding($false)))
docker cp $sqlPath "assetlibrary-postgres-1:/tmp/p7-runtime.sql" | Out-Null
docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f /tmp/p7-runtime.sql | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$publicKey = & node (Join-Path $PSScriptRoot 'helpers/sign-install-receipt.mjs') keygen $privateKey
if ($LASTEXITCODE -ne 0 -or -not $publicKey) { throw 'Failed to create the runtime receipt key.' }
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
$process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr

function Headers([string] $Actor, [string] $Key) {
    return @{ Authorization = "Bearer dev-$Actor"; 'Idempotency-Key' = $Key; 'Content-Type' = 'application/json' }
}
function Expect-Status([scriptblock] $Action, [int] $Expected) {
    try { & $Action | Out-Null; throw "Request unexpectedly succeeded; expected HTTP $Expected." }
    catch { if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne $Expected) { throw } }
}
function HostProfile([string] $LoomVersion) {
    return @{
        loom_version = $LoomVersion; hook_version = '0.1.0'; platform = 'windows-x64'
        loom_capability_api = @{ version = '1.0'; features = @() }
        hook_extension_api = @{ version = '1.0'; features = @() }
        surface_api = @{ version = '1.0'; features = @() }
        surface_nodes = @(); frameworks = @(@{ id = 'neuro/runtime'; version = '1.0.0'; ready = $true })
    }
}
function Issue-Download([string] $TargetArtifact, [string] $Key) {
    return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/me/artifacts/$TargetArtifact/download-sessions" `
        -Headers (Headers $subject $Key) -Body (@{ client_type = 'loom' } | ConvertTo-Json)
}
function New-Challenge([object] $Session, [string] $TargetReceipt, [string] $Key, [string] $LoomVersion = '0.1.0') {
    $body = @{ receipt_id = $TargetReceipt; client_instance_id = $clientId; receipt_public_key_base64 = $publicKey; host = HostProfile $LoomVersion } | ConvertTo-Json -Depth 8
    return Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/v1/me/download-sessions/$($Session.session_id)/install-challenge" `
        -Headers (Headers $subject $Key) -Body $body
}

try {
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        try { $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 }
        catch { $health = $null }
    } while (-not $health -and (Get-Date) -lt $deadline)
    if (-not $health) { throw 'P7 API did not become healthy.' }

    $session = Issue-Download $artifactId "p7-download-$Port"
    $challengeResponse = New-Challenge $session $receiptId "p7-challenge-$Port"
    $challenge = $challengeResponse.Content | ConvertFrom-Json
    [IO.File]::WriteAllText($challengePath, $challengeResponse.Content, (New-Object Text.UTF8Encoding($false)))
    if ($challengeResponse.Headers['Cache-Control'] -ne 'private, no-store' -or
        $challenge.artifact.digest -ne ('bb' * 32) -or $challenge.archive_sha256 -ne ('aa' * 32) -or
        $challenge.download_session_id -ne $session.session_id -or
        $challenge.PSObject.Properties.Name -contains 'principal' -or $challenge.PSObject.Properties.Name -contains 'access_token') {
        throw 'Install challenge did not preserve its privacy or exact digest binding.'
    }
    $replay = (New-Challenge $session $receiptId "p7-challenge-$Port").Content | ConvertFrom-Json
    if ($replay.nonce -ne $challenge.nonce) { throw 'Challenge idempotency replay changed the nonce.' }
    Expect-Status { New-Challenge $session $receiptId "p7-challenge-$Port" '0.0.1' } 409
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/v1/me/download-sessions/$($session.session_id)/install-challenge" `
            -Headers (Headers "p7-other-$Port" "p7-cross-principal-$Port") -Body (@{ receipt_id = [guid]::NewGuid().ToString(); client_instance_id = $clientId; receipt_public_key_base64 = $publicKey; host = HostProfile '0.1.0' } | ConvertTo-Json -Depth 8) -ErrorAction Stop
    } 404

    $incompatibleSession = Issue-Download $secondArtifactId "p7-download-incompatible-$Port"
    Expect-Status { New-Challenge $incompatibleSession $secondReceiptId "p7-incompatible-$Port" '0.0.1' } 409
    $secondChallengeResponse = New-Challenge $incompatibleSession $secondReceiptId "p7-challenge-2-$Port"
    [IO.File]::WriteAllText($secondChallengePath, $secondChallengeResponse.Content, (New-Object Text.UTF8Encoding($false)))

    $installedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $signature = & node (Join-Path $PSScriptRoot 'helpers/sign-install-receipt.mjs') sign $privateKey $challengePath $installedAt
    if ($LASTEXITCODE -ne 0 -or -not $signature) { throw 'Failed to sign the runtime receipt.' }
    $verifyBody = @{ installed_at_epoch_seconds = $installedAt; signature_base64 = $signature } | ConvertTo-Json
    $verifyUri = "http://127.0.0.1:$Port/v1/me/install-receipts/$receiptId/verify"
    $invalidSignature = [Convert]::ToBase64String((New-Object byte[] 64))
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $verifyUri -Headers (Headers $subject "p7-invalid-signature-$Port") `
            -Body (@{ installed_at_epoch_seconds = $installedAt; signature_base64 = $invalidSignature } | ConvertTo-Json) -ErrorAction Stop
    } 403
    $crossUri = "http://127.0.0.1:$Port/v1/me/install-receipts/$secondReceiptId/verify"
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $crossUri -Headers (Headers $subject "p7-cross-release-$Port") -Body $verifyBody -ErrorAction Stop
    } 403

    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_signing_keys SET status='revoked',revoked_at=now() WHERE publisher_id='$publisherId' AND key_id='p7-runtime-key';" | Out-Null
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $verifyUri -Headers (Headers $subject "p7-revoked-$Port") -Body $verifyBody -ErrorAction Stop
    } 404
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_signing_keys SET status='active',revoked_at=NULL WHERE publisher_id='$publisherId' AND key_id='p7-runtime-key';" | Out-Null

    $verifyHeaders = Headers $subject "p7-verify-$Port"
    $verifiedResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $verifyUri -Headers $verifyHeaders -Body $verifyBody
    $verified = $verifiedResponse.Content | ConvertFrom-Json
    $verifiedReplay = Invoke-RestMethod -Method Post -Uri $verifyUri -Headers $verifyHeaders -Body $verifyBody
    if ($verifiedResponse.Headers['Cache-Control'] -ne 'private, no-store' -or $verified.status -ne 'verified' -or
        $verified.receipt_id -ne $receiptId -or $verifiedReplay.verified_at -ne $verified.verified_at) {
        throw 'Verified receipt response was invalid or not idempotent.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $verifyUri -Headers (Headers $subject "p7-replay-$Port") -Body $verifyBody -ErrorAction Stop
    } 409
    $stored = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc `
        "SELECT ir.status || ':' || octet_length(ir.signature) || ':' || (le.installed_release_id=ir.release_id)::int || ':' || (le.installed_artifact_id=ir.artifact_id)::int || ':' || (SELECT count(*) FROM outbox_events WHERE aggregate_type='install_receipt' AND aggregate_id=ir.id) FROM install_receipts ir JOIN library_entries le ON le.principal_issuer=ir.principal_issuer AND le.principal_subject=ir.principal_subject AND le.package_id='$packageId' WHERE ir.id='$receiptId';"
    if ($stored.Trim() -ne 'verified:64:1:1:1') { throw "Install receipt was not persisted atomically: $stored" }
    Write-Output 'P7 InstallReceipt runtime passed: exact binding, compatibility, signature, revocation, anti-replay, privacy, and library projection.'
    $passed = $true
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    if (-not $passed) {
        if (Test-Path -LiteralPath $stdout) { [Console]::Error.WriteLine((Get-Content -LiteralPath $stdout -Tail 80) -join [Environment]::NewLine) }
        if (Test-Path -LiteralPath $stderr) { [Console]::Error.WriteLine((Get-Content -LiteralPath $stderr -Tail 80) -join [Environment]::NewLine) }
    }
    $cleanup = "BEGIN; DELETE FROM idempotency_keys WHERE principal_issuer='$issuer' AND principal_subject LIKE 'p7-%-$Port'; DELETE FROM library_entries WHERE package_id='$packageId'; DELETE FROM install_receipts WHERE artifact_id IN ('$artifactId','$secondArtifactId'); DELETE FROM download_sessions WHERE artifact_id IN ('$artifactId','$secondArtifactId'); DELETE FROM audit_events WHERE resource_id IN ('$receiptId','$secondReceiptId') OR resource_type='download_session' AND details->>'artifact_id' IN ('$artifactId','$secondArtifactId'); DELETE FROM outbox_events WHERE aggregate_id IN ('$receiptId','$secondReceiptId') OR aggregate_type='download_session' AND payload->>'artifact_id' IN ('$artifactId','$secondArtifactId'); DELETE FROM published_release_artifacts WHERE release_id IN ('$releaseId','$secondReleaseId'); DELETE FROM submissions WHERE release_id IN ('$releaseId','$secondReleaseId'); DELETE FROM artifacts WHERE id IN ('$artifactId','$secondArtifactId'); DELETE FROM releases WHERE id IN ('$releaseId','$secondReleaseId'); DELETE FROM packages WHERE id='$packageId'; DELETE FROM publisher_signing_keys WHERE publisher_id='$publisherId'; DELETE FROM publishers WHERE id='$publisherId'; COMMIT;"
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c $cleanup *> $null
    docker exec assetlibrary-postgres-1 rm -f /tmp/p7-runtime.sql *> $null
    Remove-Item -LiteralPath $sqlPath,$privateKey,$challengePath,$secondChallengePath -Force -ErrorAction SilentlyContinue
    if ($passed) { Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue }
}
