# Preserve Docker CLI's displayed metric name and raw precision. This is not RSS.
function Convert-ArtDockerBytes([string] $Value) {
    if ($Value -notmatch '^(\d{1,18}(?:\.\d{1,6})?)(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$') { throw 'Invalid Docker memory display' }
    $number = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
    $units = @{ B = 1; kB = 1000; MB = 1000000; GB = 1000000000; TB = 1000000000000
        KiB = 1024; MiB = 1048576; GiB = 1073741824; TiB = 1099511627776 }
    $bytes = $number * $units[$Matches[2]]
    if ($bytes -gt [long]::MaxValue) { throw 'Docker memory display overflow' }
    [long][Math]::Floor($bytes)
}

function Convert-ArtContainerMetric($Value, $Container, [string] $Phase, [string] $Point) {
    if ($Value.Name -ne $Container.Name -or -not $Container.Id.StartsWith($Value.ID) -or $Value.ID.Length -lt 12) {
        throw 'Container resource identity mismatch'
    }
    $memory = $Value.MemUsage -split '\s*/\s*'
    if ($memory.Count -ne 2 -or $Value.CPUPerc -notmatch '^\d{1,5}(?:\.\d{1,4})?%$') { throw 'Invalid Docker resource display' }
    $usage = Convert-ArtDockerBytes $memory[0]
    $limit = Convert-ArtDockerBytes $memory[1]
    if ($usage -le 0 -or $limit -le 0) { throw 'Missing running-container memory observation' }
    @{ phase = $Phase; point = $Point; collector_received_utc = [DateTime]::UtcNow.ToString('o')
        role = $Container.Role; container_id = $Container.Id; image_id = $Container.Image
        source = 'docker stats CLI'; raw_memory_display = $Value.MemUsage
        parsed_display_memory_bytes = $usage; parsed_display_limit_bytes = $limit
        cpu_percent = [double]::Parse($Value.CPUPerc.TrimEnd('%'), [Globalization.CultureInfo]::InvariantCulture)
        raw_cpu_display = $Value.CPUPerc; pids_display = $Value.PIDs }
}

function Save-ArtContainerObservation([string] $Phase, [string] $Point) {
    $started = [DateTime]::UtcNow.ToString('o')
    $result = Invoke-RunDocker (@('stats','--no-stream','--format','{{json .}}') + @($Run.Containers | ForEach-Object Id))
    $ended = [DateTime]::UtcNow.ToString('o')
    $rows = @($result.Text -split '\r?\n' | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    if ($rows.Count -ne $Run.Containers.Count) { throw 'Missing candidate container resource observation' }
    foreach ($container in $Run.Containers) {
        $row = @($rows | Where-Object Name -eq $container.Name)
        if ($row.Count -ne 1) { throw 'Duplicate or missing container resource identity' }
        $metric = Convert-ArtContainerMetric $row[0] $container $Phase $Point
        $metric.collection_start_utc = $started; $metric.collection_end_utc = $ended
        $Run.Resources.Containers.Add($metric)
    }
}
