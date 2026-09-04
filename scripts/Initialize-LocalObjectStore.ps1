$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}

$container = 'assetlibrary-object-store-1'
docker exec $container mc alias set local http://127.0.0.1:9000 $env:MINIO_ROOT_USER $env:MINIO_ROOT_PASSWORD *> $null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($bucket in @('assetlibrary-quarantine', 'assetlibrary-published')) {
    docker exec $container mc mb --ignore-existing "local/$bucket" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    docker exec $container mc anonymous set none "local/$bucket" *> $null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Output 'Local object-store buckets are present and private.'
