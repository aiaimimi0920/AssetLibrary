$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$policyPath = Join-Path $root 'security/app-update-tuf-policy.json'
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$violations = @()

function Assert-Value($Actual, $Expected, [string] $Name) {
    if ($Actual -cne $Expected) { $script:violations += "$Name must be $Expected." }
}

Assert-Value $policy.schema_version '1.0' 'TUF policy schema version'
Assert-Value $policy.implementation.crate 'tough' 'TUF implementation'
Assert-Value $policy.implementation.version '0.24.0' 'TUF implementation version'
Assert-Value $policy.implementation.tuf_specification '1.0.0' 'TUF specification'
Assert-Value $policy.implementation.delegated_roles $false 'Delegated roles setting'
Assert-Value $policy.implementation.consistent_snapshot $true 'Consistent snapshot setting'
Assert-Value $policy.implementation.expiration_enforcement 'safe' 'Expiration enforcement'

$expectedRoles = @{
    root = @(2, 3, 'ed25519', 'offline-independent')
    targets = @(2, 3, 'ed25519', 'offline-independent')
    snapshot = @(1, 1, 'ecdsa-sha2-nistp256', 'online-hsm')
    timestamp = @(1, 1, 'ecdsa-sha2-nistp256', 'online-hsm')
}
foreach ($name in $expectedRoles.Keys) {
    $role = $policy.roles.$name
    $expected = $expectedRoles[$name]
    if ($role.threshold -ne $expected[0] -or $role.keys -ne $expected[1] -or
        $role.algorithm -cne $expected[2] -or $role.custody -cne $expected[3]) {
        $violations += "TUF $name role violates threshold or custody policy."
    }
}

$expectedRepositories = @(
    'hook-beta', 'hook-nightly', 'hook-stable',
    'loom-beta', 'loom-nightly', 'loom-stable'
)
$actualRepositories = @($policy.repositories | ForEach-Object { $_.id } | Sort-Object)
if (($actualRepositories -join ',') -cne ($expectedRepositories -join ',')) {
    $violations += 'TUF repositories must be the exact Loom/Hook and stable/beta/nightly product set.'
}
$rootKeySets = @($policy.repositories | ForEach-Object { $_.root_key_set })
if (@($rootKeySets | Select-Object -Unique).Count -ne 6) {
    $violations += 'Every product/channel repository must have an independent Root key set.'
}
foreach ($repository in $policy.repositories) {
    if ($repository.id -cne "$($repository.product)-$($repository.channel)" -or
        $repository.root_key_set -cne "$($repository.id)-root") {
        $violations += "Repository identity is not self-consistent: $($repository.id)"
    }
}

foreach ($field in @(
    'app_updates_enabled', 'production_repository_initialized',
    'root_ceremony_verified', 'client_activation_verified'
)) {
    if ($policy.admission.$field -ne $false) {
        $violations += "TUF admission field must remain false in repository policy: $field"
    }
}

$cargo = Get-Content -LiteralPath (Join-Path $root 'crates/app-update-client/Cargo.toml') -Raw
$client = Get-Content -LiteralPath (Join-Path $root 'crates/app-update-client/src/client.rs') -Raw
$policyCode = Get-Content -LiteralPath (Join-Path $root 'crates/app-update-client/src/policy.rs') -Raw
if ($cargo -notmatch 'tough\s*=\s*\{\s*version\s*=\s*"=0\.24\.0"') {
    $violations += 'The native TUF client must pin tough exactly to 0.24.0.'
}
foreach ($required in @(
    'ExpirationEnforcement::Safe', '.datastore(', 'max_root_updates: 32',
    'validate_root_policy', 'consistent_snapshot'
)) {
    if (-not $client.Contains($required)) { $violations += "TUF client is missing: $required" }
}
if ($client.Contains('ExpirationEnforcement::Unsafe')) {
    $violations += 'The product TUF client must never disable expiration enforcement.'
}
foreach ($required in @(
    'the signed channel kill switch is active', 'remote application downgrade is forbidden',
    'candidate digest is revoked', 'rollback_allowed'
)) {
    if (-not $policyCode.Contains($required)) { $violations += "TUF policy code is missing: $required" }
}

$apiConfig = Get-Content -LiteralPath (Join-Path $root 'services/api/src/config.rs') -Raw
$helmValues = Get-Content -LiteralPath (Join-Path $root 'deploy/helm/assetlibrary/values.yaml') -Raw
if ($apiConfig -notmatch 'App Update admission gate is closed outside development' -or
    $helmValues -notmatch '(?m)^\s*appUpdatesEnabled:\s*false\s*$') {
    $violations += 'App Update must remain disabled in API and Helm defaults.'
}

foreach ($requiredFile in @(
    'docs/ADR/ADR-008-app-update-tuf.md',
    'schemas/app-update-tuf-policy.schema.json',
    'schemas/app-update-tuf-target.schema.json',
    'schemas/app-update-control.schema.json'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $requiredFile) -PathType Leaf)) {
        $violations += "Missing App Update TUF contract file: $requiredFile"
    }
}

if ($violations.Count -gt 0) {
    $violations | ForEach-Object { Write-Error $_ }
    exit 1
}
Write-Output 'App Update TUF policy contract passed; production admission remains disabled.'
