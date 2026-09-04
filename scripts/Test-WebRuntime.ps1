param(
    [int] $ApiPort = 18088,
    [int] $WebPort = 18089,
    [ValidateRange(0, 600)]
    [int] $VisualHoldSeconds = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}

$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$publisherId = [guid]::NewGuid().ToString()
$packageId = [guid]::NewGuid().ToString()
$releaseId = [guid]::NewGuid().ToString()
$artifactId = [guid]::NewGuid().ToString()
$shadowArtifactId = [guid]::NewGuid().ToString()
$submissionId = [guid]::NewGuid().ToString()
$slug = "web-runtime-$runId"
$name = "Web Runtime $runId"
$digestHex = ('42' * 32) -join ''
$sqlPath = Join-Path $env:TEMP "assetlibrary-web-$runId.sql"
$logs = @()
$processes = @()
$stage = 'setup'
$portsClaimed = $false

function Invoke-Sql([string] $Sql) {
    [IO.File]::WriteAllText($sqlPath, $Sql, (New-Object Text.UTF8Encoding($false)))
    docker cp $sqlPath "assetlibrary-postgres-1:/tmp/web-runtime.sql" | Out-Null
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f /tmp/web-runtime.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL runtime command failed.' }
}

function Start-Hidden([string] $Name, [string] $FilePath, [string[]] $Arguments = @()) {
    $stdout = Join-Path $env:TEMP "assetlibrary-$Name-$runId.stdout.log"
    $stderr = Join-Path $env:TEMP "assetlibrary-$Name-$runId.stderr.log"
    $script:logs += $stdout, $stderr
    $start = @{
        FilePath = $FilePath
        PassThru = $true
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
    }
    if ($Arguments.Count -gt 0) { $start.ArgumentList = $Arguments }
    $process = Start-Process @start
    $script:processes += $process
    return $process
}

function Wait-Http([string] $Uri, [System.Diagnostics.Process] $Process) {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 300
        if ($Process.HasExited) { throw "Process exited before $Uri became available." }
        try { $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2 } catch { $response = $null }
    } while (-not $response -and (Get-Date) -lt $deadline)
    if (-not $response) { throw "Timed out waiting for $Uri." }
    return $response
}

function Assert-PortFree([int] $Port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($listener) { throw "TCP port $Port is already in use." }
}

function Stop-ProcessTree([int] $TargetId) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetId" -ErrorAction SilentlyContinue)
    $children | ForEach-Object { Stop-ProcessTree ([int] $_.ProcessId) }
    Stop-Process -Id $TargetId -Force -ErrorAction SilentlyContinue
}

function Stop-OwnedListener([int] $Port) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $process -or $process.CommandLine -notlike "*$root*") {
            throw "Refusing to stop an unexpected listener on TCP port $Port."
        }
        Stop-ProcessTree ([int] $listener.OwningProcess)
    }
}

function Sql-Scalar([string] $Sql) {
    $value = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc $Sql
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL cleanup verification failed.' }
    return "$value".Trim()
}

