param([int] $Port = 18086)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}

$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$alias = "assetlibrary-p5-$runId"
$prefix = "$alias-v1"
$publisherId = [guid]::NewGuid().ToString()
$packageA = [guid]::NewGuid().ToString()
$packageB = [guid]::NewGuid().ToString()
$releaseA = [guid]::NewGuid().ToString()
$releaseB = [guid]::NewGuid().ToString()
$artifactA = [guid]::NewGuid().ToString()
$artifactB = [guid]::NewGuid().ToString()
$shadowArtifactA = [guid]::NewGuid().ToString()
$submissionA = [guid]::NewGuid().ToString()
$submissionB = [guid]::NewGuid().ToString()
$eventId = [guid]::NewGuid().ToString()
$sqlPath = Join-Path $env:TEMP "assetlibrary-search-$runId.sql"
$logs = @()
$processes = @()
$succeeded = $false

function Invoke-Sql([string] $Sql) {
    [IO.File]::WriteAllText($sqlPath, $Sql, (New-Object Text.UTF8Encoding($false)))
    docker cp $sqlPath "assetlibrary-postgres-1:/tmp/search-runtime.sql" | Out-Null
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f /tmp/search-runtime.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL runtime command failed.' }
}

function Sql-Scalar([string] $Sql) {
    $value = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc $Sql
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL scalar query failed.' }
    return $value.Trim()
}

function OpenSearch([string] $Method, [string] $Path) {
    $raw = & curl.exe -sSfk -u "admin:$env:OPENSEARCH_INITIAL_ADMIN_PASSWORD" -X $Method "https://127.0.0.1:9200$Path"
    if ($LASTEXITCODE -ne 0) { throw "OpenSearch $Method $Path failed." }
    if ($raw) { return $raw | ConvertFrom-Json }
}

function Alias-Target {
    $value = OpenSearch GET "/_alias/$alias"
    return @($value.PSObject.Properties.Name)
}

function Start-Worker([string] $Name, [string] $Executable) {
    $stdout = Join-Path $env:TEMP "assetlibrary-$Name-$runId.stdout.log"
    $stderr = Join-Path $env:TEMP "assetlibrary-$Name-$runId.stderr.log"
    $script:logs += $stdout, $stderr
    $process = Start-Process -FilePath $Executable -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $script:processes += $process
    return $process
}

function Expect-Status([scriptblock] $Action, [int] $Expected) {
    try { & $Action | Out-Null; throw "Request unexpectedly succeeded; expected HTTP $Expected." }
    catch { if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne $Expected) { throw } }
}

Push-Location $root
try {
    & cargo build -p assetlibrary-api -p assetlibrary-indexer-worker -p assetlibrary-outbox-worker --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
$env:NATS_URL = 'nats://127.0.0.1:4222'
$env:ASSETLIBRARY_NATS_URL = $env:NATS_URL
$env:ASSETLIBRARY_VALKEY_URL = "redis://:$env:VALKEY_PASSWORD@127.0.0.1:6379"
$env:ASSETLIBRARY_OPENSEARCH_URL = 'https://127.0.0.1:9200'
$env:ASSETLIBRARY_OPENSEARCH_USERNAME = 'admin'
$env:ASSETLIBRARY_OPENSEARCH_PASSWORD = $env:OPENSEARCH_INITIAL_ADMIN_PASSWORD
$env:ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS = 'true'
$env:ASSETLIBRARY_SEARCH_ALIAS = $alias
$env:ASSETLIBRARY_SEARCH_INDEX_PREFIX = $prefix
$env:ASSETLIBRARY_INDEXER_CONSUMER = "indexer-$runId"
$env:ASSETLIBRARY_BIND = "127.0.0.1:$Port"
$env:AWS_ACCESS_KEY_ID = $env:MINIO_ROOT_USER
$env:AWS_SECRET_ACCESS_KEY = $env:MINIO_ROOT_PASSWORD
'ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID','ASSETLIBRARY_EDGE_POLICY_NAMESPACE_ID','ASSETLIBRARY_EDGE_POLICY_API_TOKEN' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }

