param(
    [Parameter(Mandatory = $true)][string] $EvidenceDirectory,
    [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string] $PostgresImage,
    [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string] $NatsImage,
    [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string] $MinioImage,
    [ValidateRange(1,65535)][int] $ClamAvPort = 3310,
    [ValidatePattern('^sha256:[0-9a-f]{64}$')][string] $OpenSearchImage,
    [ValidatePattern('^sha256:[0-9a-f]{64}$')][string] $ValkeyImage
)
$ErrorActionPreference = 'Stop'
if ([bool]$OpenSearchImage -ne [bool]$ValkeyImage) { throw 'Optional rollback requires both image IDs' }
$repo = Split-Path -Parent $PSScriptRoot
$root = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\', '/')
$allowed = 'C:\Users\Public\nas_home\AI\GameEditor\linshi\'
if (-not $root.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be under linshi' }
if (Test-Path -LiteralPath $root) { throw 'Refusing to reuse an existing test directory' }
$script:Run = @{
    Root = $root; Repo = $repo; Id = 'al-art-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)
    Utf8 = [Text.UTF8Encoding]::new($false); DockerCounter = 0
    Containers = [Collections.Generic.List[object]]::new(); Workers = [Collections.Generic.List[object]]::new()
    Secrets = @(); Commands = @{ pg = @(); nats = @('--jetstream','--store_dir=/data','--http_port=8222'); minio = @('server','/data') }
}
foreach ($module in @('scanner-runtime/Environment.ps1','scanner-runtime/Fixture.ps1','scanner-runtime/Stack.ps1',
    'art-runtime/Workflow.ps1','art-runtime/Edge.ps1','art-runtime/Indexer.ps1','art-runtime/Rollback.ps1','art-runtime/Restricted.ps1')) { . "$PSScriptRoot/$module" }
foreach ($directory in @('', 'logs', 'tmp', 'scanner-temp', 'fixtures', 'postgres', 'nats', 'minio')) {
    [void][IO.Directory]::CreateDirectory((Join-Path $root $directory))
}
$result = [ordered]@{ status = 'running'; run_id = $Run.Id; production_ready = $false
    real_account_or_cloud_tested = $false; automatic_indexer_propagation_tested = $false; rollback_tested = $false }
try {
    Start-RunStack $PostgresImage $NatsImage $MinioImage $ClamAvPort
    Initialize-RunSchema -MigrationsOnly
    Initialize-ArtPrincipals
    $text = Invoke-RunTool 'build-fixture' "$repo/target/release/examples/build_signed_fixture.exe" @("$root/fixtures/signed.zip") 15
    $fixture = $text | ConvertFrom-Json
    if ($fixture.public_key -notmatch '^[0-9a-f]{64}$' -or $fixture.digest -notmatch '^[0-9a-f]{64}$' -or
        $fixture.canonical_digest -notmatch '^[0-9a-f]{64}$' -or $fixture.size_bytes -lt 1 -or
        $fixture.size_bytes -gt 1048576) { throw 'Invalid small signed fixture' }
    Start-ArtEdge
    Start-ArtIndexer
    $api = $Run.Common.Clone()
    foreach ($key in $Run.Storage.Keys) { $api[$key] = $Run.Storage[$key] }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $apiPort = $listener.LocalEndpoint.Port; $listener.Stop()
    $Run.ApiOrigin = "http://127.0.0.1:$apiPort"
    $api.ASSETLIBRARY_BIND = "127.0.0.1:$apiPort"; $api.ASSETLIBRARY_SEARCH_PROVIDER = 'postgres'
    $api.ASSETLIBRARY_APP_UPDATES_ENABLED = 'false'
    $api.ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL = $Run.EdgeOrigin; $api.ASSETLIBRARY_RESTRICTED_DOWNLOAD_BASE_URL = $Run.EdgeOrigin
    $api.ASSETLIBRARY_DOWNLOAD_TICKET_ISSUER = 'isolated-art'; $api.ASSETLIBRARY_DOWNLOAD_TICKET_AUDIENCE = 'isolated-edge'
    $api.ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64 = $Run.TicketSecret
    $api.ASSETLIBRARY_DOWNLOAD_TICKET_TTL_SECONDS = '900'
    $Run.ApiSettings = $api.Clone()
    $apiWorker = Start-RunWorker 'api' "$repo/target/release/assetlibrary-api.exe" $api
    Wait-RunCondition 'Art API readiness' {
        if ($apiWorker.Process.HasExited) { throw 'Art API exited before readiness' }
        try { (Invoke-WebRequest -UseBasicParsing -Uri "$($Run.ApiOrigin)/readyz" -TimeoutSec 2).StatusCode -eq 200 }
        catch { $false }
    } 15
    New-ArtUploadedFixture $fixture
    Assert-ArtEdgeDenied "$($Run.EdgeOrigin)/public/sha256/$($fixture.canonical_digest)/neuro-starter-art-1.0.0-dev.zip"
    $scanner = $api.Clone()
    $scanner.ASSETLIBRARY_SCANNER_TEMP_ROOT = "$root/scanner-temp"; $scanner.ASSETLIBRARY_SCANNER_CONSUMER = $Run.Id
    $scanner.ASSETLIBRARY_SCAN_TIMEOUT_SECONDS = '20'; $scanner.ASSETLIBRARY_CLAMAV_ADDRESS = "127.0.0.1:$ClamAvPort"
    Start-RunWorker 'scanner' "$repo/target/release/assetlibrary-scanner-worker.exe" $scanner | Out-Null
    Start-RunWorker 'outbox' "$repo/target/release/assetlibrary-outbox-worker.exe" $Run.Common | Out-Null
    Wait-RunArtifact $Run.Artifact 'verified'
    $verified = Get-RunArtifactEvidence $Run.Artifact
    if (-not $verified.verification_complete -or $verified.raw_sha256 -ne $fixture.digest -or
        $verified.canonical_sha256 -ne $fixture.canonical_digest -or $verified.verified_events -ne 1 -or
        $verified.session_status -ne 'verified') { throw 'Scanner evidence does not match uploaded artifact' }
    Write-RunJson 'verification.json' $verified
    if ((Get-ArtSearch).items.Count -ne 0) { throw 'Unpublished artifact appeared in PG search' }
    Assert-ArtEdgeDenied "$($Run.EdgeOrigin)/public/sha256/$($fixture.canonical_digest)/neuro-starter-art-1.0.0-dev.zip"
    Set-ArtPolicyFailure $true
    Publish-ArtFixture
    $search = Get-ArtSearch
    if ($search.items.Count -ne 1 -or $search.items[0].id -ne $Run.PackageId) { throw 'Published package missing from PG search' }
    Write-RunJson 'search.json' $search
    $publicationEvent = Get-ArtCatalogEvent 'release_published'
    Test-ArtProjectionFailure $publicationEvent
    Assert-ArtEdgeDenied "$($Run.EdgeOrigin)/public/sha256/$($fixture.canonical_digest)/neuro-starter-art-1.0.0-dev.zip"
    Set-ArtPolicyFailure $false
    Wait-ArtProjection 'published' $true $publicationEvent
    Test-ArtEdgeDownload $fixture
    Test-ArtRestrictedDownload $fixture
    if ($OpenSearchImage) { Test-ArtIndexerRollback $OpenSearchImage $ValkeyImage $publicationEvent }
    $revoked = Invoke-ArtRequest 'POST' "/v1/me/publishers/$($Run.PublisherId)/signing-keys/local-test-key/revoke" 'art-publisher' @{
        reason = 'Isolated Art revocation test'
    } 200 'revoke-key'
    if ($revoked.status -ne 'revoked') { throw 'Signing key not revoked' }
    if ((Get-ArtSearch).items.Count -ne 0) { throw 'Revoked artifact remains in PG search' }
    Invoke-ArtRequest 'GET' "/v1/public/artifacts/$($Run.Artifact.Id)/download" '' $null 404 | Out-Null
    $revocationEvent = Get-ArtCatalogEvent 'signing_key_revoked'
    Wait-ArtProjection 'revoked' $false $revocationEvent
    $revocationKey = "revoked:signing_key:$($Run.PublisherId):local-test-key"
    if ((Get-ArtPolicyState).keys -notcontains $revocationKey) { throw 'Irreversible signing-key deny was not projected' }
    if ($OpenSearchImage) { Test-ArtRollbackRevocation $revocationEvent; $result.rollback_tested = $true }
    Invoke-ArtRequest 'POST' "/v1/me/publishers/$($Run.PublisherId)/signing-keys/local-test-key/revoke" 'art-publisher' @{
        reason = 'Isolated Art revocation test'
    } 200 'revoke-key' | Out-Null
    if ((Get-ArtCatalogEvent 'signing_key_revoked') -ne $revocationEvent) { throw 'Revoke replay emitted another invalidation' }
    $result.automatic_indexer_propagation_tested = $true
    $result.edge_only_search_dependencies_configured = $false
    $result.explicit_reconcile_called = $false
    Assert-ArtEdgeDenied $Run.DownloadUrl
    Test-ArtRestrictedRevocation
    if (@([IO.Directory]::EnumerateFileSystemEntries("$root/scanner-temp")).Count -ne 0) { throw 'Scanner temporary files remain' }
    $result.status = 'passed'; $result.fixture = $fixture; $result.clamav_version = $Run.ClamAvVersion
    $result.artifact_id = $Run.Artifact.Id; $result.revoked_search_items = 0; $result.revoked_api_status = 404; $result.revoked_edge_status = 404
    $result.binaries = @('assetlibrary-api.exe','assetlibrary-scanner-worker.exe','assetlibrary-outbox-worker.exe',
        'assetlibrary-indexer-worker.exe','examples/build_signed_fixture.exe') | ForEach-Object {
        @{ name = $_; sha256 = (Get-FileHash -LiteralPath "$repo/target/release/$_").Hash.ToLowerInvariant() }
    }
    $result.edge_sources = @('index.ts','range.ts','ticket.ts') | ForEach-Object {
        @{ name = $_; sha256 = (Get-FileHash -LiteralPath "$repo/services/edge/src/$_").Hash.ToLowerInvariant() }
    }
    $result.edge_execution = @('edge-compiled/index.js','edge-compiled/range.js','edge-compiled/ticket.js') | ForEach-Object {
        @{ name = $_; sha256 = (Get-FileHash -LiteralPath "$root/$_").Hash.ToLowerInvariant() }
    }
    $result.edge_adapters = @('edge-server.mjs','s3-bucket.mjs','policy-port.mjs') | ForEach-Object {
        @{ name = $_; sha256 = (Get-FileHash -LiteralPath "$repo/scripts/art-runtime/$_").Hash.ToLowerInvariant() }
    }
} catch {
    $result.status = 'failed'; $result.error = $_.Exception.Message
    throw
} finally {
    try { Stop-RunEnvironment; $result.cleanup_passed = $true }
    catch { $result.status = 'failed'; $result.cleanup_passed = $false; $result.cleanup_error = $_.Exception.Message; throw }
    finally { Write-RunJson 'runtime-result.json' $result }
}
Write-Output "Isolated Art API-to-Edge runtime passed: $root"
