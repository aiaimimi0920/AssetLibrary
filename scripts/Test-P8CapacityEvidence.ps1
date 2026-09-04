[CmdletBinding()]
param(
    [string]$EvidenceManifest,
    [string]$ReportPath,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$schemaPath = Join-Path $root 'schemas/p8-capacity-evidence.schema.json'
$runSchemaPath = Join-Path $root 'schemas/p8-load-run-manifest.schema.json'
$loadRunnerPath = Join-Path $root 'scripts/Run-P8LoadTest.ps1'
$jsonSchemaValidator = Join-Path $root 'scripts/validate-json-schema.mjs'
. (Join-Path $PSScriptRoot 'RepositoryEvidencePath.ps1')

function Assert-PropertySet($Value, [string[]]$Expected, [string]$Context) {
    if ($null -eq $Value) { throw "$Context is required." }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($actual -join ',') -cne ($wanted -join ',')) {
        throw "$Context properties must exactly match: $($Expected -join ', ')."
    }
}

function Assert-ExactSet([object[]]$Actual, [string[]]$Expected, [string]$Context) {
    $actualText = @($Actual | ForEach-Object { "$_" } | Sort-Object) -join ','
    $expectedText = @($Expected | Sort-Object) -join ','
    if ($actualText -cne $expectedText) { throw "$Context must match the required bounded set." }
}

function Convert-EvidenceTime($Value, [string]$Context) {
    $text = "$Value"
    if ($text -notmatch '(Z|[+-][0-9]{2}:[0-9]{2})$') {
        throw "$Context must include an explicit UTC offset."
    }
    try {
        return [DateTimeOffset]::Parse(
            $text,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    } catch {
        throw "$Context must be an RFC 3339 date-time."
    }
}

function Assert-BoundedIdentifier($Value, [string]$Context) {
    $text = "$Value"
    if ($text.Length -lt 1 -or $text.Length -gt 128 -or
        $text -notmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]*$') {
        throw "$Context is not a bounded identifier."
    }
}

function Convert-FiniteNumber($Value, [string]$Context) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [bool]) {
        throw "$Context must be a JSON number."
    }
    try { $number = [double]$Value } catch { throw "$Context must be a JSON number." }
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
        throw "$Context must be finite."
    }
    return $number
}

function Convert-Integer($Value, [string]$Context) {
    $number = Convert-FiniteNumber $Value $Context
    if ([Math]::Truncate($number) -ne $number) { throw "$Context must be an integer." }
    return [long]$number
}

function Assert-Boolean($Value, [bool]$Expected, [string]$Context) {
    if ($Value -isnot [bool] -or $Value -ne $Expected) {
        throw "$Context must be the JSON boolean '$($Expected.ToString().ToLowerInvariant())'."
    }
}

function Assert-JsonSchema([string]$Schema, [string]$Document, [string]$Context) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js is required for Draft 2020-12 evidence validation.' }
    $arguments = @($jsonSchemaValidator, '--schema', $Schema)
    if ($Document) { $arguments += @('--document', $Document) }
    $nodePath = if ($node.Path) { $node.Path } else { $node.Name }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $nodePath @arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        $detail = (($output | ForEach-Object { "$_" }) -join ' ').Trim()
        if ($detail.Length -gt 2048) { $detail = $detail.Substring(0, 2048) }
        throw "$Context failed JSON Schema validation: $detail"
    }
}

function Resolve-EvidenceFile(
    $Reference,
    [string]$Context,
    [string]$EvidenceDirectory,
    [Collections.Generic.HashSet[string]]$Seen,
    [switch]$WithWindow
) {
    $properties = @('path', 'sha256', 'byte_length', 'redacted')
    if ($WithWindow) { $properties += @('window_start', 'window_end') }
    Assert-PropertySet $Reference $properties $Context
    $relative = "$($Reference.path)"
    if ([IO.Path]::IsPathRooted($relative) -or $relative -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or
        @($relative -split '[/\\]') -contains '..') {
        throw "$Context path must be a bounded relative evidence path."
    }
    if ("$($Reference.sha256)" -cnotmatch '^[0-9a-f]{64}$') {
        throw "$Context must be redacted and addressed by lowercase SHA-256."
    }
    Assert-Boolean $Reference.redacted $true "$Context.redacted"
    $declaredLength = Convert-Integer $Reference.byte_length "$Context.byte_length"
    if ($declaredLength -lt 1 -or $declaredLength -gt 268435456) {
        throw "$Context byte_length must be between 1 and 268435456."
    }
    $candidate = Resolve-RepositoryEvidencePath -RepositoryRoot $root -RawPath (Join-Path $EvidenceDirectory $relative)
    $prefix = $EvidenceDirectory.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Context must resolve to a file inside its evidence directory."
    }
    if (-not $Seen.Add($candidate)) { throw "$Context reuses an evidence file already assigned to another signal." }
    $file = Get-Item -LiteralPath $candidate -Force
    if ($file.Length -ne $declaredLength) { throw "$Context byte_length does not match the file." }
    $digest = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -cne "$($Reference.sha256)") { throw "$Context SHA-256 does not match the file." }
    return $candidate
}

