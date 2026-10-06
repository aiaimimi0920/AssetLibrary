[CmdletBinding()]
param(
    [ValidateSet('smoke', 'baseline', 'double', 'soak', 'burst', 'download')]
    [string]$Profile = 'smoke',
    [switch]$AllowRemoteTarget,
    [switch]$ValidateOnly,
    [string]$EvidenceRoot = 'test-results/p8-load'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$controlScript = Join-Path $root 'performance/k6/control-plane.js'
$downloadScript = Join-Path $root 'performance/k6/download.js'
. (Join-Path $PSScriptRoot 'RepositoryEvidencePath.ps1')

function Assert-TargetSafety([string]$Raw, [string]$Name, [switch]$HttpsOnly) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { throw "$Name is required." }
    try { $uri = [Uri]$Raw } catch { throw "$Name must be a valid absolute HTTP(S) URL." }
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https')) {
        throw "$Name must be a valid absolute HTTP(S) URL."
    }
    if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw "$Name must not contain credentials, query parameters, or a fragment."
    }
    if ($HttpsOnly -and $uri.Scheme -ne 'https') { throw "$Name must use HTTPS." }
    $loopback = $uri.IsLoopback -or $uri.Host -in @('localhost', '127.0.0.1', '::1')
    if (-not $loopback -and $uri.Scheme -ne 'https') {
        throw "$Name must use HTTPS for a remote target."
    }
    if (-not $loopback -and -not $AllowRemoteTarget) {
        throw 'Remote load targets require the explicit -AllowRemoteTarget switch.'
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

if (-not (Test-Path -LiteralPath $controlScript) -or -not (Test-Path -LiteralPath $downloadScript)) {
    throw 'P8 k6 scenario files are missing.'
}

$script = $controlScript
switch ($Profile) {
    'smoke' {
        $env:LOAD_MULTIPLIER = '0.01'
        $env:LOAD_DURATION = '1m'
    }
    'baseline' {
        $env:LOAD_MULTIPLIER = '1'
        $env:LOAD_DURATION = '10m'
    }
    'double' {
        $env:LOAD_MULTIPLIER = '2'
        $env:LOAD_DURATION = '30m'
    }
    'soak' {
        $env:LOAD_MULTIPLIER = '2'
        $env:LOAD_DURATION = '24h'
    }
    'burst' {
        $env:LOAD_MULTIPLIER = '5'
        $env:LOAD_DURATION = '10m'
    }
    'download' {
        $script = $downloadScript
        if (-not $env:LOAD_DURATION) { $env:LOAD_DURATION = '10m' }
        Assert-TargetSafety $env:DOWNLOAD_URL 'DOWNLOAD_URL' -HttpsOnly
    }
}

if ($Profile -ne 'download') {
    Assert-TargetSafety $env:ASSETLIBRARY_API_BASE_URL 'ASSETLIBRARY_API_BASE_URL'
    if ($env:UPLOAD_ENABLED -eq '1') {
        if ($env:UPLOAD_RELEASE_ID -notmatch '^[0-9a-fA-F-]{36}$' -or
            [string]::IsNullOrWhiteSpace($env:ASSETLIBRARY_AUTH_TOKEN)) {
            throw 'Upload load requires UPLOAD_RELEASE_ID and ASSETLIBRARY_AUTH_TOKEN.'
        }
    }
}
$evidenceBase = Resolve-RepositoryEvidencePath -RepositoryRoot $root -RawPath $EvidenceRoot

if ($ValidateOnly) {
    Write-Output "P8 load configuration is valid for profile '$Profile'."
    return
}

$k6 = Get-Command k6 -ErrorAction SilentlyContinue
if (-not $k6) { throw 'k6 is not installed or is not on PATH.' }

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$evidence = Join-Path $evidenceBase "$timestamp-$Profile"
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$summary = Join-Path $evidence 'k6-summary.json'
$transcript = Join-Path $evidence 'k6-transcript.log'
$manifest = Join-Path $evidence 'run-manifest.json'
$started = (Get-Date).ToUniversalTime()
$exitCode = 1
$transcriptWriter = [IO.StreamWriter]::new(
    $transcript,
    $false,
    [Text.UTF8Encoding]::new($false)
)
try {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $k6.Source run --summary-export $summary $script 2>&1 | ForEach-Object {
            $line = "$_"
            $transcriptWriter.WriteLine($line)
            $transcriptWriter.Flush()
            Write-Output $line
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
} finally {
    $transcriptWriter.Dispose()
}
$finished = (Get-Date).ToUniversalTime()
$commit = Get-GitCommit
$k6Version = (& $k6.Source version 2>$null | Select-Object -First 1)
$summaryPresent = Test-Path -LiteralPath $summary
$summaryDigest = if ($summaryPresent) {
    (Get-FileHash -LiteralPath $summary -Algorithm SHA256).Hash.ToLowerInvariant()
} else { $null }
if ($exitCode -eq 0 -and -not $summaryPresent) { $exitCode = 1 }

$manifestBody = [ordered]@{
    schema_version = '1.1'
    profile = $Profile
    started_at = $started.ToString('o')
    finished_at = $finished.ToString('o')
    git_commit = $commit
    k6_version = "$k6Version".Trim()
    exit_code = $exitCode
    summary_present = $summaryPresent
    summary_sha256 = $summaryDigest
    upload_enabled = ($env:UPLOAD_ENABLED -eq '1')
    remote_target_confirmed = [bool]$AllowRemoteTarget
    capacity_evidence_state = 'k6_summary_only'
    cost_evidence_state = 'not_collected'
    p8_gate_eligible = $false
} | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $manifestBody + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if ($exitCode -ne 0) { throw "k6 failed with exit code $exitCode. Evidence: $evidence" }
Write-Output "P8 load profile passed. Evidence: $evidence"
