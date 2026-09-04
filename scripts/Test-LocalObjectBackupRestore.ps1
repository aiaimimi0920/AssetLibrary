[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [string]$EvidenceRoot = 'test-results/p8-recovery'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$container = 'assetlibrary-object-store-1'
$runId = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))-$PID"
$sourcePublished = "al-recovery-src-$runId-pub"
$sourceQuarantine = "al-recovery-src-$runId-quarantine"
$restoredPublished = "al-recovery-dst-$runId-pub"
$restoredQuarantine = "al-recovery-dst-$runId-quarantine"
$containerRoot = "/tmp/assetlibrary-minio-recovery-$runId"
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

function Assert-PrivateBucket([string]$Bucket) {
    $policy = (Invoke-Docker @('exec', $container, 'mc', 'anonymous', 'get', "local/$Bucket") | Out-String).Trim()
    if ($policy -notmatch 'private') { throw 'Object-store bucket is not private.' }
}

function Get-ObjectFact([string]$Bucket, [string]$Key, [string]$Suffix) {
    $path = "$containerRoot/verify-$Suffix"
    Invoke-Docker @('exec', $container, 'mc', 'cp', "local/$Bucket/$Key", $path) | Out-Null
    $digest = ((Invoke-Docker @('exec', $container, 'sha256sum', $path) | Out-String).Trim() -split '\s+')[0]
    $bytes = [long]((Invoke-Docker @('exec', $container, 'stat', '-c', '%s', $path) | Out-String).Trim())
    return [ordered]@{ key = $Key; bytes = $bytes; sha256 = $digest }
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
    if ($compose -notmatch 'minio/minio:RELEASE\.2025-04-22T22-12-26Z') {
        throw 'Local object-store version is not pinned.'
    }
    Write-Output 'Local object-store backup/restore configuration is valid.'
    return
}

$evidence = Join-Path $evidenceBase "$runId-object-store"
$hostFixtures = Join-Path $env:TEMP "assetlibrary-object-fixtures-$runId"
New-Item -ItemType Directory -Path $evidence, $hostFixtures -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $hostFixtures 'published.txt'), 'published-art-fixture', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $hostFixtures 'quarantine.txt'), 'quarantine-capability-fixture', [Text.UTF8Encoding]::new($false))
$publishedKey = "sha256/recovery/$runId/art.txt"
$quarantineKey = "quarantine/recovery/$runId/capability.txt"
$started = (Get-Date).ToUniversalTime()
$stage = 'preflight'
$failureStage = $null
$failureCode = $null
$sourceFacts = $null
$restoredFacts = $null
$mcVersion = $null
$canonicalPrivate = $false
$cleanupFailures = 0
$createdBuckets = New-Object Collections.Generic.List[string]

