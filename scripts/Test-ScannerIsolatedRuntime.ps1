param(
    [Parameter(Mandatory = $true)][string] $EvidenceDirectory,
    [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string] $PostgresImage,
    [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string] $NatsImage,
    [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string] $MinioImage,
    [ValidateRange(1,65535)][int] $ClamAvPort = 3310
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$root = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\', '/')
$allowed = 'C:\Users\Public\nas_home\AI\GameEditor\linshi\'
if (-not $root.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be under linshi' }
if (Test-Path -LiteralPath $root) { throw 'Refusing to reuse an existing test directory' }
$script:Run = @{
    Root = $root; Repo = $repo; Id = 'al-scan-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)
    Utf8 = [Text.UTF8Encoding]::new($false); DockerCounter = 0
    Containers = [Collections.Generic.List[object]]::new(); Workers = [Collections.Generic.List[object]]::new()
    Secrets = @(); Commands = @{ pg = @(); nats = @('--jetstream','--store_dir=/data','--http_port=8222'); minio = @('server','/data') }
}
. "$PSScriptRoot/scanner-runtime/Environment.ps1"
. "$PSScriptRoot/scanner-runtime/Fixture.ps1"
. "$PSScriptRoot/scanner-runtime/Stack.ps1"
foreach ($directory in @('', 'logs', 'tmp', 'scanner-temp', 'fixtures', 'postgres', 'nats', 'minio')) {
    [void][IO.Directory]::CreateDirectory((Join-Path $root $directory))
}
$result = [ordered]@{ status = 'running'; run_id = $Run.Id; production_ready = $false; real_account_or_cloud_tested = $false }
try {
    Start-RunStack $PostgresImage $NatsImage $MinioImage $ClamAvPort
    $result.clamav_version = $Run.ClamAvVersion
    $natsMonitorPort = $Run.NatsMonitorPort
    Initialize-RunSchema
    $fixtureText = & rtk proxy "$repo/target/release/examples/build_signed_fixture.exe" "$root/fixtures/signed.zip"
    if ($LASTEXITCODE -ne 0) { throw 'Signed fixture generation failed' }
    $fixture = ($fixtureText -join "`n") | ConvertFrom-Json
    if ($fixture.public_key -notmatch '^[0-9a-f]{64}$') { throw 'Invalid fixture key' }
    Invoke-RunSql "INSERT INTO publisher_signing_keys (publisher_id,key_id,public_key,status) VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea1','local-test-key',decode('$($fixture.public_key)','hex'),'active')" | Out-Null
    $artifact = New-RunArtifact 'signed.zip' $fixture.digest $fixture.size_bytes
    $common = $Run.Common
    $scanner = $common.Clone()
    foreach ($key in $Run.Storage.Keys) { $scanner[$key] = $Run.Storage[$key] }
    $scanner.ASSETLIBRARY_SCANNER_TEMP_ROOT = "$root/scanner-temp"; $scanner.ASSETLIBRARY_SCANNER_CONSUMER = $Run.Id
    $scanner.ASSETLIBRARY_SCAN_TIMEOUT_SECONDS = '20'
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $unavailablePort = $listener.LocalEndpoint.Port; $listener.Stop()
    $scanner.ASSETLIBRARY_CLAMAV_ADDRESS = "127.0.0.1:$unavailablePort"
    $firstWorker = Start-RunWorker 'scanner-unavailable' "$repo/target/release/assetlibrary-scanner-worker.exe" $scanner
    Start-RunWorker 'outbox' "$repo/target/release/assetlibrary-outbox-worker.exe" $common | Out-Null
    Wait-RunCondition 'retry on unavailable ClamAV' {
        (Invoke-RunSql "SELECT last_scan_error FROM artifacts WHERE id='$($artifact.Id)'") -eq 'malware_scanner_unavailable'
    }
    Stop-RunWorker $firstWorker
    $beforeRecovery = Get-RunArtifactEvidence $artifact
    if ($beforeRecovery.verified_events -ne 0 -or $beforeRecovery.published_object_key) { throw 'Unavailable malware scanner allowed promotion' }
    $result.recovery_start_consumer = Get-RunConsumer $natsMonitorPort
    $scanner.ASSETLIBRARY_CLAMAV_ADDRESS = "127.0.0.1:$ClamAvPort"
    Start-RunWorker 'scanner-recovered' "$repo/target/release/assetlibrary-scanner-worker.exe" $scanner | Out-Null
    # A forced stop can interrupt the next delivery before NAK. Allow the real
    # 180-second ACK expiry to redeliver; never reset consumer state or seed success.
    Wait-RunArtifact $artifact 'verified' 240
    $result.recovery_wait_limit_seconds = 240
    $verified = Get-RunArtifactEvidence $artifact
    $expectedKey = "sha256/$($fixture.canonical_digest.Substring(0,2))/$($fixture.canonical_digest)"
    if (-not $verified.verification_complete -or $verified.raw_sha256 -ne $fixture.digest -or
        $verified.canonical_sha256 -ne $fixture.canonical_digest -or $verified.published_object_key -ne $expectedKey -or
        $verified.retry_count -lt 1 -or $verified.verified_attempts -ne 1 -or $verified.session_status -ne 'verified') { throw 'Recovery evidence is incomplete' }
    Invoke-RunDocker @('exec',$Run.Minio,'mc','stat',"local/assetlibrary-published/$expectedKey") | Out-Null
    Wait-RunCondition 'recovered event acknowledged' {
        $state = Get-RunConsumer $natsMonitorPort
        $state.ack_floor.consumer_seq -gt 0 -and $state.num_pending -eq 0 -and $state.num_ack_pending -eq 0
    }
    $beforeDuplicateConsumer = Get-RunConsumer $natsMonitorPort
    $duplicate = [guid]::NewGuid().ToString(); Add-RunEvent $artifact $duplicate
    Wait-RunCondition 'duplicate event dispatch' { (Invoke-RunSql "SELECT published_at IS NOT NULL FROM outbox_events WHERE id='$duplicate'") -eq 't' }
    Wait-RunCondition 'duplicate event acknowledged' {
        $state = Get-RunConsumer $natsMonitorPort
        $state.ack_floor.consumer_seq -gt $beforeDuplicateConsumer.ack_floor.consumer_seq -and
            $state.ack_floor.stream_seq -gt $beforeDuplicateConsumer.ack_floor.stream_seq -and
            $state.num_pending -eq 0 -and $state.num_ack_pending -eq 0
    }
    $result.duplicate_consumer = @{ before = $beforeDuplicateConsumer; after = (Get-RunConsumer $natsMonitorPort); event_id = $duplicate }
    $afterDuplicate = Get-RunArtifactEvidence $artifact
    if ($afterDuplicate.verified_events -ne 1 -or $afterDuplicate.attempts -ne $verified.attempts) { throw 'Duplicate scan changed terminal evidence' }
    [IO.File]::WriteAllText("$root/fixtures/invalid.zip", 'not a ZIP archive', $Run.Utf8)
    $badFile = Get-Item -LiteralPath "$root/fixtures/invalid.zip"
    $badDigest = (Get-FileHash -LiteralPath $badFile.FullName).Hash.ToLowerInvariant()
    $badArtifact = New-RunArtifact 'invalid.zip' $badDigest $badFile.Length
    Wait-RunArtifact $badArtifact 'quarantined'
    $rejected = Get-RunArtifactEvidence $badArtifact
    if ($rejected.last_error -ne 'manifest_invalid' -or $rejected.published_object_key -or $rejected.quarantined_events -ne 1) { throw 'Invalid archive was not safely quarantined' }
    $nextArtifact = New-RunArtifact 'signed.zip' $fixture.digest $fixture.size_bytes
    Wait-RunArtifact $nextArtifact 'verified'
    $next = Get-RunArtifactEvidence $nextArtifact
    if ($next.published_object_key -ne $expectedKey -or $next.verified_events -ne 1) { throw 'Next scan or content-addressed reuse failed' }
    if (@([IO.Directory]::EnumerateFileSystemEntries("$root/scanner-temp")).Count -ne 0) { throw 'Scanner temporary files remain' }
    $result.status = 'passed'; $result.before_recovery = $beforeRecovery; $result.recovered = $verified
    $result.after_duplicate = $afterDuplicate; $result.invalid_archive = $rejected; $result.next_artifact = $next
    $result.images = @($Run.Containers); $result.fixture = $fixture
    $result.binaries = @('assetlibrary-scanner-worker.exe','assetlibrary-outbox-worker.exe') | ForEach-Object {
        @{ name = $_; sha256 = (Get-FileHash -LiteralPath "$repo/target/release/$_").Hash.ToLowerInvariant() }
    }
} catch {
    $result.status = 'failed'; $result.error = $_.Exception.Message
    throw
} finally {
    try {
        Stop-RunEnvironment
        $result.cleanup_passed = $true
    } catch {
        $result.status = 'failed'; $result.cleanup_passed = $false; $result.cleanup_error = $_.Exception.Message
        throw
    } finally { Write-RunJson 'runtime-result.json' $result }
}
Write-Output "Isolated scanner runtime passed: $root"