function Assert-K6Metric($Summary, [string]$MetricName) {
    $metrics = $Summary.PSObject.Properties['metrics']
    if (-not $metrics) { throw 'k6 summary metrics are missing.' }
    $metric = $metrics.Value.PSObject.Properties[$MetricName]
    if (-not $metric) { throw "k6 summary is missing threshold metric '$MetricName'." }
    $thresholds = $metric.Value.PSObject.Properties['thresholds']
    if (-not $thresholds -or $thresholds.Value.PSObject.Properties.Count -lt 1) {
        throw "k6 metric '$MetricName' has no threshold result."
    }
    foreach ($threshold in $thresholds.Value.PSObject.Properties) {
        Assert-Boolean $threshold.Value.ok $true "k6 threshold '$MetricName/$($threshold.Name)'.ok"
    }
}

function Assert-Capacity($Capacity, [string]$Profile) {
    $common = @(
        'max_resource_utilization_percent', 'remaining_headroom_percent',
        'autoscaling_response_seconds', 'control_plane_5xx_rate', 'event_e2e_p99_seconds',
        'search_freshness_p99_seconds', 'cascading_failure', 'control_plane_artifact_bytes'
    )
    $specific = if ($Profile -eq 'download') {
        @('concurrent_download_vus', 'cdn_cache_hit_api_independent')
    } else { @('browse_p95_ms', 'search_p95_ms') }
    Assert-PropertySet $Capacity ($common + $specific) "runs[$Profile].capacity"
    $utilization = Convert-FiniteNumber $Capacity.max_resource_utilization_percent 'capacity.max_resource_utilization_percent'
    $headroom = Convert-FiniteNumber $Capacity.remaining_headroom_percent 'capacity.remaining_headroom_percent'
    $scaling = Convert-FiniteNumber $Capacity.autoscaling_response_seconds 'capacity.autoscaling_response_seconds'
    $errors = Convert-FiniteNumber $Capacity.control_plane_5xx_rate 'capacity.control_plane_5xx_rate'
    $eventLatency = Convert-FiniteNumber $Capacity.event_e2e_p99_seconds 'capacity.event_e2e_p99_seconds'
    $freshness = Convert-FiniteNumber $Capacity.search_freshness_p99_seconds 'capacity.search_freshness_p99_seconds'
    $artifactBytes = Convert-Integer $Capacity.control_plane_artifact_bytes 'capacity.control_plane_artifact_bytes'
    if ($utilization -lt 0 -or $utilization -gt 60 -or $headroom -lt 40 -or $headroom -gt 100 -or
        $scaling -lt 0 -or $scaling -ge 120 -or $errors -lt 0 -or $errors -ge 0.001 -or
        $eventLatency -lt 0 -or $eventLatency -ge 30 -or $freshness -lt 0 -or $freshness -ge 60 -or
        $artifactBytes -ne 0) {
        throw "runs[$Profile].capacity violates a P8 capacity or SLO bound."
    }
    Assert-Boolean $Capacity.cascading_failure $false 'capacity.cascading_failure'
    if ($Profile -eq 'download') {
        $vus = Convert-Integer $Capacity.concurrent_download_vus 'capacity.concurrent_download_vus'
        Assert-Boolean $Capacity.cdn_cache_hit_api_independent $true 'capacity.cdn_cache_hit_api_independent'
        if ($vus -lt 10000) {
            throw 'The download run must prove 10,000 VUs and API-independent CDN cache hits.'
        }
    } else {
        $browse = Convert-FiniteNumber $Capacity.browse_p95_ms 'capacity.browse_p95_ms'
        $search = Convert-FiniteNumber $Capacity.search_p95_ms 'capacity.search_p95_ms'
        if ($browse -lt 0 -or $browse -ge 300 -or $search -lt 0 -or $search -ge 500) {
            throw "runs[$Profile].capacity violates public browse/search latency bounds."
        }
    }
}