$seed = @"
BEGIN;
INSERT INTO publishers(id,slug,display_name,status) VALUES
('$publisherId','search-publisher-$runId','Search Runtime Publisher','active');
INSERT INTO publisher_signing_keys(publisher_id,key_id,public_key,status) VALUES
('$publisherId','search-runtime-key',decode(repeat('21',32),'hex'),'active');
INSERT INTO packages(id,publisher_id,slug,kind,status,name,summary,description,visibility,tags) VALUES
('$packageA','$publisherId','search-alpha-$runId','art','published','Search $runId Alpha','Runtime alpha','First runtime package','public',ARRAY['runtime-$runId','featured']),
('$packageB','$publisherId','search-beta-$runId','art','published','Search $runId Beta','Runtime beta','Second runtime package','public',ARRAY['runtime-$runId','featured']);
INSERT INTO releases(id,package_id,version,status,created_by_issuer,created_by_subject,published_at) VALUES
('$releaseA','$packageA','1.0.0','published','assetlibrary-development','search-runtime',now()),
('$releaseB','$packageB','1.0.0','published','assetlibrary-development','search-runtime',now());
INSERT INTO artifacts(id,release_id,status,object_key,sha256,canonical_sha256,size_bytes,media_type,verified_at,published_object_key,scanner_version,rule_version,scan_evidence,signature) VALUES
('$artifactA','$releaseA','verified','fixture/$artifactA.zip',decode(repeat('31',32),'hex'),decode(repeat('31',32),'hex'),1024,'application/zip',now(),'sha256/31/'||repeat('31',32),'runtime','runtime','{}','{"keyId":"search-runtime-key"}'),
('$artifactB','$releaseB','verified','fixture/$artifactB.zip',decode(repeat('32',32),'hex'),decode(repeat('32',32),'hex'),2048,'application/zip',now(),'sha256/32/'||repeat('32',32),'runtime','runtime','{}','{"keyId":"search-runtime-key"}'),
('$shadowArtifactA','$releaseA','verified','fixture/$shadowArtifactA.zip',decode(repeat('33',32),'hex'),decode(repeat('33',32),'hex'),4096,'application/zip',now(),'sha256/33/'||repeat('33',32),'runtime','runtime','{}','{"keyId":"search-runtime-key"}');
INSERT INTO submissions(id,release_id,status,artifact_id) VALUES
('$submissionA','$releaseA','approved','$artifactA'),
('$submissionB','$releaseB','approved','$artifactB');
INSERT INTO published_release_artifacts(release_id,artifact_id,approval_submission_id,source,published_at) VALUES
('$releaseA','$artifactA','$submissionA','reviewed_submission',now()),
('$releaseB','$artifactB','$submissionB','reviewed_submission',now());
COMMIT;
"@

