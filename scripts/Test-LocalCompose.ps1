$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$composePath = Join-Path $root 'deploy/local/compose.yaml'
$names = @(
    'POSTGRES_PASSWORD', 'VALKEY_PASSWORD', 'OPENSEARCH_INITIAL_ADMIN_PASSWORD',
    'CLICKHOUSE_PASSWORD', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'
)

foreach ($name in $names) {
    [Environment]::SetEnvironmentVariable($name, 'contract-check-not-a-runtime-secret', 'Process')
}

& docker compose -f $composePath config --quiet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Local Compose contract passed.'
