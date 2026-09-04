param([int] $Port = 18084)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}

Push-Location $root
try {
    & cargo build -p assetlibrary-api --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

$publisherId = [guid]::NewGuid().ToString()
$packageId = [guid]::NewGuid().ToString()
$releaseId = [guid]::NewGuid().ToString()
$artifactId = [guid]::NewGuid().ToString()
$rejectedReleaseId = [guid]::NewGuid().ToString()
$rejectedArtifactId = [guid]::NewGuid().ToString()
$issuer = 'assetlibrary-development'
$sqlPath = Join-Path $env:TEMP "assetlibrary-workflow-$Port.sql"
$sql = @"
INSERT INTO publishers (id,slug,display_name,status) VALUES
('$publisherId','runtime-capability-$Port','Runtime Capability Publisher','active');
INSERT INTO publisher_members (publisher_id,principal_issuer,principal_subject,role,status) VALUES
('$publisherId','$issuer','workflow-publisher-$Port','owner','active');
INSERT INTO packages (id,publisher_id,slug,kind,status,name,summary) VALUES
('$packageId','$publisherId','runtime-capability-$Port','capability','draft','Runtime Capability','P4 runtime fixture');
INSERT INTO releases (id,package_id,version,status,created_by_issuer,created_by_subject) VALUES
('$releaseId','$packageId','1.0.0','draft','$issuer','workflow-publisher-$Port'),
('$rejectedReleaseId','$packageId','1.1.0','draft','$issuer','workflow-publisher-$Port');
INSERT INTO publisher_signing_keys (publisher_id,key_id,public_key,status) VALUES
('$publisherId','runtime-key',decode(repeat('11',32),'hex'),'active');
INSERT INTO artifacts (id,release_id,status,object_key,sha256,canonical_sha256,size_bytes,media_type,
verified_at,published_object_key,scanner_version,rule_version,scan_evidence,signature) VALUES
('$artifactId','$releaseId','verified','fixture/$artifactId.zip',decode(repeat('ab',32),'hex'),
decode(repeat('ab',32),'hex'),1024,'application/zip',now(),'sha256/ab/' || repeat('ab',32),'scanner-runtime','rules-runtime','{}','{"keyId":"runtime-key"}'),
('$rejectedArtifactId','$rejectedReleaseId','verified','fixture/$rejectedArtifactId.zip',decode(repeat('cd',32),'hex'),
decode(repeat('cd',32),'hex'),1024,'application/zip',now(),'sha256/cd/' || repeat('cd',32),'scanner-runtime','rules-runtime','{}','{"keyId":"runtime-key"}');
INSERT INTO store_roles (principal_issuer,principal_subject,role) VALUES
('$issuer','workflow-publisher-$Port','reviewer'),
('$issuer','workflow-reviewer-1-$Port','reviewer'),
('$issuer','workflow-reviewer-2-$Port','reviewer'),
('$issuer','workflow-operator-$Port','operator'),
('$issuer','workflow-moderator-1-$Port','moderator'),
('$issuer','workflow-moderator-2-$Port','moderator');
"@
[IO.File]::WriteAllText($sqlPath, $sql, (New-Object Text.UTF8Encoding($false)))
docker cp $sqlPath "assetlibrary-postgres-1:/tmp/workflow-runtime.sql" | Out-Null
docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f /tmp/workflow-runtime.sql | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:ASSETLIBRARY_BIND = "127.0.0.1:$Port"
$env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_APP_UPDATES_ENABLED = 'false'
$executable = Join-Path $root 'target/debug/assetlibrary-api.exe'
$stdout = Join-Path $env:TEMP "assetlibrary-workflow-$Port.stdout.log"
$stderr = Join-Path $env:TEMP "assetlibrary-workflow-$Port.stderr.log"
$process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr

function Headers([string] $Subject, [string] $Key) {
    return @{ Authorization = "Bearer dev-$Subject"; 'Idempotency-Key' = $Key; 'Content-Type' = 'application/json' }
}

function Expect-Status([scriptblock] $Action, [int] $Expected) {
    try {
        & $Action | Out-Null
        throw "Request unexpectedly succeeded; expected HTTP $Expected."
    } catch {
        if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne $Expected) { throw }
    }
}

