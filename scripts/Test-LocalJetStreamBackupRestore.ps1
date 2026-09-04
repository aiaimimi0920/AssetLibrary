[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [string]$EvidenceRoot = 'test-results/p8-recovery'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sourceContainer = 'assetlibrary-nats-1'
$streamName = 'ASSETLIBRARY_EVENTS'
$runId = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))-$PID"
$recoveryContainer = "assetlibrary-nats-recovery-$runId"
$natsImage = 'nats@sha256:31c6ed3b2da61645aaa3ad9217b5a52b34b6ebd555ecb71259cd7723c59ae1ea'
$natsBoxImage = 'natsio/nats-box@sha256:4b4fb1128c3ba46180d4510aaf2ca792c3fa997e4968a7bc9062f9554fbdb8b4'
. (Join-Path $PSScriptRoot 'RepositoryEvidencePath.ps1')

function Invoke-Docker([string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & docker @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw "Docker command failed: $($Arguments[0])" }
    return $output
}

function Invoke-Nats([string]$Container, [string[]]$NatsArguments, [string]$BackupMount) {
    $arguments = @('run', '--rm', '--network', "container:$Container")
    if ($BackupMount) { $arguments += @('-v', "${BackupMount}:/backup") }
    $arguments += @($natsBoxImage, 'nats', '--server', 'nats://127.0.0.1:4222')
    $arguments += $NatsArguments
    return Invoke-Docker $arguments
}

function Get-JetStreamFingerprint([string]$Container) {
    $streamRaw = Invoke-Nats $Container @('stream', 'info', '-j', $streamName) $null | Out-String
    $stream = $streamRaw | ConvertFrom-Json
    $namesRaw = Invoke-Nats $Container @('consumer', 'list', '-j', $streamName) $null | Out-String
    $parsedNames = $namesRaw | ConvertFrom-Json
    $names = @($parsedNames | Sort-Object)
    $consumers = @()
    foreach ($name in $names) {
        $raw = Invoke-Nats $Container @('consumer', 'info', '-j', $streamName, [string]$name) $null | Out-String
        $info = $raw | ConvertFrom-Json
        $consumers += [ordered]@{
            name = [string]$name
            config = $info.config
            delivered = [ordered]@{
                consumer_sequence = $info.delivered.consumer_seq
                stream_sequence = $info.delivered.stream_seq
            }
            ack_floor = [ordered]@{
                consumer_sequence = $info.ack_floor.consumer_seq
                stream_sequence = $info.ack_floor.stream_seq
            }
            num_ack_pending = $info.num_ack_pending
            num_redelivered = $info.num_redelivered
            num_pending = $info.num_pending
        }
    }
    return [ordered]@{
        config = $stream.config
        state = $stream.state
        consumers = $consumers
    }
}

