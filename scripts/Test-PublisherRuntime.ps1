param([int] $Port = 18088)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
& (Join-Path $PSScriptRoot 'Invoke-LocalMigration.ps1') | Out-Null
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}

Push-Location $root
try {
    & cargo build -p assetlibrary-api --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$publisherId = [guid]::NewGuid().ToString()
$otherPublisherId = [guid]::NewGuid().ToString()
$suspendedPublisherId = [guid]::NewGuid().ToString()
$otherPackageId = [guid]::NewGuid().ToString()
$appPackageId = [guid]::NewGuid().ToString()
$issuer = 'assetlibrary-development'
$owner = "publisher-owner-$Port-$runId"
$releaseManager = "publisher-release-$Port-$runId"
$revoked = "publisher-revoked-$Port-$runId"
$otherOwner = "publisher-other-$Port-$runId"
$suspendedOwner = "publisher-suspended-$Port-$runId"
$sqlPath = Join-Path $env:TEMP "assetlibrary-publisher-$Port-$runId.sql"
$sql = @"
INSERT INTO publishers (id,slug,display_name,status) VALUES
('$publisherId','publisher-$runId','Publisher Runtime','active'),
('$otherPublisherId','publisher-other-$runId','Other Publisher','active'),
('$suspendedPublisherId','publisher-suspended-$runId','Suspended Publisher','suspended');
INSERT INTO publisher_members (publisher_id,principal_issuer,principal_subject,role,status) VALUES
('$publisherId','$issuer','$owner','owner','active'),
('$publisherId','$issuer','$releaseManager','release_manager','active'),
('$publisherId','$issuer','$revoked','maintainer','revoked'),
('$otherPublisherId','$issuer','$otherOwner','owner','active'),
('$suspendedPublisherId','$issuer','$suspendedOwner','owner','active');
INSERT INTO packages (id,publisher_id,slug,kind,status,visibility,name) VALUES
('$otherPackageId','$otherPublisherId','publisher-other-package-$runId','art','draft','private','Other Draft');
"@
[IO.File]::WriteAllText($sqlPath, $sql, (New-Object Text.UTF8Encoding($false)))
docker cp $sqlPath "assetlibrary-postgres-1:/tmp/publisher-runtime.sql" | Out-Null
docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 `
    -f /tmp/publisher-runtime.sql | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:ASSETLIBRARY_BIND = "127.0.0.1:$Port"
$env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_APP_UPDATES_ENABLED = 'false'
$executable = Join-Path $root 'target/debug/assetlibrary-api.exe'
$stdout = Join-Path $env:TEMP "assetlibrary-publisher-$Port.stdout.log"
$stderr = Join-Path $env:TEMP "assetlibrary-publisher-$Port.stderr.log"
$process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr

function Headers([string] $Subject, [string] $Key = '') {
    $headers = @{ Authorization = "Bearer dev-$Subject"; 'Content-Type' = 'application/json' }
    if ($Key) { $headers['Idempotency-Key'] = $Key }
    return $headers
}

function Expect-Status([scriptblock] $Action, [int] $Expected) {
    try {
        & $Action | Out-Null
        throw "Request unexpectedly succeeded; expected HTTP $Expected."
    } catch {
        if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne $Expected) { throw }
    }
}

function Invoke-ConcurrentPosts(
    [string] $Uri,
    [string] $Subject,
    [string] $FirstKey,
    [string] $SecondKey,
    [string] $Body
) {
    Add-Type -AssemblyName System.Net.Http
    $clients = @([Net.Http.HttpClient]::new(), [Net.Http.HttpClient]::new())
    $requests = @()
    $tasks = @()
    try {
        foreach ($index in 0..1) {
            $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $Uri)
            [void] $request.Headers.TryAddWithoutValidation('Authorization', "Bearer dev-$Subject")
            $key = if ($index -eq 0) { $FirstKey } else { $SecondKey }
            [void] $request.Headers.TryAddWithoutValidation('Idempotency-Key', $key)
            $request.Content = [Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json')
            $requests += $request
            $tasks += $clients[$index].SendAsync($request)
        }
        [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]] $tasks)
        return @($tasks | ForEach-Object { [int] $_.Result.StatusCode })
    } finally {
        $tasks | ForEach-Object { if ($_.IsCompleted -and $_.Result) { $_.Result.Dispose() } }
        $requests | ForEach-Object { $_.Dispose() }
        $clients | ForEach-Object { $_.Dispose() }
    }
}

try {
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        try { $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 }
        catch { $health = $null }
    } while (-not $health -and (Get-Date) -lt $deadline)
    if (-not $health) { throw 'Publisher API did not become healthy.' }

    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/me/publishers" -ErrorAction Stop
    } 401
    $membershipsResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/me/publishers" `
        -Headers (Headers $owner)
    $memberships = $membershipsResponse.Content | ConvertFrom-Json
    if ($memberships.items.Count -ne 1 -or $memberships.items[0].publisher.id -ne $publisherId `
        -or $memberships.items[0].role -ne 'owner') { throw 'Publisher memberships escaped principal scope.' }
    if ([string] $membershipsResponse.Headers['Cache-Control'] -notmatch 'no-store') {
        throw 'Authenticated publisher response is cacheable.'
    }

    $keyBytes = New-Object byte[] 32
    for ($index = 0; $index -lt $keyBytes.Length; $index++) { $keyBytes[$index] = 0x11 }
    $keyBase64 = [Convert]::ToBase64String($keyBytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $keyFingerprint = 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($keyBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $signingKeyId = "publisher-key-$runId"
    $signingKeyUri = "http://127.0.0.1:$Port/v1/me/publishers/$publisherId/signing-keys"
    $signingKeyBody = @{
        key_id = $signingKeyId
        algorithm = 'ed25519'
        public_key_base64 = $keyBase64
    } | ConvertTo-Json
    $signingKeyIdempotency = "publisher-signing-key-$runId"
    $signingKey = Invoke-RestMethod -Method Post -Uri $signingKeyUri `
        -Headers (Headers $owner $signingKeyIdempotency) -Body $signingKeyBody
    $signingKeyAgain = Invoke-RestMethod -Method Post -Uri $signingKeyUri `
        -Headers (Headers $owner $signingKeyIdempotency) -Body $signingKeyBody
    if ($signingKey.key_id -ne $signingKeyId -or $signingKey.status -ne 'active' `
        -or $signingKey.fingerprint -ne $keyFingerprint -or $signingKey.public_key_base64 -ne $keyBase64 `
        -or $signingKeyAgain.created_at -ne $signingKey.created_at) {
        throw 'Signing-key registration lost canonical identity or idempotency.'
    }
    if (($signingKey | ConvertTo-Json -Depth 5) -match '(?i)private|secret') {
        throw 'Signing-key response exposed forbidden private material.'
    }
    $signingKeysResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $signingKeyUri `
        -Headers (Headers $releaseManager)
    $signingKeys = $signingKeysResponse.Content | ConvertFrom-Json
    if ($signingKeys.items.Count -ne 1 -or $signingKeys.items[0].fingerprint -ne $keyFingerprint `
        -or $signingKeysResponse.Headers['Cache-Control'] -ne 'private, no-store') {
        throw 'Signing-key list lost membership scope, fingerprint, or cache control.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Get `
            -Uri "http://127.0.0.1:$Port/v1/me/publishers/$otherPublisherId/signing-keys" `
            -Headers (Headers $owner) -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $signingKeyUri `
            -Headers (Headers $releaseManager "release-manager-key-$runId") -Body $signingKeyBody -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $signingKeyUri `
            -Headers (Headers $owner "invalid-key-$runId") `
            -Body ($signingKeyBody -replace [regex]::Escape($keyBase64), 'ERER') -ErrorAction Stop
    } 400
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $signingKeyUri `
            -Headers (Headers $owner $signingKeyIdempotency) `
            -Body ($signingKeyBody -replace $signingKeyId, "changed-key-$runId") -ErrorAction Stop
    } 409
    $revokeUri = "$signingKeyUri/$signingKeyId/revoke"
    $revokeBody = @{ reason = 'Publisher-requested key retirement.' } | ConvertTo-Json
    $revokedKey = Invoke-RestMethod -Method Post -Uri $revokeUri `
        -Headers (Headers $owner "revoke-key-$runId") -Body $revokeBody
    $revokedKeyAgain = Invoke-RestMethod -Method Post -Uri $revokeUri `
        -Headers (Headers $owner "revoke-key-$runId") -Body $revokeBody
    if ($revokedKey.status -ne 'revoked' -or -not $revokedKey.revoked_at `
        -or $revokedKeyAgain.revoked_at -ne $revokedKey.revoked_at) {
        throw 'Signing-key revocation was not terminal and idempotent.'
    }

    $packageUri = "http://127.0.0.1:$Port/v1/me/publishers/$publisherId/packages"
    $packageBody = @{
        slug = "publisher-package-$runId"; kind = 'art'; visibility = 'private'
        name = 'Publisher Package'; summary = 'Publisher runtime draft.'
        description = 'Created through the authenticated Publisher API.'; tags = @('art', 'runtime')
    } | ConvertTo-Json
    $packageKey = "publisher-package-$runId"
    $package = Invoke-RestMethod -Method Post -Uri $packageUri -Headers (Headers $owner $packageKey) -Body $packageBody
    $packageAgain = Invoke-RestMethod -Method Post -Uri $packageUri -Headers (Headers $owner $packageKey) -Body $packageBody
    if ($package.id -ne $packageAgain.id -or $package.status -ne 'draft') {
        throw 'Package draft creation was not idempotent.'
    }
    $packageDetail = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/me/packages/$($package.id)" -Headers (Headers $owner)
    if ($packageDetail.description -ne 'Created through the authenticated Publisher API.') {
        throw 'Owned package detail did not preserve the bounded draft description.'
    }
    $packageUpdateBody = @{
        expected_updated_at = $package.updated_at; visibility = 'unlisted'
        name = 'Publisher Package Updated'; summary = 'Updated Publisher runtime draft.'
        description = 'Updated through the authenticated Publisher API.'; tags = @('art', 'updated')
    } | ConvertTo-Json
    $packageUpdateKey = "publisher-package-update-$runId"
    $packageUpdated = Invoke-RestMethod -Method Patch `
        -Uri "http://127.0.0.1:$Port/v1/me/packages/$($package.id)" `
        -Headers (Headers $owner $packageUpdateKey) -Body $packageUpdateBody
    $packageUpdatedAgain = Invoke-RestMethod -Method Patch `
        -Uri "http://127.0.0.1:$Port/v1/me/packages/$($package.id)" `
        -Headers (Headers $owner $packageUpdateKey) -Body $packageUpdateBody
    if ($packageUpdated.updated_at -ne $packageUpdatedAgain.updated_at `
        -or $packageUpdated.slug -ne "publisher-package-$runId" -or $packageUpdated.kind -ne 'art' `
        -or $packageUpdated.visibility -ne 'unlisted' -or $packageUpdated.tags.Count -ne 2) {
        throw 'Package update lost idempotency, immutable identity, or mutable metadata.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/packages/$($package.id)" `
            -Headers (Headers $owner $packageUpdateKey) `
            -Body ($packageUpdateBody -replace 'Publisher Package Updated', 'Conflicting Update') `
            -ErrorAction Stop
    } 409
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/packages/$($package.id)" `
            -Headers (Headers $owner "publisher-package-stale-$runId") -Body $packageUpdateBody `
            -ErrorAction Stop
    } 409
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/packages/$($package.id)" `
            -Headers (Headers $releaseManager "publisher-package-role-$runId") `
            -Body ($packageUpdateBody -replace [regex]::Escape($package.updated_at), $packageUpdated.updated_at) `
            -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/packages/$($package.id)" `
            -Headers (Headers $revoked "publisher-package-revoked-$runId") `
            -Body ($packageUpdateBody -replace [regex]::Escape($package.updated_at), $packageUpdated.updated_at) `
            -ErrorAction Stop
    } 403
    $changedPackageBody = $packageBody -replace 'Publisher runtime draft\.', 'Changed summary.'
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $packageUri -Headers (Headers $owner $packageKey) `
            -Body $changedPackageBody -ErrorAction Stop
    } 409
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $packageUri `
            -Headers (Headers $releaseManager "release-manager-package-$runId") -Body $packageBody -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $packageUri `
            -Headers (Headers $revoked "revoked-package-$runId") -Body $packageBody -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/me/publishers/$otherPublisherId/packages" `
            -Headers (Headers $owner) -ErrorAction Stop
    } 403

    $suspendedBody = $packageBody -replace "publisher-package-$runId", "publisher-suspended-package-$runId"
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$Port/v1/me/publishers/$suspendedPublisherId/packages" `
            -Headers (Headers $suspendedOwner "suspended-package-$runId") -Body $suspendedBody -ErrorAction Stop
    } 409
    $appBody = $packageBody -replace '"art"', '"app_update"' `
        -replace "publisher-package-$runId", "publisher-app-$runId"
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $packageUri `
            -Headers (Headers $owner "app-package-$runId") -Body $appBody -ErrorAction Stop
    } 501

    $secondBody = $packageBody -replace "publisher-package-$runId", "publisher-page-$runId" `
        -replace 'Publisher Package', 'Publisher Page Package'
    $second = Invoke-RestMethod -Method Post -Uri $packageUri `
        -Headers (Headers $owner "page-package-$runId") -Body $secondBody
    $firstPage = Invoke-RestMethod -Method Get -Uri "$packageUri`?limit=1" -Headers (Headers $owner)
    if (-not $firstPage.next_cursor) { throw 'Owned package cursor was not returned for a bounded page.' }
    $cursor = [Uri]::EscapeDataString([string] $firstPage.next_cursor)
    $secondPage = Invoke-RestMethod -Method Get -Uri "$packageUri`?limit=1&cursor=$cursor" -Headers (Headers $owner)
    $pagedIds = @($firstPage.items[0].id, $secondPage.items[0].id)
    if ($pagedIds -notcontains $package.id -or $pagedIds -notcontains $second.id) {
        throw 'Owned package cursor skipped or duplicated a draft.'
    }
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 `
        -c "INSERT INTO packages(id,publisher_id,slug,kind,status,visibility,name) VALUES ('$appPackageId','$publisherId','publisher-app-edit-$runId','app_update','draft','private','App Update Draft')" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not seed App Update package edit gate.' }
    $appPackage = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/me/packages/$appPackageId" -Headers (Headers $owner)
    $appUpdateBody = @{
        expected_updated_at = $appPackage.updated_at
        visibility = 'private'; name = 'App Update Edited'; summary = ''; description = ''; tags = @()
    } | ConvertTo-Json
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/packages/$appPackageId" `
            -Headers (Headers $owner "publisher-app-edit-$runId") -Body $appUpdateBody -ErrorAction Stop
    } 501
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 `
        -c "UPDATE packages SET status='published' WHERE id='$($second.id)'" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not seed published Package lifecycle gate.' }
    $publishedUpdateBody = @{
        expected_updated_at = $second.updated_at; visibility = 'private'; name = $second.name
        summary = $second.summary; description = ''; tags = $second.tags
    } | ConvertTo-Json
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/packages/$($second.id)" `
            -Headers (Headers $owner "publisher-published-edit-$runId") -Body $publishedUpdateBody -ErrorAction Stop
    } 409

    $releaseUri = "http://127.0.0.1:$Port/v1/me/packages/$($package.id)/releases"
    $releaseBody = @{
        version = '1.0.0'
        compatibility = @{ products = @(@{ name = 'loom'; version_requirement = '>=0.1.0' }) }
        permissions = @('filesystem.read-project')
    } | ConvertTo-Json -Depth 6
    $releaseKey = "publisher-release-$runId"
    $release = Invoke-RestMethod -Method Post -Uri $releaseUri `
        -Headers (Headers $releaseManager $releaseKey) -Body $releaseBody
    $releaseAgain = Invoke-RestMethod -Method Post -Uri $releaseUri `
        -Headers (Headers $releaseManager $releaseKey) -Body $releaseBody
    if ($release.id -ne $releaseAgain.id -or $release.created_by.subject -ne $releaseManager) {
        throw 'Release draft lost idempotency or immutable creator identity.'
    }
    $releaseDetailResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/me/releases/$($release.id)" -Headers (Headers $owner)
    $releaseDetail = $releaseDetailResponse.Content | ConvertFrom-Json
    if ($releaseDetail.id -ne $release.id -or $releaseDetailResponse.Headers['Cache-Control'] -ne 'private, no-store') {
        throw 'Owned release detail lost identity or private cache control.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Get `
            -Uri "http://127.0.0.1:$Port/v1/me/releases/$($release.id)" `
            -Headers (Headers $otherOwner) -ErrorAction Stop
    } 403
    $updateBody = @{
        expected_updated_at = $release.updated_at
        compatibility = @{ products = @(
            @{ name = 'loom'; version_requirement = '>=0.2.0' }
            @{ name = 'hook'; version_requirement = '^0.1.0' }
        ) }
        permissions = @('filesystem.read-project', 'network.fetch')
    } | ConvertTo-Json -Depth 6
    $updateKey = "publisher-release-update-$runId"
    $releaseUpdated = Invoke-RestMethod -Method Patch `
        -Uri "http://127.0.0.1:$Port/v1/me/releases/$($release.id)" `
        -Headers (Headers $releaseManager $updateKey) -Body $updateBody
    $releaseUpdatedAgain = Invoke-RestMethod -Method Patch `
        -Uri "http://127.0.0.1:$Port/v1/me/releases/$($release.id)" `
        -Headers (Headers $releaseManager $updateKey) -Body $updateBody
    if ($releaseUpdated.updated_at -ne $releaseUpdatedAgain.updated_at `
        -or $releaseUpdated.version -ne '1.0.0' -or $releaseUpdated.created_by.subject -ne $releaseManager `
        -or $releaseUpdated.compatibility.products.Count -ne 2 -or $releaseUpdated.permissions.Count -ne 2) {
        throw 'Release draft update lost idempotency, immutable fields, or editable metadata.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/releases/$($release.id)" `
            -Headers (Headers $releaseManager $updateKey) `
            -Body ($updateBody -replace 'network.fetch', 'network.post') -ErrorAction Stop
    } 409
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/releases/$($release.id)" `
            -Headers (Headers $owner "publisher-release-stale-$runId") -Body $updateBody -ErrorAction Stop
    } 409
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/releases/$($release.id)" `
            -Headers (Headers $revoked "publisher-release-revoked-$runId") `
            -Body ($updateBody -replace [regex]::Escape($release.updated_at), $releaseUpdated.updated_at) `
            -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $releaseUri `
            -Headers (Headers $releaseManager "invalid-semver-$runId") `
            -Body ($releaseBody -replace '"1.0.0"', '"not-semver"') -ErrorAction Stop
    } 400
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $releaseUri `
            -Headers (Headers $owner "duplicate-release-$runId") -Body $releaseBody -ErrorAction Stop
    } 409
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$Port/v1/me/packages/$otherPackageId/releases" `
            -Headers (Headers $owner "cross-release-$runId") -Body $releaseBody -ErrorAction Stop
    } 403
    $releases = Invoke-RestMethod -Method Get -Uri $releaseUri -Headers (Headers $owner)
    if ($releases.items.id -notcontains $release.id) { throw 'Owned release list omitted its draft.' }

    $racePackageBody = $packageBody -replace "publisher-package-$runId", "publisher-race-$runId"
    $packageRace = @(Invoke-ConcurrentPosts $packageUri $owner "race-package-a-$runId" `
        "race-package-b-$runId" $racePackageBody | Sort-Object)
    if (($packageRace -join ',') -ne '200,409') { throw "Concurrent package uniqueness failed: $packageRace" }
    $raceReleaseBody = $releaseBody -replace '"1.0.0"', '"2.0.0"'
    $releaseRace = @(Invoke-ConcurrentPosts $releaseUri $releaseManager "race-release-a-$runId" `
        "race-release-b-$runId" $raceReleaseBody | Sort-Object)
    if (($releaseRace -join ',') -ne '200,409') { throw "Concurrent release uniqueness failed: $releaseRace" }

    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 `
        -c "UPDATE publisher_members SET status='revoked' WHERE publisher_id='$publisherId' AND principal_subject IN ('$owner','$releaseManager')" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not revoke Publisher runtime memberships.' }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $packageUri `
            -Headers (Headers $owner $packageKey) -Body $packageBody -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/packages/$($package.id)" `
            -Headers (Headers $owner $packageUpdateKey) -Body $packageUpdateBody -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $releaseUri `
            -Headers (Headers $releaseManager $releaseKey) -Body $releaseBody -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Patch `
            -Uri "http://127.0.0.1:$Port/v1/me/releases/$($release.id)" `
            -Headers (Headers $releaseManager $updateKey) -Body $updateBody -ErrorAction Stop
    } 403

    $facts = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc `
        "SELECT (SELECT count(*) FROM audit_events WHERE resource_id='$($package.id)' AND action='package.created') || ':' || (SELECT count(*) FROM audit_events WHERE resource_id='$($package.id)' AND action='package.updated') || ':' || (SELECT count(*) FROM outbox_events WHERE aggregate_id='$($package.id)' AND subject='assetlibrary.package.v1' AND payload->'actor'->>'subject'='$owner') || ':' || (SELECT count(*) FROM audit_events WHERE resource_id='$($release.id)' AND action='release.created') || ':' || (SELECT count(*) FROM audit_events WHERE resource_id='$($release.id)' AND action='release.updated') || ':' || (SELECT count(*) FROM outbox_events WHERE aggregate_id='$($release.id)' AND subject='assetlibrary.release.v1' AND payload->>'action'='updated') || ':' || (SELECT created_by_subject FROM releases WHERE id='$($release.id)')"
    if ($facts.Trim() -ne "1:1:2:1:1:1:$releaseManager") {
        throw "Publisher audit, outbox, or creator invariant failed: $facts"
    }
    $keyFacts = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc `
        "SELECT (SELECT count(*) FROM audit_events WHERE resource_id='$publisherId' AND action='signing_key.registered') || ':' || (SELECT count(*) FROM audit_events WHERE resource_id='$publisherId' AND action='signing_key.revoked') || ':' || (SELECT count(*) FROM outbox_events WHERE aggregate_id='$publisherId' AND subject='assetlibrary.publisher.signing_key.v1') || ':' || (SELECT status FROM publisher_signing_keys WHERE publisher_id='$publisherId' AND key_id='$signingKeyId')"
    if ($keyFacts.Trim() -ne '1:1:2:revoked') {
        throw "Signing-key audit, outbox, or terminal-state invariant failed: $keyFacts"
    }
    Write-Output "Publisher runtime passed: memberships=scoped, signing keys=canonical/revoked, revoked replays=denied, package=$($package.id), package/release optimistic edit=locked, release=$($release.id), concurrent uniqueness=2/2, audit/outbox=exactly-once."
} finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    if ($process) { Wait-Process -Id $process.Id -ErrorAction SilentlyContinue }
    $cleanup = @"
BEGIN;
DELETE FROM idempotency_keys WHERE principal_issuer='$issuer' AND principal_subject IN ('$owner','$releaseManager','$revoked','$otherOwner','$suspendedOwner');
DELETE FROM audit_events WHERE actor_issuer='$issuer' AND actor_subject IN ('$owner','$releaseManager','$revoked','$otherOwner','$suspendedOwner');
DELETE FROM outbox_events WHERE subject IN ('assetlibrary.package.v1','assetlibrary.release.v1','assetlibrary.publisher.signing_key.v1')
  AND (payload->>'publisher_id' IN ('$publisherId','$otherPublisherId','$suspendedPublisherId')
       OR payload->>'package_id' IN (SELECT id::text FROM packages WHERE publisher_id IN ('$publisherId','$otherPublisherId','$suspendedPublisherId')));
DELETE FROM releases WHERE package_id IN (SELECT id FROM packages WHERE publisher_id IN ('$publisherId','$otherPublisherId','$suspendedPublisherId'));
DELETE FROM packages WHERE publisher_id IN ('$publisherId','$otherPublisherId','$suspendedPublisherId');
DELETE FROM publisher_signing_keys WHERE publisher_id IN ('$publisherId','$otherPublisherId','$suspendedPublisherId');
DELETE FROM publisher_members WHERE publisher_id IN ('$publisherId','$otherPublisherId','$suspendedPublisherId');
DELETE FROM publishers WHERE id IN ('$publisherId','$otherPublisherId','$suspendedPublisherId');
COMMIT;
"@
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c $cleanup *> $null
    docker exec assetlibrary-postgres-1 rm -f /tmp/publisher-runtime.sql *> $null
    Remove-Item -LiteralPath $sqlPath -Force -ErrorAction SilentlyContinue
}
