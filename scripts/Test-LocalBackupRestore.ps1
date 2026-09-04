[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [string]$EvidenceRoot = 'test-results/p8-recovery'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$container = 'assetlibrary-postgres-1'
$sourceDatabase = 'assetlibrary'
$restoreDatabase = "assetlibrary_restore_$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))_$PID"
$dumpPath = "/tmp/$restoreDatabase.dump"
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

function Invoke-SqlValue([string]$Database, [string]$Sql) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & docker exec $container psql -U assetlibrary -d $Database -v ON_ERROR_STOP=1 -At -c $Sql 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw 'PostgreSQL verification query failed.' }
    return (($output | Out-String).Trim())
}

function Get-DatabaseFingerprint([string]$Database) {
    $tableOutput = Invoke-SqlValue $Database "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    $tables = @($tableOutput -split '\r?\n' | Where-Object { $_ })
    if ($tables.Count -eq 0) { throw 'Source database has no public tables; run migrations first.' }
    $counts = [ordered]@{}
    foreach ($table in $tables) {
        if ($table -notmatch '^[a-z][a-z0-9_]*$') { throw 'Unexpected table identifier.' }
        $counts[$table] = [long](Invoke-SqlValue $Database "SELECT count(*) FROM public.`"$table`"")
    }
    return [ordered]@{
        table_counts = $counts
        constraint_count = [long](Invoke-SqlValue $Database "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace")
        migration_ids = Invoke-SqlValue $Database "SELECT COALESCE(string_agg(migration_id, ',' ORDER BY migration_id), '') FROM migration_checkpoints"
        audit_event_count = [long](Invoke-SqlValue $Database 'SELECT count(*) FROM audit_events')
        audit_sequence_sha256 = Invoke-SqlValue $Database "SELECT encode(digest(COALESCE(string_agg(id::text, ',' ORDER BY occurred_at, id), ''), 'sha256'), 'hex') FROM audit_events"
        outbox_event_count = [long](Invoke-SqlValue $Database 'SELECT count(*) FROM outbox_events')
        outbox_sequence_sha256 = Invoke-SqlValue $Database "SELECT encode(digest(COALESCE(string_agg(id::text, ',' ORDER BY occurred_at, id), ''), 'sha256'), 'hex') FROM outbox_events"
        extensions = Invoke-SqlValue $Database "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname IN ('citext', 'pgcrypto')"
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
    Write-Output 'Local PostgreSQL backup/restore configuration is valid.'
    return
}

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$evidence = Join-Path $evidenceBase "$timestamp-postgresql"
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$started = (Get-Date).ToUniversalTime()
$stage = 'preflight'
$failureStage = $null
$sourceFingerprint = $null
$restoredFingerprint = $null
$dumpSha256 = $null
$dumpBytes = $null
$restoreSeconds = $null
$pgDumpVersion = $null
$restoreCreated = $false
$dumpCreated = $false
$cleanupFailures = 0
$failureCode = $null

try {
    $running = (Invoke-Docker @('inspect', '--format', '{{.State.Running}}', $container) | Out-String).Trim()
    if ($running -ne 'true') { throw 'Local PostgreSQL container is not running.' }
    if ((Invoke-SqlValue $sourceDatabase "SELECT to_regclass('public.migration_checkpoints') IS NOT NULL") -ne 't') {
        throw 'Source database migrations are not initialized.'
    }
    $pgDumpVersion = (Invoke-Docker @('exec', $container, 'pg_dump', '--version') | Out-String).Trim()
    $sourceFingerprint = Get-DatabaseFingerprint $sourceDatabase

    $stage = 'backup'
    $dumpCreated = $true
    Invoke-Docker @('exec', $container, 'pg_dump', '-U', 'assetlibrary', '-d', $sourceDatabase,
        '--format=custom', '--no-owner', '--no-privileges', "--file=$dumpPath") | Out-Null
    $dumpSha256 = ((Invoke-Docker @('exec', $container, 'sha256sum', $dumpPath) | Out-String).Trim() -split '\s+')[0]
    $dumpBytes = [long]((Invoke-Docker @('exec', $container, 'stat', '-c', '%s', $dumpPath) | Out-String).Trim())

    $stage = 'isolated_restore'
    $restoreCreated = $true
    Invoke-Docker @('exec', $container, 'createdb', '-U', 'assetlibrary', '-T', 'template0', $restoreDatabase) | Out-Null
    $restoreStarted = (Get-Date).ToUniversalTime()
    Invoke-Docker @('exec', $container, 'pg_restore', '-U', 'assetlibrary', '-d', $restoreDatabase,
        '--exit-on-error', '--no-owner', '--no-privileges', $dumpPath) | Out-Null
    $restoreSeconds = ((Get-Date).ToUniversalTime() - $restoreStarted).TotalSeconds

    $stage = 'reconciliation'
    $restoredFingerprint = Get-DatabaseFingerprint $restoreDatabase
    $sourceJson = $sourceFingerprint | ConvertTo-Json -Depth 8 -Compress
    $restoredJson = $restoredFingerprint | ConvertTo-Json -Depth 8 -Compress
    if ($sourceJson -cne $restoredJson) { throw 'Restored database fingerprint does not match the source.' }
} catch {
    $failureStage = $stage
    $failureCode = $_.Exception.Message
} finally {
    if ($restoreCreated -and $restoreDatabase -match '^assetlibrary_restore_[0-9]+_[0-9]+$') {
        try { Invoke-Docker @('exec', $container, 'dropdb', '-U', 'assetlibrary', '--if-exists', '--force', $restoreDatabase) | Out-Null } catch { $cleanupFailures++ }
    }
    if ($dumpCreated -and $dumpPath -match '^/tmp/assetlibrary_restore_[0-9]+_[0-9]+\.dump$') {
        try { Invoke-Docker @('exec', $container, 'rm', '-f', $dumpPath) | Out-Null } catch { $cleanupFailures++ }
    }
}
if (-not $failureStage -and $cleanupFailures -gt 0) {
    $failureStage = 'cleanup'
    $failureCode = 'One or more guarded PostgreSQL recovery resources could not be removed.'
}

$finished = (Get-Date).ToUniversalTime()
$sourceJson = if ($sourceFingerprint) { $sourceFingerprint | ConvertTo-Json -Depth 8 -Compress } else { $null }
$restoredJson = if ($restoredFingerprint) { $restoredFingerprint | ConvertTo-Json -Depth 8 -Compress } else { $null }
$manifest = [ordered]@{
    schema_version = '1.0'
    scope = 'local-logical-postgresql'
    status = if ($failureStage) { 'failed' } else { 'passed' }
    failure_stage = $failureStage
    failure_code = $failureCode
    started_at = $started.ToString('o')
    finished_at = $finished.ToString('o')
    git_commit = Get-GitCommit
    pg_dump_version = $pgDumpVersion
    dump_sha256 = $dumpSha256
    dump_bytes = $dumpBytes
    logical_restore_duration_seconds = $restoreSeconds
    source_fingerprint_sha256 = if ($sourceJson) { Get-TextSha256 $sourceJson } else { $null }
    restored_fingerprint_sha256 = if ($restoredJson) { Get-TextSha256 $restoredJson } else { $null }
    table_counts = if ($sourceFingerprint) { $sourceFingerprint.table_counts } else { $null }
    migration_ids = if ($sourceFingerprint) { $sourceFingerprint.migration_ids } else { $null }
    audit_event_count = if ($sourceFingerprint) { $sourceFingerprint.audit_event_count } else { $null }
    outbox_event_count = if ($sourceFingerprint) { $sourceFingerprint.outbox_event_count } else { $null }
    limitations = @('not PostgreSQL PITR', 'not production RPO/RTO evidence', 'does not cover other data systems')
} | ConvertTo-Json -Depth 8
$manifestPath = Join-Path $evidence 'run-manifest.json'
[IO.File]::WriteAllText($manifestPath, $manifest + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if ($failureStage) { throw "Local PostgreSQL restore failed during $failureStage. Evidence: $evidence" }
Write-Output "Local PostgreSQL logical backup/restore passed. Evidence: $evidence"
