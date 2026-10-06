param(
    [Parameter(Mandatory = $true)][string] $ReleaseId,
    [Parameter(Mandatory = $true)][string] $EvidenceDirectory,
    [Parameter(Mandatory = $true)][string] $ImageArchive
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($ReleaseId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]{0,79}$') { throw 'Invalid release ID' }
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repo '..\release\AssetLibrary'))
$destination = Join-Path $releaseRoot $ReleaseId
if (Test-Path -LiteralPath $destination) { throw 'Release destination already exists' }
$evidence = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
$image = (Resolve-Path -LiteralPath $ImageArchive).Path
$requiredEvidence = @('verification.json', 'osv-final.json', 'edge-original.json', 'edge-new.json',
    'loom-verifier.json', 'object-migration.json', 'ACCEPTANCE.md')
foreach ($name in $requiredEvidence) {
    if (!(Test-Path -LiteralPath (Join-Path $evidence $name) -PathType Leaf)) {
        throw "Missing evidence: $name"
    }
}
$verification = Get-Content -LiteralPath (Join-Path $evidence 'verification.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($verification.status -ne 'passed') { throw 'Local validation has not passed' }
$binaries = @('assetlibrary-api', 'assetlibrary-publisher', 'assetlibrary-scanner-worker',
    'assetlibrary-outbox-worker', 'assetlibrary-indexer-worker', 'assetlibrary-cleanup-worker')
foreach ($name in $binaries) {
    if (!(Test-Path -LiteralPath "$repo\target\release\$name.exe")) { throw "Missing binary: $name" }
}
if (!(Test-Path -LiteralPath "$repo\apps\web\.next\standalone\server.js")) { throw 'Missing web build' }

function Copy-Tree([string] $source, [string] $target) {
    & rtk proxy robocopy $source $target /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copy failed: $source" }
}

New-Item -ItemType Directory -Path "$destination\bin", "$destination\images", "$destination\evidence" | Out-Null
foreach ($name in $binaries) {
    Copy-Item -LiteralPath "$repo\target\release\$name.exe" -Destination "$destination\bin"
}
Copy-Item -LiteralPath "$repo\target\release\examples\verify_download.exe" -Destination "$destination\bin"
Copy-Tree "$repo\apps\web\.next\standalone" "$destination\web"
Copy-Tree "$repo\apps\web\.next\static" "$destination\web\.next\static"
if (Test-Path -LiteralPath "$repo\apps\web\public") { Copy-Tree "$repo\apps\web\public" "$destination\web\public" }
Copy-Tree "$repo\services\edge\dist" "$destination\edge"
New-Item -ItemType Directory -Path "$destination\deployment\pc2" | Out-Null
Get-ChildItem -LiteralPath "$repo\deploy\pc2" -File |
    Where-Object { $_.Extension -in @('.md', '.yaml', '.toml', '.py') -or $_.Name -eq 'Dockerfile.rust-pc2' } |
    Copy-Item -Destination "$destination\deployment\pc2"
Copy-Tree "$repo\migrations" "$destination\migrations"
Copy-Item -LiteralPath $image -Destination "$destination\images\assetlibrary-pc2-services.tar"
foreach ($name in $requiredEvidence) { Copy-Item -LiteralPath (Join-Path $evidence $name) -Destination "$destination\evidence" }

$commit = (& rtk proxy git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify source commit' }
$sourcePaths = @(& rtk proxy git -C $repo ls-files --cached --others --exclude-standard) |
    Where-Object { $_ -notmatch '^\.memsearch/' } | Sort-Object -Unique
if ($LASTEXITCODE -ne 0) { throw 'Cannot inventory source' }
$sourceFiles = @($sourcePaths | ForEach-Object {
    $file = Join-Path $repo $_
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
})
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText("$destination\source-inventory.json", ($sourceFiles | ConvertTo-Json -Depth 5), $utf8)
$readme = @"
# AssetLibrary $ReleaseId

Locally built Windows services and Publisher CLI, Next.js standalone web,
PC2 Linux service image, Edge bundle, migrations, and redacted acceptance evidence.
The local web build was validated with Node.js 22.22.2. Configure its external API origin.

This is a dirty-source local validation build, not a signed production candidate.
App Update and production eligibility remain false. Read evidence/ACCEPTANCE.md
for the exact runtime scope, provider limitations, and preservation checks.
source-inventory.json identifies the exact source bytes beyond the base commit.
"@
[IO.File]::WriteAllText("$destination\README.md", $readme, $utf8)
$entries = @(Get-ChildItem -LiteralPath $destination -Recurse -File | Sort-Object FullName | ForEach-Object {
    [ordered]@{
        path = $_.FullName.Substring($destination.Length + 1).Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = $_.Length
    }
})
$manifest = [ordered]@{
    schema_version = '1.0'; product = 'AssetLibrary'; release_id = $ReleaseId
    bundle_kind = 'local-validated-build'; source_commit = $commit; source_dirty = $true
    built_at_utc = [DateTime]::UtcNow.ToString('o')
    production_eligibility = $false; app_updates_enabled = $false
    verification = $verification; files = $entries
}
[IO.File]::WriteAllText("$destination\release-manifest.json", ($manifest | ConvertTo-Json -Depth 12), $utf8)
[IO.File]::WriteAllLines("$destination\SHA256SUMS", @($entries | ForEach-Object { "$($_.sha256)  $($_.path)" }), $utf8)
foreach ($entry in $entries) {
    $file = Join-Path $destination $entry.path
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        throw "Packaged digest mismatch: $($entry.path)"
    }
}
Write-Output "Local validation package verified: $destination ($($entries.Count) files)"
