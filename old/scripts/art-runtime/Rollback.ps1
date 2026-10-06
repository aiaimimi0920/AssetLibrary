# Optional transition proof. These dependencies start only after the Edge-only
# publication/retry proof, and are distinct from all shared development services.
function Test-ArtIndexerRollback([string] $OpenSearchImage, [string] $ValkeyImage, [string] $EventId) {
    foreach ($directory in @('opensearch', 'valkey')) { [void][IO.Directory]::CreateDirectory("$($Run.Root)/$directory") }
    $Run.Commands.opensearch = @(); $Run.Commands.valkey = @()
    $Run.OpenSearch = Start-RunContainer 'opensearch' $OpenSearchImage @('--memory=2g', '-p', '127.0.0.1::9200',
        '-e', 'discovery.type=single-node', '-e', 'DISABLE_SECURITY_PLUGIN=true', '-e', 'DISABLE_INSTALL_DEMO_CONFIG=true',
        '-e', 'OPENSEARCH_JAVA_OPTS=-Xms256m -Xmx256m', '--mount', "type=bind,source=$($Run.Root)/opensearch,target=/usr/share/opensearch/data")
    $Run.Valkey = Start-RunContainer 'valkey' $ValkeyImage @('--memory=256m', '-p', '127.0.0.1::6379',
        '--mount', "type=bind,source=$($Run.Root)/valkey,target=/data")
    $Run.SearchOrigin = "http://127.0.0.1:$(Get-RunPort $Run.OpenSearch 9200)"
    Write-RunJson 'rollback-resources.json' @{ containers = @($Run.Containers); shared_search_services_used = $false }
    Wait-RunCondition 'isolated rollback OpenSearch readiness' {
        try { (Invoke-RestMethod "$($Run.SearchOrigin)/_cluster/health" -TimeoutSec 3).status -in @('green', 'yellow') }
        catch { $false }
    } 240
    Wait-RunCondition 'isolated rollback Valkey readiness' {
        (Invoke-RunDocker @('exec', $Run.Valkey, 'valkey-cli', 'PING') -AllowFailure).Text -eq 'PONG'
    } 15
    $settings = $Run.IndexerSettings.Clone()
    $settings.ASSETLIBRARY_INDEXER_MODE = 'search-edge'
    $settings.ASSETLIBRARY_OPENSEARCH_URL = $Run.SearchOrigin
    $settings.ASSETLIBRARY_OPENSEARCH_USERNAME = 'local-test'
    $settings.ASSETLIBRARY_OPENSEARCH_PASSWORD = 'unused-local-security-disabled'
    $settings.ASSETLIBRARY_VALKEY_URL = "redis://127.0.0.1:$(Get-RunPort $Run.Valkey 6379)"
    $settings.ASSETLIBRARY_SEARCH_ALIAS = $Run.Id
    $settings.ASSETLIBRARY_SEARCH_INDEX_PREFIX = "$($Run.Id)-v1"
    $Run.RollbackSettings = $settings
    $Run.FullIndexer = Start-RunWorker 'indexer-full' "$($Run.Repo)/target/release/assetlibrary-indexer-worker.exe" $settings
    Wait-RunCondition 'same event independently projected by full indexer' {
        if ($Run.FullIndexer.Process.HasExited) { throw 'Full indexer exited during rollback' }
        (Invoke-RunSql "SELECT count(*) FROM projection_events WHERE event_id='$EventId' AND projection IN ('edge-policy-v1','search-edge-v1')") -eq '2'
    } 150
    $document = Invoke-RestMethod "$($Run.SearchOrigin)/$($Run.Id)/_doc/$($Run.PackageId)" -TimeoutSec 3
    if ($document._source.artifact_id -ne $Run.Artifact.Id) { throw 'Full mode skipped the Edge-only event or indexed another artifact' }
    $scannerBefore = (Get-ArtIndexerConsumer $Run.Id).config | ConvertTo-Json -Depth 8 -Compress
    if (-not $scannerBefore -or $scannerBefore -eq 'null') { throw 'Missing scanner consumer configuration snapshot' }
    $conflict = $settings.Clone(); $conflict.ASSETLIBRARY_INDEXER_CONSUMER = $Run.Id
    $rejected = Start-RunWorker 'indexer-consumer-conflict' "$($Run.Repo)/target/release/assetlibrary-indexer-worker.exe" $conflict
    if (-not $rejected.Process.WaitForExit(15000) -or $rejected.Process.ExitCode -eq 0) { throw 'Conflicting scanner durable was not rejected' }
    if (-not $rejected.Stderr.Wait(5000) -or $rejected.Stderr.Result -notmatch 'existing indexer consumer configuration conflicts') {
        throw 'Consumer conflict failed for an unrelated reason'
    }
    Stop-RunWorker $rejected
    $scannerAfter = (Get-ArtIndexerConsumer $Run.Id).config | ConvertTo-Json -Depth 8 -Compress
    if ($scannerBefore -ne $scannerAfter) { throw 'Conflicting startup changed scanner consumer configuration' }
    Write-RunJson 'consumer-conflict-rejected.json' @{ rejected = $true; scanner_durable = $Run.Id
        destructive_reconfiguration = $false; config_before = ($scannerBefore | ConvertFrom-Json); config_after = ($scannerAfter | ConvertFrom-Json) }
    $old = (Invoke-RestMethod "$($Run.SearchOrigin)/_alias/$($Run.Id)" -TimeoutSec 3).PSObject.Properties.Name
    $rebuild = Start-RunWorker 'indexer-rebuild' "$($Run.Repo)/target/release/assetlibrary-indexer-worker.exe" $settings @('rebuild')
    if (-not $rebuild.Process.WaitForExit(150000) -or $rebuild.Process.ExitCode -ne 0) { throw 'Rollback rebuild failed' }
    Stop-RunWorker $rebuild
    $new = (Invoke-RestMethod "$($Run.SearchOrigin)/_alias/$($Run.Id)" -TimeoutSec 3).PSObject.Properties.Name
    if (@($new).Count -ne 1 -or $old -eq $new) { throw 'Rebuild did not swap the isolated alias' }
    $api = $Run.ApiSettings.Clone()
    foreach ($key in $settings.Keys) { if ($key -match '^ASSETLIBRARY_(OPENSEARCH|VALKEY|SEARCH_)') { $api[$key] = $settings[$key] } }
    $api.ASSETLIBRARY_SEARCH_PROVIDER = 'opensearch'
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    $api.ASSETLIBRARY_BIND = "127.0.0.1:$port"; $Run.RollbackApiOrigin = "http://127.0.0.1:$port"
    $worker = Start-RunWorker 'api-rollback' "$($Run.Repo)/target/release/assetlibrary-api.exe" $api
    Wait-RunCondition 'rollback API readiness' {
        if ($worker.Process.HasExited) { throw 'Rollback API exited' }
        try { (Invoke-WebRequest -UseBasicParsing -Uri "$($Run.RollbackApiOrigin)/readyz" -TimeoutSec 2).StatusCode -eq 200 }
        catch { $false }
    } 15
    $search = Get-ArtRollbackSearch
    if ($search.items.Count -ne 1 -or $search.items[0].id -ne $Run.PackageId) { throw 'OpenSearch API rollback contract mismatch' }
    $Run.RollbackGeneration = (Invoke-RunDocker @('exec', $Run.Valkey, 'valkey-cli', 'GET', 'assetlibrary:catalog:generation')).Text
    if ([long]$Run.RollbackGeneration -lt 2) { throw 'Full mode cache invalidation/rebuild generation missing' }
    Write-RunJson 'rollback-published.json' @{ event_id = $EventId; both_projection_markers = $true; old_index = $old
        new_index = $new; generation = $Run.RollbackGeneration; search = $search; consumer = Get-ArtIndexerConsumer $Run.IndexerBase
        edge_only_consumer = Get-ArtIndexerConsumer; shared_search_services_used = $false }
}

