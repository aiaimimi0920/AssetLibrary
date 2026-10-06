param(
    [int] $BasePort = 18110,
    [switch] $StartDependencies
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'

if ($StartDependencies) {
    & (Join-Path $PSScriptRoot 'Start-LocalDependencies.ps1')
}
if (-not (Test-Path -LiteralPath $envPath)) {
    throw 'Run Start-LocalDependencies.ps1 or pass -StartDependencies first.'
}

Push-Location $root
try {
    & cargo test --locked -p assetlibrary-loom-client -p assetlibrary-publisher
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & cargo clippy --locked -p assetlibrary-loom-client -p assetlibrary-publisher --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot 'Test-PublisherRuntime.ps1') -Port $BasePort
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'Test-ScannerVerifiedRuntime.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'Test-LibraryDownloadRuntime.ps1') -Port ($BasePort + 1)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'Test-InstallReceiptRuntime.ps1') -Port ($BasePort + 2)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output 'P7 composite runtime passed: publisher API, signed scanner promotion, download/library, Loom adapter, CLI, InstallReceipt, and rollback gates.'
