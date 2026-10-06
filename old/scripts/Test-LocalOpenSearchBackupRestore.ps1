[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [string]$EvidenceRoot = 'test-results/p8-recovery'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runId = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))-$PID"
$sourceIndex = "assetlibrary-recovery-fixture-$runId"
$restoredIndex = "$sourceIndex-restored"
$aliasName = "$sourceIndex-alias"
$repository = "assetlibrary-recovery-$runId"
$snapshot = "snapshot-$runId"
$endpoint = 'https://127.0.0.1:9200'
. (Join-Path $PSScriptRoot 'RepositoryEvidencePath.ps1')

function Import-LocalEnvironment {
    $envPath = Join-Path $root '.env'
    if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
    Get-Content -LiteralPath $envPath | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
    if ([string]::IsNullOrWhiteSpace($env:OPENSEARCH_INITIAL_ADMIN_PASSWORD)) {
        throw 'Local OpenSearch admin password is missing.'
    }
}

function Write-PrivateCurlConfig([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, '', [Text.UTF8Encoding]::new($false))
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetOwner($identity)
    $security.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $identity,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $security
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Invoke-OpenSearch([string]$Method, [string]$Path, [string]$Body) {
    if ($Path -notmatch '^/[A-Za-z0-9_.*?,=&:/-]*$') { throw 'Unsafe OpenSearch request path.' }
    $responsePath = Join-Path $env:TEMP "assetlibrary-os-response-$runId-$([Guid]::NewGuid().ToString('N')).json"
    $configPath = Join-Path $env:TEMP "assetlibrary-os-config-$runId-$([Guid]::NewGuid().ToString('N')).txt"
    $bodyPath = $null
    try {
        $curlConfig = "silent`nshow-error`ninsecure`nuser = `"admin:$env:OPENSEARCH_INITIAL_ADMIN_PASSWORD`"`n"
        Write-PrivateCurlConfig $configPath $curlConfig
        $arguments = @('--config', $configPath, '--request', $Method, '--url', "$endpoint$Path",
            '--output', $responsePath, '--write-out', '%{http_code}', '--header', 'Content-Type: application/json')
        if ($Body) {
            $bodyPath = Join-Path $env:TEMP "assetlibrary-os-body-$runId-$([Guid]::NewGuid().ToString('N')).json"
            [IO.File]::WriteAllText($bodyPath, $Body, [Text.UTF8Encoding]::new($false))
            $arguments += @('--data-binary', "@$bodyPath")
        }
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $status = (& curl.exe @arguments 2>&1 | Out-String).Trim()
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($exitCode -ne 0) {
            $detail = $status
            if ($detail.Length -gt 500) { $detail = $detail.Substring(0, 500) }
            throw "OpenSearch transport request failed with curl exit $exitCode. $detail"
        }
        $response = if (Test-Path -LiteralPath $responsePath) {
            Get-Content -LiteralPath $responsePath -Raw
        } else { '' }
        if ($status -notmatch '^2[0-9][0-9]$') {
            $errorType = $null
            $errorReason = $null
            try {
                $error = ($response | ConvertFrom-Json).error
                $errorType = $error.type
                $errorReason = $error.reason
            } catch {}
            throw "OpenSearch request failed with HTTP $status ($errorType): $errorReason"
        }
        return $response
    } finally {
        Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
        if ($bodyPath) { Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue }
    }
}

function Get-IndexFingerprint([string]$Index) {
    $mappingResponse = Invoke-OpenSearch 'GET' "/$Index/_mapping" $null | ConvertFrom-Json
    $mapping = $mappingResponse.psobject.Properties[$Index].Value.mappings
    $count = [long]((Invoke-OpenSearch 'GET' "/$Index/_count" $null | ConvertFrom-Json).count)
    if ($count -gt 10000) { throw 'Recovery fixture index exceeds the bounded reconciliation limit.' }
    $documents = Invoke-OpenSearch 'GET' "/$Index/_search?size=$count&sort=_id:asc&filter_path=hits.hits._id,hits.hits._source" $null | ConvertFrom-Json
    return [ordered]@{
        mapping = $mapping
        document_count = $count
        documents = $documents.hits.hits
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
    if ($compose -notmatch 'path\.repo:\s*/snapshots' -or $compose -notmatch 'opensearch-snapshot-data:') {
        throw 'Local OpenSearch snapshot repository volume is not configured.'
    }
    Write-Output 'Local OpenSearch backup/restore configuration is valid.'
    return
}

Import-LocalEnvironment
$evidence = Join-Path $evidenceBase "$runId-opensearch"
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$started = (Get-Date).ToUniversalTime()
$stage = 'preflight'
$failureStage = $null
$failureCode = $null
$sourceFingerprint = $null
$restoredFingerprint = $null
$snapshotDuration = $null
$snapshotState = $null
$snapshotFailedShards = $null
$version = $null
$sourceCreated = $false
$restoredCreated = $false
$repositoryCreated = $false
$snapshotCreated = $false
$cleanupFailures = 0

try {
    $rootInfo = Invoke-OpenSearch 'GET' '/' $null | ConvertFrom-Json
    $version = $rootInfo.version.number

    $stage = 'fixture'
    $indexBody = @{
        settings = @{ number_of_shards = 1; number_of_replicas = 0 }
        mappings = @{
            dynamic = 'strict'
            properties = @{
                package_id = @{ type = 'keyword' }
                name = @{ type = 'text'; fields = @{ keyword = @{ type = 'keyword' } } }
                version = @{ type = 'keyword' }
            }
        }
    } | ConvertTo-Json -Depth 10 -Compress
    $sourceCreated = $true
    Invoke-OpenSearch 'PUT' "/$sourceIndex" $indexBody | Out-Null
    foreach ($number in 1..2) {
        $document = @{ package_id = "fixture-$number"; name = "Recovery fixture $number"; version = "1.0.$number" } |
            ConvertTo-Json -Compress
        Invoke-OpenSearch 'PUT' "/$sourceIndex/_doc/$number" $document | Out-Null
    }
    Invoke-OpenSearch 'POST' "/$sourceIndex/_refresh" '{}' | Out-Null
    $sourceFingerprint = Get-IndexFingerprint $sourceIndex

    $stage = 'snapshot'
    $repositoryBody = @{ type = 'fs'; settings = @{ location = '/snapshots'; compress = $true } } |
        ConvertTo-Json -Depth 5 -Compress
    $repositoryCreated = $true
    Invoke-OpenSearch 'PUT' "/_snapshot/$repository" $repositoryBody | Out-Null
    Invoke-OpenSearch 'POST' "/_snapshot/$repository/_verify" '{}' | Out-Null
    $snapshotBody = @{ indices = $sourceIndex; include_global_state = $false; partial = $false } |
        ConvertTo-Json -Compress
    $snapshotStarted = (Get-Date).ToUniversalTime()
    $snapshotCreated = $true
    $snapshotResponse = Invoke-OpenSearch 'PUT' "/_snapshot/$repository/${snapshot}?wait_for_completion=true" $snapshotBody |
        ConvertFrom-Json
    $snapshotDuration = ((Get-Date).ToUniversalTime() - $snapshotStarted).TotalSeconds
    $snapshotState = $snapshotResponse.snapshot.state
    $snapshotFailedShards = $snapshotResponse.snapshot.shards.failed
    if ($snapshotState -ne 'SUCCESS' -or $snapshotFailedShards -ne 0) {
        throw "OpenSearch snapshot state was '$snapshotState' with '$snapshotFailedShards' failed shards."
    }

    $stage = 'isolated_restore'
    $restoreBody = @{
        indices = $sourceIndex
        include_global_state = $false
        include_aliases = $false
        rename_pattern = '(.+)'
        rename_replacement = $restoredIndex
    } | ConvertTo-Json -Compress
    $restoredCreated = $true
    Invoke-OpenSearch 'POST' "/_snapshot/$repository/$snapshot/_restore?wait_for_completion=true" $restoreBody | Out-Null
    $restoredFingerprint = Get-IndexFingerprint $restoredIndex
    $sourceJson = $sourceFingerprint | ConvertTo-Json -Depth 20 -Compress
    $restoredJson = $restoredFingerprint | ConvertTo-Json -Depth 20 -Compress
    if ($sourceJson -cne $restoredJson) { throw 'Restored OpenSearch index does not match the source fixture.' }

    $stage = 'alias_cutover'
    $aliasBody = @{ actions = @(@{ add = @{ index = $restoredIndex; alias = $aliasName; is_write_index = $true } }) } |
        ConvertTo-Json -Depth 8 -Compress
    Invoke-OpenSearch 'POST' '/_aliases' $aliasBody | Out-Null
    $aliasResponse = Invoke-OpenSearch 'GET' "/_alias/$aliasName" $null | ConvertFrom-Json
    $aliasTargets = @($aliasResponse.psobject.Properties.Name)
    if ($aliasTargets.Count -ne 1 -or $aliasTargets[0] -ne $restoredIndex) {
        throw 'OpenSearch recovery alias does not target exactly the restored index.'
    }
} catch {
    $failureStage = $stage
    $failureCode = $_.Exception.Message
} finally {
    if ($restoredCreated -and $restoredIndex -match '^assetlibrary-recovery-fixture-[0-9]+-[0-9]+-restored$') {
        try { Invoke-OpenSearch 'DELETE' "/$restoredIndex" $null | Out-Null } catch { $cleanupFailures++ }
    }
    if ($sourceCreated -and $sourceIndex -match '^assetlibrary-recovery-fixture-[0-9]+-[0-9]+$') {
        try { Invoke-OpenSearch 'DELETE' "/$sourceIndex" $null | Out-Null } catch { $cleanupFailures++ }
    }
    if ($snapshotCreated) {
        try { Invoke-OpenSearch 'DELETE' "/_snapshot/$repository/$snapshot" $null | Out-Null } catch { $cleanupFailures++ }
    }
    if ($repositoryCreated) {
        try { Invoke-OpenSearch 'DELETE' "/_snapshot/$repository" $null | Out-Null } catch { $cleanupFailures++ }
    }
}
if (-not $failureStage -and $cleanupFailures -gt 0) {
    $failureStage = 'cleanup'
    $failureCode = 'One or more exact OpenSearch recovery resources could not be removed.'
}

$finished = (Get-Date).ToUniversalTime()
$sourceJson = if ($sourceFingerprint) { $sourceFingerprint | ConvertTo-Json -Depth 20 -Compress } else { $null }
$restoredJson = if ($restoredFingerprint) { $restoredFingerprint | ConvertTo-Json -Depth 20 -Compress } else { $null }
$manifest = [ordered]@{
    schema_version = '1.0'
    scope = 'local-opensearch-fixture-snapshot'
    status = if ($failureStage) { 'failed' } else { 'passed' }
    failure_stage = $failureStage
    failure_code = $failureCode
    started_at = $started.ToString('o')
    finished_at = $finished.ToString('o')
    git_commit = Get-GitCommit
    opensearch_version = $version
    repository_type = 'fs'
    include_global_state = $false
    include_aliases = $false
    fixture_documents = 2
    snapshot_duration_seconds = $snapshotDuration
    snapshot_state = $snapshotState
    snapshot_failed_shards = $snapshotFailedShards
    source_fingerprint_sha256 = if ($sourceJson) { Get-TextSha256 $sourceJson } else { $null }
    restored_fingerprint_sha256 = if ($restoredJson) { Get-TextSha256 $restoredJson } else { $null }
    limitations = @('fixture index only', 'same local cluster restore', 'not encrypted independent storage', 'not production RPO/RTO evidence')
} | ConvertTo-Json -Depth 8
$manifestPath = Join-Path $evidence 'run-manifest.json'
[IO.File]::WriteAllText($manifestPath, $manifest + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if ($failureStage) { throw "Local OpenSearch restore failed during $failureStage. Evidence: $evidence" }
Write-Output "Local OpenSearch snapshot/restore passed. Evidence: $evidence"