try {
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        try { $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 }
        catch { $health = $null }
    } while (-not $health -and (Get-Date) -lt $deadline)
    if (-not $health) { throw 'Workflow API did not become healthy.' }

    $workspaceUri = "http://127.0.0.1:$Port/v1/me/releases/$releaseId/workspace"
    $initialWorkspaceResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $workspaceUri `
        -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" }
    $initialWorkspace = $initialWorkspaceResponse.Content | ConvertFrom-Json
    if ($initialWorkspaceResponse.Headers['Cache-Control'] -ne 'private, no-store' `
        -or $initialWorkspace.release_id -ne $releaseId -or $initialWorkspace.artifacts.Count -ne 1 `
        -or $initialWorkspace.artifacts[0].id -ne $artifactId -or $initialWorkspace.submission `
        -or -not $initialWorkspace.can_upload) {
        throw 'Publisher release workspace lost scope, artifact, upload readiness, or cache isolation.'
    }
    if ($initialWorkspaceResponse.Content -match 'object_key|scan_evidence|principal_|reviewer_|submitted_by_') {
        throw 'Publisher release workspace leaked storage, scanner evidence, or principal fields.'
    }

    $submitUri = "http://127.0.0.1:$Port/v1/me/releases/$releaseId/submissions"
    $submitBody = @{ artifact_id = $artifactId } | ConvertTo-Json
    $submission = Invoke-RestMethod -Method Post -Uri $submitUri `
        -Headers (Headers "workflow-publisher-$Port" "submit-runtime-$Port") -Body $submitBody
    $submissionAgain = Invoke-RestMethod -Method Post -Uri $submitUri `
        -Headers (Headers "workflow-publisher-$Port" "submit-runtime-$Port") -Body $submitBody
    if ($submission.id -ne $submissionAgain.id -or $submission.required_approvals -ne 2) {
        throw 'Capability submission was not idempotent or did not require two approvals.'
    }

    $rejectSubmitUri = "http://127.0.0.1:$Port/v1/me/releases/$rejectedReleaseId/submissions"
    $rejectSubmission = Invoke-RestMethod -Method Post -Uri $rejectSubmitUri `
        -Headers (Headers "workflow-publisher-$Port" "reject-submit-$Port") `
        -Body (@{ artifact_id = $rejectedArtifactId } | ConvertTo-Json)

    $queueResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/internal/review-queue?limit=1" `
        -Headers @{ Authorization = "Bearer dev-workflow-reviewer-1-$Port" }
    $queue = $queueResponse.Content | ConvertFrom-Json
    if ($queueResponse.Headers['Cache-Control'] -ne 'private, no-store' -or -not $queue.next_cursor) {
        throw 'Review queue lost private caching or stable cursor semantics.'
    }
    $nextQueue = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/internal/review-queue?limit=1&cursor=$([uri]::EscapeDataString($queue.next_cursor))" `
        -Headers @{ Authorization = "Bearer dev-workflow-reviewer-1-$Port" }
    $queuedIds = @($queue.items.submission.id; $nextQueue.items.submission.id)
    if (($queuedIds | Sort-Object -Unique).Count -ne 2 -or $queuedIds -notcontains $submission.id `
        -or $queuedIds -notcontains $rejectSubmission.id) {
        throw 'Stable review queue pagination duplicated or skipped a submission.'
    }
    if (-not $queue.items.package.name -or -not $queue.items.release_version) {
        throw 'Review queue did not include the bounded operator projection.'
    }

    $detailUri = "http://127.0.0.1:$Port/v1/internal/submissions/$($submission.id)"
    $detailResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $detailUri `
        -Headers @{ Authorization = "Bearer dev-workflow-reviewer-1-$Port" }
    $detail = $detailResponse.Content | ConvertFrom-Json
    if ($detailResponse.Headers['Cache-Control'] -ne 'private, no-store' -or -not $detail.can_review `
        -or $detail.evidence.digest -notmatch '^sha256:[0-9a-f]{64}$') {
        throw 'Operator submission detail lost cache, reviewability, or digest evidence.'
    }
    if ($detailResponse.Content -match 'object_key|scan_evidence|submitted_by_|reviewer_subject') {
        throw 'Operator submission detail leaked internal storage, scanner, or principal fields.'
    }
    $selfDetail = Invoke-RestMethod -Method Get -Uri $detailUri `
        -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" }
    if ($selfDetail.can_review) { throw 'Publisher member was marked eligible for self review.' }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Get -Uri $detailUri `
            -Headers @{ Authorization = "Bearer dev-workflow-moderator-1-$Port" } -ErrorAction Stop
    } 403

    $reviewUri = "http://127.0.0.1:$Port/v1/internal/submissions/$($submission.id)/reviews"
    $changesBody = @{ decision = 'needs_changes'; reason = 'Declare the network permission.'; findings = @(
        @{ code = 'capability.permission'; severity = 'error'; message = 'Permission evidence is missing.' }
    ) } | ConvertTo-Json -Depth 5
    $changes = Invoke-RestMethod -Method Post -Uri $reviewUri `
        -Headers (Headers "workflow-reviewer-1-$Port" "changes-runtime-$Port") -Body $changesBody
    if ($changes.submission.status -ne 'changes_requested') { throw 'Needs-changes review did not change submission state.' }
    $feedbackResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $workspaceUri `
        -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" }
    $feedbackWorkspace = $feedbackResponse.Content | ConvertFrom-Json
    if ($feedbackWorkspace.submission.status -ne 'changes_requested' `
        -or $feedbackWorkspace.feedback.Count -ne 1 `
        -or $feedbackWorkspace.feedback[0].decision -ne 'needs_changes' `
        -or $feedbackWorkspace.feedback[0].findings[0].code -ne 'capability.permission') {
        throw 'Publisher release workspace did not expose bounded review feedback.'
    }
    if ($feedbackResponse.Content -match 'reviewer_|submitted_by_|policy_evidence|scan_evidence|object_key') {
        throw 'Publisher review feedback leaked reviewer, policy, scanner, or storage internals.'
    }

    $resubmitted = Invoke-RestMethod -Method Post -Uri $submitUri `
        -Headers (Headers "workflow-publisher-$Port" "resubmit-runtime-$Port") -Body $submitBody
    if ($resubmitted.revision -ne 2 -or $resubmitted.approval_count -ne 0) {
        throw 'Resubmission did not invalidate prior-revision review evidence.'
    }
    $approveBody = @{ decision = 'approved'; reason = 'Policy checks passed.'; findings = @() } | ConvertTo-Json
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $reviewUri `
            -Headers (Headers "workflow-publisher-$Port" "self-review-$Port") -Body $approveBody -ErrorAction Stop
    } 403
    $first = Invoke-RestMethod -Method Post -Uri $reviewUri `
        -Headers (Headers "workflow-reviewer-1-$Port" "approve-one-$Port") -Body $approveBody
    if ($first.submission.status -ne 'in_review' -or $first.submission.approval_count -ne 1) {
        throw 'First capability approval bypassed the four-eyes gate.'
    }
    $reviewedDetail = Invoke-RestMethod -Method Get -Uri $detailUri `
        -Headers @{ Authorization = "Bearer dev-workflow-reviewer-1-$Port" }
    if ($reviewedDetail.can_review -or $reviewedDetail.reviews.Count -ne 1 `
        -or $reviewedDetail.reviews[0].decision -ne 'approved') {
        throw 'Submission detail did not reflect current-revision review history or reviewer eligibility.'
    }
    $second = Invoke-RestMethod -Method Post -Uri $reviewUri `
        -Headers (Headers "workflow-reviewer-2-$Port" "approve-two-$Port") -Body $approveBody
    if ($second.submission.status -ne 'approved' -or $second.submission.approval_count -ne 2) {
        throw 'Second independent approval did not approve the submission.'
    }

    $publishUri = "http://127.0.0.1:$Port/v1/internal/submissions/$($submission.id)/publish"
    $published = Invoke-RestMethod -Method Post -Uri $publishUri `
        -Headers (Headers "workflow-operator-$Port" "publish-runtime-$Port")
    if ($published.status -ne 'approved') { throw 'Publication response lost approved submission evidence.' }
    $publishedAgain = Invoke-RestMethod -Method Post -Uri $publishUri `
        -Headers (Headers "workflow-operator-$Port" "publish-runtime-$Port")
    if ($publishedAgain.id -ne $published.id) { throw 'Authorized publication replay lost its result.' }
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE store_roles SET status='revoked' WHERE principal_issuer='$issuer' AND principal_subject='workflow-operator-$Port'" | Out-Null
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $publishUri `
            -Headers (Headers "workflow-operator-$Port" "publish-runtime-$Port") -ErrorAction Stop
    } 403
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE store_roles SET status='active' WHERE principal_issuer='$issuer' AND principal_subject='workflow-operator-$Port'" | Out-Null
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_signing_keys SET status='revoked',revoked_at=now() WHERE publisher_id='$publisherId' AND key_id='runtime-key'" | Out-Null
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $publishUri `
            -Headers (Headers "workflow-operator-$Port" "publish-runtime-$Port") -ErrorAction Stop
    } 409
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_signing_keys SET status='active',revoked_at=NULL WHERE publisher_id='$publisherId' AND key_id='runtime-key'" | Out-Null
    $public = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/v1/public/packages/runtime-capability-$Port"
    if ($public.id -ne $packageId) { throw 'Published package was not visible in the public catalog.' }

    $rejectUri = "http://127.0.0.1:$Port/v1/internal/submissions/$($rejectSubmission.id)/reviews"
    $rejectBody = @{ decision = 'rejected'; reason = 'The package violates policy.'; findings = @() } | ConvertTo-Json
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_members SET status='revoked' WHERE publisher_id='$publisherId'" | Out-Null
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $submitUri `
            -Headers (Headers "workflow-publisher-$Port" "submit-runtime-$Port") `
            -Body $submitBody -ErrorAction Stop
    } 403
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $rejectUri `
            -Headers (Headers "workflow-publisher-$Port" "former-member-review-$Port") -Body $approveBody -ErrorAction Stop
    } 403
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_members SET status='active' WHERE publisher_id='$publisherId'" | Out-Null
    $rejected = Invoke-RestMethod -Method Post -Uri $rejectUri `
        -Headers (Headers "workflow-reviewer-1-$Port" "reject-runtime-$Port") -Body $rejectBody
    $rejectedAgain = Invoke-RestMethod -Method Post -Uri $rejectUri `
        -Headers (Headers "workflow-reviewer-1-$Port" "reject-runtime-$Port") -Body $rejectBody
    if ($rejected.submission.status -ne 'rejected' -or $rejectedAgain.review_id -ne $rejected.review_id) {
        throw 'Rejected review was not persisted idempotently.'
    }
    $withdrawUri = "http://127.0.0.1:$Port/v1/me/submissions/$($rejectSubmission.id)/withdraw"
    $withdrawBody = @{ reason = 'Publisher accepts the rejection.' } | ConvertTo-Json
    $withdrawn = Invoke-RestMethod -Method Post -Uri $withdrawUri `
        -Headers (Headers "workflow-publisher-$Port" "withdraw-runtime-$Port") -Body $withdrawBody
    $withdrawnAgain = Invoke-RestMethod -Method Post -Uri $withdrawUri `
        -Headers (Headers "workflow-publisher-$Port" "withdraw-runtime-$Port") -Body $withdrawBody
    if ($withdrawn.status -ne 'withdrawn' -or $withdrawnAgain.id -ne $withdrawn.id) {
        throw 'Submission withdrawal was not persisted idempotently.'
    }

    $reportBody = @{ release_id = $releaseId; reason = 'Runtime policy report.'; evidence_urls = @('https://example.invalid/evidence') } | ConvertTo-Json
    $case = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/me/packages/$packageId/reports" `
        -Headers (Headers "workflow-consumer-$Port" "report-runtime-$Port") -Body $reportBody
    $secondCase = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/me/packages/$packageId/reports" `
        -Headers (Headers "workflow-consumer-$Port" "report-second-$Port") `
        -Body (@{ release_id = $null; reason = 'Second bounded runtime report.'; evidence_urls = @() } | ConvertTo-Json)
    $caseQueueResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/internal/moderation-cases?limit=1" `
        -Headers @{ Authorization = "Bearer dev-workflow-moderator-1-$Port" }
    $caseQueue = $caseQueueResponse.Content | ConvertFrom-Json
    if ($caseQueueResponse.Headers['Cache-Control'] -ne 'private, no-store' -or -not $caseQueue.next_cursor) {
        throw 'Moderation queue lost private caching or stable cursor semantics.'
    }
    $nextCases = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/internal/moderation-cases?limit=1&cursor=$([uri]::EscapeDataString($caseQueue.next_cursor))" `
        -Headers @{ Authorization = "Bearer dev-workflow-moderator-1-$Port" }
    $caseIds = @($caseQueue.items.id; $nextCases.items.id)
    if (($caseIds | Sort-Object -Unique).Count -ne 2 -or $caseIds -notcontains $case.id `
        -or $caseIds -notcontains $secondCase.id) {
        throw 'Stable moderation queue pagination duplicated or skipped a case.'
    }
    if ($caseQueueResponse.Content -match 'reporter_|requested_by_|approved_by_|object_key|scan_evidence') {
        throw 'Moderation queue leaked principal, storage, or scanner fields.'
    }
    $caseDetailUri = "http://127.0.0.1:$Port/v1/internal/moderation-cases/$($case.id)"
    $caseDetailResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $caseDetailUri `
        -Headers @{ Authorization = "Bearer dev-workflow-moderator-1-$Port" }
    $caseDetail = $caseDetailResponse.Content | ConvertFrom-Json
    if ($caseDetailResponse.Headers['Cache-Control'] -ne 'private, no-store' -or -not $caseDetail.can_propose `
        -or $caseDetail.report_reason -ne 'Runtime policy report.' -or $caseDetail.actions.Count -ne 0) {
        throw 'Moderation detail lost cache, report, or proposal eligibility facts.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Get -Uri $caseDetailUri `
            -Headers @{ Authorization = "Bearer dev-workflow-reviewer-1-$Port" } -ErrorAction Stop
    } 403
    $proposalBody = @{ action = 'yank'; target_type = 'release'; target_ref = $releaseId; reason = 'Confirmed policy violation.' } | ConvertTo-Json
    $action = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/internal/moderation-cases/$($case.id)/actions" `
        -Headers (Headers "workflow-moderator-1-$Port" "propose-runtime-$Port") -Body $proposalBody
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$Port/v1/internal/moderation-cases/$($case.id)/actions" `
            -Headers (Headers "workflow-moderator-2-$Port" "duplicate-proposal-$Port") `
            -Body $proposalBody -ErrorAction Stop
    } 409
    $proposerDetail = Invoke-RestMethod -Method Get -Uri $caseDetailUri `
        -Headers @{ Authorization = "Bearer dev-workflow-moderator-1-$Port" }
    $approverDetail = Invoke-RestMethod -Method Get -Uri $caseDetailUri `
        -Headers @{ Authorization = "Bearer dev-workflow-moderator-2-$Port" }
    if ($proposerDetail.actions[0].can_approve -or -not $approverDetail.actions[0].can_approve `
        -or $approverDetail.can_propose) {
        throw 'Moderation detail did not preserve proposal or independent-approver eligibility.'
    }
    $approveActionUri = "http://127.0.0.1:$Port/v1/internal/moderation-actions/$($action.id)/approve"
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $approveActionUri `
            -Headers (Headers "workflow-moderator-1-$Port" "own-action-$Port") -ErrorAction Stop
    } 403
    $applied = Invoke-RestMethod -Method Post -Uri $approveActionUri `
        -Headers (Headers "workflow-moderator-2-$Port" "apply-runtime-$Port")
    $appliedAgain = Invoke-RestMethod -Method Post -Uri $approveActionUri `
        -Headers (Headers "workflow-moderator-2-$Port" "apply-runtime-$Port")
    if ($applied.status -ne 'applied' -or $appliedAgain.id -ne $applied.id) {
        throw 'Two-person moderation action was not applied idempotently.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/public/packages/runtime-capability-$Port" -ErrorAction Stop
    } 404
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $publishUri `
            -Headers (Headers "workflow-operator-$Port" "republish-yanked-$Port") -ErrorAction Stop
    } 409

    $conflictProposal = Invoke-RestMethod -Method Post `
        -Uri "http://127.0.0.1:$Port/v1/internal/moderation-cases/$($secondCase.id)/actions" `
        -Headers (Headers "workflow-moderator-1-$Port" "propose-conflict-$Port") -Body $proposalBody
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$Port/v1/internal/moderation-actions/$($conflictProposal.id)/approve" `
            -Headers (Headers "workflow-moderator-2-$Port" "approve-conflict-$Port") -ErrorAction Stop
    } 409

    $thirdCase = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/me/packages/$packageId/reports" `
        -Headers (Headers "workflow-consumer-$Port" "report-third-$Port") `
        -Body (@{ release_id = $rejectedReleaseId; reason = 'Artifact integrity report.'; evidence_urls = @() } | ConvertTo-Json)
    $artifactProposalBody = @{ action = 'revoke'; target_type = 'artifact'; target_ref = $rejectedArtifactId; reason = 'Artifact integrity violation.' } | ConvertTo-Json
    $artifactAction = Invoke-RestMethod -Method Post `
        -Uri "http://127.0.0.1:$Port/v1/internal/moderation-cases/$($thirdCase.id)/actions" `
        -Headers (Headers "workflow-moderator-1-$Port" "propose-artifact-$Port") -Body $artifactProposalBody
    $artifactApplied = Invoke-RestMethod -Method Post `
        -Uri "http://127.0.0.1:$Port/v1/internal/moderation-actions/$($artifactAction.id)/approve" `
        -Headers (Headers "workflow-moderator-2-$Port" "approve-artifact-$Port")
    if ($artifactApplied.status -ne 'applied') { throw 'Artifact blocklist enforcement was not applied.' }
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE moderation_cases SET created_at=(SELECT created_at FROM moderation_cases WHERE id='$($case.id)') WHERE id='$($thirdCase.id)'" | Out-Null

    $publisherCasesResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases?limit=1" `
        -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" }
    $publisherCases = $publisherCasesResponse.Content | ConvertFrom-Json
    if ($publisherCasesResponse.Headers['Cache-Control'] -ne 'private, no-store' -or -not $publisherCases.next_cursor) {
        throw 'Publisher moderation list lost private caching or stable pagination.'
    }
    $nextPublisherCases = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases?limit=1&cursor=$([uri]::EscapeDataString($publisherCases.next_cursor))" `
        -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" }
    $publisherCaseIds = @($publisherCases.items.id; $nextPublisherCases.items.id)
    if (($publisherCaseIds | Sort-Object -Unique).Count -ne 2 -or $publisherCaseIds -notcontains $case.id `
        -or $publisherCaseIds -notcontains $thirdCase.id -or $publisherCaseIds -contains $secondCase.id) {
        throw 'Publisher moderation pagination leaked an open case or skipped applied cases.'
    }
    if ($publisherCasesResponse.Content -match 'Runtime policy report|example.invalid/evidence|reporter_|requested_by_|approved_by_|object_key|scan_evidence') {
        throw 'Publisher moderation list leaked report, principal, storage, or scanner fields.'
    }
    $publisherCaseDetail = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases/$($case.id)" `
        -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" }
    if (-not $publisherCaseDetail.can_appeal -or $publisherCaseDetail.action_reason -ne 'Confirmed policy violation.' `
        -or $publisherCaseDetail.item.status -ne 'actioned') {
        throw 'Publisher moderation detail lost enforcement or appeal eligibility facts.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Get -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases/$($case.id)" `
            -Headers @{ Authorization = "Bearer dev-workflow-consumer-$Port" } -ErrorAction Stop
    } 404
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_members SET status='revoked' WHERE publisher_id='$publisherId'" | Out-Null
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Get -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases/$($case.id)" `
            -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" } -ErrorAction Stop
    } 404
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_members SET status='active' WHERE publisher_id='$publisherId'" | Out-Null

    $appealBody = @{ reason = 'Please re-evaluate the evidence.' } | ConvertTo-Json
    $appeal = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases/$($case.id)/appeal" `
        -Headers (Headers "workflow-publisher-$Port" "appeal-runtime-$Port") -Body $appealBody
    $appealAgain = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases/$($case.id)/appeal" `
        -Headers (Headers "workflow-publisher-$Port" "appeal-runtime-$Port") -Body $appealBody
    if ($appeal.status -ne 'appealed' -or $appealAgain.id -ne $appeal.id) {
        throw 'Publisher appeal did not enter appealed state or replay idempotently.'
    }
    Expect-Status {
        Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases/$($case.id)/appeal" `
            -Headers (Headers "workflow-publisher-$Port" "appeal-again-$Port") `
            -Body (@{ reason = 'A different reason must not be audited without persistence.' } | ConvertTo-Json) `
            -ErrorAction Stop
    } 409
    $appealedDetail = Invoke-RestMethod -Method Get -Uri $caseDetailUri `
        -Headers @{ Authorization = "Bearer dev-workflow-moderator-2-$Port" }
    if (-not $appealedDetail.can_resolve -or $appealedDetail.appeal.reason -ne 'Please re-evaluate the evidence.') {
        throw 'Moderation detail did not expose the bounded appeal to its resolver.'
    }
    $publisherAppealedDetail = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases/$($case.id)" `
        -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" }
    if ($publisherAppealedDetail.can_appeal -or $publisherAppealedDetail.appeal.reason -ne 'Please re-evaluate the evidence.') {
        throw 'Publisher moderation detail did not expose the persisted appeal state.'
    }
    $resolveBody = @{ resolution = 'upheld'; reason = 'The independent evidence remains valid.' } | ConvertTo-Json
    $resolved = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/internal/moderation-cases/$($case.id)/resolve" `
        -Headers (Headers "workflow-moderator-2-$Port" "resolve-runtime-$Port") -Body $resolveBody
    if ($resolved.status -ne 'resolved') { throw 'Appeal resolution did not close the moderation case.' }
    $resolvedDetail = Invoke-RestMethod -Method Get -Uri $caseDetailUri `
        -Headers @{ Authorization = "Bearer dev-workflow-moderator-2-$Port" }
    if ($resolvedDetail.can_resolve -or $resolvedDetail.appeal.resolution -ne 'upheld' `
        -or $resolvedDetail.actions[0].status -ne 'applied') {
        throw 'Resolved moderation detail is inconsistent with the applied action and appeal result.'
    }
    if (($resolvedDetail | ConvertTo-Json -Depth 8) -match 'reporter_|requested_by_|approved_by_|object_key|scan_evidence') {
        throw 'Moderation detail leaked principal, storage, or raw scanner fields.'
    }
    $publisherResolvedDetail = Invoke-RestMethod -Method Get `
        -Uri "http://127.0.0.1:$Port/v1/me/moderation-cases/$($case.id)" `
        -Headers @{ Authorization = "Bearer dev-workflow-publisher-$Port" }
    if ($publisherResolvedDetail.item.status -ne 'resolved' -or $publisherResolvedDetail.can_appeal `
        -or $publisherResolvedDetail.appeal.resolution -ne 'upheld') {
        throw 'Publisher moderation detail did not expose the bounded appeal resolution.'
    }

    $facts = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc `
        "SELECT (SELECT count(*) FROM audit_events WHERE resource_id IN ('$($submission.id)','$($case.id)','$($action.id)')) || ':' || (SELECT count(*) FROM outbox_events WHERE aggregate_id IN ('$releaseId','$packageId','$($case.id)')) || ':' || (SELECT count(*) FROM published_release_artifacts WHERE release_id='$releaseId' AND artifact_id='$artifactId' AND approval_submission_id='$($submission.id)' AND source='reviewed_submission')"
    $parts = $facts.Trim().Split(':')
    if ([int] $parts[0] -lt 8 -or [int] $parts[1] -lt 5 -or $parts[2] -ne '1') {
        throw "Workflow audit, outbox, or publication binding evidence is incomplete: $facts"
    }
    $appealAudits = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc `
        "SELECT count(*) FROM audit_events WHERE resource_id='$($case.id)' AND action='moderation.appealed'"
    if ($appealAudits.Trim() -ne '1') { throw "Appeal replay duplicated its audit event: $appealAudits" }
    Write-Output "Workflow runtime passed: publisher workspace=sanitized, revoked member/operator/key replays=denied, revision=2, approvals=2, publication binding=1, moderation=two-person, audit=$($parts[0]), outbox=$($parts[1])."
} finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    if ($process) { Wait-Process -Id $process.Id -ErrorAction SilentlyContinue }
    $cleanupSql = @"
BEGIN;
DELETE FROM idempotency_keys WHERE principal_issuer='$issuer' AND principal_subject LIKE '%-$Port';
DELETE FROM audit_events WHERE actor_issuer='$issuer' AND actor_subject LIKE '%-$Port';
DELETE FROM outbox_events WHERE payload->>'package_id'='$packageId' OR aggregate_id IN ('$packageId','$releaseId','$rejectedReleaseId');
DELETE FROM blocklist_entries WHERE source_action_id IN (SELECT id FROM moderation_actions WHERE case_id IN (SELECT id FROM moderation_cases WHERE package_id='$packageId'));
DELETE FROM moderation_actions WHERE case_id IN (SELECT id FROM moderation_cases WHERE package_id='$packageId');
DELETE FROM moderation_cases WHERE package_id='$packageId';
DELETE FROM reviews WHERE submission_id IN (SELECT id FROM submissions WHERE release_id IN ('$releaseId','$rejectedReleaseId'));
DELETE FROM published_release_artifacts WHERE release_id IN ('$releaseId','$rejectedReleaseId');
DELETE FROM submissions WHERE release_id IN ('$releaseId','$rejectedReleaseId');
DELETE FROM artifacts WHERE id IN ('$artifactId','$rejectedArtifactId');
DELETE FROM releases WHERE id IN ('$releaseId','$rejectedReleaseId');
DELETE FROM packages WHERE id='$packageId';
DELETE FROM publisher_members WHERE publisher_id='$publisherId';
DELETE FROM publisher_signing_keys WHERE publisher_id='$publisherId';
DELETE FROM store_roles WHERE principal_issuer='$issuer' AND principal_subject LIKE '%-$Port';
DELETE FROM publishers WHERE id='$publisherId';
COMMIT;
"@
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c $cleanupSql *> $null
    docker exec assetlibrary-postgres-1 rm -f /tmp/workflow-runtime.sql *> $null
    Remove-Item -LiteralPath $sqlPath -Force -ErrorAction SilentlyContinue
}
