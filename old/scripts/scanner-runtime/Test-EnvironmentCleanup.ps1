param([Parameter(Mandatory = $true)][string] $EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\','/')
if (-not $root.StartsWith('C:\Users\Public\nas_home\AI\GameEditor\linshi\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be under linshi' }
if (Test-Path -LiteralPath $root) { throw 'Refusing an existing evidence directory' }
[void][IO.Directory]::CreateDirectory($root)
foreach ($directory in @('logs','tmp')) { [void][IO.Directory]::CreateDirectory("$root/$directory") }
$script:Run = @{ Root = $root; Id = 'cleanup-fixture'; Utf8 = [Text.UTF8Encoding]::new($false)
    Secrets = @(); Workers = [Collections.Generic.List[object]]::new(); Containers = @([pscustomobject]@{ Id = 'owned-fixture' }) }
. "$PSScriptRoot/Environment.ps1"
# In-memory Docker fault injection only; never contact or stop a real container.
$script:calls = [Collections.Generic.List[string]]::new()
$script:wrongOwner = $false
function Invoke-RunDocker([string[]] $DockerArguments, [switch] $AllowFailure) {
    $calls.Add($DockerArguments[0])
    switch ($DockerArguments[0]) {
        'inspect' {
            if ($DockerArguments[2] -eq '{{.State.Running}}') { return @{ Text = 'false'; Code = 0 } }
            return @{ Text = $(if ($wrongOwner) { 'another-run' } else { $Run.Id }); Code = 0 }
        }
        'logs' { throw 'Injected logs timeout' }
        'stop' { return @{ Text = ''; Code = 0 } }
        default { throw 'Unexpected fake Docker call' }
    }
}
$caught = $false
try { Stop-RunEnvironment } catch { $caught = $_.Exception.Message -eq 'Scoped cleanup failed; see cleanup.json' }
if (-not $caught -or @($calls | Where-Object { $_ -eq 'stop' }).Count -ne 1) {
    throw 'Diagnostic failure skipped owned-container stop or hid cleanup error'
}
$report = [IO.File]::ReadAllText("$root/cleanup.json") | ConvertFrom-Json
if ($report.passed -or $report.errors -notcontains 'Injected logs timeout') { throw 'Diagnostic error was not retained' }
Write-RunJson 'diagnostic-failure-cleanup.json' $report
$calls.Clear(); $wrongOwner = $true; $caught = $false
try { Stop-RunEnvironment } catch { $caught = $_.Exception.Message -eq 'Scoped cleanup failed; see cleanup.json' }
if (-not $caught -or $calls -contains 'stop' -or $calls -contains 'logs') { throw 'Ownership mismatch permitted side effects' }
$caught = $false
try {
    Invoke-RunTool 'timeout-tool' "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" `
        @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') 1 | Out-Null
} catch { $caught = $_.Exception.Message -eq 'Run tool exceeded deadline: timeout-tool' }
if (-not $caught -or $Run.Workers.Count -ne 1 -or -not $Run.Workers[0].Stopped) { throw 'Timed-out owned tool was not stopped' }
Write-RunJson 'cleanup-regression.json' @{ passed = $true; diagnostic_failure_still_stops_owned = $true
    ownership_mismatch_prevents_side_effects = $true; timed_out_owned_tool_stopped = $true; real_docker_called = $false }
Write-Output "Environment cleanup regression passed: $root"
