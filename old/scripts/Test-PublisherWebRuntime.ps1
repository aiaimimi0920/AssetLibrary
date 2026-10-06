param(
    [int] $ApiPort = 18108,
    [int] $WebPort = 18109,
    [int] $AccountPort = 18110
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
$caseId = [guid]::NewGuid().ToString()
$actionId = [guid]::NewGuid().ToString()
$subject = "publisher-web-$runId-account"
$issuer = 'assetlibrary-development'
$accessToken = "dev-$subject"
$cookieName = 'neuro_session'
$cookieValue = "session-$runId"
$publisherName = "Publisher Web $runId"
$packageName = "Private Draft $runId"
$packageSlug = "private-draft-$runId"
$actionReason = "Publisher enforcement notice $runId"
$reportSentinel = "private-report-$runId"
$storageSentinel = "internal-storage-$runId"
$artifactFileName = "publisher-web-$runId.zip"
$signingKeyId = "publisher-web-$runId"
$signingKeyBase64 = 'ERERERERERERERERERERERERERERERERERERERERERE='
$signingKeyFingerprint = 'sha256:02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc'
$sqlPath = Join-Path $env:TEMP "assetlibrary-publisher-web-$runId.sql"
$logs = @()
$processes = @()
$stage = 'setup'
$portsClaimed = $false

function Invoke-Sql([string] $Sql) {
    [IO.File]::WriteAllText($sqlPath, $Sql, (New-Object Text.UTF8Encoding($false)))
    docker cp $sqlPath "assetlibrary-postgres-1:/tmp/publisher-web-runtime.sql" | Out-Null
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 `
        -f /tmp/publisher-web-runtime.sql | Out-Null
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

function Get-PublisherPage([switch] $Authenticated, [string] $Path = '/publisher') {
    $request = @{ UseBasicParsing = $true; Uri = "http://127.0.0.1:$WebPort$Path" }
    if ($Authenticated) { $request.WebSession = $script:authenticatedSession }
    return Invoke-WebRequest @request
}

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:ASSETLIBRARY_BIND = "127.0.0.1:$ApiPort"
$env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_API_URL = "http://127.0.0.1:$ApiPort"
$env:ASSETLIBRARY_PUBLIC_URL = "http://127.0.0.1:$WebPort"
$env:ASSETLIBRARY_UPLOAD_ORIGINS = 'http://127.0.0.1:9100'
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
VALUES ('$publisherId','publisher-web-$runId','$publisherName','active');
INSERT INTO publisher_members(publisher_id,principal_issuer,principal_subject,role,status)
VALUES ('$publisherId','$issuer','$subject','owner','active');
INSERT INTO publisher_signing_keys(publisher_id,key_id,public_key,status)
VALUES ('$publisherId','$signingKeyId',decode(repeat('11',32),'hex'),'active');
INSERT INTO packages(id,publisher_id,slug,kind,status,visibility,name,summary,description,tags)
VALUES ('$packageId','$publisherId','$packageSlug','art','draft','private','$packageName',
        'Private publisher SSR package','Bounded private description',ARRAY['art','runtime']);
INSERT INTO releases(id,package_id,version,status,compatibility,permissions,created_by_issuer,created_by_subject)
VALUES ('$releaseId','$packageId','1.0.0','draft','{"products":[{"name":"loom","version_requirement":">=0.1.0"}]}',
        '["filesystem.read-project"]','$issuer','private-release-creator-$runId');
INSERT INTO artifacts(id,release_id,status,object_key,size_bytes,media_type)
VALUES ('$artifactId','$releaseId','uploaded','quarantine/$storageSentinel/$artifactFileName',1048576,'application/zip');
INSERT INTO moderation_cases(id,package_id,status,reason,evidence,reporter_issuer,reporter_subject,evidence_urls)
VALUES ('$caseId','$packageId','actioned','$reportSentinel','{}','private-reporter-issuer',
        'private-reporter-subject','["https://evidence.internal.invalid/report"]');
INSERT INTO moderation_actions(id,case_id,action,target_type,target_ref,reason,status,
        requested_by_issuer,requested_by_subject,approved_by_issuer,approved_by_subject,applied_at)
VALUES ('$actionId','$caseId','block','package','$packageId','$actionReason','applied',
        'private-proposer-issuer','private-proposer-subject','private-approver-issuer',
        'private-approver-subject',now());
INSERT INTO blocklist_entries(target_type,target_ref,status,reason,source_action_id)
VALUES ('package','$packageId','active','$actionReason','$actionId');
COMMIT;
"@

try {
    $stage = 'claim ports and seed fixture'
    @($ApiPort, $WebPort, $AccountPort) | ForEach-Object { Assert-PortFree $_ }
    $portsClaimed = $true
    Invoke-Sql $seed

    $stage = 'start independent services'
    $api = Start-Hidden 'publisher-web-api' (Join-Path $root 'target/debug/assetlibrary-api.exe')
    $account = Start-Hidden 'publisher-account' 'node.exe' `
        @((Join-Path $root 'scripts/fixtures/account-service.mjs'))
    Wait-Http "http://127.0.0.1:$ApiPort/healthz" $api
    Wait-Http "http://127.0.0.1:$AccountPort/healthz" $account
    $web = Start-Hidden 'publisher-web-next' 'pnpm.cmd' `
        @('--dir', (Join-Path $root 'apps/web'), 'start', '-p', "$WebPort")
    Wait-Http "http://127.0.0.1:$WebPort/healthz" $web

    $stage = 'direct service boundaries'
    $accountSession = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$AccountPort/v1/session" `
        -WebSession $authenticatedSession
    if ($accountSession.access_token -ne $accessToken -or $accountSession.principal.subject -ne $subject) {
        throw 'Independent Account Service returned the wrong session contract.'
    }
    $directMemberships = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/me/publishers" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    if ($directMemberships.items.Count -ne 1 -or $directMemberships.items[0].publisher.id -ne $publisherId) {
        throw 'Publisher API did not authorize the Account Service bearer.'
    }
    $directSigningKeysResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/me/publishers/$publisherId/signing-keys" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    $directSigningKeys = $directSigningKeysResponse.Content | ConvertFrom-Json
    if ($directSigningKeysResponse.Headers['Cache-Control'] -ne 'private, no-store' `
        -or $directSigningKeys.items.Count -ne 1 -or $directSigningKeys.items[0].key_id -ne $signingKeyId `
        -or $directSigningKeys.items[0].fingerprint -ne $signingKeyFingerprint) {
        throw 'Publisher signing-key API lost scope, fingerprint, or cache isolation.'
    }
    $directReleaseResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/me/releases/$releaseId" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    $directRelease = $directReleaseResponse.Content | ConvertFrom-Json
    if ($directRelease.id -ne $releaseId -or $directRelease.status -ne 'draft' `
        -or $directReleaseResponse.Headers['Cache-Control'] -ne 'private, no-store') {
        throw 'Publisher release detail API lost identity, status, or cache isolation.'
    }
    $directWorkspaceResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/me/releases/$releaseId/workspace" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    $directWorkspace = $directWorkspaceResponse.Content | ConvertFrom-Json
    if ($directWorkspaceResponse.Headers['Cache-Control'] -ne 'private, no-store' `
        -or $directWorkspace.release_id -ne $releaseId -or $directWorkspace.artifacts.Count -ne 1 `
        -or $directWorkspace.artifacts[0].file_name -ne $artifactFileName `
        -or $directWorkspace.artifacts[0].status -ne 'uploaded' -or -not $directWorkspace.can_upload) {
        throw 'Publisher supply-chain API lost scope, artifact state, or private caching.'
    }
    if ($directWorkspaceResponse.Content -match [regex]::Escape($storageSentinel) `
        -or $directWorkspaceResponse.Content -match 'object_key|scan_evidence|principal_|reviewer_') {
        throw 'Publisher supply-chain API leaked storage, scanner evidence, or principal fields.'
    }
    $directCasesResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/me/moderation-cases" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    $directCases = $directCasesResponse.Content | ConvertFrom-Json
    $directCase = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$ApiPort/v1/me/moderation-cases/$caseId" `
        -Headers @{ Authorization = "Bearer $accessToken" }
    if ($directCasesResponse.Headers['Cache-Control'] -ne 'private, no-store' `
        -or $directCases.items.Count -ne 1 -or $directCases.items[0].id -ne $caseId `
        -or -not $directCase.can_appeal -or $directCase.action_reason -ne $actionReason) {
        throw 'Publisher moderation API lost scope, cache, enforcement, or appeal facts.'
    }
    if ($directCasesResponse.Content -match $reportSentinel `
        -or ($directCase | ConvertTo-Json -Depth 8) -match 'reporter_|evidence_urls|private-proposer|private-approver') {
        throw 'Publisher moderation API leaked report evidence or internal principals.'
    }
    try {
        Invoke-WebRequest -UseBasicParsing -Method Get `
            -Uri "http://127.0.0.1:$ApiPort/v1/me/moderation-cases/$caseId" `
            -Headers @{ Authorization = 'Bearer dev-unrelated-publisher-runtime' } -ErrorAction Stop | Out-Null
        throw 'Unrelated principal unexpectedly read a Publisher moderation case.'
    } catch {
        if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne 404) { throw }
    }

    $stage = 'authenticated Publisher SSR'
    $publisher = Get-PublisherPage -Authenticated
    foreach ($value in @($publisherName, $packageName, 'Private publisher SSR package', '创建包草稿')) {
        if ($publisher.Content -notmatch [regex]::Escape($value)) {
            $states = @('需要外部账号会话','账号适配器尚未配置','账号服务暂时不可用',
                '账号会话响应无效','Publisher 数据暂时不可用','没有访问该工作区的权限')
            $state = @($states | Where-Object { $publisher.Content -match [regex]::Escape($_) }) -join ','
            throw "Publisher SSR omitted $value (rendered state: $state)."
        }
    }
    foreach ($secret in @($accessToken, $subject, $issuer, $cookieValue)) {
        if ($publisher.Content -match [regex]::Escape($secret)) { throw 'Publisher SSR leaked server identity data.' }
    }
    if ($publisher.Headers['Cache-Control'] -notmatch 'no-store' `
        -or $publisher.Headers['X-Robots-Tag'] -notmatch 'noindex' `
        -or $publisher.Headers['X-Frame-Options'] -ne 'DENY') {
        throw 'Publisher private-cache or security headers failed.'
    }

    $stage = 'authenticated draft forms'
    $packageForm = Get-PublisherPage -Authenticated -Path "/publisher/packages/new?publisher=$publisherId"
    $releaseForm = Get-PublisherPage -Authenticated `
        -Path "/publisher/packages/$packageId/releases/new?publisher=$publisherId"
    $packageWorkspace = Get-PublisherPage -Authenticated -Path "/publisher/packages/$packageId"
    $releaseWorkspace = Get-PublisherPage -Authenticated `
        -Path "/publisher/packages/$packageId/releases/$releaseId"
    if ($packageForm.Content -notmatch '创建独立安装包' -or $packageForm.Content -notmatch $publisherName `
        -or $releaseForm.Content -notmatch '创建不可变版本' -or $releaseForm.Content -notmatch $packageName `
        -or $releaseForm.Content -notmatch $packageSlug) {
        throw 'Publisher package or release form was not backed by real authorized resources.'
    }
    foreach ($value in @('PACKAGE RELEASE WORKSPACE','保存 Package 草稿',$packageSlug,'1.0.0','管理 Release')) {
        if ($packageWorkspace.Content -notmatch [regex]::Escape($value)) {
            throw "Publisher Package workspace omitted $value."
        }
    }
    foreach ($value in @('RELEASE CONTROL PLANE','保存 Release 草稿','filesystem.read-project',
        '&gt;=0.1.0','上传 ZIP Artifact',$artifactFileName,'等待扫描','文件仍是不可信输入')) {
        if ($releaseWorkspace.Content -notmatch [regex]::Escape($value)) {
            throw "Publisher Release workspace omitted $value."
        }
    }
    foreach ($response in @($packageForm, $releaseForm, $packageWorkspace, $releaseWorkspace)) {
        foreach ($secret in @($accessToken, $subject, $issuer, $cookieValue,
            "private-release-creator-$runId", $storageSentinel)) {
            if ($response.Content -match [regex]::Escape($secret)) {
                throw 'Publisher form or workspace leaked Account Service or creator identity.'
            }
        }
        if ($response.Headers['Cache-Control'] -notmatch 'no-store' `
            -or $response.Headers['X-Robots-Tag'] -notmatch 'noindex') {
            throw 'Publisher form or workspace lost private response headers.'
        }
    }

    $stage = 'authenticated signing-key SSR'
    $signingKeys = Get-PublisherPage -Authenticated `
        -Path "/publisher/signing-keys?publisher=$publisherId"
    foreach ($value in @('私钥永远不会进入商店', $signingKeyId, $signingKeyBase64,
        $signingKeyFingerprint, '注册公钥', '不可逆吊销')) {
        if ($signingKeys.Content -notmatch [regex]::Escape($value)) {
            throw "Publisher signing-key SSR omitted $value."
        }
    }
    foreach ($secret in @($accessToken, $subject, $issuer, $cookieValue, 'private_key', 'secret_key')) {
        if ($signingKeys.Content -match [regex]::Escape($secret)) {
            throw 'Publisher signing-key SSR leaked identity or private key material.'
        }
    }
    if ($signingKeys.Headers['Cache-Control'] -notmatch 'no-store' `
        -or $signingKeys.Headers['X-Robots-Tag'] -notmatch 'noindex' `
        -or $signingKeys.Headers['X-Frame-Options'] -ne 'DENY') {
        throw 'Publisher signing-key SSR security headers failed.'
    }

    $stage = 'authenticated Publisher moderation SSR'
    $moderation = Get-PublisherPage -Authenticated -Path '/publisher/moderation'
    $moderationCase = Get-PublisherPage -Authenticated -Path "/publisher/moderation/$caseId"
    foreach ($value in @('处罚与申诉', $packageName, $actionReason, '提交正式申诉')) {
        if ($moderation.Content -notmatch [regex]::Escape($value) `
            -and $moderationCase.Content -notmatch [regex]::Escape($value)) {
            throw "Publisher moderation SSR omitted $value."
        }
    }
    foreach ($content in @($moderation.Content, $moderationCase.Content)) {
        foreach ($secret in @($accessToken, $subject, $issuer, $cookieValue, $reportSentinel,
            'private-reporter', 'private-proposer', 'private-approver', 'evidence.internal.invalid')) {
            if ($content -match [regex]::Escape($secret)) { throw 'Publisher moderation SSR leaked private data.' }
        }
    }
    foreach ($response in @($moderation, $moderationCase)) {
        if ($response.Headers['Cache-Control'] -notmatch 'no-store' `
            -or $response.Headers['X-Robots-Tag'] -notmatch 'noindex' `
            -or $response.Headers['X-Frame-Options'] -ne 'DENY') {
            throw 'Publisher moderation SSR security headers failed.'
        }
    }

    $stage = 'revoked membership gate'
    Invoke-Sql "UPDATE publisher_members SET status='revoked' WHERE publisher_id='$publisherId';"
    $revoked = Get-PublisherPage -Authenticated -Path "/publisher/moderation/$caseId"
    $revokedPackage = Get-PublisherPage -Authenticated -Path "/publisher/packages/$packageId"
    $revokedRelease = Get-PublisherPage -Authenticated `
        -Path "/publisher/packages/$packageId/releases/$releaseId"
    $revokedSigningKeys = Get-PublisherPage -Authenticated `
        -Path "/publisher/signing-keys?publisher=$publisherId"
    if ($revoked.Content -notmatch '没有访问该工作区的权限' `
        -or $revoked.Content -match [regex]::Escape($actionReason) `
        -or $revokedPackage.Content -notmatch '没有访问该工作区的权限' `
        -or $revokedPackage.Content -match '保存 Package 草稿' `
        -or $revokedRelease.Content -notmatch '没有访问该工作区的权限' `
        -or $revokedRelease.Content -match '保存 Release 草稿' `
        -or $revokedSigningKeys.Content -notmatch '没有访问该工作区的权限' `
        -or $revokedSigningKeys.Content -match [regex]::Escape($signingKeyBase64)) {
        throw 'Revoked membership did not fail closed for Publisher moderation, release editing, and keys.'
    }
    Invoke-Sql "UPDATE publisher_members SET status='active' WHERE publisher_id='$publisherId';"

    $stage = 'unauthenticated identity gate'
    $unauthenticated = Get-PublisherPage
    if ($unauthenticated.Content -notmatch '需要外部账号会话' `
        -or $unauthenticated.Content -match [regex]::Escape($packageName)) {
        throw 'Missing Account Service session did not fail closed.'
    }

    $stage = 'Publisher API outage gate'
    Stop-ProcessTree $api.Id
    Wait-Process -Id $api.Id -ErrorAction SilentlyContinue
    $apiUnavailable = Get-PublisherPage -Authenticated
    if ($apiUnavailable.Content -notmatch 'Publisher 数据暂时不可用' `
        -or $apiUnavailable.Content -match [regex]::Escape($packageName)) {
        throw 'Publisher API outage was not rendered explicitly.'
    }

    $stage = 'Account Service outage gate'
    $api = Start-Hidden 'publisher-web-api-restarted' (Join-Path $root 'target/debug/assetlibrary-api.exe')
    Wait-Http "http://127.0.0.1:$ApiPort/healthz" $api
    Stop-ProcessTree $account.Id
    Wait-Process -Id $account.Id -ErrorAction SilentlyContinue
    $accountUnavailable = Get-PublisherPage -Authenticated
    if ($accountUnavailable.Content -notmatch '账号服务暂时不可用') {
        throw 'Account Service outage was not rendered explicitly.'
    }

    Write-Output 'Publisher web runtime passed: external session exchange, editable Package workspace, public-key-only trust workspace, sanitized supply-chain workspace, scoped moderation and appeal SSR, no-store headers, no identity leakage, and fail-closed dependency gates.'
} catch {
    Write-Warning "Publisher web runtime failed at $stage`: $($_.Exception.Message)"
    throw
} finally {
    $cleanupFailure = $null
    try {
        $processes | ForEach-Object { Stop-ProcessTree $_.Id }
        $processes | ForEach-Object { Wait-Process -Id $_.Id -ErrorAction SilentlyContinue }
        if ($portsClaimed) {
            @($ApiPort, $WebPort, $AccountPort) | ForEach-Object { Stop-OwnedListener $_ }
        }
    } catch { $cleanupFailure = $_; Write-Warning $_.Exception.Message }
    try {
        Invoke-Sql "BEGIN; DELETE FROM blocklist_entries WHERE source_action_id='$actionId'; DELETE FROM moderation_actions WHERE id='$actionId'; DELETE FROM moderation_cases WHERE id='$caseId'; DELETE FROM artifacts WHERE id='$artifactId'; DELETE FROM releases WHERE id='$releaseId'; DELETE FROM packages WHERE id='$packageId'; DELETE FROM publisher_signing_keys WHERE publisher_id='$publisherId'; DELETE FROM publisher_members WHERE publisher_id='$publisherId'; DELETE FROM publishers WHERE id='$publisherId'; COMMIT;"
        if ($portsClaimed) {
            Start-Sleep -Milliseconds 300
            foreach ($port in @($ApiPort, $WebPort, $AccountPort)) {
                if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
                    throw "Publisher web runtime listener still owns TCP port $port after cleanup."
                }
            }
        }
    } catch { if (-not $cleanupFailure) { $cleanupFailure = $_ }; Write-Warning $_.Exception.Message }
    docker exec assetlibrary-postgres-1 rm -f /tmp/publisher-web-runtime.sql *> $null
    Remove-Item -LiteralPath $sqlPath -Force -ErrorAction SilentlyContinue
    $logs | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
    if ($cleanupFailure) { throw $cleanupFailure }
}