foreach ($requiredFile in @($schemaPath, $runSchemaPath, $jsonSchemaValidator, $loadRunnerPath)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "P8 evidence contract file is missing: $requiredFile"
    }
}
Assert-JsonSchema $schemaPath '' 'P8 capacity evidence schema'
Assert-JsonSchema $runSchemaPath '' 'P8 load run manifest schema'
$schema = [IO.File]::ReadAllText($schemaPath) | ConvertFrom-Json
if ($schema.'$schema' -ne 'https://json-schema.org/draft/2020-12/schema' -or
    $schema.additionalProperties -ne $false -or $schema.properties.evidence_origin.const -ne 'cloud' -or
    $schema.properties.runs.minItems -ne 4 -or $schema.properties.runs.maxItems -ne 4) {
    throw 'P8 capacity evidence schema must remain strict and cloud-only.'
}
if ($ValidateOnly) {
    $loadRunner = [IO.File]::ReadAllText($loadRunnerPath)
    foreach ($contract in @(
        "capacity_evidence_state = 'k6_summary_only'",
        "cost_evidence_state = 'not_collected'",
        'p8_gate_eligible = $false'
    )) {
        if (-not $loadRunner.Contains($contract)) { throw "Load anti-spoof contract is missing: $contract" }
    }
    Write-Output 'P8 capacity evidence static contract passed.'
    return
}
if ([string]::IsNullOrWhiteSpace($EvidenceManifest)) { throw 'EvidenceManifest is required.' }

$manifestPath = Resolve-RepositoryEvidencePath -RepositoryRoot $root -RawPath $EvidenceManifest
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'EvidenceManifest does not exist.' }
$evidenceDirectory = Split-Path -Parent $manifestPath
Assert-JsonSchema $schemaPath $manifestPath 'Evidence manifest'
$manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
Assert-PropertySet $manifest @(
    'schema_version', 'evidence_origin', 'environment', 'git_commit', 'topology', 'runs', 'cost', 'review'
) 'evidence manifest'
if ($manifest.schema_version -ne '1.0' -or $manifest.evidence_origin -ne 'cloud' -or
    $manifest.environment -notin @('staging', 'production') -or
    "$($manifest.git_commit)" -cnotmatch '^[0-9a-f]{40}$') {
    throw 'Evidence manifest identity must be schema 1.0, cloud-only, and commit-bound.'
}

$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
Assert-PropertySet $manifest.topology @(
    'topology_id', 'provider', 'account_ref_sha256', 'deployment_digest', 'regions',
    'generator_domains', 'evidence', 'failure_independent_generator_locations'
) 'topology'
Assert-BoundedIdentifier $manifest.topology.topology_id 'topology.topology_id'
Assert-BoundedIdentifier $manifest.topology.provider 'topology.provider'
if ("$($manifest.topology.account_ref_sha256)" -cnotmatch '^[0-9a-f]{64}$' -or
    "$($manifest.topology.deployment_digest)" -cnotmatch '^sha256:[0-9a-f]{64}$' -or
    $manifest.topology.failure_independent_generator_locations -ne $true) {
    throw 'Topology must be account-redacted, immutable-digest bound, and failure-independent.'
}
Assert-Boolean $manifest.topology.failure_independent_generator_locations $true 'topology.failure_independent_generator_locations'
if (@($manifest.topology.regions).Count -lt 1 -or @($manifest.topology.regions).Count -gt 16) {
    throw 'Topology must declare between one and sixteen regions.'
}
Assert-ExactSet @($manifest.topology.regions) @($manifest.topology.regions | Sort-Object -Unique) 'Topology regions'
foreach ($region in $manifest.topology.regions) { Assert-BoundedIdentifier $region 'topology.regions[]' }
Resolve-EvidenceFile $manifest.topology.evidence 'topology.evidence' $evidenceDirectory $seen | Out-Null
if (@($manifest.topology.generator_domains).Count -lt 2 -or @($manifest.topology.generator_domains).Count -gt 32) {
    throw 'Topology must map two to thirty-two generator failure domains.'
}
Assert-ExactSet @($manifest.topology.generator_domains | ForEach-Object { $_.location }) @(
    $manifest.topology.generator_domains | ForEach-Object { $_.location } | Sort-Object -Unique
) 'Topology generator locations'
Assert-ExactSet @($manifest.topology.generator_domains | ForEach-Object { $_.failure_domain }) @(
    $manifest.topology.generator_domains | ForEach-Object { $_.failure_domain } | Sort-Object -Unique
) 'Topology generator failure domains'
$generatorDomainMap = @{}
foreach ($domain in $manifest.topology.generator_domains) {
    Assert-PropertySet $domain @('location', 'failure_domain', 'region') 'topology.generator_domains[]'
    Assert-BoundedIdentifier $domain.location 'topology.generator_domains[].location'
    Assert-BoundedIdentifier $domain.failure_domain 'topology.generator_domains[].failure_domain'
    Assert-BoundedIdentifier $domain.region 'topology.generator_domains[].region'
    if (@($manifest.topology.regions) -cnotcontains "$($domain.region)") {
        throw 'Every generator failure domain must belong to a declared topology region.'
    }
    $generatorDomainMap["$($domain.location)"] = $domain
}