Push-Location $root
try {
    & cargo build -p assetlibrary-api --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & pnpm --dir apps/web build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
$env:NATS_URL = 'nats://127.0.0.1:4222'
$env:ASSETLIBRARY_NATS_URL = 'nats://127.0.0.1:4222'
$env:ASSETLIBRARY_VALKEY_URL = "redis://:$env:VALKEY_PASSWORD@127.0.0.1:6379"
$env:ASSETLIBRARY_OPENSEARCH_URL = 'https://127.0.0.1:9200'
$env:ASSETLIBRARY_OPENSEARCH_USERNAME = 'admin'
$env:ASSETLIBRARY_OPENSEARCH_PASSWORD = $env:OPENSEARCH_INITIAL_ADMIN_PASSWORD
$env:ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS = 'true'
$env:ASSETLIBRARY_BIND = "127.0.0.1:$ApiPort"
$env:ASSETLIBRARY_API_URL = "http://127.0.0.1:$ApiPort"
$env:ASSETLIBRARY_PUBLIC_URL = "http://127.0.0.1:$WebPort"
$env:AWS_ACCESS_KEY_ID = $env:MINIO_ROOT_USER
$env:AWS_SECRET_ACCESS_KEY = $env:MINIO_ROOT_PASSWORD
$ticketSecret = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($ticketSecret)
$env:ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL = 'http://downloads.local'
$env:ASSETLIBRARY_RESTRICTED_DOWNLOAD_BASE_URL = 'http://downloads.local'
$env:ASSETLIBRARY_DOWNLOAD_TICKET_ISSUER = 'assetlibrary-web-runtime'
$env:ASSETLIBRARY_DOWNLOAD_TICKET_AUDIENCE = 'edge-web-runtime'
$env:ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64 = [Convert]::ToBase64String($ticketSecret).TrimEnd('=').Replace('+','-').Replace('/','_')
$env:ASSETLIBRARY_DOWNLOAD_TICKET_TTL_SECONDS = '300'

$seed = @"
BEGIN;
INSERT INTO publishers(id,slug,display_name,status) VALUES
('$publisherId','web-publisher-$runId','Web Runtime Publisher','active');
INSERT INTO publisher_signing_keys(publisher_id,key_id,public_key,status) VALUES
('$publisherId','web-runtime-key',decode(repeat('41',32),'hex'),'active');
INSERT INTO packages(id,publisher_id,slug,kind,status,name,summary,description,visibility,tags) VALUES
('$packageId','$publisherId','$slug','art','published','$name','Runtime SSR package','Runtime web package','public',ARRAY['web-runtime']);
INSERT INTO releases(id,package_id,version,status,compatibility,permissions,created_by_issuer,created_by_subject,published_at) VALUES
('$releaseId','$packageId','1.0.0','published','{"products":[{"name":"loom","version_requirement":">=0.1.0"},{"name":"hook","version_requirement":">=0.1.0"}]}','["hook.selection.read"]','assetlibrary-development','web-runtime',now());
INSERT INTO artifacts(id,release_id,status,object_key,sha256,canonical_sha256,size_bytes,media_type,verified_at,published_object_key,scanner_version,rule_version,scan_evidence,signature) VALUES
('$artifactId','$releaseId','verified','fixture/$artifactId.zip',decode(repeat('42',32),'hex'),decode(repeat('42',32),'hex'),1024,'application/zip',now(),'sha256/42/'||repeat('42',32),'runtime','runtime','{}','{"keyId":"web-runtime-key"}'),
('$shadowArtifactId','$releaseId','verified','fixture/$shadowArtifactId.zip',decode(repeat('43',32),'hex'),decode(repeat('43',32),'hex'),2048,'application/zip',now(),'sha256/43/'||repeat('43',32),'runtime','runtime','{}','{"keyId":"web-runtime-key"}');
INSERT INTO submissions(id,release_id,status,artifact_id) VALUES
('$submissionId','$releaseId','approved','$artifactId');
INSERT INTO published_release_artifacts(release_id,artifact_id,approval_submission_id,source,published_at) VALUES
('$releaseId','$artifactId','$submissionId','reviewed_submission',now());
COMMIT;
"@

try {
    $stage = 'seed fixture'
    Assert-PortFree $ApiPort
    Assert-PortFree $WebPort
    $portsClaimed = $true
    Invoke-Sql $seed
    $stage = 'start API'
    $api = Start-Hidden 'web-api' (Join-Path $root 'target/debug/assetlibrary-api.exe')
    Wait-Http "http://127.0.0.1:$ApiPort/healthz" $api | Out-Null
    $stage = 'public detail API'
    $publisherApi = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/v1/public/publishers/web-publisher-$runId"
    $releaseApi = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/v1/public/packages/$slug/releases"
    if ($publisherApi.Content -notmatch 'Web Runtime Publisher' -or $releaseApi.Content -notmatch 'hook.selection.read' `
        -or $releaseApi.Content -notmatch 'version_requirement' -or $releaseApi.Content -notmatch $digestHex) {
        throw 'Public publisher or release API did not contain the verified projection.'
    }
    if ($releaseApi.Content -match 'object_key|scan_evidence|created_by_|principal_|manifest|public_key') {
        throw 'Public release API exposed an internal persistence or identity field.'
    }
    if ($releaseApi.Content -match [regex]::Escape($shadowArtifactId)) {
        throw 'Public release API exposed an unapproved sibling artifact.'
    }
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/v1/public/artifacts/$shadowArtifactId/download" -ErrorAction Stop | Out-Null
        throw 'Unapproved sibling artifact unexpectedly received a public download.'
    } catch {
        if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne 404) { throw }
    }
    $stage = 'start web'
    $web = Start-Hidden 'web-next' 'pnpm.cmd' @('--dir', (Join-Path $root 'apps/web'), 'start', '-p', "$WebPort")
    Wait-Http "http://127.0.0.1:$WebPort/healthz" $web | Out-Null

    $stage = 'catalog SSR'
    $homeResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$WebPort/"
    if ($homeResponse.Content -notmatch $name -or $homeResponse.Content -notmatch 'Runtime SSR package') {
        throw 'SSR catalog HTML did not contain the real API package.'
    }
    if ($homeResponse.Headers['Cache-Control'] -notmatch 'no-store') { throw 'Dynamic catalog response was cacheable.' }
    $stage = 'detail SSR'
    $detail = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$WebPort/packages/$slug"
    $detailChecks = [ordered]@{
        package = $name
        publisher = 'Web Runtime Publisher'
        version = '1.0.0'
        permission = 'hook.selection.read'
        digest = $digestHex
    }
    $missingDetail = @($detailChecks.GetEnumerator() | Where-Object { $detail.Content -notmatch [regex]::Escape($_.Value) } | ForEach-Object Key)
    if ($missingDetail.Count -gt 0) {
        throw "SSR package detail is missing verified fields: $($missingDetail -join ', ')."
    }
    if ($detail.Headers['Cache-Control'] -notmatch 'no-store' -or $detail.Content -notmatch '<link rel="canonical"') {
        throw 'Package detail cache or canonical metadata contract failed.'
    }
    $stage = 'publisher SSR'
    $publisher = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$WebPort/publishers/web-publisher-$runId"
    if ($publisher.Content -notmatch 'Web Runtime Publisher' -or $publisher.Content -notmatch $name `
        -or $publisher.Headers['Cache-Control'] -notmatch 'no-store' -or $publisher.Content -notmatch '<link rel="canonical"') {
        throw 'Publisher SSR identity, package projection, cache, or canonical metadata failed.'
    }
    $stage = 'search prompt SSR'
    $search = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$WebPort/search"
    if ($search.Content -notmatch 'SEARCH RESULT') { throw 'Search route did not render its prompt state.' }
    if ($VisualHoldSeconds -gt 0) {
        $stage = 'visual review hold'
        Write-Output "P6 visual review ready: http://127.0.0.1:$WebPort/ (fixture slug: $slug)"
        Start-Sleep -Seconds $VisualHoldSeconds
    }

    $stage = 'API outage state'
    Stop-ProcessTree $api.Id
    Wait-Process -Id $api.Id -ErrorAction SilentlyContinue
    $unavailable = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$WebPort/"
    if ($unavailable.StatusCode -ne 200 -or $unavailable.Headers['Cache-Control'] -notmatch 'no-store' `
        -or $unavailable.Content -notmatch 'CATALOG / UNAVAILABLE') {
        throw 'API outage was not rendered as an explicit unavailable state.'
    }
    Write-Output 'P6 web runtime passed: approved-artifact public API, real publisher/release SSR, and explicit outage state.'
} catch {
    Write-Warning "P6 web runtime failed at $stage`: $($_.Exception.Message)"
    throw
} finally {
    $cleanupFailure = $null
    try {
        $processes | ForEach-Object { Stop-ProcessTree $_.Id }
        $processes | ForEach-Object { Wait-Process -Id $_.Id -ErrorAction SilentlyContinue }
        if ($portsClaimed) {
            Stop-OwnedListener $ApiPort
            Stop-OwnedListener $WebPort
        }
    } catch {
        $cleanupFailure = $_
        Write-Warning $_.Exception.Message
    }
    $cleanup = "BEGIN; DELETE FROM published_release_artifacts WHERE release_id='$releaseId'; DELETE FROM submissions WHERE id='$submissionId'; DELETE FROM artifacts WHERE id IN ('$artifactId','$shadowArtifactId'); DELETE FROM releases WHERE id='$releaseId'; DELETE FROM packages WHERE id='$packageId'; DELETE FROM publisher_signing_keys WHERE publisher_id='$publisherId'; DELETE FROM publishers WHERE id='$publisherId'; COMMIT;"
    try {
        Invoke-Sql $cleanup
        if ((Sql-Scalar "SELECT count(*) FROM packages WHERE id='$packageId'") -ne '0') {
            throw 'Web runtime PostgreSQL fixture still exists after cleanup.'
        }
        if ($portsClaimed) {
            Start-Sleep -Milliseconds 300
            foreach ($port in @($ApiPort, $WebPort)) {
                if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
                    throw "Web runtime listener still owns TCP port $port after cleanup."
                }
            }
        }
    } catch {
        if (-not $cleanupFailure) { $cleanupFailure = $_ }
        Write-Warning $_.Exception.Message
    }
    docker exec assetlibrary-postgres-1 rm -f /tmp/web-runtime.sql *> $null
    Remove-Item -LiteralPath $sqlPath -Force -ErrorAction SilentlyContinue
    $logs | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
    if ($cleanupFailure) { throw $cleanupFailure }
}
