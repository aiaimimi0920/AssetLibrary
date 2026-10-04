. "$PSScriptRoot/ContainerMetrics.ps1"

function Import-ArtResourceTypes {
    if (-not ('ArtResourceSampler' -as [type])) {
        Add-Type -Path @("$PSScriptRoot/resource-sampler.cs", "$PSScriptRoot/query-load.cs") `
            -ReferencedAssemblies @('System.dll','System.Core.dll','System.Net.Http.dll')
    }
}

function Start-ArtResourceObservation {
    Import-ArtResourceTypes
    $workers = @($Run.Workers | Where-Object { -not $_.Stopped })
    $Run.Resources = @{ Native = $null; Containers = [Collections.Generic.List[object]]::new(); Queries = @(); Stopped = $false
        StartedUtc = [DateTime]::UtcNow.ToString('o') }
    $Run.Resources.Native = [ArtResourceSampler]::new(
        [string[]]@($workers | ForEach-Object Label), [int[]]@($workers | ForEach-Object { $_.Process.Id }),
        [string[]]@($workers | ForEach-Object Binary))
    $Run.Resources.Native.SetPhase('idle')
    Save-ArtContainerObservation 'idle' 'before'
    Start-Sleep -Seconds 3
    Save-ArtContainerObservation 'idle' 'after'
    $Run.Resources.Native.SetPhase('upload-and-scan')
    Save-ArtContainerObservation 'upload-and-scan' 'before'
}

function Complete-ArtScanObservation {
    Save-ArtContainerObservation 'upload-and-scan' 'after'
    $Run.Resources.Native.SetPhase('between-phases')
}

function Test-ArtTwoClientQueries {
    $Run.Resources.Native.SetPhase('two-client-query')
    Save-ArtContainerObservation 'two-client-query' 'before'
    $queries = [ArtQueryLoad]::Run($Run.ApiOrigin, 10)
    if ($queries.Requests.Count -ne 20 -or $queries.PeakClientInFlight -ne 2) { throw 'Two-client query load contract mismatch' }
    $overlap = $false
    foreach ($request in $queries.Requests) {
        $response = $request.Body | ConvertFrom-Json
        if ($response.items.Count -ne 1 -or $response.items[0].id -ne $Run.PackageId) { throw 'Concurrent PG query returned wrong package' }
        if (@($queries.Requests | Where-Object { $_.Client -ne $request.Client -and
            $_.StartTicks -lt $request.EndTicks -and $_.EndTicks -gt $request.StartTicks }).Count) { $overlap = $true }
        $Run.Resources.Queries += @{ client = $request.Client; status = $request.Status
            start_ticks = $request.StartTicks; end_ticks = $request.EndTicks
            elapsed_ms = 1000.0 * ($request.EndTicks - $request.StartTicks) / $queries.StopwatchFrequency
            response_items = 1; package_id = $Run.PackageId }
    }
    if (-not $overlap) { throw 'No overlapping client request windows observed' }
    $Run.Resources.StopwatchFrequency = $queries.StopwatchFrequency
    Save-ArtContainerObservation 'two-client-query' 'after'
    $Run.Resources.Native.SetPhase('between-phases')
}

function Stop-ArtResourceObservation([bool] $Passed) {
    if (-not $Run.Resources -or $Run.Resources.Stopped) { return }
    if (-not $Run.Resources.Native) { $Run.Resources.Stopped = $true; return }
    try {
        $samples = @($Run.Resources.Native.Snapshot())
        $summary = foreach ($group in $samples | Where-Object Phase -ne 'between-phases' | Group-Object Phase,Label) {
            $first = $group.Group[0]; $last = $group.Group[-1]
            @{ phase = $first.Phase; label = $first.Label; process_id = $first.ProcessId; samples = $group.Count
                sampled_max_working_set_bytes = ($group.Group | Measure-Object WorkingSetBytes -Maximum).Maximum
                sampled_max_private_bytes = ($group.Group | Measure-Object PrivateBytes -Maximum).Maximum
                os_lifetime_peak_working_set_bytes_at_last_sample = $last.LifetimePeakWorkingSetBytes
                cpu_delta_ms = $last.CpuTotalMilliseconds - $first.CpuTotalMilliseconds
                first_sample_utc = $first.TimestampUtc; last_sample_utc = $last.TimestampUtc }
        }
        $os = Get-CimInstance Win32_OperatingSystem -Property Caption,Version,BuildNumber
        $cpu = Get-CimInstance Win32_Processor -Property Name,NumberOfLogicalProcessors
        $report = @{ status = $(if ($Passed) { 'passed' } else { 'failed' })
            started_utc = $Run.Resources.StartedUtc; ended_utc = [DateTime]::UtcNow.ToString('o')
            environment = @{ os = $os.Caption; version = $os.Version; build = $os.BuildNumber
                cpu = @($cpu | Select-Object Name,NumberOfLogicalProcessors) }
            topology = @{ search_provider = 'postgres'; indexer_mode = 'edge-policy'; opensearch_valkey_used = $false
                owned_containers = @($Run.Containers); shared_clamav = $Run.ClamAvVersion }
            scope = @{ native_source = 'Windows Process counters'; nominal_native_sample_interval_ms = 100
                native_sample_bound = 30000; native_inspector_child_measured = $false; shared_clamav_resources_measured = $false
                docker_desktop_and_collector_measured = $false; combined_simultaneous_peak_measured = $false
                capacity_or_production_budget_proven = $false; disk_peak_measured = $false }
            native = @($summary); native_samples = $samples; container_snapshots = @($Run.Resources.Containers)
            query_requests = $Run.Resources.Queries; query_stopwatch_frequency = $Run.Resources.StopwatchFrequency
            scanner_temp_final_logical_bytes = [long](Get-ChildItem -LiteralPath "$($Run.Root)/scanner-temp" -Recurse -File |
                Measure-Object Length -Sum).Sum; artifact_id = $Run.Artifact.Id }
    } finally {
        try { $Run.Resources.Native.Dispose() } finally { $Run.Resources.Stopped = $true }
    }
    # A success receipt is written only after the sampler's thread has exited.
    Write-RunJson 'candidate-resources.json' $report
}
