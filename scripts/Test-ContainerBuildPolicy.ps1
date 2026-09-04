[CmdletBinding()]
param([switch]$DockerfileCheck)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$matrixPath = Join-Path $root 'deploy/images/build-matrix.json'
$rustPath = Join-Path $root 'deploy/images/rust-service.Dockerfile'
$webPath = Join-Path $root 'deploy/images/web.Dockerfile'
$ignorePath = Join-Path $root '.dockerignore'
$releaseEvidencePath = Join-Path $root 'scripts/release-candidate-evidence.mjs'

foreach ($path in @($matrixPath, $rustPath, $webPath, $ignorePath, $releaseEvidencePath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Container build input is missing: $path" }
}

$matrix = [IO.File]::ReadAllText($matrixPath) | ConvertFrom-Json
$rust = [IO.File]::ReadAllText($rustPath)
$web = [IO.File]::ReadAllText($webPath)
$ignore = [IO.File]::ReadAllText($ignorePath)
$releaseEvidence = [IO.File]::ReadAllText($releaseEvidencePath)
$components = @($matrix.components | ForEach-Object { $_.name } | Sort-Object) -join ','
if ($matrix.schema_version -ne '1.0' -or $components -cne 'api,cleanup,indexer,outbox,scanner,web') {
    throw 'Container build matrix must contain the exact six production components.'
}
foreach ($property in $matrix.base_images.PSObject.Properties) {
    if ($property.Value -notmatch '^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$') {
        throw "Base image is not digest pinned: $($property.Name)"
    }
    $isConsumed = $rust.Contains("$($property.Value)") -or $web.Contains("$($property.Value)")
    if ($property.Name -eq 'clamav_runtime') {
        $isConsumed = $releaseEvidence.Contains('base_images?.clamav_runtime')
    }
    if (-not $isConsumed) {
        throw "Pinned base image is not consumed by a Dockerfile: $($property.Name)"
    }
}
foreach ($component in $matrix.components) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $component.dockerfile) -PathType Leaf)) {
        throw "Container build matrix references a missing Dockerfile: $($component.name)"
    }
    if ($component.name -ne 'web' -and
        ([string]::IsNullOrWhiteSpace("$($component.package)") -or
         [string]::IsNullOrWhiteSpace("$($component.binary)"))) {
        throw "Rust component lacks an explicit package/binary pair: $($component.name)"
    }
}
foreach ($dockerfile in @($rust, $web)) {
    if ($dockerfile -match '(?im)^\s*FROM\s+[^$\s]+:(latest|main|master)\b' -or
        $dockerfile -match '(?i)\b(curl|wget)\b.*\|\s*(sh|bash)\b' -or
        $dockerfile -notmatch 'org\.opencontainers\.image\.revision' -or
        $dockerfile -notmatch 'org\.opencontainers\.image\.source') {
        throw 'Dockerfiles must use immutable inputs, avoid piped installers, and retain source labels.'
    }
}
if ($rust -notmatch 'cargo build --locked --release' -or $rust -notmatch 'USER nonroot:nonroot' -or
    $rust -notmatch 'unsupported package/binary pair') {
    throw 'Rust image must use the package allowlist, locked release build, and non-root runtime.'
}
if ($web -notmatch 'pnpm install --frozen-lockfile' -or $web -notmatch '/\.next/standalone' -or
    $web -notmatch '(?m)^USER node$') {
    throw 'Web image must use the frozen graph, standalone output, and non-root runtime.'
}
foreach ($entry in @('.git', '.env', '.pnpm-store', '**/node_modules', '**/target', '**/test-results', 'release/evidence')) {
    if ($ignore -notmatch "(?m)^$([regex]::Escape($entry))$") {
        throw "Docker context exclusion is missing: $entry"
    }
}

if ($DockerfileCheck) {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { throw 'Docker is required for Dockerfile build checks.' }
    $common = @(
        '--check', '--build-arg', "SOURCE_COMMIT=$('a' * 40)",
        '--build-arg', 'SOURCE_URL=https://example.invalid/neuro/assetlibrary',
        '--build-arg', 'VERSION=0.0.0'
    )
    $checks = @(
        @('-f', $rustPath, '--build-arg', 'PACKAGE=assetlibrary-api', '--build-arg', 'BINARY=assetlibrary-api'),
        @('-f', $webPath)
    )
    foreach ($check in $checks) {
        & docker buildx build @common @check $root
        if ($LASTEXITCODE -ne 0) { throw 'Dockerfile build check failed.' }
    }
}

Write-Output 'Container build policy contract passed.'
