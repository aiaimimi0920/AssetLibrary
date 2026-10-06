$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$composePath = Join-Path $root 'deploy/local/compose.yaml'
$observabilityComposePath = Join-Path $root 'deploy/local/observability.compose.yaml'
$names = @(
    'POSTGRES_PASSWORD', 'VALKEY_PASSWORD', 'OPENSEARCH_INITIAL_ADMIN_PASSWORD',
    'CLICKHOUSE_PASSWORD', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD',
    'GRAFANA_CLOUD_OTLP_ENDPOINT', 'GRAFANA_CLOUD_OTLP_INSTANCE_ID',
    'GRAFANA_CLOUD_OTLP_TOKEN'
)

foreach ($name in $names) {
    [Environment]::SetEnvironmentVariable($name, 'contract-check-not-a-runtime-secret', 'Process')
}
[Environment]::SetEnvironmentVariable(
    'GRAFANA_CLOUD_OTLP_ENDPOINT',
    'https://otlp.example.invalid/otlp',
    'Process'
)

& docker compose -f $composePath config --quiet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& docker compose -f $observabilityComposePath config --quiet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& docker compose -f $observabilityComposePath run --rm --no-deps otel-collector `
    validate --config=/etc/otelcol-contrib/config.yaml
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Local Compose contract passed.'
