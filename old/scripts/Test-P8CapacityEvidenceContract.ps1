$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$verifier = Join-Path $root 'scripts/Test-P8CapacityEvidence.ps1'
$fixtureRoot = Join-Path $root "test-results/p8-capacity-contract-$PID"
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-Json([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine), $utf8)
}

function New-FileReference(
    [string]$RelativePath,
    [string]$Kind,
    [string]$WindowStart,
    [string]$WindowEnd
) {
    $path = Join-Path $fixtureRoot $RelativePath
    Write-Json $path ([ordered]@{ kind = $Kind; fixture = $true })
    $reference = [ordered]@{
        path = $RelativePath.Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        byte_length = (Get-Item -LiteralPath $path).Length
        redacted = $true
    }
    if ($WindowStart) {
        $reference.window_start = $WindowStart
        $reference.window_end = $WindowEnd
    }
    return $reference
}

function New-K6Summary([string]$Profile, [string]$RelativePath) {
    $metrics = [ordered]@{}
    if ($Profile -eq 'download') {
        $metrics['http_req_failed'] = @{ thresholds = @{ 'rate<0.001' = @{ ok = $true } } }
        $metrics['checks'] = @{ thresholds = @{ 'rate>0.999' = @{ ok = $true } } }
    } else {
        $metrics['http_req_failed{scenario:browse}'] = @{ thresholds = @{ 'rate<0.001' = @{ ok = $true } } }
        $metrics['http_req_duration{scenario:browse}'] = @{ thresholds = @{ 'p(95)<300' = @{ ok = $true } } }
        $metrics['http_req_failed{scenario:search}'] = @{ thresholds = @{ 'rate<0.001' = @{ ok = $true } } }
        $metrics['http_req_duration{scenario:search}'] = @{ thresholds = @{ 'p(95)<500' = @{ ok = $true } } }
    }
    $path = Join-Path $fixtureRoot $RelativePath
    Write-Json $path ([ordered]@{ metrics = $metrics })
    return [ordered]@{
        path = $RelativePath.Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        byte_length = (Get-Item -LiteralPath $path).Length
        redacted = $true
    }
}

