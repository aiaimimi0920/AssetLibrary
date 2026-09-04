param(
    [int] $ApiPort = 18111,
    [int] $WebPort = 18112,
    [int] $AccountPort = 18113
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
& (Join-Path $PSScriptRoot 'Invoke-LocalMigration.ps1') | Out-Null
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}

$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$publisherId = [guid]::NewGuid().ToString()
$packageId = [guid]::NewGuid().ToString()
$releaseId = [guid]::NewGuid().ToString()
$artifactId = [guid]::NewGuid().ToString()
$submissionId = [guid]::NewGuid().ToString()
$moderationCaseId = [guid]::NewGuid().ToString()
$moderationActionId = [guid]::NewGuid().ToString()
$subject = "operator-web-$runId-account"
$publisherSubject = "operator-web-$runId-publisher"
$issuer = 'assetlibrary-development'
$accessToken = "dev-$subject"
$cookieName = 'neuro_session'
$cookieValue = "session-$runId"
$packageName = "Operator Queue $runId"
$objectKey = "private/operator-$runId.zip"
$scanSentinel = "raw-scan-$runId"
$reporterSentinel = "reporter-$runId"
$proposerSentinel = "proposer-$runId"
$approverSentinel = "approver-$runId"
$sqlPath = Join-Path $env:TEMP "assetlibrary-operator-web-$runId.sql"
$logs = @()
$processes = @()
$stage = 'setup'
$portsClaimed = $false