$requiredProfiles = @('baseline', 'soak', 'burst', 'download')
if (@($manifest.runs).Count -ne 4) { throw 'Exactly four required P8 load profiles must be supplied.' }
Assert-ExactSet @($manifest.runs | ForEach-Object { $_.profile }) $requiredProfiles 'P8 run profiles'
$earliestRun = [DateTimeOffset]::MaxValue
$latestRun = [DateTimeOffset]::MinValue
$minimumSeconds = @{ baseline = 600; soak = 86400; burst = 600; download = 600 }

foreach ($run in $manifest.runs) {
    $profile = "$($run.profile)"
    Assert-PropertySet $run @(
        'profile', 'target_origin', 'started_at', 'finished_at', 'load_manifest', 'k6_summary',
        'generators', 'signals', 'capacity'
    ) "runs[$profile]"
    try { $target = [Uri]"$($run.target_origin)" } catch { throw "runs[$profile].target_origin is invalid." }
    if (-not $target.IsAbsoluteUri -or $target.Scheme -ne 'https' -or $target.IsLoopback -or
        $target.Host -match '(^|\.)localhost\.?$' -or $target.UserInfo -or $target.Query -or
        $target.Fragment -or $target.AbsolutePath -ne '/') {
        throw "runs[$profile].target_origin must be a remote HTTPS origin without credentials or path."
    }
    $started = Convert-EvidenceTime $run.started_at "runs[$profile].started_at"
    $finished = Convert-EvidenceTime $run.finished_at "runs[$profile].finished_at"
    if ($finished -le $started -or ($finished - $started).TotalSeconds -lt $minimumSeconds[$profile]) {
        throw "runs[$profile] does not cover the required profile duration."
    }
    if ($started -lt $earliestRun) { $earliestRun = $started }
    if ($finished -gt $latestRun) { $latestRun = $finished }

    $loadPath = Resolve-EvidenceFile $run.load_manifest "runs[$profile].load_manifest" $evidenceDirectory $seen
    $summaryPath = Resolve-EvidenceFile $run.k6_summary "runs[$profile].k6_summary" $evidenceDirectory $seen
    Assert-JsonSchema $runSchemaPath $loadPath "runs[$profile].load_manifest"
    $runManifest = [IO.File]::ReadAllText($loadPath) | ConvertFrom-Json
    $exitCode = Convert-Integer $runManifest.exit_code "runs[$profile].load_manifest.exit_code"
    if ($runManifest.schema_version -ne '1.1' -or $runManifest.profile -ne $profile -or
        $runManifest.git_commit -cne $manifest.git_commit -or $exitCode -ne 0 -or
        $runManifest.capacity_evidence_state -ne 'k6_summary_only' -or
        $runManifest.cost_evidence_state -ne 'not_collected' -or
        "$($runManifest.summary_sha256)" -cne "$($run.k6_summary.sha256)") {
        throw "runs[$profile].load_manifest violates the immutable standalone k6 contract."
    }
    Assert-Boolean $runManifest.summary_present $true "runs[$profile].load_manifest.summary_present"
    Assert-Boolean $runManifest.remote_target_confirmed $true "runs[$profile].load_manifest.remote_target_confirmed"
    Assert-Boolean $runManifest.p8_gate_eligible $false "runs[$profile].load_manifest.p8_gate_eligible"
    $loadStarted = Convert-EvidenceTime $runManifest.started_at "runs[$profile].load_manifest.started_at"
    $loadFinished = Convert-EvidenceTime $runManifest.finished_at "runs[$profile].load_manifest.finished_at"
    if ($loadStarted -ne $started -or $loadFinished -ne $finished -or
        [string]::IsNullOrWhiteSpace("$($runManifest.k6_version)")) {
        throw "runs[$profile].load_manifest is not time/version bound to the evidence manifest."
    }
    $summary = [IO.File]::ReadAllText($summaryPath) | ConvertFrom-Json
    if ($profile -eq 'download') {
        Assert-K6Metric $summary 'http_req_failed'
        Assert-K6Metric $summary 'checks'
    } else {
        foreach ($metric in @(
            'http_req_failed{scenario:browse}', 'http_req_duration{scenario:browse}',
            'http_req_failed{scenario:search}', 'http_req_duration{scenario:search}'
        )) { Assert-K6Metric $summary $metric }
    }

    if (@($run.generators).Count -lt 2 -or @($run.generators).Count -gt 32) {
        throw "runs[$profile] requires two to thirty-two generators."
    }
    Assert-ExactSet @($run.generators | ForEach-Object { $_.location }) @(
        $run.generators | ForEach-Object { $_.location } | Sort-Object -Unique
    ) "runs[$profile] generator locations"
    Assert-ExactSet @($run.generators | ForEach-Object { $_.failure_domain }) @(
        $run.generators | ForEach-Object { $_.failure_domain } | Sort-Object -Unique
    ) "runs[$profile] generator failure domains"
    foreach ($generator in $run.generators) {
        Assert-PropertySet $generator @(
            'location', 'failure_domain', 'cpu_max_percent', 'dropped_iterations',
            'ephemeral_ports_exhausted', 'clock_offset_ms', 'evidence'
        ) "runs[$profile].generator"
        Assert-BoundedIdentifier $generator.location "runs[$profile].generator.location"
        Assert-BoundedIdentifier $generator.failure_domain "runs[$profile].generator.failure_domain"
        $mappedDomain = $generatorDomainMap["$($generator.location)"]
        if (-not $mappedDomain -or "$($mappedDomain.failure_domain)" -cne "$($generator.failure_domain)") {
            throw "runs[$profile] generator is not bound to the declared topology map."
        }
        $cpu = Convert-FiniteNumber $generator.cpu_max_percent "runs[$profile].generator.cpu_max_percent"
        $dropped = Convert-Integer $generator.dropped_iterations "runs[$profile].generator.dropped_iterations"
        $clockOffset = Convert-FiniteNumber $generator.clock_offset_ms "runs[$profile].generator.clock_offset_ms"
        Assert-Boolean $generator.ephemeral_ports_exhausted $false "runs[$profile].generator.ephemeral_ports_exhausted"
        if ($cpu -lt 0 -or $cpu -ge 70 -or $dropped -ne 0 -or
            $clockOffset -lt 0 -or $clockOffset -gt 1000) {
            throw "runs[$profile] contains saturated or unsynchronized generator evidence."
        }
        Resolve-EvidenceFile $generator.evidence "runs[$profile].generator.evidence" $evidenceDirectory $seen | Out-Null
    }

    $signals = @('prometheus', 'opentelemetry', 'cloudflare', 'postgresql', 'nats', 'opensearch')
    Assert-PropertySet $run.signals $signals "runs[$profile].signals"
    foreach ($signalName in $signals) {
        $signal = $run.signals.PSObject.Properties[$signalName].Value
        Resolve-EvidenceFile $signal "runs[$profile].signals.$signalName" $evidenceDirectory $seen -WithWindow | Out-Null
        $signalStart = Convert-EvidenceTime $signal.window_start "runs[$profile].signals.$signalName.window_start"
        $signalEnd = Convert-EvidenceTime $signal.window_end "runs[$profile].signals.$signalName.window_end"
        if ($signalEnd -le $signalStart -or $signalStart -gt $started -or $signalEnd -lt $finished) {
            throw "runs[$profile].signals.$signalName does not cover the complete run window."
        }
    }
    Assert-Capacity $run.capacity $profile
}

