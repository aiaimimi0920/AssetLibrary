param(
    [Parameter(Mandatory = $true)][string] $EvidenceDirectory,
    [ValidateRange(1,5)][int] $Repetitions = 3,
    [string] $ScannerBinary,
    [string] $FixtureBinary
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$root = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\','/')
if (-not $root.StartsWith('C:\Users\Public\nas_home\AI\GameEditor\linshi\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be under linshi' }
if (Test-Path -LiteralPath $root) { throw 'Refusing an existing evidence directory' }
if (-not $ScannerBinary) { $ScannerBinary = "$repo/target/release/assetlibrary-scanner-worker.exe" }
if (-not $FixtureBinary) { $FixtureBinary = "$repo/target/release/examples/build_resource_fixtures.exe" }
$ScannerBinary = (Resolve-Path -LiteralPath $ScannerBinary).Path
$FixtureBinary = (Resolve-Path -LiteralPath $FixtureBinary).Path
[void][IO.Directory]::CreateDirectory($root)
$utf8 = [Text.UTF8Encoding]::new($false)
$oldTemp = $env:TEMP; $oldTmp = $env:TMP
$env:TEMP = $root; $env:TMP = $root
$samples = [Collections.Generic.List[object]]::new()
$report = [ordered]@{
    status = 'running'; measured_at_utc = [DateTime]::UtcNow.ToString('o')
    scope = 'Windows local inspection child only; no parent worker, ClamAV, API or service-stack resource claim'
    concurrency = 1; repetitions = $Repetitions; cpu_clock_resolution_note = 'Windows process CPU time may be quantized'
    metric = 'Windows GetProcessMemoryInfo.PeakWorkingSetSize on retained handle after process exit; not Linux RSS or private bytes'
    binaries = @($ScannerBinary,$FixtureBinary) | ForEach-Object { @{ path = $_; sha256 = (Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant() } }
    production_ready = $false
}
try {
    . "$PSScriptRoot/scanner-runtime/ResourceMetrics.ps1"
    & rtk proxy $FixtureBinary "$root/fixtures"
    if ($LASTEXITCODE -ne 0) { throw 'Resource fixture generation failed' }
    $fixtures = [IO.File]::ReadAllText("$root/fixtures/fixtures.json") | ConvertFrom-Json
    foreach ($fixture in $fixtures.profiles) {
        for ($iteration = 1; $iteration -le $Repetitions; $iteration++) {
            $directory = "$root/$($fixture.name)-$iteration"
            [void][IO.Directory]::CreateDirectory($directory)
            Copy-Item -LiteralPath "$root/fixtures/$($fixture.name).zip" -Destination "$directory/artifact.zip"
            if ((Get-FileHash -LiteralPath "$directory/artifact.zip").Hash.ToLowerInvariant() -ne $fixture.digest) { throw 'Fixture hash mismatch' }
            $request = @{ kind = 'art'; publisher_slug = 'neuro-fixture-publisher'; package_slug = 'neuro-starter-art'
                version = '1.0.0-dev'; permissions = @(); size_bytes = $fixture.size_bytes; expected_digest = 'sha256:' + $fixture.digest }
            [IO.File]::WriteAllText("$directory/inspection-request.json", ($request | ConvertTo-Json), $utf8)
            $metrics = Invoke-MeasuredInspector $ScannerBinary $directory
            $result = [IO.File]::ReadAllText("$directory/inspection-result.json") | ConvertFrom-Json
            $actual = if ($null -ne $result.Ok) { 'ok' } else { [string]$result.Err }
            if ($actual -ne $fixture.expected) { throw "Unexpected $($fixture.name) result: $actual" }
            if ($actual -eq 'ok') {
                $raw = -join @($result.Ok.raw_sha256 | ForEach-Object { ([int]$_).ToString('x2') })
                $canonical = -join @($result.Ok.canonical_sha256 | ForEach-Object { ([int]$_).ToString('x2') })
                if ($raw -ne $fixture.digest -or $canonical -ne $fixture.canonical_digest) { throw 'Inspection digest mismatch' }
            }
            $samples.Add(@{ profile = $fixture.name; iteration = $iteration; result = $actual; metrics = $metrics
                workspace_final_file_bytes = (Get-ChildItem -LiteralPath $directory -File | Measure-Object Length -Sum).Sum })
        }
    }
    $report.fixtures = $fixtures; $report.status = 'passed'
    $report.summary = @($fixtures.profiles | ForEach-Object {
        $name = $_.name; $group = @($samples | Where-Object { $_.profile -eq $name })
        @{ profile = $name; samples = $group.Count
            peak_working_set_bytes_max = ($group.metrics.peak_working_set_bytes | Measure-Object -Maximum).Maximum
            elapsed_ms_min = ($group.metrics.elapsed_ms | Measure-Object -Minimum).Minimum
            elapsed_ms_max = ($group.metrics.elapsed_ms | Measure-Object -Maximum).Maximum
            cpu_ms_min = ($group.metrics.cpu_ms | Measure-Object -Minimum).Minimum
            cpu_ms_max = ($group.metrics.cpu_ms | Measure-Object -Maximum).Maximum }
    })
} catch {
    $report.status = 'failed'; $report.error = $_.Exception.Message
    throw
} finally {
    $report.samples = @($samples)
    [IO.File]::WriteAllText("$root/resource-result.json", ($report | ConvertTo-Json -Depth 12), $utf8)
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp
}
Write-Output "Scanner inspection measurements passed: $root"
