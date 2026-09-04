$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$policyPath = Join-Path $root 'security/dependency-security-policy.json'
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$violations = @()

function Assert-ExactSet([object[]]$Actual, [string[]]$Expected, [string]$Name) {
    $actualText = @($Actual | ForEach-Object { "$_" } | Sort-Object) -join ','
    $expectedText = @($Expected | Sort-Object) -join ','
    if ($actualText -cne $expectedText) { $script:violations += "$Name does not match the bounded policy set." }
}

foreach ($lockfile in $policy.lockfiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $lockfile))) {
        $violations += "Missing declared lockfile: $lockfile"
    }
}

$workflowRoot = Join-Path $root '.github/workflows'
$actionReferenceCount = 0
$workflowContent = ''
Get-ChildItem -LiteralPath $workflowRoot -File |
    Where-Object { $_.Extension -in @('.yml', '.yaml') } |
    ForEach-Object {
    $content = Get-Content -LiteralPath $_.FullName -Raw
    $workflowContent += $content
    foreach ($match in [regex]::Matches($content, '(?m)^\s*-\s*uses:\s*([^\s#]+)')) {
        $actionReferenceCount += 1
        $reference = $match.Groups[1].Value
        if ($reference -notmatch '@[a-f0-9]{40}$') {
            $violations += "$($_.Name): action is not pinned to a full commit SHA: $reference"
        }
    }
    if ($content -match '(?im)^\s*run:.*\btofu\s+(plan|apply)\b') {
        $violations += "$($_.Name): cloud mutation commands are forbidden in CI"
    }
}

$securityEntry = Get-Content -LiteralPath (Join-Path $workflowRoot 'security.yml') -Raw
$securityPolicy = Get-Content -LiteralPath (Join-Path $workflowRoot 'security-policy.yml') -Raw
$qualityPolicy = Get-Content -LiteralPath (Join-Path $workflowRoot 'ci.yml') -Raw
$releasePolicy = Get-Content -LiteralPath (Join-Path $workflowRoot 'release.yml') -Raw
if ($securityEntry -notmatch 'tags:\s*\["v\*"\]' -or
    $securityEntry -notmatch 'uses:\s*\./\.github/workflows/security-policy\.yml' -or
    $securityPolicy -notmatch 'workflow_call:' -or $securityPolicy -match 'continue-on-error:\s*true') {
    $violations += 'PR, main, scheduled, manual, and tagged release scans must share one fail-closed workflow.'
}
if ([regex]::Matches($securityPolicy, 'timeout --signal=TERM --kill-after=30s 300s').Count -ne 3) {
    $violations += 'Every pnpm audit must have the bounded five-minute fail-closed timeout.'
}
if ($qualityPolicy -notmatch 'workflow_call:' -or
    $qualityPolicy -notmatch 'test-release-candidate-evidence\.mjs' -or
    $qualityPolicy -notmatch 'test-production-promotion-evidence\.mjs' -or
    $qualityPolicy -notmatch 'Test-AppUpdateTufPolicy\.ps1' -or
    $qualityPolicy -notmatch 'app-update-tuf-policy\.schema\.json' -or
    $releasePolicy -notmatch 'uses:\s*\./\.github/workflows/security-policy\.yml' -or
    $releasePolicy -notmatch 'uses:\s*\./\.github/workflows/ci\.yml' -or
    $releasePolicy -notmatch 'Test-ContainerImages\.ps1' -or
    $releasePolicy -notmatch 'release-candidate-evidence\.mjs' -or
    $releasePolicy -notmatch 'release-candidate-evidence\.schema\.json') {
    $violations += 'Release candidates must reuse same-commit security and quality gates and verify their evidence schema.'
}

if ($actionReferenceCount -lt 8) {
    $violations += "CI policy scanned only $actionReferenceCount action references; workflow discovery is incomplete."
}

foreach ($property in $policy.actions.PSObject.Properties) {
    if ($property.Value -notmatch '^[a-f0-9]{40}$') {
        $violations += "Action policy SHA is invalid: $($property.Name)"
    } elseif ($workflowContent -notmatch (
        [regex]::Escape("$($property.Name)") + '(?:/[A-Za-z0-9_-]+)?@' + [regex]::Escape("$($property.Value)")
    )) {
        $violations += "Declared Action pin is not used by a workflow: $($property.Name)"
    }
}

Assert-ExactSet $policy.scans @('dependency-review', 'codeql', 'secret', 'osv', 'container', 'iac') 'Security scans'
if ($policy.sbom_format -ne 'spdx-json' -or $policy.provenance_format -ne 'slsa-v1' -or
    $policy.image_signature -ne 'sigstore-keyless') {
    $violations += 'SBOM, provenance, and image-signature formats must be explicit.'
}
foreach ($property in $policy.tool_images.PSObject.Properties) {
    if ($property.Value -notmatch '^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$') {
        $violations += "Tool image is not pinned by digest: $($property.Name)"
    }
}
foreach ($tool in @('osv_scanner', 'trivy', 'syft', 'actionlint')) {
    if (-not $policy.tool_images.PSObject.Properties[$tool] -or
        -not $workflowContent.Contains("$($policy.tool_images.$tool)")) {
        $violations += "Security workflow does not use the declared tool image: $tool"
    }
}

