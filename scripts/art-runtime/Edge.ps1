# Load the actual Edge implementation, and feed its policy port through the real
# indexer example. No copied publication SQL, public allowlist or anonymous S3.
function Start-ArtEdge {
    $Run.Node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    # TypeScript 7's Node launcher spawns a native compiler. Own the resolved EXE
    # directly so a compile timeout cannot leave that different-binary child alive.
    $resolver = [uri]([IO.Path]::GetFullPath("$($Run.Repo)/services/edge/node_modules/typescript/lib/getExePath.js"))
    $compiler = (Invoke-RunTool 'resolve-compiler' $Run.Node @('--input-type=module', '-e',
        'const module=await import(process.argv[1]);process.stdout.write(module.default());', $resolver.AbsoluteUri) 10).Trim()
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf) -or [IO.Path]::GetFileName($compiler) -ne 'tsc.exe') {
        throw 'Expected the installed TypeScript native compiler'
    }
    Invoke-RunTool 'compile-edge' $compiler @('--ignoreConfig', '--target', 'ES2022', '--module', 'node16',
        '--moduleResolution', 'node16', '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--typeRoots', "$($Run.Root)/edge-types",
        '--outDir', "$($Run.Root)/edge-compiled", "$($Run.Repo)/services/edge/src/index.ts",
        "$($Run.Repo)/services/edge/src/range.ts", "$($Run.Repo)/services/edge/src/ticket.ts") | Out-Null
    $settings = $Run.Storage.Clone()
    $Run.PolicyToken = New-RunSecret
    $Run.TicketSecret = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes((New-RunSecret))).TrimEnd('=').Replace('+','-').Replace('/','_')
    $Run.Secrets += @($Run.PolicyToken, $Run.TicketSecret)
    $settings.ART_POLICY_TOKEN = $Run.PolicyToken; $settings.ART_TICKET_SECRET = $Run.TicketSecret
    $settings.ART_EDGE_MODULE = "$($Run.Root)/edge-compiled/index.js"
    $settings.ART_EDGE_ENDPOINT_FILE = "$($Run.Root)/edge-endpoint.txt"
    $Run.EdgeWorker = Start-RunWorker 'edge' $Run.Node $settings @("$($Run.Repo)/scripts/art-runtime/edge-server.mjs")
    Wait-RunCondition 'local Edge handler readiness' {
        if ($Run.EdgeWorker.Process.HasExited) { throw 'Local Edge process exited before readiness' }
        if (-not (Test-Path -LiteralPath $settings.ART_EDGE_ENDPOINT_FILE)) { return $false }
        $origin = [IO.File]::ReadAllText($settings.ART_EDGE_ENDPOINT_FILE)
        if ($origin -notmatch '^http://127\.0\.0\.1:\d+$') { throw 'Invalid local Edge endpoint' }
        try { (Invoke-WebRequest -UseBasicParsing -Uri "$origin/healthz" -TimeoutSec 2).StatusCode -eq 200 }
        catch { $false }
    } 15
    $Run.EdgeOrigin = [IO.File]::ReadAllText($settings.ART_EDGE_ENDPOINT_FILE)
}

function Invoke-ArtReconcile([string] $Label, [bool] $Eligible) {
    $settings = @{ DATABASE_URL = $Run.Common.DATABASE_URL; ART_ISOLATED_TEST = 'true'
        ART_POLICY_ORIGIN = $Run.EdgeOrigin; ART_POLICY_TOKEN = $Run.PolicyToken; ART_PACKAGE_ID = $Run.PackageId }
    $worker = Start-RunWorker "reconcile-$Label" "$($Run.Repo)/target/release/examples/reconcile_local_policy.exe" $settings
    if (-not $worker.Process.WaitForExit(25000)) { throw 'Local policy reconcile exceeded deadline' }
    $code = $worker.Process.ExitCode
    if (-not $worker.Stdout.Wait(5000)) { throw 'Local policy reconcile output did not close' }
    $text = $worker.Stdout.GetAwaiter().GetResult()
    Stop-RunWorker $worker
    if ($code -ne 0) { throw "Local policy reconcile failed: $Label" }
    $projection = $text | ConvertFrom-Json
    if ($projection.eligible -ne $Eligible -or $projection.package_id -ne $Run.PackageId) { throw 'Unexpected policy eligibility' }
    Write-RunJson "reconcile-$Label.json" $projection
}

