# Own only this run's containers and native workers; never load the repository .env.
. "$PSScriptRoot/ProcessOutput.ps1"
function Write-RunJson([string] $Name, $Value) {
    [IO.File]::WriteAllText((Join-Path $Run.Root $Name), ($Value | ConvertTo-Json -Depth 12), $Run.Utf8)
}

function ConvertTo-RunArgument([string] $Value) {
    # ProcessStartInfo on Windows PowerShell has no ArgumentList property.
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-RunDocker([string[]] $DockerArguments, [switch] $AllowFailure) {
    # Record only operation metadata, never arguments (SQL/env may contain secrets).
    $Run.DockerCounter++
    $log = "$($Run.Root)/logs/docker-$($Run.DockerCounter)"
    $record = [ordered]@{ operation = $DockerArguments[0]; status = 'starting'; exit_code = $null
        stdout_completed = $false; stderr_completed = $false }
    [IO.File]::WriteAllText("$log.json", ($record | ConvertTo-Json), $Run.Utf8)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command rtk -CommandType Application).Source
    $start.Arguments = (@(@('proxy', 'docker') + $DockerArguments | ForEach-Object { ConvertTo-RunArgument $_ }) -join ' ')
    $start.WorkingDirectory = $Run.Root
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = [AssetLibraryRunOutput]::Read($process.StandardOutput)
        $stderr = [AssetLibraryRunOutput]::Read($process.StandardError)
        if (-not $process.WaitForExit(45000)) {
            $docker = (Get-Command docker -CommandType Application).Source
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" | Where-Object {
                $_.ExecutablePath -eq $docker
            } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            if (-not $process.HasExited) { $process.Kill() }
            [void]$process.WaitForExit(5000)
            throw "Docker $($DockerArguments[0]) exceeded 45 seconds"
        }
        $record.exit_code = $process.ExitCode
        $record.stdout_completed = $stdout.Wait(5000)
        $record.stderr_completed = $stderr.Wait(5000)
        if (-not $record.stdout_completed -or -not $record.stderr_completed) {
            throw "Docker $($record.operation) output did not close; exit=$($record.exit_code); stdout=$($record.stdout_completed); stderr=$($record.stderr_completed)"
        }
        $code = $process.ExitCode
        $text = $stdout.Result + $stderr.Result
        $record.status = 'completed'
    } catch { $record.status = 'failed'; throw }
    finally {
        [IO.File]::WriteAllText("$log.json", ($record | ConvertTo-Json), $Run.Utf8)
        $process.Dispose()
    }
    foreach ($secret in $Run.Secrets) { $text = $text.Replace($secret, '[REDACTED]') }
    [IO.File]::WriteAllText("$log.log", $text, $Run.Utf8)
    if ($code -ne 0 -and -not $AllowFailure) { throw "Docker $($DockerArguments[0]) failed: exit=$code; see run logs" }
    [pscustomobject]@{ Code = $code; Text = $text.Trim() }
}

function Wait-RunCondition([string] $Label, [scriptblock] $Condition, [int] $Seconds = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out: $Label"
}

function New-RunSecret {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    -join @($bytes | ForEach-Object { $_.ToString('x2') })
}

function Start-RunContainer([string] $Role, [string] $Image, [string[]] $ExtraArguments) {
    $name = "$($Run.Id)-$Role"
    $exists = Invoke-RunDocker @('inspect', $name) -AllowFailure
    if ($exists.Code -eq 0) { throw 'Refusing to replace an existing container' }
    $network = if ($Run.Network) { $Run.Network } else { $Run.Id }
    $arguments = @('run', '-d', '--pull=never', '--name', $name,
        '--label', "assetlibrary.test.run=$($Run.Id)", '--network', $network, '--cpus=1')
    # Register the unique name before starting: a timed-out client may still have
    # created the daemon-side container. Cleanup must check its ownership label.
    $container = [pscustomobject]@{ Role = $Role; Name = $name; Id = $name; Image = $Image }
    $Run.Containers.Add($container)
    $result = Invoke-RunDocker ($arguments + $ExtraArguments + @($Image) + $Run.Commands[$Role])
    if ($result.Text -notmatch '^[0-9a-f]{64}$') { throw 'Container identity is invalid' }
    $container.Id = $result.Text
    $result.Text
}