function Invoke-Sql([string] $Sql) {
    [IO.File]::WriteAllText($sqlPath, $Sql, (New-Object Text.UTF8Encoding($false)))
    docker cp $sqlPath "assetlibrary-postgres-1:/tmp/operator-web-runtime.sql" | Out-Null
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 `
        -f /tmp/operator-web-runtime.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL runtime command failed.' }
}

function Start-Hidden([string] $Name, [string] $FilePath, [string[]] $Arguments = @()) {
    $stdout = Join-Path $env:TEMP "assetlibrary-$Name-$runId.stdout.log"
    $stderr = Join-Path $env:TEMP "assetlibrary-$Name-$runId.stderr.log"
    $script:logs += $stdout, $stderr
    $start = @{
        FilePath = $FilePath; PassThru = $true; WindowStyle = 'Hidden'
        RedirectStandardOutput = $stdout; RedirectStandardError = $stderr
    }
    if ($Arguments.Count -gt 0) { $start.ArgumentList = $Arguments }
    $process = Start-Process @start
    $script:processes += $process
    return $process
}

function Wait-Http([string] $Uri, [System.Diagnostics.Process] $Process) {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 300
        if ($Process.HasExited) { throw "Process exited before $Uri became available." }
        try { $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2 } catch { $response = $null }
    } while (-not $response -and (Get-Date) -lt $deadline)
    if (-not $response) { throw "Timed out waiting for $Uri." }
}

function Assert-PortFree([int] $Port) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
        throw "TCP port $Port is already in use."
    }
}

function Stop-ProcessTree([int] $TargetId) {
    @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetId" -ErrorAction SilentlyContinue) |
        ForEach-Object { Stop-ProcessTree ([int] $_.ProcessId) }
    Stop-Process -Id $TargetId -Force -ErrorAction SilentlyContinue
}

function Stop-OwnedListener([int] $Port) {
    foreach ($listener in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $process -or $process.CommandLine -notlike "*$root*") {
            throw "Refusing to stop an unexpected listener on TCP port $Port."
        }
        Stop-ProcessTree ([int] $listener.OwningProcess)
    }
}

function Get-OperatorPage([switch] $Authenticated, [string] $Path = '/operator') {
    $request = @{ UseBasicParsing = $true; Uri = "http://127.0.0.1:$WebPort$Path" }
    if ($Authenticated) { $request.WebSession = $script:authenticatedSession }
    return Invoke-WebRequest @request
}

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:ASSETLIBRARY_BIND = "127.0.0.1:$ApiPort"
$env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_API_URL = "http://127.0.0.1:$ApiPort"
$env:ASSETLIBRARY_PUBLIC_URL = "http://127.0.0.1:$WebPort"
$env:ASSETLIBRARY_ACCOUNT_SESSION_URL = "http://127.0.0.1:$AccountPort/v1/session"
$env:ASSETLIBRARY_ACCOUNT_SESSION_COOKIE = $cookieName
$env:ACCOUNT_FIXTURE_PORT = "$AccountPort"
$env:ACCOUNT_FIXTURE_COOKIE_NAME = $cookieName
$env:ACCOUNT_FIXTURE_COOKIE_VALUE = $cookieValue
$env:ACCOUNT_FIXTURE_ISSUER = $issuer
$env:ACCOUNT_FIXTURE_SUBJECT = $subject
$env:ACCOUNT_FIXTURE_ACCESS_TOKEN = $accessToken
$authenticatedSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$authenticatedSession.Cookies.Add([Net.Cookie]::new($cookieName, $cookieValue, '/', '127.0.0.1'))

Push-Location $root
try {
    & cargo build -p assetlibrary-api --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & pnpm --dir apps/web build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

$seed = @"
BEGIN;
INSERT INTO publishers(id,slug,display_name,status)
VALUES ('$publisherId','operator-$runId','Operator Publisher $runId','active');
INSERT INTO publisher_members(publisher_id,principal_issuer,principal_subject,role,status)
VALUES ('$publisherId','$issuer','$publisherSubject','owner','active');
INSERT INTO packages(id,publisher_id,slug,kind,status,visibility,name,summary)
VALUES ('$packageId','$publisherId','operator-package-$runId','capability','submitted','private',
        '$packageName','Real operator SSR queue package');
INSERT INTO releases(id,package_id,version,status,compatibility,permissions,created_by_issuer,created_by_subject)
VALUES ('$releaseId','$packageId','2.1.0','in_review','{"products":[{"name":"loom","version_requirement":">=0.1.0"}]}',
        '["filesystem.read-project"]','$issuer','$publisherSubject');
INSERT INTO artifacts(id,release_id,status,object_key,sha256,canonical_sha256,size_bytes,media_type,
        verified_at,published_object_key,scanner_version,rule_version,scan_evidence,signature)
VALUES ('$artifactId','$releaseId','verified','$objectKey',decode(repeat('ef',32),'hex'),
        decode(repeat('ef',32),'hex'),4096,'application/zip',now(),'sha256/ef/' || repeat('ef',32),
        'scanner-runtime','rules-runtime','{"sentinel":"$scanSentinel"}','{"keyId":"operator-key"}');
INSERT INTO submissions(id,release_id,status,artifact_id,revision,required_approvals,
        submitted_by_issuer,submitted_by_subject,policy_version,scanner_version,rule_version,submitted_at)
VALUES ('$submissionId','$releaseId','in_review','$artifactId',1,2,'$issuer','$publisherSubject',
        'p4-v1','scanner-runtime','rules-runtime',now());
INSERT INTO moderation_cases(id,package_id,release_id,status,reason,evidence_urls,reporter_issuer,
        reporter_subject,appeal_reason)
VALUES ('$moderationCaseId','$packageId','$releaseId','appealed','Runtime moderation report.',
        '["https://example.invalid/operator-evidence"]','$issuer','$reporterSentinel',
        'Publisher supplied bounded appeal evidence.');
INSERT INTO moderation_actions(id,case_id,action,target_type,target_ref,reason,status,
        requested_by_issuer,requested_by_subject,approved_by_issuer,approved_by_subject,applied_at)
VALUES ('$moderationActionId','$moderationCaseId','block','package','$packageId',
        'Independent operators confirmed the report.','applied','$issuer','$proposerSentinel',
        '$issuer','$approverSentinel',now());
INSERT INTO blocklist_entries(target_type,target_ref,status,reason,source_action_id)
VALUES ('package','$packageId','active','Independent operators confirmed the report.','$moderationActionId');
INSERT INTO store_roles(principal_issuer,principal_subject,role,status) VALUES
('$issuer','$subject','reviewer','active'),
('$issuer','$subject','moderator','active');
COMMIT;
"@

try {
    $stage = 'claim ports and seed fixture'
    @($ApiPort, $WebPort, $AccountPort) | ForEach-Object { Assert-PortFree $_ }
    $portsClaimed = $true
    Invoke-Sql $seed

    $stage = 'start independent services'
    $api = Start-Hidden 'operator-web-api' (Join-Path $root 'target/debug/assetlibrary-api.exe')
    $account = Start-Hidden 'operator-account' 'node.exe' @((Join-Path $root 'scripts/fixtures/account-service.mjs'))
    Wait-Http "http://127.0.0.1:$ApiPort/healthz" $api
    Wait-Http "http://127.0.0.1:$AccountPort/healthz" $account
    $web = Start-Hidden 'operator-web-next' 'pnpm.cmd' `
        @('--dir', (Join-Path $root 'apps/web'), 'start', '-p', "$WebPort")
    Wait-Http "http://127.0.0.1:$WebPort/healthz" $web

    $stage = 'direct service boundaries'
    $accountSession = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$AccountPort/v1/session" `
        -WebSession $authenticatedSession
    if ($accountSession.access_token -ne $accessToken -or $accountSession.principal.subject -ne $subject) {
        throw 'Independent Account Service returned the wrong session contract.'
    }
    $directQueue = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$ApiPort/v1/internal/review-queue" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    $directDetail = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/internal/submissions/$submissionId" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    if ($directQueue.items.submission.id -notcontains $submissionId -or -not $directDetail.can_review) {
        throw 'Operator API did not authorize the Account Service bearer.'
    }
    $directModeration = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/internal/moderation-cases" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    $directCase = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/internal/moderation-cases/$moderationCaseId" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    if ($directModeration.items.id -notcontains $moderationCaseId -or -not $directCase.can_resolve `
        -or $directCase.actions[0].id -ne $moderationActionId) {
        throw 'Moderation API did not expose the sanitized case and appeal workspace.'
    }

    $stage = 'authenticated Operator SSR'
    $queue = Get-OperatorPage -Authenticated
    $detail = Get-OperatorPage -Authenticated -Path "/operator/submissions/$submissionId"
    $moderationQueue = Get-OperatorPage -Authenticated -Path '/operator/moderation'
    $moderationDetail = Get-OperatorPage -Authenticated -Path "/operator/moderation/$moderationCaseId"
    foreach ($value in @($packageName, 'Real operator SSR queue package', 'Review Queue', '打开审核')) {
        if ($queue.Content -notmatch [regex]::Escape($value)) { throw "Operator queue SSR omitted $value." }
    }
    foreach ($value in @($packageName, '可审核制品事实', 'filesystem.read-project', '提交审核决定')) {
        if ($detail.Content -notmatch [regex]::Escape($value)) { throw "Operator detail SSR omitted $value." }
    }
    foreach ($value in @($packageName, 'Moderation Cases', 'Runtime moderation report.', '打开案件')) {
        if ($moderationQueue.Content -notmatch [regex]::Escape($value)) { throw "Moderation queue SSR omitted $value." }
    }
    foreach ($value in @('举报事实', 'Publisher supplied bounded appeal evidence.', '提交申诉结论')) {
        if ($moderationDetail.Content -notmatch [regex]::Escape($value)) { throw "Moderation detail SSR omitted $value." }
    }
    foreach ($content in @($queue.Content, $detail.Content, $moderationQueue.Content, $moderationDetail.Content)) {
        foreach ($secret in @($accessToken, $subject, $issuer, $cookieValue, $objectKey, $scanSentinel,
                $reporterSentinel, $proposerSentinel, $approverSentinel)) {
            if ($content -match [regex]::Escape($secret)) { throw 'Operator SSR leaked identity or raw internal evidence.' }
        }
    }
    foreach ($response in @($queue, $detail, $moderationQueue, $moderationDetail)) {
        if ($response.Headers['Cache-Control'] -notmatch 'no-store' `
            -or $response.Headers['X-Robots-Tag'] -notmatch 'noindex' `
            -or $response.Headers['X-Frame-Options'] -ne 'DENY') {
            throw 'Operator private-cache or security headers failed.'
        }
    }

    $stage = 'identity and role gates'
    $unauthenticated = Get-OperatorPage
    if ($unauthenticated.Content -notmatch '需要外部账号会话' `
        -or $unauthenticated.Content -match [regex]::Escape($packageName)) {
        throw 'Missing Account Service session did not fail closed.'
    }
    Invoke-Sql "UPDATE store_roles SET status='revoked' WHERE principal_issuer='$issuer' AND principal_subject='$subject';"
    $forbidden = Get-OperatorPage -Authenticated
    if ($forbidden.Content -notmatch '没有 Operator 工作区权限' `
        -or $forbidden.Content -match [regex]::Escape($packageName)) {
        throw 'Revoked Store Role did not fail closed.'
    }
    Invoke-Sql "UPDATE store_roles SET status='active' WHERE principal_issuer='$issuer' AND principal_subject='$subject';"

    $stage = 'Operator API outage gate'
    Stop-ProcessTree $api.Id
    Wait-Process -Id $api.Id -ErrorAction SilentlyContinue
    $apiUnavailable = Get-OperatorPage -Authenticated
    if ($apiUnavailable.Content -notmatch '审核数据暂时不可用' `
        -or $apiUnavailable.Content -match [regex]::Escape($packageName)) {
        throw 'Operator API outage was not rendered explicitly.'
    }

    $stage = 'Account Service outage gate'
    Stop-ProcessTree $account.Id
    Wait-Process -Id $account.Id -ErrorAction SilentlyContinue
    $accountUnavailable = Get-OperatorPage -Authenticated
    if ($accountUnavailable.Content -notmatch '账号服务暂时不可用') {
        throw 'Account Service outage was not rendered explicitly.'
    }

    Write-Output 'Operator web runtime passed: external session, Review and Moderation roles, sanitized queue/detail SSR, action forms, headers, no leakage, and fail-closed gates.'
} catch {
    Write-Warning "Operator web runtime failed at $stage`: $($_.Exception.Message)"
    throw
} finally {
    $cleanupFailure = $null
    try {
        $processes | ForEach-Object { Stop-ProcessTree $_.Id }
        $processes | ForEach-Object { Wait-Process -Id $_.Id -ErrorAction SilentlyContinue }
        if ($portsClaimed) { @($ApiPort, $WebPort, $AccountPort) | ForEach-Object { Stop-OwnedListener $_ } }
    } catch { $cleanupFailure = $_; Write-Warning $_.Exception.Message }
    try {
        Invoke-Sql "BEGIN; DELETE FROM store_roles WHERE principal_issuer='$issuer' AND principal_subject='$subject'; DELETE FROM blocklist_entries WHERE source_action_id='$moderationActionId'; DELETE FROM moderation_actions WHERE id='$moderationActionId'; DELETE FROM moderation_cases WHERE id='$moderationCaseId'; DELETE FROM submissions WHERE id='$submissionId'; DELETE FROM artifacts WHERE id='$artifactId'; DELETE FROM releases WHERE id='$releaseId'; DELETE FROM packages WHERE id='$packageId'; DELETE FROM publisher_members WHERE publisher_id='$publisherId'; DELETE FROM publishers WHERE id='$publisherId'; COMMIT;"
        if ($portsClaimed) {
            Start-Sleep -Milliseconds 300
            foreach ($port in @($ApiPort, $WebPort, $AccountPort)) {
                if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
                    throw "Operator web runtime listener still owns TCP port $port after cleanup."
                }
            }
        }
    } catch { if (-not $cleanupFailure) { $cleanupFailure = $_ }; Write-Warning $_.Exception.Message }
    docker exec assetlibrary-postgres-1 rm -f /tmp/operator-web-runtime.sql *> $null
    Remove-Item -LiteralPath $sqlPath -Force -ErrorAction SilentlyContinue
    $logs | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
    if ($cleanupFailure) { throw $cleanupFailure }
}
