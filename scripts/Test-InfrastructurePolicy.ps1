$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$staging = Get-Content -LiteralPath (Join-Path $root 'deploy/tofu/environments/staging/backend.tf') -Raw
$production = Get-Content -LiteralPath (Join-Path $root 'deploy/tofu/environments/production/backend.tf') -Raw
$edgeTofu = Get-Content -LiteralPath (Join-Path $root 'deploy/tofu/modules/edge/main.tf') -Raw
$stagingEdge = Get-Content -LiteralPath (Join-Path $root 'deploy/tofu/environments/staging/main.tf') -Raw
$productionEdge = Get-Content -LiteralPath (Join-Path $root 'deploy/tofu/environments/production/main.tf') -Raw
$productionVariables = Get-Content -LiteralPath (Join-Path $root 'deploy/tofu/environments/production/variables.tf') -Raw
$chart = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/deployments.yaml') -Raw
$services = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/services.yaml') -Raw
$availability = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/availability.yaml') -Raw
$progressive = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/progressive-delivery.yaml') -Raw
$values = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/values.yaml') -Raw
$valuesSchema = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/values.schema.json') -Raw
$progressiveCi = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/values-progressive-ci.yaml') -Raw
$workers = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/workers.yaml') -Raw
$cleanup = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/cleanup.yaml') -Raw
$network = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/networkpolicy.yaml') -Raw
$scannerScaling = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/scanner-autoscaling.yaml') -Raw
$monitoring = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/templates/monitoring.yaml') -Raw
$dashboard = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/dashboards/assetlibrary-overview.json') -Raw | ConvertFrom-Json
$edgeConfig = Get-Content -LiteralPath (Join-Path $root 'services/edge/wrangler.toml') -Raw
$compose = Get-Content -LiteralPath (Join-Path $root 'deploy/local/compose.yaml') -Raw
$costPolicy = Get-Content -LiteralPath (Join-Path $root 'deploy/policies/cost-budget-policy.json') -Raw

