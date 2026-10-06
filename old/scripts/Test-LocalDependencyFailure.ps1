[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [switch]$ConfirmLocalFaultInjection,
    [int]$Port = 18088,
    [string]$EvidenceRoot = 'test-results/p8-failure'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$composePath = Join-Path $root 'deploy/local/compose.yaml'
$envPath = Join-Path $root '.env'
$executable = Join-Path $root 'target/debug/assetlibrary-api.exe'
$runId = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))-$PID"
$searchIndex = "assetlibrary-failure-fixture-$runId"
. (Join-Path $PSScriptRoot 'RepositoryEvidencePath.ps1')

function Invoke-Native([string]$Command, [string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $Command @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        $detail = ($output | Out-String).Trim()
        if ($detail.Length -gt 1000) { $detail = $detail.Substring(0, 1000) }
        throw "$Command failed with exit $exitCode. $detail"
    }
    return $output
}

function Invoke-Compose([string[]]$Arguments) {
    $prefix = @('compose', '--env-file', $envPath, '-f', $composePath)
    return Invoke-Native 'docker' ($prefix + $Arguments)
}

function Invoke-OpenSearchAdmin([string]$Method, [string]$Path, [string]$Body = '') {
    if ($Method -notin @('PUT', 'DELETE') -or $Path -notmatch '^/assetlibrary-failure-fixture-[0-9]+-[0-9]+$') {
        throw 'Unsafe OpenSearch failure-fixture request.'
    }
    $curl = 'curl -fsk -u admin:$OPENSEARCH_INITIAL_ADMIN_PASSWORD -X ' + $Method
    if ($Body) {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Body))
        $command = 'echo ' + $encoded + ' | base64 -d | ' + $curl +
            ' -H Content-Type:application/json --data-binary @- https://127.0.0.1:9200' + $Path
    } else {
        $command = $curl + ' https://127.0.0.1:9200' + $Path
    }
    return Invoke-Native 'docker' @('exec', 'assetlibrary-opensearch-1', 'sh', '-c', $command)
}

function Wait-HttpStatus([string]$Uri, [int]$Expected, [int]$TimeoutSeconds = 20) {
    $started = (Get-Date).ToUniversalTime()
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $status = 0
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 8 -ErrorAction Stop
            $status = [int]$response.StatusCode
        } catch {
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        }
        if ($status -eq $Expected) {
            return [ordered]@{
                uri_path = ([Uri]$Uri).PathAndQuery
                expected_status = $Expected
                observed_status = $status
                duration_ms = [math]::Round(((Get-Date).ToUniversalTime() - $started).TotalMilliseconds)
            }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Expected HTTP $Expected from $(([Uri]$Uri).PathAndQuery), observed $status."
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
$compose = Get-Content -LiteralPath $composePath -Raw
$requiredServices = @('postgres', 'valkey', 'opensearch')
foreach ($service in $requiredServices) {
    if ($compose -notmatch "(?m)^  $([regex]::Escape($service)):") {
        throw "Local dependency service is missing: $service"
    }
}
if ($ValidateOnly) {
    Write-Output 'Local dependency failure configuration is valid.'
    return
}
if (-not $ConfirmLocalFaultInjection) {
    throw 'Local dependency interruption requires -ConfirmLocalFaultInjection.'
}
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }

$evidence = Join-Path $evidenceBase "$runId-dependency-failure"
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$stdout = Join-Path $env:TEMP "assetlibrary-failure-api-$runId.stdout.log"
$stderr = Join-Path $env:TEMP "assetlibrary-failure-api-$runId.stderr.log"
$started = (Get-Date).ToUniversalTime()
$stage = 'build'
$failureStage = $null
$failureCode = $null
$cleanupFailures = 0
$checks = New-Object Collections.Generic.List[object]
$stopped = New-Object Collections.Generic.List[string]
$process = $null
$fixtureCreated = $false