$cost = $manifest.cost
Assert-PropertySet $cost @(
    'window_start', 'window_end', 'categories', 'provider_export', 'formula_version',
    'currency', 'tax_treatment', 'reviewer', 'alert_deliveries'
) 'cost'
$costStart = Convert-EvidenceTime $cost.window_start 'cost.window_start'
$costEnd = Convert-EvidenceTime $cost.window_end 'cost.window_end'
if ($costEnd -le $costStart -or $costStart -gt $earliestRun -or $costEnd -lt $latestRun) {
    throw 'Cost evidence must be ordered and cover every required run.'
}
Assert-ExactSet @($cost.categories) @(
    'storage', 'requests', 'egress', 'database', 'cluster', 'search', 'analytics', 'observability'
) 'Cost categories'
Assert-BoundedIdentifier $cost.formula_version 'cost.formula_version'
Assert-BoundedIdentifier $cost.tax_treatment 'cost.tax_treatment'
Assert-BoundedIdentifier $cost.reviewer 'cost.reviewer'
if ("$($cost.currency)" -cnotmatch '^[A-Z]{3}$') { throw 'cost.currency must be a three-letter uppercase code.' }
Resolve-EvidenceFile $cost.provider_export 'cost.provider_export' $evidenceDirectory $seen | Out-Null
if (@($cost.alert_deliveries).Count -ne 3) { throw 'Exactly three budget alert deliveries are required.' }
Assert-ExactSet @($cost.alert_deliveries | ForEach-Object { $_.threshold_percent }) @('50', '80', '100') 'Alert thresholds'
$severity = @{ 50 = 'informational'; 80 = 'warning'; 100 = 'critical' }
foreach ($alert in $cost.alert_deliveries) {
    Assert-PropertySet $alert @('threshold_percent', 'severity', 'route', 'delivered', 'evidence') 'cost.alert_delivery'
    if ($alert.severity -ne $severity[[int]$alert.threshold_percent] -or
        $alert.route -ne 'independent_billing_channel') {
        throw 'Budget alerts must prove independent 50/80/100% delivery with required severities.'
    }
    Assert-Boolean $alert.delivered $true 'cost.alert_delivery.delivered'
    Resolve-EvidenceFile $alert.evidence 'cost.alert_delivery.evidence' $evidenceDirectory $seen | Out-Null
}

