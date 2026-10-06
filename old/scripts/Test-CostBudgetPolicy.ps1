$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$policyPath = Join-Path $root 'deploy/policies/cost-budget-policy.json'
$schemaPath = Join-Path $root 'schemas/cost-budget-policy.schema.json'
$loadRunnerPath = Join-Path $root 'scripts/Run-P8LoadTest.ps1'

function Assert-ExactSet([object[]]$Actual, [string[]]$Expected, [string]$Name) {
    $actualText = @($Actual | ForEach-Object { "$_" } | Sort-Object) -join ','
    $expectedText = @($Expected | Sort-Object) -join ','
    if ($actualText -cne $expectedText) { throw "$Name must match the required bounded set." }
}

function Assert-CostPolicy($Policy) {
    if ($Policy.schema_version -ne '1.0' -or
        $Policy.evidence_requirement -ne 'measured_provider_export' -or
        $Policy.budget_window -ne 'calendar_month' -or
        $Policy.currency_source -ne 'provider_export' -or
        $Policy.tax_treatment_source -ne 'evidence_manifest') {
        throw 'Cost policy evidence provenance or accounting window is invalid.'
    }
    Assert-ExactSet $Policy.categories @(
        'storage', 'requests', 'egress', 'database', 'cluster', 'search', 'analytics', 'observability'
    ) 'Cost categories'
    $expectedSeverity = @{ 50 = 'informational'; 80 = 'warning'; 100 = 'critical' }
    Assert-ExactSet @($Policy.thresholds | ForEach-Object { $_.percent }) @(50, 80, 100) 'Budget thresholds'
    foreach ($threshold in $Policy.thresholds) {
        if ($threshold.severity -ne $expectedSeverity[[int]$threshold.percent] -or
            $threshold.route -ne 'independent_billing_channel') {
            throw 'Budget threshold severity or independent route is invalid.'
        }
    }
    Assert-ExactSet $Policy.allocation.required_labels @(
        'environment', 'service', 'component', 'region', 'owner', 'cost-center'
    ) 'Allocation labels'
    Assert-ExactSet $Policy.allocation.forbidden_labels @(
        'publisher_id', 'package_id', 'digest', 'principal', 'request_id', 'trace_id'
    ) 'Forbidden allocation labels'
    if ($Policy.allocation.value_policy -ne 'bounded_allowlist') {
        throw 'Cost allocation values must come from a bounded allowlist.'
    }
    Assert-ExactSet $Policy.evidence.alert_delivery_thresholds @(50, 80, 100) 'Alert evidence thresholds'
    Assert-ExactSet $Policy.evidence.required_fields @(
        'environment', 'window_start', 'window_end', 'provider', 'provider_export_sha256',
        'formula_version', 'currency', 'tax_treatment', 'reviewer', 'alert_delivery_evidence'
    ) 'Cost evidence fields'
    if (-not $Policy.evidence.provider_export_redacted -or
        -not $Policy.evidence.provider_export_sha256_required) {
        throw 'Provider cost exports must be redacted and content-addressed.'
    }
}

if (-not (Test-Path -LiteralPath $policyPath) -or -not (Test-Path -LiteralPath $schemaPath)) {
    throw 'Cost budget policy and schema are required.'
}
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$schema = Get-Content -LiteralPath $schemaPath -Raw | ConvertFrom-Json
if ($schema.'$schema' -ne 'https://json-schema.org/draft/2020-12/schema' -or
    $schema.additionalProperties -ne $false) {
    throw 'Cost budget JSON schema must be strict draft 2020-12.'
}
Assert-CostPolicy $policy

$invalid = (Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json)
$invalid.categories = @($invalid.categories | Where-Object { $_ -ne 'egress' })
try {
    Assert-CostPolicy $invalid
    throw 'Cost policy validator accepted a missing category.'
} catch {
    if ($_.Exception.Message -eq 'Cost policy validator accepted a missing category.') { throw }
}
$loadRunner = Get-Content -LiteralPath $loadRunnerPath -Raw
foreach ($contract in @(
    "capacity_evidence_state = 'k6_summary_only'",
    "cost_evidence_state = 'not_collected'",
    'p8_gate_eligible = $false'
)) {
    if (-not $loadRunner.Contains($contract)) { throw "Load evidence state is missing: $contract" }
}

Write-Output 'Cost budget policy contract passed.'
