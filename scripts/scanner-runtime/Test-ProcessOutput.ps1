param([Parameter(Mandatory = $true)][string] $EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\','/')
if (-not $root.StartsWith('C:\Users\Public\nas_home\AI\GameEditor\linshi\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be under linshi' }
if (Test-Path -LiteralPath $root) { throw 'Refusing an existing evidence directory' }
foreach ($directory in @('logs','tmp')) { [void][IO.Directory]::CreateDirectory("$root/$directory") }
$script:Run = @{ Root = $root; Id = 'pipe-fixture'; Utf8 = [Text.UTF8Encoding]::new($false)
    Secrets = @(); Workers = [Collections.Generic.List[object]]::new(); Containers = @() }
. "$PSScriptRoot/Environment.ps1"
$maximum = 0; $io = 0; $minimum = 0; $minimumIo = 0
[Threading.ThreadPool]::GetMaxThreads([ref]$maximum,[ref]$io)
[Threading.ThreadPool]::GetMinThreads([ref]$minimum,[ref]$minimumIo)
if ($minimum -gt 32) { throw 'Thread-pool fixture requires at most 32 minimum workers' }
$binary = "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe"
try {
    # Bound only this test process. The former pool-based readers exhausted this
    # capacity and left both completed-process output tasks waiting indefinitely.
    if (-not [Threading.ThreadPool]::SetMaxThreads($minimum,$io)) { throw 'Cannot bound fixture thread pool' }
    for ($index = 0; $index -lt [Math]::Ceiling($minimum / 2); $index++) {
        Start-RunWorker "sleeper-$index" $binary @{} @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') | Out-Null
    }
    $output = Invoke-RunTool 'short-probe' $binary @('-NoProfile','-NonInteractive','-Command',
        '[Console]::Out.Write("probe-output"); [Console]::Error.Write("probe-error")') 5
    if ($output -ne 'probe-output') { throw 'Short-probe stdout mismatch' }
    if ([IO.File]::ReadAllText("$root/logs/short-probe.stderr.log") -ne 'probe-error') { throw 'Short-probe stderr mismatch' }
    Write-RunJson 'process-output.json' @{ passed = $true; thread_pool_capacity = $minimum
        long_lived_workers = $Run.Workers.Count - 1; both_streams_drained = $true; real_docker_called = $false }
} finally {
    [void][Threading.ThreadPool]::SetMaxThreads($maximum,$io)
    Stop-RunEnvironment
}
if (@($Run.Workers | Where-Object { -not $_.Stopped }).Count) { throw 'Owned output fixture leaked a process' }
Write-Output "Process output regression passed: $root"
