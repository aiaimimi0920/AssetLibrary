param([Parameter(Mandatory = $true)][string] $EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\','/')
if (-not $root.StartsWith('C:\Users\Public\nas_home\AI\GameEditor\linshi\',[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path $root)) { throw 'Expected new linshi evidence directory' }
[void][IO.Directory]::CreateDirectory($root)
. "$PSScriptRoot/TestNetwork.ps1"
$first = 'al-art-20261004000000-aaaaaa'
$second = 'al-art-20261004000001-bbbbbb'
$script:Calls = @()
function Invoke-RunDocker([string[]] $DockerArguments, [switch] $AllowFailure) {
    $script:Calls += ($DockerArguments -join ' ')
    $code = 0; $value = ''
    if ($DockerArguments[0] -eq 'network' -and $DockerArguments[1] -eq 'create') {
        $code = $script:CreateCode; $value = $script:CreateError
    } elseif ($DockerArguments[0] -eq 'network' -and $DockerArguments[1] -eq 'ls') {
        $value = "foreign-network`n$first`n$second"
    } elseif ($DockerArguments[0] -eq 'network' -and $DockerArguments[1] -eq 'inspect') {
        $name = $DockerArguments[2]
        $label = if ($name -eq $first -and $script:ForeignLabel) { 'foreign-owner' } else { $name }
        $value = @(@{ Name = $name; Labels = @{ 'assetlibrary.test.run' = $label }
            Containers = @{ ($name + '-container') = @{ Name = $name + '-pg' } } }) | ConvertTo-Json -Depth 6 -Compress
    } elseif ($DockerArguments[0] -eq 'inspect') {
        $name = $DockerArguments[3].Replace('-container','')
        $running = $name -eq $first -or $script:AllRunning
        $label = if ($script:ForeignContainer) { 'foreign-owner' } else { $name }
        $value = if ($DockerArguments[2] -eq '{{json .State.Running}}') { $running.ToString().ToLowerInvariant() }
            elseif ($DockerArguments[2] -eq '{{json .Config.Labels}}') { @{ 'assetlibrary.test.run' = $label } | ConvertTo-Json -Compress }
            else { throw 'Expected metadata-only container inspect' }
    } else { throw 'Unexpected Docker command in read-only mock' }
    [pscustomobject]@{ Code = $code; Text = $value }
}
function Reset-Case {
    $script:Run = @{ Id = 'current-run' }; $script:Calls = @()
    $script:CreateCode = 1; $script:CreateError = 'all predefined address pools have been fully subnetted'
    $script:AllRunning = $false; $script:ForeignLabel = $false; $script:ForeignContainer = $false
}
Reset-Case
$script:CreateCode = 0
Initialize-RunTestNetwork
if ($Run.Network -ne $Run.Id -or $Run.NetworkReused -or $Calls.Count -ne 1) { throw 'Fresh network selection failed' }
Reset-Case
Initialize-RunTestNetwork
if ($Run.Network -ne $second -or -not $Run.NetworkReused) { throw 'Running network was not excluded' }
Reset-Case
$script:ForeignLabel = $true
Initialize-RunTestNetwork
if ($Run.Network -ne $second -or $Calls -contains "inspect $first-container") { throw 'Foreign network ownership was accepted' }
foreach ($case in @('unrelated-error','all-running','foreign-container')) {
    Reset-Case
    if ($case -eq 'unrelated-error') { $script:CreateError = 'daemon unavailable' }
    if ($case -eq 'all-running') { $script:AllRunning = $true }
    if ($case -eq 'foreign-container') { $script:ForeignContainer = $true }
    $failed = $false
    try { Initialize-RunTestNetwork } catch { $failed = $true }
    if (-not $failed -or $Run.Network) { throw "Unsafe fallback was accepted: $case" }
    if ($case -eq 'unrelated-error' -and $Calls.Count -ne 1) { throw 'Unrelated error triggered fallback' }
}
if ($Calls | Where-Object { $_ -match '(^| )(stop|rm|prune|disconnect|connect)( |$)' }) { throw 'Network selection performed destructive operations' }
$receipt = @{ passed = $true; cases = 6; real_docker_called = $false; running_and_foreign_resources_rejected = $true }
[IO.File]::WriteAllText("$root/network-selection.json",($receipt | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output 'Test network selection contracts passed'
