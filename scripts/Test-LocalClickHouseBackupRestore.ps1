[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [string]$EvidenceRoot = 'test-results/p8-recovery'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$container = 'assetlibrary-clickhouse-1'
$runId = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))_$PID"
$sourceDatabase = "al_recovery_source_$runId"
$restoredDatabase = "al_recovery_restored_$runId"
$backupName = "recovery-$($runId.Replace('_', '-')).zip"
$backupPath = "/var/lib/clickhouse/backups/$backupName"
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
    if ($exitCode -ne 0) {
        $detail = ($output | Out-String).Trim()
        if ($detail.Length -gt 1000) { $detail = $detail.Substring(0, 1000) }
        throw "Docker command failed: $($Arguments[0]). $detail"
    }
    return $output
}

function Invoke-ClickHouse([string]$Sql, [switch]$MultiQuery) {
    $arguments = @('exec', $container, 'clickhouse-client', '--format', 'TabSeparatedRaw')
    if ($MultiQuery) { $arguments += '--multiquery' }
    $arguments += @('--query', $Sql)
    return (Invoke-Docker $arguments | Out-String).Trim()
}

function Get-DatabaseFingerprint([string]$Database) {
    if ($Database -notmatch '^al_recovery_(source|restored)_[0-9]+_[0-9]+$') {
        throw 'Unsafe ClickHouse recovery database name.'
    }
    return [ordered]@{
        tables = Invoke-ClickHouse "SELECT concat(name, ':', engine) FROM system.tables WHERE database='$Database' ORDER BY name"
        event_count = [long](Invoke-ClickHouse "SELECT count() FROM $Database.events")
        event_id_sha256 = Invoke-ClickHouse "SELECT hex(SHA256(arrayStringConcat(arraySort(groupArray(toString(event_id))), ','))) FROM $Database.events"
        occurred_range = Invoke-ClickHouse "SELECT concat(toString(min(occurred_at)), '/', toString(max(occurred_at))) FROM $Database.events"
        partitions = Invoke-ClickHouse "SELECT concat(partition, ':', toString(sum(rows))) FROM system.parts WHERE active AND database='$Database' AND table='events' GROUP BY partition ORDER BY partition"
        daily_totals = Invoke-ClickHouse "SELECT concat(toString(day), ':', kind, ':', toString(sum(events)), ':', toString(sum(bytes))) FROM $Database.daily_totals GROUP BY day, kind ORDER BY day, kind"
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
    $compose = Get-Content -LiteralPath (Join-Path $root 'deploy/local/compose.yaml') -Raw
    if ($compose -notmatch 'clickhouse-backup-data:/var/lib/clickhouse/backups' -or
        $compose -notmatch 'clickhouse/clickhouse-server:26\.8-alpine') {
        throw 'Local ClickHouse backup volume or image pin is missing.'
    }
    Write-Output 'Local ClickHouse backup/restore configuration is valid.'
    return
}

$evidence = Join-Path $evidenceBase "$($runId.Replace('_', '-'))-clickhouse"
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$started = (Get-Date).ToUniversalTime()
$stage = 'preflight'
$failureStage = $null
$failureCode = $null
$sourceFingerprint = $null
$restoredFingerprint = $null
$backupSha256 = $null
$backupBytes = $null
$backupSeconds = $null
$restoreSeconds = $null
$version = $null
$sourceCreated = $false
$restoredCreated = $false
$backupCreated = $false
$cleanupFailures = 0

try {
    $running = (Invoke-Docker @('inspect', '--format', '{{.State.Running}}', $container) | Out-String).Trim()
    if ($running -ne 'true') { throw 'Local ClickHouse container is not running.' }
    $version = Invoke-ClickHouse 'SELECT version()'

    $stage = 'fixture'
    Invoke-ClickHouse "CREATE DATABASE $sourceDatabase" | Out-Null
    $sourceCreated = $true
    $fixture = @"
CREATE TABLE $sourceDatabase.events (
    event_id UUID,
    occurred_at DateTime64(3, 'UTC'),
    kind LowCardinality(String),
    bytes UInt64
) ENGINE = MergeTree PARTITION BY toYYYYMM(occurred_at) ORDER BY (occurred_at, event_id);
CREATE TABLE $sourceDatabase.daily_totals (
    day Date,
    kind LowCardinality(String),
    events UInt64,
    bytes UInt64
) ENGINE = SummingMergeTree ORDER BY (day, kind);
CREATE MATERIALIZED VIEW $sourceDatabase.events_daily_mv TO $sourceDatabase.daily_totals AS
SELECT toDate(occurred_at) AS day, kind, count() AS events, sum(bytes) AS bytes
FROM $sourceDatabase.events GROUP BY day, kind;
INSERT INTO $sourceDatabase.events VALUES
    ('00000000-0000-4000-8000-000000000001', '2026-01-10 10:00:00.000', 'download', 1024),
    ('00000000-0000-4000-8000-000000000002', '2026-01-10 11:00:00.000', 'download', 2048),
    ('00000000-0000-4000-8000-000000000003', '2026-02-11 12:00:00.000', 'install', 4096);
"@
    Invoke-ClickHouse $fixture -MultiQuery | Out-Null
    $sourceFingerprint = Get-DatabaseFingerprint $sourceDatabase

    $stage = 'backup'
    $backupStarted = (Get-Date).ToUniversalTime()
    $backupCreated = $true
    $backupResult = Invoke-ClickHouse "BACKUP DATABASE $sourceDatabase TO File('$backupName')"
    $backupSeconds = ((Get-Date).ToUniversalTime() - $backupStarted).TotalSeconds
    if ($backupResult -notmatch 'BACKUP_CREATED') { throw 'ClickHouse backup did not report completion.' }
    $backupSha256 = ((Invoke-Docker @('exec', $container, 'sha256sum', $backupPath) | Out-String).Trim() -split '\s+')[0]
    $backupBytes = [long]((Invoke-Docker @('exec', $container, 'stat', '-c', '%s', $backupPath) | Out-String).Trim())

    $stage = 'isolated_restore'
    $restoreStarted = (Get-Date).ToUniversalTime()
    $restoredCreated = $true
    $restoreResult = Invoke-ClickHouse "RESTORE DATABASE $sourceDatabase AS $restoredDatabase FROM File('$backupName')"
    $restoreSeconds = ((Get-Date).ToUniversalTime() - $restoreStarted).TotalSeconds
    if ($restoreResult -notmatch 'RESTORED') { throw 'ClickHouse restore did not report completion.' }

    $stage = 'reconciliation'
    $restoredFingerprint = Get-DatabaseFingerprint $restoredDatabase
    $sourceJson = $sourceFingerprint | ConvertTo-Json -Depth 8 -Compress
    $restoredJson = $restoredFingerprint | ConvertTo-Json -Depth 8 -Compress
    if ($sourceJson -cne $restoredJson) { throw 'Restored ClickHouse database fingerprint does not match the source.' }
} catch {
    $failureStage = $stage
    $failureCode = $_.Exception.Message
} finally {
    if ($restoredCreated -and $restoredDatabase -match '^al_recovery_restored_[0-9]+_[0-9]+$') {
        try { Invoke-ClickHouse "DROP DATABASE IF EXISTS $restoredDatabase" | Out-Null } catch { $cleanupFailures++ }
    }
    if ($sourceCreated -and $sourceDatabase -match '^al_recovery_source_[0-9]+_[0-9]+$') {
        try { Invoke-ClickHouse "DROP DATABASE IF EXISTS $sourceDatabase" | Out-Null } catch { $cleanupFailures++ }
    }
    if ($backupCreated -and $backupName -match '^recovery-[0-9]+-[0-9]+\.zip$') {
        try { Invoke-Docker @('exec', $container, 'rm', '-f', $backupPath) | Out-Null } catch { $cleanupFailures++ }
    }
}
if (-not $failureStage -and $cleanupFailures -gt 0) {
    $failureStage = 'cleanup'
    $failureCode = 'One or more guarded ClickHouse recovery resources could not be removed.'
}

$finished = (Get-Date).ToUniversalTime()
$sourceJson = if ($sourceFingerprint) { $sourceFingerprint | ConvertTo-Json -Depth 8 -Compress } else { $null }
$restoredJson = if ($restoredFingerprint) { $restoredFingerprint | ConvertTo-Json -Depth 8 -Compress } else { $null }
$manifest = [ordered]@{
    schema_version = '1.0'
    scope = 'local-clickhouse-fixture-backup'
    status = if ($failureStage) { 'failed' } else { 'passed' }
    failure_stage = $failureStage
    failure_code = $failureCode
    started_at = $started.ToString('o')
    finished_at = $finished.ToString('o')
    git_commit = Get-GitCommit
    clickhouse_version = $version
    backup_sha256 = $backupSha256
    backup_bytes = $backupBytes
    backup_duration_seconds = $backupSeconds
    restore_duration_seconds = $restoreSeconds
    event_count = if ($sourceFingerprint) { $sourceFingerprint.event_count } else { $null }
    source_fingerprint_sha256 = if ($sourceJson) { Get-TextSha256 $sourceJson } else { $null }
    restored_fingerprint_sha256 = if ($restoredJson) { Get-TextSha256 $restoredJson } else { $null }
    limitations = @('fixture database only', 'same local ClickHouse server', 'not encrypted independent storage', 'not production RPO/RTO evidence')
} | ConvertTo-Json -Depth 8
$manifestPath = Join-Path $evidence 'run-manifest.json'
[IO.File]::WriteAllText($manifestPath, $manifest + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if ($failureStage) { throw "Local ClickHouse restore failed during $failureStage. Evidence: $evidence" }
Write-Output "Local ClickHouse backup/restore passed. Evidence: $evidence"
