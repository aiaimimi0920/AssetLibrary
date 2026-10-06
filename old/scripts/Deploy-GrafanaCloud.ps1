param(
    [switch]$ValidateOnly,
    [switch]$UpdateDashboard,
    [ValidateRange(5, 1440)]
    [int]$ReceiptLookbackMinutes = 60
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dashboardPath = Join-Path $root 'deploy/helm/assetlibrary/dashboards/assetlibrary-overview.json'
$folderUid = 'neuro-assetlibrary'
$dashboardUid = 'neuro-assetlibrary-overview'

function Get-HttpStatusCode([System.Management.Automation.ErrorRecord]$ErrorRecord) {
    if ($null -eq $ErrorRecord.Exception.Response) { return $null }
    return [int]$ErrorRecord.Exception.Response.StatusCode
}

function Invoke-GrafanaApi(
    [string]$Method,
    [string]$Path,
    [AllowNull()]$Body = $null,
    [int[]]$AllowedStatusCodes = @(200)
) {
    $parameters = @{
        Uri = "$script:stackUrl$Path"
        Method = $Method
        Headers = $script:headers
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 100 -Compress
    }
    try {
        return [pscustomobject]@{
            StatusCode = 200
            Body = Invoke-RestMethod @parameters
        }
    } catch {
        $statusCode = Get-HttpStatusCode $_
        if ($null -ne $statusCode -and $AllowedStatusCodes -contains $statusCode) {
            return [pscustomobject]@{ StatusCode = $statusCode; Body = $null }
        }
        throw
    }
}

function Test-PositiveMetricSample($Response) {
    foreach ($series in @($Response.data.result)) {
        foreach ($sample in @($series.values)) {
            if ($sample.Count -ge 2 -and [double]$sample[1] -gt 0) { return $true }
        }
    }
    return $false
}

if (-not (Test-Path -LiteralPath $dashboardPath -PathType Leaf)) {
    throw 'The repository dashboard JSON is missing.'
}
$dashboard = Get-Content -LiteralPath $dashboardPath -Raw | ConvertFrom-Json
if ($dashboard.uid -cne $dashboardUid -or $dashboard.title -cne 'Neuro AssetLibrary Overview') {
    throw 'The dashboard identity does not match the deployment contract.'
}
if (@($dashboard.panels).Count -lt 12) {
    throw 'The dashboard must contain at least 12 bounded signal panels.'
}
$datasourceVariable = @($dashboard.templating.list | Where-Object { $_.name -ceq 'datasource' })
if ($datasourceVariable.Count -ne 1 -or $datasourceVariable[0].type -cne 'datasource' -or
    $datasourceVariable[0].query -cne 'prometheus') {
    throw 'The dashboard must expose exactly one Prometheus datasource variable.'
}
if ($ValidateOnly) {
    Write-Output 'Grafana Cloud deployment contract passed (no network calls made).'
    exit 0
}

$script:stackUrl = [Environment]::GetEnvironmentVariable('GRAFANA_CLOUD_STACK_URL', 'Process')
$apiToken = [Environment]::GetEnvironmentVariable('GRAFANA_CLOUD_API_TOKEN', 'Process')
if ([string]::IsNullOrWhiteSpace($script:stackUrl) -or [string]::IsNullOrWhiteSpace($apiToken)) {
    throw 'GRAFANA_CLOUD_STACK_URL and GRAFANA_CLOUD_API_TOKEN are required.'
}
$script:stackUrl = $script:stackUrl.TrimEnd('/')
$parsedStackUrl = $null
if (-not [Uri]::TryCreate($script:stackUrl, [UriKind]::Absolute, [ref]$parsedStackUrl) -or
    $parsedStackUrl.Scheme -cne 'https' -or [string]::IsNullOrWhiteSpace($parsedStackUrl.Host) -or
    -not [string]::IsNullOrEmpty($parsedStackUrl.UserInfo) -or
    $parsedStackUrl.AbsolutePath -cne '/') {
    throw 'GRAFANA_CLOUD_STACK_URL must be an HTTPS origin without credentials or a path.'
}
$script:headers = @{
    Authorization = "Bearer $apiToken"
    Accept = 'application/json'
    'User-Agent' = 'AssetLibrary-Grafana-Deployment'
}

$null = Invoke-GrafanaApi -Method Get -Path '/api/org'
$datasources = @((Invoke-GrafanaApi -Method Get -Path '/api/datasources').Body)
$prometheusDatasources = @($datasources | Where-Object { $_.type -ceq 'prometheus' })
if ($prometheusDatasources.Count -eq 0) { throw 'The Grafana stack has no Prometheus datasource.' }

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$start = [DateTimeOffset]::UtcNow.AddMinutes(-$ReceiptLookbackMinutes).ToUnixTimeSeconds()
$metricQuery = [Uri]::EscapeDataString('sum(assetlibrary_http_requests_total{service="assetlibrary-api"})')
$selectedDatasource = $null
foreach ($candidate in $prometheusDatasources) {
    $uid = [Uri]::EscapeDataString([string]$candidate.uid)
    $path = "/api/datasources/proxy/uid/$uid/api/v1/query_range?query=$metricQuery&start=$start&end=$now&step=30"
    try {
        $result = (Invoke-GrafanaApi -Method Get -Path $path).Body
        if (Test-PositiveMetricSample $result) {
            $selectedDatasource = $candidate
            break
        }
    } catch {
        continue
    }
}
if ($null -eq $selectedDatasource) {
    throw 'No recent AssetLibrary metric was found. Run the API for two scrape intervals and retry.'
}

$escapedFolderUid = [Uri]::EscapeDataString($folderUid)
$folder = Invoke-GrafanaApi -Method Get -Path "/api/folders/$escapedFolderUid" -AllowedStatusCodes @(200, 404)
if ($folder.StatusCode -eq 404) {
    $folder = Invoke-GrafanaApi -Method Post -Path '/api/folders' -Body @{
        uid = $folderUid
        title = 'Neuro AssetLibrary'
    }
    Write-Output 'Grafana folder created.'
} else {
    Write-Output 'Grafana folder already exists.'
}

$escapedDashboardUid = [Uri]::EscapeDataString($dashboardUid)
$existing = Invoke-GrafanaApi -Method Get -Path "/api/dashboards/uid/$escapedDashboardUid" `
    -AllowedStatusCodes @(200, 404)
if ($existing.StatusCode -eq 404 -or $UpdateDashboard) {
    $datasourceVariable[0].current = [pscustomobject]@{
        selected = $true
        text = [string]$selectedDatasource.name
        value = [string]$selectedDatasource.uid
    }
    $null = Invoke-GrafanaApi -Method Post -Path '/api/dashboards/db' -Body @{
        dashboard = $dashboard
        folderUid = $folderUid
        overwrite = [bool]$UpdateDashboard
        message = if ($UpdateDashboard) { 'Update AssetLibrary dashboard' } else { 'Initial AssetLibrary dashboard' }
    }
    Write-Output $(if ($UpdateDashboard) { 'Grafana dashboard updated.' } else { 'Grafana dashboard created.' })
} else {
    Write-Output 'Grafana dashboard already exists; no overwrite was performed.'
}

$verified = (Invoke-GrafanaApi -Method Get -Path "/api/dashboards/uid/$escapedDashboardUid").Body
if ($verified.meta.folderUid -cne $folderUid -or @($verified.dashboard.panels).Count -lt 12) {
    throw 'The deployed dashboard failed folder or panel-count verification.'
}
$deployedDatasource = @($verified.dashboard.templating.list | Where-Object { $_.name -ceq 'datasource' })
if ($deployedDatasource.Count -ne 1 -or
    [string]$deployedDatasource[0].current.value -cne [string]$selectedDatasource.uid) {
    throw 'The deployed dashboard is not bound to the metric datasource; rerun with -UpdateDashboard.'
}

$traceCount = 0
$tempoDatasources = @($datasources | Where-Object { $_.type -ceq 'tempo' })
$traceQueries = @()
$traceQueries += 'tags=' + [Uri]::EscapeDataString('resource.service.name=assetlibrary-api')
$traceQueries += 'q=' + [Uri]::EscapeDataString('{ resource.service.name = "assetlibrary-api" }')
foreach ($tempo in $tempoDatasources) {
    $uid = [Uri]::EscapeDataString([string]$tempo.uid)
    foreach ($query in $traceQueries) {
        try {
            $traces = (Invoke-GrafanaApi -Method Get `
                -Path "/api/datasources/proxy/uid/$uid/api/search?$query&start=$start&end=$now&limit=20").Body
            $traceCount = [Math]::Max($traceCount, @($traces.traces).Count)
        } catch {
            continue
        }
    }
}
if ($traceCount -eq 0) { throw 'No recent AssetLibrary trace was found in the Grafana stack.' }

Write-Output "Grafana telemetry receipt confirmed: metrics=yes, recent_traces=$traceCount."
Write-Output "Dashboard path: /d/$dashboardUid"