function Get-TextSha256([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))
        return ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-GitCommit {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'SilentlyContinue'
        $commit = & git -C $root rev-parse --verify HEAD 2>$null
        if ($LASTEXITCODE -eq 0) { return "$commit".Trim() }
        return $null
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

$evidenceBase = Resolve-RepositoryEvidencePath -RepositoryRoot $root -RawPath $EvidenceRoot
if ($ValidateOnly) {
    if ($natsImage -notmatch '@sha256:[0-9a-f]{64}$' -or $natsBoxImage -notmatch '@sha256:[0-9a-f]{64}$') {
        throw 'JetStream recovery images must be pinned by digest.'
    }
    Write-Output 'Local JetStream backup/restore configuration is valid.'
    return
}

$evidence = Join-Path $evidenceBase "$runId-jetstream"
$backupDirectory = Join-Path $env:TEMP "assetlibrary-js-backup-$runId"
New-Item -ItemType Directory -Path $evidence, $backupDirectory -Force | Out-Null
$started = (Get-Date).ToUniversalTime()
$stage = 'preflight'
$failureStage = $null
$failureCode = $null
$sourceFingerprint = $null
$restoredFingerprint = $null
$backupFiles = @()
$restoreSeconds = $null
$cliVersion = $null
$recoveryStarted = $false
$cleanupFailures = 0

try {
    $running = (Invoke-Docker @('inspect', '--format', '{{.State.Running}}', $sourceContainer) | Out-String).Trim()
    if ($running -ne 'true') { throw 'Local NATS container is not running.' }
    $cliVersion = (Invoke-Docker @('run', '--rm', $natsBoxImage, 'nats', '--version') | Out-String).Trim()
    $sourceFingerprint = Get-JetStreamFingerprint $sourceContainer

    $stage = 'backup'
    Invoke-Nats $sourceContainer @('stream', 'backup', '--check', '--no-progress', '--consumers', $streamName, '/backup') $backupDirectory | Out-Null
    $backupFiles = @(Get-ChildItem -LiteralPath $backupDirectory -File | Sort-Object Name | ForEach-Object {
        [ordered]@{
            name = $_.Name
            bytes = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
    if ($backupFiles.Count -lt 2) { throw 'JetStream backup is incomplete.' }

    $stage = 'isolated_restore'
    Invoke-Docker @('run', '-d', '--name', $recoveryContainer, '--label', 'com.neuro.assetlibrary.recovery=true',
        $natsImage, '--jetstream', '--store_dir=/data', '--http_port=8222') | Out-Null
    $recoveryStarted = $true
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            Invoke-Docker @('exec', $recoveryContainer, 'wget', '-q', '--spider', 'http://127.0.0.1:8222/healthz') | Out-Null
            $healthy = $true
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $healthy) { throw 'Recovery NATS container did not become healthy.' }
    $restoreStarted = (Get-Date).ToUniversalTime()
    Invoke-Nats $recoveryContainer @('stream', 'restore', '--no-progress', '/backup') $backupDirectory | Out-Null
    $restoreSeconds = ((Get-Date).ToUniversalTime() - $restoreStarted).TotalSeconds

    $stage = 'reconciliation'
    $restoredFingerprint = Get-JetStreamFingerprint $recoveryContainer
    $sourceJson = $sourceFingerprint | ConvertTo-Json -Depth 30 -Compress
    $restoredJson = $restoredFingerprint | ConvertTo-Json -Depth 30 -Compress
    if ($sourceJson -cne $restoredJson) {
        [IO.File]::WriteAllText(
            (Join-Path $evidence 'source-fingerprint.json'),
            ($sourceFingerprint | ConvertTo-Json -Depth 30) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false)
        )
        [IO.File]::WriteAllText(
            (Join-Path $evidence 'restored-fingerprint.json'),
            ($restoredFingerprint | ConvertTo-Json -Depth 30) + [Environment]::NewLine,
            [Text.UTF8Encoding]::new($false)
        )
        throw 'Restored JetStream fingerprint does not match the source.'
    }
} catch {
    $failureStage = $stage
    $failureCode = $_.Exception.Message
} finally {
    if ($recoveryStarted -and $recoveryContainer -match '^assetlibrary-nats-recovery-[0-9]+-[0-9]+$') {
        try { Invoke-Docker @('rm', '-f', $recoveryContainer) | Out-Null } catch { $cleanupFailures++ }
    }
    try {
        Remove-Item -LiteralPath $backupDirectory -Recurse -Force -ErrorAction Stop
    } catch {
        $cleanupFailures++
    }
}
if (-not $failureStage -and $cleanupFailures -gt 0) {
    $failureStage = 'cleanup'
    $failureCode = 'One or more guarded JetStream recovery resources could not be removed.'
}

$finished = (Get-Date).ToUniversalTime()
$sourceJson = if ($sourceFingerprint) { $sourceFingerprint | ConvertTo-Json -Depth 30 -Compress } else { $null }
$restoredJson = if ($restoredFingerprint) { $restoredFingerprint | ConvertTo-Json -Depth 30 -Compress } else { $null }
$state = if ($sourceFingerprint) { $sourceFingerprint.state } else { $null }
$manifest = [ordered]@{
    schema_version = '1.0'
    scope = 'local-jetstream-stream-and-consumers'
    status = if ($failureStage) { 'failed' } else { 'passed' }
    failure_stage = $failureStage
    failure_code = $failureCode
    started_at = $started.ToString('o')
    finished_at = $finished.ToString('o')
    git_commit = Get-GitCommit
    server_image = $natsImage
    cli_image = $natsBoxImage
    cli_version = $cliVersion
    stream = $streamName
    messages = if ($state) { $state.messages } else { $null }
    bytes = if ($state) { $state.bytes } else { $null }
    first_sequence = if ($state) { $state.first_seq } else { $null }
    last_sequence = if ($state) { $state.last_seq } else { $null }
    consumer_count = if ($state) { $state.consumer_count } else { $null }
    backup_files = $backupFiles
    restore_duration_seconds = $restoreSeconds
    source_fingerprint_sha256 = if ($sourceJson) { Get-TextSha256 $sourceJson } else { $null }
    restored_fingerprint_sha256 = if ($restoredJson) { Get-TextSha256 $restoredJson } else { $null }
    limitations = @('single-node local restore', 'not production RPO/RTO evidence', 'not an independent encrypted backup store')
} | ConvertTo-Json -Depth 10
$manifestPath = Join-Path $evidence 'run-manifest.json'
[IO.File]::WriteAllText($manifestPath, $manifest + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if ($failureStage) { throw "Local JetStream restore failed during $failureStage. Evidence: $evidence" }
Write-Output "Local JetStream backup/restore passed. Evidence: $evidence"