try {
    $running = (Invoke-Docker @('inspect', '--format', '{{.State.Running}}', $container) | Out-String).Trim()
    if ($running -ne 'true') { throw 'Local object-store container is not running.' }
    $mcVersion = (Invoke-Docker @('exec', $container, 'mc', '--version') | Select-Object -First 1).ToString().Trim()
    foreach ($bucket in @('assetlibrary-published', 'assetlibrary-quarantine')) { Assert-PrivateBucket $bucket }
    $canonicalPrivate = $true
    Invoke-Docker @('exec', $container, 'mkdir', '-p', "$containerRoot/fixtures", "$containerRoot/backup/published", "$containerRoot/backup/quarantine") | Out-Null
    Invoke-Docker @('cp', (Join-Path $hostFixtures 'published.txt'), "$container`:$containerRoot/fixtures/published.txt") | Out-Null
    Invoke-Docker @('cp', (Join-Path $hostFixtures 'quarantine.txt'), "$container`:$containerRoot/fixtures/quarantine.txt") | Out-Null

    $stage = 'fixture'
    foreach ($bucket in @($sourcePublished, $sourceQuarantine, $restoredPublished, $restoredQuarantine)) {
        Invoke-Docker @('exec', $container, 'mc', 'mb', "local/$bucket") | Out-Null
        $createdBuckets.Add($bucket)
        Invoke-Docker @('exec', $container, 'mc', 'anonymous', 'set', 'none', "local/$bucket") | Out-Null
    }
    Invoke-Docker @('exec', $container, 'mc', 'cp', "$containerRoot/fixtures/published.txt", "local/$sourcePublished/$publishedKey") | Out-Null
    Invoke-Docker @('exec', $container, 'mc', 'cp', "$containerRoot/fixtures/quarantine.txt", "local/$sourceQuarantine/$quarantineKey") | Out-Null
    $sourceFacts = @(
        Get-ObjectFact $sourcePublished $publishedKey 'source-published'
        Get-ObjectFact $sourceQuarantine $quarantineKey 'source-quarantine'
    )

    $stage = 'backup'
    Invoke-Docker @('exec', $container, 'mc', 'mirror', '--overwrite', '--preserve',
        "local/$sourcePublished", "$containerRoot/backup/published") | Out-Null
    Invoke-Docker @('exec', $container, 'mc', 'mirror', '--overwrite', '--preserve',
        "local/$sourceQuarantine", "$containerRoot/backup/quarantine") | Out-Null

    $stage = 'isolated_restore'
    Invoke-Docker @('exec', $container, 'mc', 'mirror', '--overwrite', '--preserve',
        "$containerRoot/backup/published", "local/$restoredPublished") | Out-Null
    Invoke-Docker @('exec', $container, 'mc', 'mirror', '--overwrite', '--preserve',
        "$containerRoot/backup/quarantine", "local/$restoredQuarantine") | Out-Null
    Assert-PrivateBucket $restoredPublished
    Assert-PrivateBucket $restoredQuarantine
    $restoredFacts = @(
        Get-ObjectFact $restoredPublished $publishedKey 'restored-published'
        Get-ObjectFact $restoredQuarantine $quarantineKey 'restored-quarantine'
    )
    $sourceJson = $sourceFacts | ConvertTo-Json -Depth 5 -Compress
    $restoredJson = $restoredFacts | ConvertTo-Json -Depth 5 -Compress
    if ($sourceJson -cne $restoredJson) { throw 'Restored object inventory does not match the source fixtures.' }
} catch {
    $failureStage = $stage
    $failureCode = $_.Exception.Message
} finally {
    foreach ($bucket in $createdBuckets) {
        if ($bucket -match '^al-recovery-(src|dst)-[0-9]+-[0-9]+-(pub|quarantine)$') {
            try { Invoke-Docker @('exec', $container, 'mc', 'rb', '--force', "local/$bucket") | Out-Null } catch { $cleanupFailures++ }
        }
    }
    if ($containerRoot -match '^/tmp/assetlibrary-minio-recovery-[0-9]+-[0-9]+$') {
        try { Invoke-Docker @('exec', $container, 'rm', '-rf', $containerRoot) | Out-Null } catch { $cleanupFailures++ }
    }
    try {
        Remove-Item -LiteralPath $hostFixtures -Recurse -Force -ErrorAction Stop
    } catch {
        $cleanupFailures++
    }
}
if (-not $failureStage -and $cleanupFailures -gt 0) {
    $failureStage = 'cleanup'
    $failureCode = 'One or more guarded object-store recovery resources could not be removed.'
}

$finished = (Get-Date).ToUniversalTime()
$sourceJson = if ($sourceFacts) { $sourceFacts | ConvertTo-Json -Depth 5 -Compress } else { $null }
$restoredJson = if ($restoredFacts) { $restoredFacts | ConvertTo-Json -Depth 5 -Compress } else { $null }
$manifest = [ordered]@{
    schema_version = '1.0'
    scope = 'local-minio-fixture-export'
    status = if ($failureStage) { 'failed' } else { 'passed' }
    failure_stage = $failureStage
    failure_code = $failureCode
    started_at = $started.ToString('o')
    finished_at = $finished.ToString('o')
    git_commit = Get-GitCommit
    mc_version = $mcVersion
    canonical_buckets_private = $canonicalPrivate
    object_count = if ($sourceFacts) { $sourceFacts.Count } else { $null }
    source_fingerprint_sha256 = if ($sourceJson) { Get-TextSha256 $sourceJson } else { $null }
    restored_fingerprint_sha256 = if ($restoredJson) { Get-TextSha256 $restoredJson } else { $null }
    objects = $sourceFacts
    limitations = @('fixture buckets only', 'same local MinIO process', 'not R2 bucket lock or lifecycle evidence', 'not production RPO/RTO evidence')
} | ConvertTo-Json -Depth 8
$manifestPath = Join-Path $evidence 'run-manifest.json'
[IO.File]::WriteAllText($manifestPath, $manifest + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if ($failureStage) { throw "Local object-store restore failed during $failureStage. Evidence: $evidence" }
Write-Output "Local object-store backup/restore passed. Evidence: $evidence"
