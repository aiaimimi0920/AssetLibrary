param([string] $JsonOutput)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extensions = @('.rs', '.ts', '.tsx', '.js', '.mjs', '.css', '.cs', '.ps1', '.tf', '.yaml', '.yml')
$ignoredDirectories = @('node_modules', 'target', '.next', '.terraform', 'coverage', 'dist', '.git')
$sourceRoots = @('apps', 'crates', 'services', 'workers', 'packages', 'scripts', 'deploy', '.github')
$violations = @()
$files = @()

function Test-Directory([string] $path) {
    $directoryInfo = Get-Item -LiteralPath $path -Force
    if ($directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Source directory is a symbolic link or junction: $path"
    }
    foreach ($file in [IO.Directory]::EnumerateFiles($path)) {
        $info = [IO.FileInfo] $file
        if ($extensions -notcontains $info.Extension -or $info.Name -match '(^|-)lock\.(yaml|yml)$') {
            continue
        }
        if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Source file is a symbolic link: $file"
        }
        $content = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($file))
        $effective = @($content.TrimStart([char]0xfeff) -split "\r?\n" |
            Where-Object { $_.Trim() -ne '' -and $_.Trim() -notmatch '^(//|#|/\*|\*|\*/)' }).Count
        $relative = $file.Substring($root.Length + 1).Replace('\', '/')
        $script:files += [ordered]@{ path = $relative; effective = $effective }
        if ($effective -gt 700) {
            $script:violations += ('{0}: {1} effective lines (hard limit 700)' -f $relative, $effective)
        }
    }
    foreach ($directory in [IO.Directory]::EnumerateDirectories($path)) {
        if ($ignoredDirectories -contains [IO.Path]::GetFileName($directory)) { continue }
        Test-Directory $directory
    }
}

try {
    if ($JsonOutput -and (Test-Path -LiteralPath $JsonOutput)) { throw "Refusing stale report: $JsonOutput" }
    foreach ($relativeRoot in $sourceRoots) {
        $path = Join-Path $root $relativeRoot
        if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Missing source root: $relativeRoot" }
        $before = $files.Count
        Test-Directory $path
        if ($files.Count -eq $before) { throw "No sources scanned in root: $relativeRoot" }
    }
    if ($JsonOutput) {
        $report = [ordered]@{
            schemaVersion = 1; threshold = 700; roots = $sourceRoots
            scanned = $files.Count; files = $files; violations = $violations
        }
        $outputPath = [IO.Path]::GetFullPath($JsonOutput)
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
        [IO.File]::WriteAllText($outputPath, ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    }
    if ($violations.Count -gt 0) {
        $violations | ForEach-Object { Write-Output $_ }
        exit 1
    }
    Write-Output 'Source size contract passed.'
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}