function Get-RunPort([string] $Container, [int] $Port) {
    $result = Invoke-RunDocker @('port', $Container, "$Port/tcp")
    if ($result.Text -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Unexpected published port binding' }
    [int]$Matches[1]
}

function Start-RunWorker([string] $Label, [string] $Binary, [hashtable] $Settings, [string[]] $Arguments = @()) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Binary
    $start.Arguments = (@($Arguments | ForEach-Object { ConvertTo-RunArgument $_ }) -join ' ')
    $start.WorkingDirectory = $Run.Root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Clear()
    $start.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
    $start.EnvironmentVariables['TEMP'] = "$($Run.Root)/tmp"
    $start.EnvironmentVariables['TMP'] = "$($Run.Root)/tmp"
    foreach ($key in $Settings.Keys) { $start.EnvironmentVariables[$key] = $Settings[$key] }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $worker = [pscustomobject]@{
        Label = $Label; Process = $process; Binary = $Binary
        Stdout = [AssetLibraryRunOutput]::Read($process.StandardOutput)
        Stderr = [AssetLibraryRunOutput]::Read($process.StandardError)
        Stopped = $false
    }
    $Run.Workers.Add($worker)
    $worker
}

function Stop-RunWorker($Worker) {
    if ($Worker.Stopped) { return }
    $process = $Worker.Process
    if (-not $process.HasExited) {
        # Failed tests may interrupt a scan: terminate only children of our owned
        # process whose executable is the same scanner binary, never by image name.
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" | Where-Object {
            $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($Worker.Binary)
        } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        if (-not $process.HasExited) { $process.Kill() }
    }
    if (-not $process.WaitForExit(10000)) { throw 'Owned worker did not exit' }
    foreach ($stream in @('Stdout', 'Stderr')) {
        if (-not $Worker.$stream.Wait(5000)) { throw 'Owned worker output did not close' }
        $text = $Worker.$stream.GetAwaiter().GetResult()
        foreach ($secret in $Run.Secrets) { $text = $text.Replace($secret, '[REDACTED]') }
        [IO.File]::WriteAllText("$($Run.Root)/logs/$($Worker.Label).$($stream.ToLowerInvariant()).log", $text, $Run.Utf8)
    }
    $process.Dispose()
    $Worker.Stopped = $true
}

function Invoke-RunTool([string] $Label, [string] $Binary, [string[]] $Arguments, [int] $Seconds = 60) {
    $worker = Start-RunWorker $Label $Binary @{} $Arguments
    try {
        if (-not $worker.Process.WaitForExit($Seconds * 1000)) { throw "Run tool exceeded deadline: $Label" }
        $code = $worker.Process.ExitCode
        if (-not $worker.Stdout.Wait(5000)) { throw "Run tool output did not close: $Label" }
        $output = $worker.Stdout.GetAwaiter().GetResult()
        if ($code -ne 0) { throw "Run tool failed: $Label; exit=$code; see run logs" }
        $output
    } finally { Stop-RunWorker $worker }
}

function Stop-RunEnvironment {
    $errors = @()
    foreach ($worker in $Run.Workers) {
        try { Stop-RunWorker $worker } catch { $errors += $_.Exception.Message }
    }
    foreach ($container in $Run.Containers) {
        try {
            $label = Invoke-RunDocker @('inspect', '--format', '{{index .Config.Labels "assetlibrary.test.run"}}', $container.Id)
            if ($label.Text -ne $Run.Id) { throw 'Container ownership label changed' }
            # Once ownership is confirmed, diagnostic failure must not skip stop.
            try { Invoke-RunDocker @('logs', '--tail', '200', $container.Id) | Out-Null }
            catch { $errors += $_.Exception.Message }
            Invoke-RunDocker @('stop', '--time', '5', $container.Id) | Out-Null
            $state = Invoke-RunDocker @('inspect', '--format', '{{.State.Running}}', $container.Id)
            if ($state.Text -ne 'false') { throw 'Owned container is still running' }
        } catch { $errors += $_.Exception.Message }
    }
    Write-RunJson 'cleanup.json' ([ordered]@{
        passed = $errors.Count -eq 0; errors = $errors; containers = @($Run.Containers)
        policy = 'Only owned workers and containers stopped; test data, containers and network retained. No prune or volume removal.'
    })
    if ($errors.Count -gt 0) { throw 'Scoped cleanup failed; see cleanup.json' }
}
