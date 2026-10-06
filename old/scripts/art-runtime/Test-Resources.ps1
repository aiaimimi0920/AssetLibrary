param([Parameter(Mandatory = $true)][string] $EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\','/')
if (-not $root.StartsWith('C:\Users\Public\nas_home\AI\GameEditor\linshi\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be under linshi' }
if (Test-Path -LiteralPath $root) { throw 'Refusing an existing evidence directory' }
foreach ($directory in @('logs','tmp')) { [void][IO.Directory]::CreateDirectory("$root/$directory") }
$script:Run = @{ Root = $root; Id = 'resource-fixture'; Utf8 = [Text.UTF8Encoding]::new($false)
    Secrets = @(); Workers = [Collections.Generic.List[object]]::new(); Containers = @() }
. "$PSScriptRoot/../scanner-runtime/Environment.ps1"
. "$PSScriptRoot/Resources.ps1"
Import-ArtResourceTypes
if ((Convert-ArtDockerBytes '1.25MiB') -ne 1310720 -or (Convert-ArtDockerBytes '1GB') -ne 1000000000) { throw 'Docker display unit mismatch' }
foreach ($value in @('-1MiB','1XB','100000000000000000TiB')) {
    $rejected = $false; try { Convert-ArtDockerBytes $value | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid resource display accepted' }
}
$container = @{ Name = 'owned-metric'; Id = 'a' * 64; Role = 'pg'; Image = 'sha256:' + ('b' * 64) }
$row = @{ Name = 'owned-metric'; ID = 'a' * 12; MemUsage = '10MiB / 1GiB'; CPUPerc = '1.25%'; PIDs = '4' }
$metric = Convert-ArtContainerMetric $row $container 'idle' 'before'
if ($metric.parsed_display_memory_bytes -ne 10485760 -or $metric.cpu_percent -ne 1.25) { throw 'Container resource conversion mismatch' }
$row.Name = 'another-owner'; $rejected = $false
try { Convert-ArtContainerMetric $row $container 'idle' 'before' | Out-Null } catch { $rejected = $true }
if (-not $rejected) { throw 'Foreign container resource accepted' }
$server = @'
import {createServer} from "node:http";
import {writeFileSync} from "node:fs";
const mode = process.argv[4];
const counts = {received: 0, responded: 0, follow_up: 0};
const save = () => writeFileSync(process.argv[3], JSON.stringify(counts));
const server = createServer({maxHeaderSize: 1024}, (request, response) => {
  counts.received++;
  if (request.url.startsWith("/follow-up")) counts.follow_up++;
  save();
  setTimeout(() => {
    const headers = {"content-type": "application/json", "connection": "close"};
    if (mode === "redirect") headers.location = `http://127.0.0.1:${server.address().port}/follow-up`;
    response.writeHead(mode === "fail" ? 503 : mode === "redirect" ? 302 : 200, headers).end('{"items":[]}');
    counts.responded++;
    save();
  }, mode === "slow" ? 1000 : mode === "interval" ? 1 : 50);
});
server.maxConnections = 2;
server.listen(0, "127.0.0.1", () => {
  save();
  writeFileSync(process.argv[2], String(server.address().port), {flag:"wx"});
});
'@
[IO.File]::WriteAllText("$root/query-fixture.mjs", $server, $Run.Utf8)
function Start-QueryFixture([string] $Mode) {
    $worker = Start-RunWorker "query-$Mode" $node @{} @("$root/query-fixture.mjs", "$root/$Mode-port.txt", "$root/$Mode-counts.json", $Mode)
    Wait-RunCondition "query $Mode port" { Test-Path -LiteralPath "$root/$Mode-port.txt" } 5
    @{ Worker = $worker; Origin = "http://127.0.0.1:$([IO.File]::ReadAllText("$root/$Mode-port.txt"))" }
}

function Test-QueryFailure([string] $Mode, [int] $Deadline) {
    $fixture = Start-QueryFixture $Mode
    $rejected = $false; $failureText = ''
    try { [ArtQueryLoad]::Run($fixture.Origin, 25, $Deadline) | Out-Null }
    catch {
        $rejected = $true
        $pending = [Collections.Generic.Queue[Exception]]::new(); $pending.Enqueue($_.Exception)
        while ($pending.Count) {
            $exception = $pending.Dequeue(); $failureText += $exception.Message + "`n"
            if ($exception -is [AggregateException]) {
                foreach ($inner in $exception.InnerExceptions) { $pending.Enqueue($inner) }
            } elseif ($exception.InnerException) { $pending.Enqueue($exception.InnerException) }
        }
    }
    $expected = if ($Mode -in @('interval','slow')) { 'Query load exceeded deadline' } else { 'Public query dependency failed' }
    if (-not $failureText.Contains($expected)) {
        [IO.File]::WriteAllText("$root/$Mode-error.txt", $failureText, $Run.Utf8)
        throw "Unexpected query failure branch: $Mode"
    }
    if (-not $rejected -or [ArtQueryLoad]::ActiveClientTasks -ne 0) { throw "Owned query tasks not drained: $Mode" }
    $before = [IO.File]::ReadAllText("$root/$Mode-counts.json") | ConvertFrom-Json
    # Wait beyond the inter-request delay: canceled clients must not start again.
    Start-Sleep -Milliseconds 250
    $after = [IO.File]::ReadAllText("$root/$Mode-counts.json") | ConvertFrom-Json
    if ($before.received -lt 1 -or $before.received -ge 50 -or $after.received -ne $before.received -or $after.follow_up -ne 0) {
        throw "Query failure allowed subsequent requests: $Mode"
    }
    if ($Mode -eq 'interval' -and $before.responded -ne $before.received) { throw 'Fast interval fixture did not complete responses' }
    Stop-RunWorker $fixture.Worker
    @{ mode = $Mode; rejected = $true; active_client_tasks = 0; requests_at_return = $before.received
        requests_after_wait = $after.received; redirect_follow_up_requests = $after.follow_up; deadline_ms = $Deadline
        expected_error = $expected; expected_error_observed = $true }
}
$sampler = $null
try {
    $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $fixture = Start-QueryFixture 'normal'; $worker = $fixture.Worker
    $sampler = [ArtResourceSampler]::new([string[]]@('fixture'), [int[]]@($worker.Process.Id), [string[]]@($worker.Binary))
    $sampler.SetPhase('idle'); Start-Sleep -Milliseconds 150
    $sampler.SetPhase('two-client-query')
    $queries = [ArtQueryLoad]::Run($fixture.Origin, 2)
    if ($queries.Requests.Count -ne 4 -or $queries.PeakClientInFlight -ne 2 -or
        [ArtQueryLoad]::ActiveClientTasks -ne 0 -or
        @($queries.Requests | Where-Object { $_.Status -ne 200 -or $_.Body -ne '{"items":[]}' }).Count) { throw 'Gated query fixture failed' }
    $rejected = $false
    try { [ArtQueryLoad]::Run('https://example.invalid', 1) | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Non-loopback query target accepted' }
    $failures = @((Test-QueryFailure 'interval' 250), (Test-QueryFailure 'slow' 150),
        (Test-QueryFailure 'redirect' 5000), (Test-QueryFailure 'fail' 5000))
    $samples = @($sampler.Snapshot())
    if (@($samples | Where-Object { $_.WorkingSetBytes -le 0 -or $_.LifetimePeakWorkingSetBytes -le 0 }).Count -or
        @($samples | Where-Object Phase -eq 'idle').Count -lt 2 -or @($samples | Where-Object Phase -eq 'two-client-query').Count -lt 2) {
        throw 'Native resource samples incomplete'
    }
    $report = @{ passed = $true; docker_display_units = $true; rejects_invalid_and_foreign_metrics = $true
        native_samples = $samples.Count; gated_requests = 4; peak_client_in_flight = 2; rejects_non_loopback = $true
        query_failure_cases = $failures; real_docker_called = $false; real_assetlibrary_called = $false }
} finally {
    try { if ($sampler) { $sampler.Dispose() } } finally { Stop-RunEnvironment }
}
if (@($Run.Workers | Where-Object { -not $_.Stopped }).Count) { throw 'Owned fixtures remain' }
$report.cleanup_passed = $true
Write-RunJson 'resource-contract.json' $report
Write-Output "Candidate resource contracts passed: $root"