try {
    Push-Location $root
    try { Invoke-Native 'cargo' @('build', '-p', 'assetlibrary-api', '--locked') | Out-Null } finally { Pop-Location }
    $stage = 'preflight'
    foreach ($service in $requiredServices) {
        $running = (Invoke-Native 'docker' @('inspect', '--format', '{{.State.Running}}', "assetlibrary-$service-1") | Out-String).Trim()
        if ($running -ne 'true') { throw "Local dependency is not running: $service" }
    }
    Get-Content -LiteralPath $envPath | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
    $env:ASSETLIBRARY_ENVIRONMENT = 'development'
    $env:ASSETLIBRARY_BIND = "127.0.0.1:$Port"
    $env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
    $env:ASSETLIBRARY_OPENSEARCH_URL = 'https://127.0.0.1:9200'
    $env:ASSETLIBRARY_OPENSEARCH_USERNAME = 'admin'
    $env:ASSETLIBRARY_OPENSEARCH_PASSWORD = $env:OPENSEARCH_INITIAL_ADMIN_PASSWORD
    $env:ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS = 'true'
    $env:ASSETLIBRARY_VALKEY_URL = "redis://:$env:VALKEY_PASSWORD@127.0.0.1:6379"
    $stage = 'fixture_setup'
    $fixtureCreated = $true
    $indexBody = @{
        settings = @{ number_of_shards = 1; number_of_replicas = 0 }
        mappings = @{
            properties = @{
                updated_at = @{ type = 'date' }
                description = @{ type = 'text' }
                tags = @{ type = 'keyword' }
                package = @{
                    properties = @{
                        id = @{ type = 'keyword' }
                        kind = @{ type = 'keyword' }
                        name = @{ type = 'text' }
                        summary = @{ type = 'text' }
                        publisher = @{ properties = @{ display_name = @{ type = 'text' } } }
                    }
                }
            }
        }
    } | ConvertTo-Json -Depth 10 -Compress
    Invoke-OpenSearchAdmin 'PUT' "/$searchIndex" $indexBody | Out-Null
    $env:ASSETLIBRARY_SEARCH_ALIAS = $searchIndex
    $process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $baseUrl = "http://127.0.0.1:$Port"

    $stage = 'baseline'
    $checks.Add((Wait-HttpStatus "$baseUrl/healthz" 200 30))
    $checks.Add((Wait-HttpStatus "$baseUrl/readyz" 200))
    $checks.Add((Wait-HttpStatus "$baseUrl/v1/public/search?q=baseline-$runId&limit=1" 200))

    $stage = 'valkey_outage'
    $stopped.Add('valkey')
    Invoke-Compose @('stop', '--timeout', '10', 'valkey') | Out-Null
    $checks.Add((Wait-HttpStatus "$baseUrl/readyz" 200))
    $valkeyCheck = Wait-HttpStatus "$baseUrl/v1/public/search?q=valkey-$runId&limit=1" 200
    $valkeyCheck['maximum_duration_ms'] = 1000
    $checks.Add($valkeyCheck)
    if ($valkeyCheck.duration_ms -gt $valkeyCheck.maximum_duration_ms) {
        throw 'Valkey outage search exceeded the local degradation latency bound.'
    }
    Invoke-Compose @('up', '-d', '--wait', 'valkey') | Out-Null
    [void]$stopped.Remove('valkey')

    $stage = 'opensearch_outage'
    $stopped.Add('opensearch')
    Invoke-Compose @('stop', '--timeout', '10', 'opensearch') | Out-Null
    $checks.Add((Wait-HttpStatus "$baseUrl/readyz" 200))
    $checks.Add((Wait-HttpStatus "$baseUrl/v1/public/search?q=opensearch-$runId&limit=1" 503))
    Invoke-Compose @('up', '-d', '--wait', 'opensearch') | Out-Null
    [void]$stopped.Remove('opensearch')
    $checks.Add((Wait-HttpStatus "$baseUrl/v1/public/search?q=recovered-$runId&limit=1" 200 30))

    $stage = 'postgres_outage'
    $stopped.Add('postgres')
    Invoke-Compose @('stop', '--timeout', '10', 'postgres') | Out-Null
    $checks.Add((Wait-HttpStatus "$baseUrl/healthz" 200))
    $checks.Add((Wait-HttpStatus "$baseUrl/readyz" 503 30))
    Invoke-Compose @('up', '-d', '--wait', 'postgres') | Out-Null
    [void]$stopped.Remove('postgres')
    $checks.Add((Wait-HttpStatus "$baseUrl/readyz" 200 30))
} catch {
    $failureStage = $stage
    $failureCode = $_.Exception.Message
} finally {
    foreach ($service in @($stopped.ToArray())) {
        try { Invoke-Compose @('up', '-d', '--wait', $service) | Out-Null } catch { $cleanupFailures++ }
    }
    if ($fixtureCreated) {
        try { Invoke-OpenSearchAdmin 'DELETE' "/$searchIndex" | Out-Null } catch { $cleanupFailures++ }
    }
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    if ($process) { $process.Dispose() }
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
}
if (-not $failureStage -and $cleanupFailures -gt 0) {
    $failureStage = 'cleanup'
    $failureCode = 'One or more stopped dependencies could not be restored.'
}

$manifest = [ordered]@{
    schema_version = '1.0'
    scope = 'local-component-degradation'
    status = if ($failureStage) { 'failed' } else { 'passed' }
    failure_stage = $failureStage
    failure_code = $failureCode
    started_at = $started.ToString('o')
    finished_at = (Get-Date).ToUniversalTime().ToString('o')
    git_commit = Get-GitCommit
    checks = $checks
    dependencies = $requiredServices
    cleanup_failures = $cleanupFailures
    limitations = @('single-node local compose', 'sequential outages only', 'not an AZ or region failure', 'not production RTO evidence')
} | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText(
    (Join-Path $evidence 'run-manifest.json'),
    $manifest + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)
if ($failureStage) { throw "Local dependency failure drill failed during $failureStage. Evidence: $evidence" }
Write-Output "Local dependency failure drill passed. Evidence: $evidence"
