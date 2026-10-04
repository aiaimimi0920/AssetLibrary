param(
    [Parameter(Mandatory = $true)][string] $EvidenceDirectory,
    [string] $ScannerBinary,
    [string] $FixtureBinary
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$root = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\','/')
if (-not $root.StartsWith('C:\Users\Public\nas_home\AI\GameEditor\linshi\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be under linshi' }
if (Test-Path -LiteralPath $root) { throw 'Refusing an existing evidence directory' }
if (-not $ScannerBinary) { $ScannerBinary = "$repo/target/release/assetlibrary-scanner-worker.exe" }
if (-not $FixtureBinary) { $FixtureBinary = "$repo/target/release/examples/build_signed_fixture.exe" }
$ScannerBinary = (Resolve-Path -LiteralPath $ScannerBinary).Path
$FixtureBinary = (Resolve-Path -LiteralPath $FixtureBinary).Path
[void][IO.Directory]::CreateDirectory($root)
$utf8 = [Text.UTF8Encoding]::new($false)
$oldTemp = $env:TEMP; $oldTmp = $env:TMP
$env:TEMP = $root; $env:TMP = $root
try {
    # Harmless synthetic child: sleep beyond the real deadline, or make the
    # final report read-only to inject a deterministic report-write failure.
    $code = @'
using System.IO;
using System.Threading;
public static class ResourceFailureFixture {
    public static void Main(string[] args) {
        if (args[0] == "--inspect-local") { Thread.Sleep(31000); return; }
        Directory.CreateDirectory(args[0]);
        File.WriteAllText(Path.Combine(args[0], "fixtures.json"), "{\"profiles\":[]}");
        string report = Path.Combine(Directory.GetParent(args[0]).FullName, "resource-result.json");
        File.WriteAllText(report, "report-write-failure-fixture");
        File.SetAttributes(report, FileAttributes.ReadOnly);
    }
}
'@
    $binary = "$root/resource-failure-fixture.exe"
    [IO.File]::WriteAllText("$root/ResourceFailureFixture.cs", $code, $utf8)
    Add-Type -TypeDefinition $code -OutputAssembly $binary -OutputType ConsoleApplication
    . "$PSScriptRoot/ResourceMetrics.ps1"
    $caught = $false
    try { Invoke-MeasuredInspector $binary $root | Out-Null }
    catch { $caught = $_.Exception.Message -match 'exceeded 30 seconds' }
    if (-not $caught) { throw 'Expected child timeout was not reported' }
    $owned = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $binary })
    if ($owned.Count) { throw 'Timed-out measurement child remains alive' }
    for ($i = 0; $i -lt 12; $i++) {
        try { Invoke-MeasuredInspector "$root/missing.exe" $root | Out-Null; throw 'Missing EXE accepted' }
        catch { if ($_.Exception.Message -eq 'Missing EXE accepted') { throw } }
    }
    $caught = $false
    try {
        & "$repo/scripts/Measure-ScannerInspection.ps1" -EvidenceDirectory "$root/report-write-failure" `
            -ScannerBinary $ScannerBinary -FixtureBinary $binary
    } catch { $caught = $_.Exception.Message -match 'denied|拒绝' }
    if (-not $caught) { throw 'Expected report write failure was not raised' }
    if ($env:TEMP -ne $root -or $env:TMP -ne $root) { throw 'Report failure did not restore TEMP/TMP' }
    # Exercise real inspection after both failures, without service credentials.
    $normal = "$root/normal-after-timeout"
    [void][IO.Directory]::CreateDirectory($normal)
    $lines = @(& rtk proxy $FixtureBinary "$normal/artifact.zip")
    if ($LASTEXITCODE -ne 0) { throw 'Signed fixture generation failed' }
    $fixture = ($lines -join "`n") | ConvertFrom-Json
    $request = @{ kind = 'art'; publisher_slug = 'neuro-fixture-publisher'; package_slug = 'neuro-starter-art'
        version = '1.0.0-dev'; permissions = @(); size_bytes = $fixture.size_bytes; expected_digest = 'sha256:' + $fixture.digest }
    [IO.File]::WriteAllText("$normal/inspection-request.json", ($request | ConvertTo-Json), $utf8)
    $metrics = Invoke-MeasuredInspector $ScannerBinary $normal
    $result = [IO.File]::ReadAllText("$normal/inspection-result.json") | ConvertFrom-Json
    $raw = -join @($result.Ok.raw_sha256 | ForEach-Object { ([int]$_).ToString('x2') })
    if (-not $result.Ok -or $raw -ne $fixture.digest) { throw 'Next normal inspection failed' }
    $report = @{ passed = $true; timeout_child_reaped = $true; missing_spawn_attempts = 12
        report_write_failure_restored_environment = $true; normal_after_failures = $true; metrics = $metrics }
    [IO.File]::WriteAllText("$root/cleanup-regression.json", ($report | ConvertTo-Json -Depth 6), $utf8)
    Write-Output "Resource cleanup regression passed: $root"
} finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp
}
