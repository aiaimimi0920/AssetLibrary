param(
    [switch] $Recreate
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
$composePath = Join-Path $root 'deploy/local/compose.yaml'

function New-Secret([int] $Bytes = 32) {
    $buffer = New-Object byte[] $Bytes
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($buffer).Replace('+', 'A').Replace('/', 'B').TrimEnd('=')
}

if (-not (Test-Path -LiteralPath $envPath)) {
    $content = @(
        "POSTGRES_PASSWORD=$(New-Secret)",
        "VALKEY_PASSWORD=$(New-Secret)",
        "OPENSEARCH_INITIAL_ADMIN_PASSWORD=$(New-Secret 40)",
        "CLICKHOUSE_PASSWORD=$(New-Secret)",
        "MINIO_ROOT_USER=assetlibrary-local",
        "MINIO_ROOT_PASSWORD=$(New-Secret 40)",
        "ASSETLIBRARY_S3_ENDPOINT=http://127.0.0.1:9100",
        "ASSETLIBRARY_S3_REGION=us-east-1",
        "ASSETLIBRARY_QUARANTINE_BUCKET=assetlibrary-quarantine",
        "ASSETLIBRARY_PUBLISHED_BUCKET=assetlibrary-published",
        "ASSETLIBRARY_CLAMAV_ADDRESS=127.0.0.1:3310",
        "ASSETLIBRARY_S3_FORCE_PATH_STYLE=true"
    ) -join "`n"
    [IO.File]::WriteAllText($envPath, "$content`n", (New-Object Text.UTF8Encoding($false)))
    Write-Output 'Created ignored .env with random local-only credentials.'
}

$arguments = @('compose', '--env-file', $envPath, '-f', $composePath, 'up', '-d', '--wait')
if ($Recreate) { $arguments += '--force-recreate' }
& docker @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'Initialize-LocalObjectStore.ps1')
Write-Output 'AssetLibrary dependencies are healthy.'
