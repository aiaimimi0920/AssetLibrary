$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$productionRoots = @('apps', 'crates', 'services', 'workers', 'deploy')
$ignoredDirectories = @('node_modules', 'target', '.next', '.terraform', 'coverage', 'dist', '.git')
$sourceExtensions = @('.rs', '.ts', '.tsx', '.js', '.mjs', '.yaml', '.yml', '.tf')
$forbidden = @(
    @{ Pattern = 'rusqlite|sqlx.+sqlite|sqlite:'; Reason = 'SQLite is not a production data store.' },
    @{ Pattern = '\bPGMQ\b|pgmq'; Reason = 'NATS JetStream is the durable event transport.' },
    @{ Pattern = 'proxy_artifact_bytes|stream_artifact_bytes'; Reason = 'The API must not proxy artifact bytes.' }
)
$sourceFiles = [Collections.Generic.List[string]]::new()
$violations = @()

function Add-SourceFiles([string] $path) {
    foreach ($file in [IO.Directory]::EnumerateFiles($path)) {
        $info = [IO.FileInfo] $file
        if ($sourceExtensions -contains $info.Extension -or $info.Name -eq 'Dockerfile') {
            $sourceFiles.Add($file)
        }
    }
    foreach ($directory in [IO.Directory]::EnumerateDirectories($path)) {
        if ($ignoredDirectories -contains [IO.Path]::GetFileName($directory)) { continue }
        Add-SourceFiles $directory
    }
}

foreach ($relativeRoot in $productionRoots) {
    $path = Join-Path $root $relativeRoot
    if (Test-Path -LiteralPath $path -PathType Container) { Add-SourceFiles $path }
}

foreach ($rule in $forbidden) {
    foreach ($match in Select-String -LiteralPath $sourceFiles -Pattern $rule.Pattern) {
        $violations += "$($match.Path):$($match.LineNumber): $($rule.Reason)"
    }
}

if ($violations.Count -gt 0) {
    $violations | ForEach-Object { Write-Error $_ }
    exit 1
}
Write-Output 'Forbidden implementation check passed.'