Assert-PropertySet $manifest.review @('reviewer', 'reviewed_at', 'change_record', 'decision') 'review'
Assert-BoundedIdentifier $manifest.review.reviewer 'review.reviewer'
Assert-BoundedIdentifier $manifest.review.change_record 'review.change_record'
$reviewedAt = Convert-EvidenceTime $manifest.review.reviewed_at 'review.reviewed_at'
if ($reviewedAt -lt $latestRun -or $manifest.review.decision -ne 'evidence_complete_for_external_attestation') {
    throw 'Review must follow all runs and remain pending external authenticity attestation.'
}

$manifestDigest = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$report = [ordered]@{
    schema_version = '1.0'
    verification_kind = 'p8_capacity_evidence_contract'
    evidence_manifest_sha256 = $manifestDigest
    verified_at = (Get-Date).ToUniversalTime().ToString('o')
    contract_valid = $true
    file_integrity_verified = $true
    production_authenticity_verified = $false
    p8_gate_eligible = $false
    limitation = 'Repository verification cannot authenticate provider accounts, reviewer identity, or cloud execution.'
}
if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
    $resolvedReport = Resolve-RepositoryEvidencePath -RepositoryRoot $root -RawPath $ReportPath
    if ($resolvedReport -eq $manifestPath -or $seen.Contains($resolvedReport)) {
        throw 'ReportPath must not overwrite source evidence.'
    }
    $reportDirectory = Split-Path -Parent $resolvedReport
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    $temporary = "$resolvedReport.$PID.tmp"
    try {
        [IO.File]::WriteAllText(
            $temporary,
            (($report | ConvertTo-Json -Depth 5) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $resolvedReport -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
Write-Output 'P8 capacity evidence contract is valid; provider authenticity remains an external production gate.'
