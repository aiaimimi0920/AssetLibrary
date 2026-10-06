# SQL and object fixtures are inserted only into the run-owned PostgreSQL/MinIO.
function Invoke-RunSql([string] $Sql) {
    (Invoke-RunDocker @('exec', $Run.Postgres, 'psql', '-X', '-q', '-U', 'assetlibrary',
        '-d', 'assetlibrary', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', $Sql)).Text
}

function Initialize-RunSchema([switch] $MigrationsOnly) {
    foreach ($migration in (Get-ChildItem -LiteralPath "$($Run.Repo)/migrations" -Filter '*.sql' | Sort-Object Name)) {
        Invoke-RunDocker @('exec', $Run.Postgres, 'psql', '-X', '-q', '-U', 'assetlibrary',
            '-d', 'assetlibrary', '-v', 'ON_ERROR_STOP=1', '-f', "/migrations/$($migration.Name)") | Out-Null
    }
    if ($MigrationsOnly) { return }
    $sql = @'
INSERT INTO publishers (id,slug,display_name,status)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea1','neuro-fixture-publisher','Isolated Scanner Fixture','active');
INSERT INTO packages (id,publisher_id,slug,kind,status,name)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea2','018f47d2-4a75-7fa1-a12b-9a1f19d46ea1',
    'neuro-starter-art','art','draft','Isolated Scanner Fixture');
INSERT INTO releases (id,package_id,version,status,created_by_issuer,created_by_subject)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','018f47d2-4a75-7fa1-a12b-9a1f19d46ea2',
    '1.0.0-dev','draft','assetlibrary-development','isolated-fixture');
'@
    Invoke-RunSql $sql | Out-Null
}

function New-RunArtifact([string] $Filename, [string] $Digest, [long] $Size) {
    if ($Filename -notmatch '^[a-z0-9-]+\.zip$' -or $Digest -notmatch '^[0-9a-f]{64}$' -or $Size -le 0) {
        throw 'Invalid fixture input'
    }
    $artifact = [guid]::NewGuid().ToString()
    $session = [guid]::NewGuid().ToString()
    $event = [guid]::NewGuid().ToString()
    $key = "quarantine/018f47d2-4a75-7fa1-a12b-9a1f19d46ea3/$artifact/package.zip"
    Invoke-RunDocker @('exec', $Run.Minio, 'mc', 'cp', "/fixtures/$Filename", "local/assetlibrary-quarantine/$key") | Out-Null
    $sql = @"
BEGIN;
INSERT INTO artifacts (id,release_id,status,object_key,size_bytes,media_type)
VALUES ('$artifact','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','uploaded','$key',$Size,'application/zip');
INSERT INTO upload_sessions (id,release_id,artifact_id,principal_issuer,principal_subject,idempotency_key,
    request_digest,object_key,part_size_bytes,max_parts,expires_at,status,expected_digest)
VALUES ('$session','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3','$artifact','assetlibrary-development','isolated-fixture',
    '$session',decode(repeat('00',32),'hex'),'$key',5242880,1,now()+interval '1 hour','uploaded',
    '{"algorithm":"sha256","value":"sha256:$Digest"}');
COMMIT;
"@
    Invoke-RunSql $sql | Out-Null
    $item = [pscustomobject]@{ Id = $artifact; EventId = $event; Key = $key; Digest = $Digest; Size = $Size }
    Add-RunEvent $item $event
    $item
}

function Add-RunEvent($Artifact, [string] $EventId) {
    $event = [guid]::Parse($EventId).ToString()
    $id = [guid]::Parse($Artifact.Id).ToString()
    $sql = @"
INSERT INTO outbox_events (id,subject,schema_version,aggregate_type,aggregate_id,payload)
VALUES ('$event','assetlibrary.artifact.verification_requested.v1','1.0','artifact','$id',
jsonb_build_object('event_id','$event','occurred_at',now(),'schema_version','1.0',
    'actor',jsonb_build_object('type','system','id','isolated-scanner-runtime'),
    'package_id','018f47d2-4a75-7fa1-a12b-9a1f19d46ea2','release_id','018f47d2-4a75-7fa1-a12b-9a1f19d46ea3',
    'artifact_id','$id','object_key','$($Artifact.Key)','digest','sha256:$($Artifact.Digest)'));
"@
    Invoke-RunSql $sql | Out-Null
}

function Wait-RunArtifact($Artifact, [string] $Status, [int] $Seconds = 60) {
    Wait-RunCondition "$($Artifact.Id) becomes $Status" {
        (Invoke-RunSql "SELECT status FROM artifacts WHERE id='$($Artifact.Id)'") -eq $Status
    } $Seconds
}

function Get-RunArtifactEvidence($Artifact) {
    $sql = @"
SELECT json_build_object('id',a.id,'status',a.status,'attempts',a.scan_attempts,'last_error',a.last_scan_error,
    'raw_sha256',encode(a.sha256,'hex'),'canonical_sha256',encode(a.canonical_sha256,'hex'),
    'published_object_key',a.published_object_key,'session_status',(SELECT status FROM upload_sessions WHERE artifact_id=a.id),
    'retry_count',(SELECT count(*) FROM artifact_scan_attempts WHERE artifact_id=a.id AND result='retry'),
    'verified_attempts',(SELECT count(*) FROM artifact_scan_attempts WHERE artifact_id=a.id AND result='verified'),
    'verified_events',(SELECT count(*) FROM outbox_events WHERE aggregate_id=a.id AND subject='assetlibrary.artifact.verified.v1'),
    'quarantined_events',(SELECT count(*) FROM outbox_events WHERE aggregate_id=a.id AND subject='assetlibrary.artifact.quarantined.v1'),
    'verification_complete',a.manifest IS NOT NULL AND a.signature IS NOT NULL AND a.sbom_digest IS NOT NULL
        AND a.provenance_digest IS NOT NULL AND a.verified_at IS NOT NULL)
FROM artifacts a WHERE a.id='$($Artifact.Id)';
"@
    (Invoke-RunSql $sql) | ConvertFrom-Json
}

function Get-RunConsumer([int] $MonitorPort) {
    $monitor = Invoke-RestMethod "http://127.0.0.1:$MonitorPort/jsz?accounts=true&streams=true&consumers=true&config=true" -TimeoutSec 3
    $streams = @($monitor.account_details | ForEach-Object { $_.stream_detail } | Where-Object { $_.name -eq 'ASSETLIBRARY_EVENTS' })
    $consumers = @($streams | ForEach-Object { $_.consumer_detail } | Where-Object { $_.name -eq $Run.Id })
    if ($consumers.Count -ne 1) { throw 'Expected exactly one run-owned scanner consumer' }
    $consumers[0]
}