try {
    Invoke-Sql $seed
    & (Join-Path $root 'target/debug/assetlibrary-indexer-worker.exe') rebuild
    if ($LASTEXITCODE -ne 0) { throw 'Initial search projection rebuild failed.' }
    $firstIndex = @(Alias-Target)
    if ($firstIndex.Count -ne 1 -or -not $firstIndex[0].StartsWith("$prefix-")) { throw 'Versioned search alias was not created.' }

    $api = Start-Worker 'api' (Join-Path $root 'target/debug/assetlibrary-api.exe')
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 } catch { $health = $null }
    } while (-not $health -and (Get-Date) -lt $deadline)
    if (-not $health -or $api.HasExited) { throw 'Search API did not become healthy.' }

    $searchUri = "http://127.0.0.1:$Port/v1/public/search?q=$runId&kind=art&tag=runtime-$runId&limit=1"
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 300
        try { $page1 = Invoke-RestMethod -Uri $searchUri } catch { $page1 = $null }
    } while ((-not $page1 -or $page1.items.Count -ne 1 -or -not $page1.next_cursor) -and (Get-Date) -lt $deadline)
    if (-not $page1.next_cursor) { throw 'Search did not return a stable first-page cursor.' }
    $cursor = [Uri]::EscapeDataString($page1.next_cursor)
    $page2 = Invoke-RestMethod -Uri "$searchUri&cursor=$cursor"
    if ($page2.items.Count -ne 1 -or $page1.items[0].id -eq $page2.items[0].id) { throw 'Search cursor repeated or lost a result.' }
    if ($page1.items[0].artifact_id -eq $shadowArtifactA -or $page2.items[0].artifact_id -eq $shadowArtifactA) {
        throw 'Search projection selected an unapproved sibling artifact.'
    }
    if ($page1.items[0].publisher.PSObject.Properties.Name -contains 'issuer') { throw 'Public search leaked an account principal.' }
    $catalog = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/public/packages?kind=art&limit=1"
    if (-not $catalog.next_cursor) { throw 'PostgreSQL catalog cursor was not returned.' }
    $catalogNext = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/public/packages?kind=art&limit=1&cursor=$([Uri]::EscapeDataString($catalog.next_cursor))"
    if ($catalogNext.items.Count -ne 1 -or $catalog.items[0].id -eq $catalogNext.items[0].id) { throw 'PostgreSQL catalog cursor did not advance.' }
    Expect-Status { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/public/search?limit=0" -ErrorAction Stop } 400
    Expect-Status { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/public/packages?limit=0" -ErrorAction Stop } 400
    Expect-Status { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/me/library?limit=0" -Headers @{ Authorization='Bearer dev-search-runtime' } -ErrorAction Stop } 400

    $beforeGeneration = [int64](docker exec -e "VALKEYCLI_AUTH=$env:VALKEY_PASSWORD" assetlibrary-valkey-1 valkey-cli GET assetlibrary:catalog:generation)
    $indexer = Start-Worker 'indexer' (Join-Path $root 'target/debug/assetlibrary-indexer-worker.exe')
    Start-Sleep -Seconds 2
    $eventSql = @"
UPDATE packages SET visibility='private' WHERE id='$packageB';
INSERT INTO outbox_events(id,subject,schema_version,aggregate_type,aggregate_id,payload)
VALUES('$eventId','assetlibrary.catalog.invalidated.v1','1.0','package','$packageB',
jsonb_build_object('event_id','$eventId','occurred_at',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
'schema_version','1.0','actor',jsonb_build_object('type','system','id','search-runtime'),'package_id','$packageB','reason','moderation_action'));
"@
    Invoke-Sql $eventSql
    $outbox = Start-Worker 'outbox' (Join-Path $root 'target/debug/assetlibrary-outbox-worker.exe')
    $deadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 500
        $projected = Sql-Scalar "SELECT EXISTS(SELECT 1 FROM projection_events WHERE projection='search-edge-v1' AND event_id='$eventId')"
        $current = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/public/search?q=$runId&limit=10"
    } while (($projected -ne 't' -or $current.items.Count -ne 1) -and (Get-Date) -lt $deadline)
    if ($projected -ne 't' -or $current.items.Count -ne 1) {
        throw "Event-driven removal did not converge: projected=$projected results=$($current.items.Count)."
    }
    $afterGeneration = [int64](docker exec -e "VALKEYCLI_AUTH=$env:VALKEY_PASSWORD" assetlibrary-valkey-1 valkey-cli GET assetlibrary:catalog:generation)
    if ($afterGeneration -le $beforeGeneration) { throw 'Catalog cache generation was not invalidated.' }

    $processes | Where-Object { -not $_.HasExited -and $_.Id -ne $api.Id } | ForEach-Object { Stop-Process -Id $_.Id -Force }
    OpenSearch DELETE "/$($firstIndex[0])" | Out-Null
    & (Join-Path $root 'target/debug/assetlibrary-indexer-worker.exe') rebuild
    if ($LASTEXITCODE -ne 0) { throw 'Search recovery rebuild failed.' }
    $secondIndex = @(Alias-Target)
    if ($secondIndex.Count -ne 1 -or $secondIndex[0] -eq $firstIndex[0]) { throw 'Rebuild did not replace the deleted versioned index.' }
    $recovered = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/public/search?q=$runId&limit=10"
    if ($recovered.items.Count -ne 1) { throw 'Search did not recover from index deletion.' }
    $succeeded = $true
    Write-Output 'P5 search runtime passed: approved-artifact projection, stable cursors, cache invalidation, NATS, and rebuild recovery.'
} finally {
    $processes | Where-Object { -not $_.HasExited } | ForEach-Object { Stop-Process -Id $_.Id -Force }
    $processes | ForEach-Object { Wait-Process -Id $_.Id -ErrorAction SilentlyContinue }
    try {
        $indices = @(OpenSearch GET "/_cat/indices/$prefix-*?format=json&h=index")
        $indices | ForEach-Object { if ($_.index -and $_.index.StartsWith("$prefix-")) { OpenSearch DELETE "/$($_.index)" | Out-Null } }
    } catch { Write-Warning 'Could not remove exact runtime OpenSearch indices.' }
    $cleanup = "BEGIN; DELETE FROM projection_events WHERE aggregate_id IN ('$packageA','$packageB'); DELETE FROM search_projection_state WHERE projection='$alias'; DELETE FROM edge_policy_projections WHERE package_id IN ('$packageA','$packageB'); DELETE FROM outbox_events WHERE id='$eventId'; DELETE FROM published_release_artifacts WHERE release_id IN ('$releaseA','$releaseB'); DELETE FROM submissions WHERE release_id IN ('$releaseA','$releaseB'); DELETE FROM artifacts WHERE id IN ('$artifactA','$artifactB','$shadowArtifactA'); DELETE FROM releases WHERE id IN ('$releaseA','$releaseB'); DELETE FROM packages WHERE id IN ('$packageA','$packageB'); DELETE FROM publisher_signing_keys WHERE publisher_id='$publisherId'; DELETE FROM publishers WHERE id='$publisherId'; COMMIT;"
    try { Invoke-Sql $cleanup } catch { Write-Warning 'Could not remove runtime PostgreSQL fixtures.' }
    docker exec assetlibrary-postgres-1 rm -f /tmp/search-runtime.sql *> $null
    Remove-Item -LiteralPath $sqlPath -Force -ErrorAction SilentlyContinue
    if ($succeeded) {
        $logs | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
    } else {
        Write-Warning "Runtime logs retained: $($logs -join ', ')"
    }
}