function Get-ArtRollbackSearch {
    Invoke-RestMethod "$($Run.RollbackApiOrigin)/v1/public/search?q=Isolated%20Art%20Flow&kind=art&tag=isolated&limit=2" -TimeoutSec 5
}

function Test-ArtRollbackRevocation([string] $EventId) {
    Wait-RunCondition 'full mode automatic revoke projection' {
        if ($Run.FullIndexer.Process.HasExited) { throw 'Full indexer exited during revoke' }
        (Invoke-RunSql "SELECT count(*) FROM projection_events WHERE event_id='$EventId' AND projection IN ('edge-policy-v1','search-edge-v1')") -eq '2'
    } 30
    if ((Get-ArtRollbackSearch).items.Count -ne 0) { throw 'Revoked package remains in rollback search' }
    try { Invoke-RestMethod "$($Run.SearchOrigin)/$($Run.Id)/_doc/$($Run.PackageId)" -TimeoutSec 3 | Out-Null; throw 'Revoked OpenSearch document remains' }
    catch { if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404) { throw } }
    Wait-RunCondition 'full durable acknowledged revoke' {
        $consumer = Get-ArtIndexerConsumer $Run.IndexerBase
        $consumer -and $consumer.num_pending -eq 0 -and $consumer.num_ack_pending -eq 0
    } 10
    $generation = (Invoke-RunDocker @('exec', $Run.Valkey, 'valkey-cli', 'GET', 'assetlibrary:catalog:generation')).Text
    if ([long]$generation -le [long]$Run.RollbackGeneration) { throw 'Revocation did not invalidate old cache generation' }
    Write-RunJson 'rollback-revoked.json' @{ event_id = $EventId; both_projection_markers = $true
        search_items = 0; document_status = 404; generation = $generation; consumer = Get-ArtIndexerConsumer $Run.IndexerBase }
}