$baseImagePath = Join-Path $root $policy.base_image_manifest
if (-not (Test-Path -LiteralPath $baseImagePath -PathType Leaf)) {
    $violations += "Missing base image manifest: $($policy.base_image_manifest)"
} else {
    $imagePolicy = Get-Content -LiteralPath $baseImagePath -Raw | ConvertFrom-Json
    Assert-ExactSet @($imagePolicy.components | ForEach-Object { $_.name }) @(
        'api', 'web', 'scanner', 'outbox', 'indexer', 'cleanup'
    ) 'Release image components'
    foreach ($property in $imagePolicy.base_images.PSObject.Properties) {
        if ($property.Value -notmatch '^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$') {
            $violations += "Base image is not pinned by digest: $($property.Name)"
        }
    }
    if ($imagePolicy.base_images.clamav_runtime -notmatch '^docker\.io/clamav/clamav@sha256:[a-f0-9]{64}$') {
        $violations += 'The release-rendered ClamAV runtime must be digest pinned.'
    }
    foreach ($component in $imagePolicy.components) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $component.dockerfile) -PathType Leaf)) {
            $violations += "Component Dockerfile is missing: $($component.name)"
        }
    }
}

foreach ($requiredFile in @(
    'schemas/release-candidate-evidence.schema.json',
    'scripts/release-candidate-evidence.mjs',
    'scripts/test-release-candidate-evidence.mjs',
    'schemas/production-promotion-evidence.schema.json',
    'scripts/verify-production-promotion.mjs',
    'scripts/test-production-promotion-evidence.mjs',
    'security/app-update-tuf-policy.json',
    'schemas/app-update-tuf-policy.schema.json',
    'schemas/app-update-tuf-target.schema.json',
    'schemas/app-update-control.schema.json',
    'scripts/Test-AppUpdateTufPolicy.ps1',
    'docs/ADR/ADR-008-app-update-tuf.md',
    'scripts/Test-ContainerImages.ps1',
    'docs/operations/RELEASE_SECURITY_RUNBOOK.md',
    'release/README.md',
    'promotion/README.md'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $requiredFile) -PathType Leaf)) {
        $violations += "Release evidence contract file is missing: $requiredFile"
    }
}

if ($policy.exception_max_days -gt 90) { $violations += 'Security exceptions cannot exceed 90 days.' }
$exceptionsPath = Join-Path $root $policy.exceptions_file
if (-not (Test-Path -LiteralPath $exceptionsPath)) {
    $violations += "Missing dependency exceptions registry: $($policy.exceptions_file)"
} else {
    $registry = Get-Content -LiteralPath $exceptionsPath -Raw | ConvertFrom-Json
    $seenAdvisories = @{}
    $auditConfig = Get-Content -LiteralPath (Join-Path $root '.cargo/audit.toml') -Raw
    $osvConfig = Get-Content -LiteralPath (Join-Path $root 'osv-scanner.toml') -Raw
    foreach ($exception in $registry.exceptions) {
        try {
            $created = [datetime]::ParseExact($exception.created_on, 'yyyy-MM-dd', $null)
            $expires = [datetime]::ParseExact($exception.expires_on, 'yyyy-MM-dd', $null)
        } catch {
            $violations += "Dependency exception has an invalid date: $($exception.advisory)"
            continue
        }
        if ($exception.advisory -notmatch '^RUSTSEC-[0-9]{4}-[0-9]{4}$' -or $seenAdvisories[$exception.advisory]) {
            $violations += "Dependency exception advisory is invalid or duplicated: $($exception.advisory)"
        }
        $seenAdvisories[$exception.advisory] = $true
        if (($expires - $created).TotalDays -gt $policy.exception_max_days -or $expires -lt $created) {
            $violations += "Dependency exception exceeds the allowed lifetime: $($exception.advisory)"
        }
        if ($expires -lt [datetime]::UtcNow.Date) {
            $violations += "Dependency exception has expired: $($exception.advisory)"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $root $exception.evidence))) {
            $violations += "Dependency exception evidence is missing: $($exception.advisory)"
        }
        foreach ($field in @('reason', 'owner', 'reviewer')) {
            if ([string]::IsNullOrWhiteSpace("$($exception.$field)")) {
                $violations += "Dependency exception is missing ${field}: $($exception.advisory)"
            }
        }
        if ($auditConfig -notmatch [regex]::Escape($exception.advisory)) {
            $violations += "Dependency exception is not present in audit.toml: $($exception.advisory)"
        }
        if ($osvConfig -notmatch [regex]::Escape($exception.advisory) -or
            $osvConfig -notmatch [regex]::Escape($exception.expires_on)) {
            $violations += "Dependency exception is not expiry-aligned with osv-scanner.toml: $($exception.advisory)"
        }
    }
}
if ($violations.Count -gt 0) {
    $violations | ForEach-Object { Write-Error $_ }
    exit 1
}
Write-Output 'CI and dependency security policy contract passed.'
