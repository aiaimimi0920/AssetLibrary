$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $root 'scripts/Run-P8LoadTest.ps1'

function Test-Validation([string]$Url, [switch]$AllowRemote, [string]$EvidenceRoot = 'test-results/p8-load') {
    $previous = $env:ASSETLIBRARY_API_BASE_URL
    try {
        $env:ASSETLIBRARY_API_BASE_URL = $Url
        $parameters = @{
            Profile = 'smoke'
            ValidateOnly = $true
            EvidenceRoot = $EvidenceRoot
        }
        if ($AllowRemote) { $parameters.AllowRemoteTarget = $true }
        & $runner @parameters *> $null
        return $null
    } catch {
        return $_.Exception.Message
    } finally {
        $env:ASSETLIBRARY_API_BASE_URL = $previous
    }
}

if (Test-Validation 'http://127.0.0.1:8080') {
    throw 'Loopback HTTP must remain available for local smoke validation.'
}
if (-not (Test-Validation 'http://assetlibrary-staging.example' -AllowRemote)) {
    throw 'Remote HTTP must be rejected even with explicit remote confirmation.'
}
if (-not (Test-Validation 'https://assetlibrary-staging.example')) {
    throw 'Remote HTTPS must require explicit remote confirmation.'
}
if (Test-Validation 'https://assetlibrary-staging.example' -AllowRemote) {
    throw 'Confirmed remote HTTPS must pass configuration validation.'
}
if (-not (Test-Validation 'file:///tmp/catalog' -AllowRemote)) {
    throw 'Non-HTTP target schemes must be rejected.'
}
if (-not (Test-Validation 'http://127.0.0.1:8080' -EvidenceRoot '..')) {
    throw 'Evidence paths must not escape the AssetLibrary repository.'
}

$boundaryParent = Join-Path $root 'test-results'
$linkPath = Join-Path $boundaryParent "p8-evidence-link-$PID"
$externalPath = Join-Path ([IO.Path]::GetTempPath()) "assetlibrary-p8-evidence-$PID"
New-Item -ItemType Directory -Path $boundaryParent, $externalPath -Force | Out-Null
try {
    $linkType = if ($env:OS -eq 'Windows_NT') { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $linkType -Path $linkPath -Target $externalPath | Out-Null
    if (-not (Test-Validation 'http://127.0.0.1:8080' -EvidenceRoot $linkPath)) {
        throw 'Evidence paths must reject repository links targeting external directories.'
    }
} finally {
    if (Test-Path -LiteralPath $linkPath) { [IO.Directory]::Delete($linkPath) }
    Remove-Item -LiteralPath $externalPath -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'P8 load harness contract passed.'
