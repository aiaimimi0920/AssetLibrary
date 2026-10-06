# The production worker consumes only real API-generated catalog events.
function Start-ArtIndexer {
    $settings = $Run.Common.Clone()
    $settings.NATS_URL = $Run.Common.ASSETLIBRARY_NATS_URL
    $settings.ASSETLIBRARY_ENVIRONMENT = 'development'
    $settings.ASSETLIBRARY_INDEXER_MODE = 'edge-policy'
    $Run.IndexerBase = "indexer-$($Run.Id)"
    $settings.ASSETLIBRARY_INDEXER_CONSUMER = $Run.IndexerBase
    $settings.ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID = 'a' * 32
    $settings.ASSETLIBRARY_EDGE_POLICY_NAMESPACE_ID = 'b' * 32
    $settings.ASSETLIBRARY_EDGE_POLICY_API_TOKEN = $Run.PolicyToken
    $settings.ASSETLIBRARY_EDGE_POLICY_API_BASE = $Run.EdgeOrigin
    $Run.IndexerSettings = $settings
    $reject = $settings.Clone()
    $reject.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
    $reject.NATS_URL = 'nats://127.0.0.1:1'
    $worker = Start-RunWorker 'edge-rebuild-rejected' "$($Run.Repo)/target/release/assetlibrary-indexer-worker.exe" $reject @('rebuild')
    if (-not $worker.Process.WaitForExit(5000) -or $worker.Process.ExitCode -eq 0) { throw 'Edge-only rebuild was not rejected before connecting' }
    if (-not $worker.Stderr.Wait(5000) -or $worker.Stderr.Result -notmatch 'rebuild requires search-edge mode') {
        throw 'Edge-only rebuild failed for an unrelated reason'
    }
    Stop-RunWorker $worker
    Write-RunJson 'edge-rebuild-rejected.json' @{ rejected = $true; unavailable_database_and_nats = $true }
    $Run.IndexerConsumer = "$($Run.IndexerBase)-edge-policy-v1"
    $Run.IndexerWorker = Start-RunWorker 'indexer-edge' "$($Run.Repo)/target/release/assetlibrary-indexer-worker.exe" $settings
    Wait-RunCondition 'Edge-only durable readiness' {
        if ($Run.IndexerWorker.Process.HasExited) { throw 'Edge-only indexer exited before readiness' }
        $null -ne (Get-ArtIndexerConsumer)
    } 15
}

function Get-ArtIndexerConsumer([string] $Name = $Run.IndexerConsumer) {
    $monitor = Invoke-RestMethod "http://127.0.0.1:$($Run.NatsMonitorPort)/jsz?accounts=true&streams=true&consumers=true&config=true" -TimeoutSec 3
    $streams = @($monitor.account_details | ForEach-Object { $_.stream_detail } | Where-Object { $_.name -eq 'ASSETLIBRARY_EVENTS' })
    $consumers = @($streams | ForEach-Object { $_.consumer_detail } | Where-Object { $_.name -eq $Name })
    if ($consumers.Count -gt 1) { throw 'Duplicate indexer durable' }
    if ($consumers.Count -eq 1) { return $consumers[0] }
}

function Get-ArtPolicyState {
    Invoke-RestMethod "$($Run.EdgeOrigin)/test/policy-state" -Headers @{ Authorization = "Bearer $($Run.PolicyToken)" } -TimeoutSec 3
}

function Set-ArtPolicyFailure([bool] $Unavailable) {
    Invoke-RestMethod -Method Post -Uri "$($Run.EdgeOrigin)/test/policy-failure" `
        -Headers @{ Authorization = "Bearer $($Run.PolicyToken)" } -Body $Unavailable.ToString().ToLowerInvariant() -TimeoutSec 3 | Out-Null
}

function Get-ArtCatalogEvent([string] $Reason) {
    $text = Invoke-RunSql "SELECT id FROM outbox_events WHERE subject='assetlibrary.catalog.invalidated.v1' AND aggregate_id='$($Run.PackageId)' AND payload->>'reason'='$Reason'"
    [guid]::Parse($text).ToString()
}

function Wait-ArtProjection([string] $Label, [bool] $Eligible, [string] $EventId = '') {
    $started = [DateTime]::UtcNow
    Wait-RunCondition "automatic Edge projection: $Label" {
        if ($Run.IndexerWorker.Process.HasExited) { throw 'Edge-only indexer exited during projection' }
        $projected = Invoke-RunSql "SELECT EXISTS(SELECT 1 FROM edge_policy_projections WHERE package_id='$($Run.PackageId)' AND (public_digest IS NOT NULL)=$($Eligible.ToString().ToLowerInvariant()))"
        if ($projected -ne 't') { return $false }
        if ($EventId) {
            $marked = Invoke-RunSql "SELECT EXISTS(SELECT 1 FROM projection_events WHERE projection='edge-policy-v1' AND event_id='$EventId')"
            if ($marked -ne 't') { return $false }
        }
        $consumer = Get-ArtIndexerConsumer
        $consumer -and $consumer.num_pending -eq 0 -and $consumer.num_ack_pending -eq 0
    } 30
    $state = Get-ArtPolicyState
    Write-RunJson "projection-$Label.json" @{ package_id = $Run.PackageId; event_id = $EventId
        eligible = $Eligible; elapsed_ms = ([DateTime]::UtcNow - $started).TotalMilliseconds
        consumer = Get-ArtIndexerConsumer; policy = $state; explicit_reconcile = $false }
}

function Test-ArtProjectionFailure([string] $EventId) {
    Wait-RunCondition 'production indexer observes policy failure' { (Get-ArtPolicyState).failures -gt 0 } 15
    $marked = Invoke-RunSql "SELECT EXISTS(SELECT 1 FROM projection_events WHERE projection='edge-policy-v1' AND event_id='$EventId')"
    if ($marked -ne 'f') { throw 'Failed policy write marked the catalog event as processed' }
    $consumer = Get-ArtIndexerConsumer
    if ($consumer.num_ack_pending -ne 1) { throw 'Failed event was ACKed or lost' }
    Write-RunJson 'projection-failure.json' @{ event_id = $EventId; marked = $false
        consumer = $consumer; policy = Get-ArtPolicyState; explicit_reconcile = $false }
}
