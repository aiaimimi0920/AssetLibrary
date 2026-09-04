$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extensions = @('.rs', '.ts', '.tsx', '.js', '.mjs', '.css', '.ps1', '.tf', '.yaml', '.yml')
$ignoredDirectories = @('node_modules', 'target', '.next', '.terraform', 'coverage', 'dist', '.git')
$sourceRoots = @('apps', 'crates', 'services', 'workers', 'packages', 'scripts', 'deploy', '.github')
$violations = @()

function Test-Directory([string] $path) {
    foreach ($file in [IO.Directory]::EnumerateFiles($path)) {
        $info = [IO.FileInfo] $file
        if ($extensions -notcontains $info.Extension -or $info.Name -match '(^|-)lock\.(yaml|yml)$') {
            continue
        }
        $effective = ([IO.File]::ReadLines($file) |
            Where-Object { $_.Trim() -ne '' -and $_.Trim() -notmatch '^(//|#|/\*|\*|\*/)' }).Count
        if ($effective -gt 700) {
            $script:violations += "$file`: $effective effective lines (hard limit 700)"
        }
    }

    foreach ($directory in [IO.Directory]::EnumerateDirectories($path)) {
        if ($ignoredDirectories -contains [IO.Path]::GetFileName($directory)) { continue }
        Test-Directory $directory
    }
}

foreach ($relativeRoot in $sourceRoots) {
    $path = Join-Path $root $relativeRoot
    if (Test-Path -LiteralPath $path -PathType Container) { Test-Directory $path }
}

if ($violations.Count -gt 0) {
    $violations | ForEach-Object { Write-Error $_ }
    exit 1
}
Write-Output 'Source size contract passed.'