function Test-ArtEdgeDownload($Fixture) {
    $download = Invoke-ArtRequest 'GET' "/v1/public/artifacts/$($Run.Artifact.Id)/download"
    $expected = "$($Run.EdgeOrigin)/public/sha256/$($Fixture.canonical_digest)/neuro-starter-art-1.0.0-dev.zip"
    if ($download.download_url -ne $expected) { throw 'Download metadata lost canonical artifact URL' }
    $Run.DownloadUrl = $download.download_url
    $head = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $Run.DownloadUrl -TimeoutSec 10
    if ([long]$head.Headers['Content-Length'] -ne $Fixture.size_bytes) { throw 'Real Edge HEAD size mismatch' }
    Invoke-WebRequest -UseBasicParsing -Uri $Run.DownloadUrl -OutFile "$($Run.Root)/downloaded.zip" -TimeoutSec 10 | Out-Null
    $raw = (Get-FileHash -LiteralPath "$($Run.Root)/downloaded.zip").Hash.ToLowerInvariant()
    if ($raw -ne $Fixture.digest) { throw 'Real Edge download bytes differ from uploaded ZIP' }
    # Windows PowerShell's Invoke-WebRequest cannot set the restricted Range header.
    $request = [Net.HttpWebRequest]::Create($Run.DownloadUrl)
    $request.Timeout = 10000; $request.ReadWriteTimeout = 10000; $request.AddRange(0, 15)
    $range = $request.GetResponse()
    try {
        $rangeStatus = [int]$range.StatusCode
        if ($rangeStatus -ne 206 -or $range.Headers['Content-Range'] -ne "bytes 0-15/$($Fixture.size_bytes)") { throw 'Real Edge range response mismatch' }
        $reader = [IO.BinaryReader]::new($range.GetResponseStream())
        try { $rangeBytes = $reader.ReadBytes(17) } finally { $reader.Dispose() }
    } finally { $range.Dispose() }
    $expectedBytes = [IO.File]::ReadAllBytes("$($Run.Root)/fixtures/signed.zip")[0..15]
    if ([Convert]::ToBase64String($rangeBytes) -ne [Convert]::ToBase64String($expectedBytes)) { throw 'Real Edge range bytes differ' }
    # HttpClient preserves a bodyless 304 instead of PowerShell's error wrapper.
    Add-Type -AssemblyName System.Net.Http
    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(10)
    $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Run.DownloadUrl)
    [void]$message.Headers.TryAddWithoutValidation('If-None-Match', [string]$head.Headers['ETag'])
    try {
        $conditional = $client.SendAsync($message, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        try { $conditionalStatus = [int]$conditional.StatusCode } finally { $conditional.Dispose() }
    } finally { $message.Dispose(); $client.Dispose() }
    if ($conditionalStatus -ne 304) { throw "Real Edge conditional GET mismatch: $conditionalStatus" }
    Write-RunJson 'download.json' @{ artifact_id = $Run.Artifact.Id; raw_sha256 = $raw; canonical_sha256 = $Fixture.canonical_digest
        size_bytes = $Fixture.size_bytes; head_status = $head.StatusCode; range_status = $rangeStatus
        conditional_status = $conditionalStatus; actual_edge_handler = $true; cloud_cache_tested = $false }
}

function Assert-ArtEdgeDenied([string] $Url) {
    try { $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 10; $status = [int]$response.StatusCode }
    catch { $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
    if ($status -ne 404) { throw "Real Edge expected 404, got $status" }
}