function New-Run([string]$Profile, [string]$StartedAt, [string]$FinishedAt) {
    $summary = New-K6Summary $Profile "runs/$Profile/k6-summary.json"
    $runManifestPath = Join-Path $fixtureRoot "runs/$Profile/run-manifest.json"
    Write-Json $runManifestPath ([ordered]@{
        schema_version = '1.1'
        profile = $Profile
        started_at = $StartedAt
        finished_at = $FinishedAt
        git_commit = '1111111111111111111111111111111111111111'
        k6_version = 'k6 v0.57.0'
        exit_code = 0
        summary_present = $true
        summary_sha256 = $summary.sha256
        upload_enabled = $false
        remote_target_confirmed = $true
        capacity_evidence_state = 'k6_summary_only'
        cost_evidence_state = 'not_collected'
        p8_gate_eligible = $false
    })
    $loadManifest = [ordered]@{
        path = "runs/$Profile/run-manifest.json"
        sha256 = (Get-FileHash -LiteralPath $runManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        byte_length = (Get-Item -LiteralPath $runManifestPath).Length
        redacted = $true
    }
    $generators = foreach ($index in 1..2) {
        [ordered]@{
            location = "generator-$index"
            failure_domain = "provider/zone-$index"
            cpu_max_percent = 55
            dropped_iterations = 0
            ephemeral_ports_exhausted = $false
            clock_offset_ms = 25
            evidence = New-FileReference "runs/$Profile/generator-$index.json" "generator-$index" '' ''
        }
    }
    $signals = [ordered]@{}
    foreach ($signal in @('prometheus', 'opentelemetry', 'cloudflare', 'postgresql', 'nats', 'opensearch')) {
        $signals[$signal] = New-FileReference "runs/$Profile/$signal.json" $signal $StartedAt $FinishedAt
    }
    $capacity = [ordered]@{
        max_resource_utilization_percent = 55
        remaining_headroom_percent = 45
        autoscaling_response_seconds = 90
        control_plane_5xx_rate = 0.0005
        event_e2e_p99_seconds = 20
        search_freshness_p99_seconds = 40
        cascading_failure = $false
        control_plane_artifact_bytes = 0
    }
    if ($Profile -eq 'download') {
        $capacity.concurrent_download_vus = 10000
        $capacity.cdn_cache_hit_api_independent = $true
    } else {
        $capacity.browse_p95_ms = 250
        $capacity.search_p95_ms = 450
    }
    return [ordered]@{
        profile = $Profile
        target_origin = 'https://assetlibrary-staging.example'
        started_at = $StartedAt
        finished_at = $FinishedAt
        load_manifest = $loadManifest
        k6_summary = $summary
        generators = @($generators)
        signals = $signals
        capacity = $capacity
    }
}

function Copy-Manifest($Value) {
    return ($Value | ConvertTo-Json -Depth 20 | ConvertFrom-Json)
}

function Assert-Rejected([string]$Name, [scriptblock]$Mutation) {
    $candidate = Copy-Manifest $script:validManifest
    & $Mutation $candidate
    $path = Join-Path $fixtureRoot "invalid-$Name.json"
    Write-Json $path $candidate
    $accepted = $false
    try {
        & $verifier -EvidenceManifest $path *> $null
        $accepted = $true
    } catch {
        # Expected: each mutation violates one fail-closed contract.
    }
    if ($accepted) { throw "P8 verifier accepted invalid fixture '$Name'." }
    $global:LASTEXITCODE = 0
}

New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
try {
    & $verifier -ValidateOnly *> $null
    $runs = @(
        (New-Run 'baseline' '2026-01-01T00:00:00Z' '2026-01-01T00:10:00Z'),
        (New-Run 'soak' '2026-01-02T00:00:00Z' '2026-01-03T00:00:00Z'),
        (New-Run 'burst' '2026-01-04T00:00:00Z' '2026-01-04T00:10:00Z'),
        (New-Run 'download' '2026-01-05T00:00:00Z' '2026-01-05T00:10:00Z')
    )
    $alerts = foreach ($item in @(
        @{ threshold = 50; severity = 'informational' },
        @{ threshold = 80; severity = 'warning' },
        @{ threshold = 100; severity = 'critical' }
    )) {
        [ordered]@{
            threshold_percent = $item.threshold
            severity = $item.severity
            route = 'independent_billing_channel'
            delivered = $true
            evidence = New-FileReference "cost/alert-$($item.threshold).json" "alert-$($item.threshold)" '' ''
        }
    }
    $script:validManifest = [ordered]@{
        schema_version = '1.0'
        evidence_origin = 'cloud'
        environment = 'staging'
        git_commit = '1111111111111111111111111111111111111111'
        topology = [ordered]@{
            topology_id = 'staging-v1'
            provider = 'example-cloud'
            account_ref_sha256 = '2222222222222222222222222222222222222222222222222222222222222222'
            deployment_digest = "sha256:$('3' * 64)"
            regions = @('region-a')
            generator_domains = @(
                [ordered]@{ location = 'generator-1'; failure_domain = 'provider/zone-1'; region = 'region-a' },
                [ordered]@{ location = 'generator-2'; failure_domain = 'provider/zone-2'; region = 'region-a' }
            )
            evidence = New-FileReference 'topology/provider-topology.json' 'provider-topology' '' ''
            failure_independent_generator_locations = $true
        }
        runs = $runs
        cost = [ordered]@{
            window_start = '2026-01-01T00:00:00Z'
            window_end = '2026-01-06T00:00:00Z'
            categories = @('storage', 'requests', 'egress', 'database', 'cluster', 'search', 'analytics', 'observability')
            provider_export = New-FileReference 'cost/provider-export.json' 'provider-cost-export' '' ''
            formula_version = 'cost-formula-v1'
            currency = 'USD'
            tax_treatment = 'exclusive'
            reviewer = 'finops-reviewer'
            alert_deliveries = @($alerts)
        }
        review = [ordered]@{
            reviewer = 'capacity-reviewer'
            reviewed_at = '2026-01-06T01:00:00Z'
            change_record = 'CHG-1234'
            decision = 'evidence_complete_for_external_attestation'
        }
    }
    $manifestPath = Join-Path $fixtureRoot 'p8-capacity-evidence.json'
    $reportPath = Join-Path $fixtureRoot 'verification-report.json'
    Write-Json $manifestPath $validManifest
    $before = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
    & $verifier -EvidenceManifest $manifestPath -ReportPath $reportPath *> $null
    $after = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
    $report = [IO.File]::ReadAllText($reportPath) | ConvertFrom-Json
    if ($before -cne $after -or $report.contract_valid -ne $true -or
        $report.production_authenticity_verified -ne $false -or $report.p8_gate_eligible -ne $false) {
        throw 'Valid evidence verification must be immutable and remain production-ineligible.'
    }

    Assert-Rejected 'local-origin' { param($value) $value.evidence_origin = 'local' }
    Assert-Rejected 'missing-signal' { param($value) $value.runs[0].signals.PSObject.Properties.Remove('nats') }
    Assert-Rejected 'missing-provider-export' { param($value) $value.cost.provider_export.path = 'cost/missing.json' }
    Assert-Rejected 'hash-mismatch' { param($value) $value.runs[0].signals.prometheus.sha256 = '0' * 64 }
    Assert-Rejected 'single-generator' { param($value) $value.runs[0].generators = @($value.runs[0].generators[0]) }
    Assert-Rejected 'unmapped-generator' { param($value) $value.runs[0].generators[0].failure_domain = 'provider/zone-9' }
    Assert-Rejected 'loopback-target' { param($value) $value.runs[0].target_origin = 'https://127.0.0.1/' }
    Assert-Rejected 'null-latency' { param($value) $value.runs[0].capacity.browse_p95_ms = $null }
    Assert-Rejected 'string-boolean' { param($value) $value.runs[0].load_manifest.redacted = 'true' }
    Assert-Rejected 'path-escape' { param($value) $value.runs[0].signals.nats.path = '../outside.json' }
    Assert-Rejected 'reused-signal' {
        param($value)
        $value.runs[0].signals.nats = $value.runs[0].signals.postgresql
    }
    Assert-Rejected 'reversed-signal-window' {
        param($value)
        $value.runs[0].signals.nats.window_start = $value.runs[0].finished_at
        $value.runs[0].signals.nats.window_end = $value.runs[0].started_at
    }
    Assert-Rejected 'reversed-cost-window' {
        param($value)
        $value.cost.window_start = '2026-01-06T00:00:00Z'
        $value.cost.window_end = '2026-01-01T00:00:00Z'
    }
    Assert-Rejected 'standalone-gate-spoof' {
        param($value)
        $source = Join-Path $fixtureRoot $value.runs[0].load_manifest.path
        $spoofed = [IO.File]::ReadAllText($source) | ConvertFrom-Json
        $spoofed.p8_gate_eligible = $true
        $relative = 'runs/baseline/spoofed-run-manifest.json'
        $target = Join-Path $fixtureRoot $relative
        Write-Json $target $spoofed
        $value.runs[0].load_manifest.path = $relative
        $value.runs[0].load_manifest.sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        $value.runs[0].load_manifest.byte_length = (Get-Item -LiteralPath $target).Length
    }
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

Write-Output 'P8 capacity evidence adversarial contract passed.'