if ($staging -notmatch 'assetlibrary/staging/terraform\.tfstate') { throw 'Staging state key is not isolated.' }
if ($production -notmatch 'assetlibrary/production/terraform\.tfstate') { throw 'Production state key is not isolated.' }
if ($staging -eq $production) { throw 'Staging and production backend contracts must differ.' }
if ($edgeTofu -notmatch 'cloudflare_r2_bucket_lifecycle' -or
    $edgeTofu -notmatch 'abort_multipart_uploads_transition' -or
    $edgeTofu -notmatch 'conditions\s*=\s*\{ prefix = "quarantine/" \}' -or
    $edgeTofu -notmatch 'cloudflare_r2_bucket_lock' -or
    $edgeTofu -notmatch 'prefix\s*=\s*"sha256/"') {
    throw 'R2 quarantine lifecycle and published digest-prefix lock are required.'
}
if ($stagingEdge -notmatch 'quarantine_retention_seconds' -or
    $productionEdge -notmatch 'published_lock_seconds' -or
    $productionVariables -notmatch 'default\s*=\s*2592000' -or
    $productionVariables -notmatch 'default\s*=\s*31536000') {
    throw 'Environment-specific R2 retention values must be explicit.'
}
if ($chart -notmatch 'runAsNonRoot: true' -or $chart -notmatch 'readOnlyRootFilesystem: true') {
    throw 'Kubernetes workloads must enforce restricted container security.'
}
if ($chart -notmatch 'resources:' -or $chart -notmatch 'topologySpreadConstraints:') {
    throw 'Kubernetes workloads require resources and topology spread.'
}
if ($values -notmatch '(?ms)^progressiveDelivery:\s*\r?\n\s+enabled:\s+false' -or
    $values -notmatch 'version:\s+v1\.9\.1' -or
    $values -notmatch 'sha256:15c0d41f2c69a382d4399bcb28ed4f03ee9f58b56cfc9e6cd55bcbf0f311c06d' -or
    $values -notmatch 'provider:\s+nginx') {
    throw 'Progressive delivery must default off and pin the reviewed Argo Rollouts controller contract.'
}
$parsedValuesSchema = $valuesSchema | ConvertFrom-Json
if ($parsedValuesSchema.properties.config.properties.appUpdatesEnabled.const -ne $false -or
    $parsedValuesSchema.properties.progressiveDelivery.properties.controller.properties.version.const -ne 'v1.9.1') {
    throw 'Helm values schema must keep App Update disabled and pin the progressive-delivery controller version.'
}
if ($chart -notmatch 'kind:.*Rollout.*Deployment' -or $chart -notmatch 'list 5 25 100' -or
    $chart -notmatch 'progressDeadlineAbort:\s+true' -or $chart -notmatch 'stableService:' -or
    $chart -notmatch 'canaryService:' -or $chart -notmatch 'stableIngress:' -or
    $chart -notmatch 'templateName:.*-canary') {
    throw 'API and web workloads must expose the disabled-by-default 5/25/100 Rollout contract.'
}
if ($progressive -notmatch 'requires observability\.serviceMonitor\.enabled' -or
    $progressive -notmatch 'requires observability\.prometheusRule\.enabled' -or
    ([regex]::Matches($progressive, 'kind:\s+Ingress')).Count -ne 1 -or
    $progressive -notmatch 'range \$component := list "api" "web"' -or
    ([regex]::Matches($progressive, 'kind:\s+AnalysisTemplate')).Count -ne 2 -or
    $progressive -notmatch '(?m)^\s+tls:' -or
    $progressive -notmatch 'failureLimit:\s+0' -or
    $progressive -notmatch 'request-rate' -or $progressive -notmatch '5xx-ratio' -or
    $progressive -notmatch 'canary-p95' -or $progressive -notmatch 'global-slo-alerts') {
    throw 'Progressive delivery requires TLS NGINX routing and fail-closed request-rate, error, latency, and alert analysis.'
}
if ($services -notmatch 'assetlibrary\.neuro/track: stable' -or
    $services -notmatch 'assetlibrary\.neuro/track: canary' -or
    $monitoring -notmatch 'targetLabel:\s+rollout_track' -or
    $availability -notmatch 'kind:.*Rollout.*Deployment') {
    throw 'Canary Services, metric relabeling, and HPA target switching must remain connected.'
}
if ($progressiveCi -notmatch '(?ms)^progressiveDelivery:\s*\r?\n\s+enabled:\s+true' -or
    $progressiveCi -notmatch 'prometheusAddress:\s+http' -or
    $progressiveCi -notmatch 'api\.assetlibrary\.example' -or
    $progressiveCi -notmatch 'store\.assetlibrary\.example') {
    throw 'Progressive-delivery CI values must enable routable API and web analysis inputs.'
}
if ($workers -notmatch 'runtimeClassName:' -or $workers -notmatch 'required-pids-limit' -or
    $workers -notmatch 'readOnlyRootFilesystem: true' -or $workers -notmatch 'CLAMAV_NO_FRESHCLAMD' -or
    $workers -notmatch 'mountPath: /var/lib/clamav') {
    throw 'Scanner workloads must declare sandbox, PID, filesystem, and offline malware controls.'
}
if ($cleanup -notmatch 'concurrencyPolicy: Forbid' -or $cleanup -notmatch 'activeDeadlineSeconds:' -or
    $cleanup -notmatch 'runtimeClassName:' -or $cleanup -notmatch 'required-pids-limit') {
    throw 'Cleanup jobs must be non-overlapping, time bounded, and sandboxed.'
}
if ($network -match '0\.0\.0\.0/0' -or $network -notmatch 'podSelector:' -or
    $network -notmatch '\.Values\.network\.dependencies' -or
    $network -notmatch 'app\.kubernetes\.io/component: \{\{ \$component \}\}') {
    throw 'Workloads must use explicit per-component dependencies and selected ingress Pods.'
}
if ($scannerScaling -notmatch 'type: nats-jetstream' -or $scannerScaling -notmatch 'maxReplicaCount:') {
    throw 'Scanner autoscaling must be bounded and driven by JetStream lag.'
}
if ($monitoring -notmatch 'kind: ServiceMonitor' -or $monitoring -notmatch 'honorLabels: true' -or
    $monitoring -notmatch 'kind: PrometheusRule' -or $monitoring -notmatch 'kind: AlertmanagerConfig' -or
    $monitoring -notmatch 'OBSERVABILITY_RUNBOOK\.md') {
    throw 'Production monitoring resources, stable labels, alerts, and runbooks are required.'
}
if ($dashboard.uid -ne 'neuro-assetlibrary-overview' -or $dashboard.panels.Count -lt 12) {
    throw 'The P8 Grafana dashboard is missing required bounded signal panels.'
}
if ($edgeConfig -notmatch '(?ms)\[observability\].*enabled\s*=\s*true' -or
    $edgeConfig -notmatch '(?ms)\[observability\.traces\].*enabled\s*=\s*true') {
    throw 'Cloudflare Worker logs and traces must be explicitly configured.'
}
foreach ($runbook in @('OBSERVABILITY_RUNBOOK.md', 'LOAD_TEST_PLAN.md', 'BACKUP_RESTORE_RUNBOOK.md', 'COST_BUDGET_RUNBOOK.md', 'FAILURE_DRILL_RUNBOOK.md', 'RELEASE_SECURITY_RUNBOOK.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root "docs/operations/$runbook"))) {
        throw "P8 operations documentation is missing: $runbook"
    }
}
if ($costPolicy -notmatch 'measured_provider_export' -or
    $costPolicy -notmatch 'independent_billing_channel') {
    throw 'P8 cost policy must require measured exports and independent alert delivery.'
}
if ($compose -match '0\.0\.0\.0:') { throw 'Local data services must not bind all interfaces.' }
if ($compose -notmatch 'path\.repo:\s*/snapshots' -or
    $compose -notmatch 'opensearch-snapshot-data:/snapshots' -or
    $compose -notmatch 'condition: service_completed_successfully') {
    throw 'Local OpenSearch recovery requires an initialized independent snapshot volume.'
}
if ($compose -notmatch 'clickhouse-backup-data:/var/lib/clickhouse/backups' -or
    $compose -notmatch 'chown 101:101 /var/lib/clickhouse/backups') {
    throw 'Local ClickHouse recovery requires an initialized independent backup volume.'
}
if ($compose -match 'MINIO_API_CORS_ALLOW_ORIGIN:\s*["'']?\*' -or
    $compose -notmatch 'MINIO_API_CORS_ALLOW_ORIGIN:\s*\$\{ASSETLIBRARY_BROWSER_ORIGINS:') {
    throw 'Local object-store CORS must use the explicit browser-origin allowlist, not a wildcard.'
}
foreach ($match in [regex]::Matches($compose, '(?m)^\s*(POSTGRES_PASSWORD|VALKEY_PASSWORD):\s*(.+)$')) {
    if ($match.Groups[2].Value.Trim() -notmatch '^\$\{') {
        throw 'Local Compose must not contain default database credentials.'
    }
}

Write-Output 'Infrastructure policy contract passed.'
