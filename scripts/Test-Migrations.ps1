$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$container = 'assetlibrary-postgres-1'
$database = "assetlibrary_migration_$PID"
$tempSql = Join-Path $env:TEMP "$database.sql"
$containerSql = "/tmp/$database.sql"

try {
    docker exec $container psql -U assetlibrary -d postgres -v ON_ERROR_STOP=1 `
        -c "CREATE DATABASE $database" | Out-Null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $builder = New-Object Text.StringBuilder
    foreach ($number in 1..6) {
        $path = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter ("{0:D4}_*.sql" -f $number) |
            Select-Object -First 1 -ExpandProperty FullName
        if (-not $path) { throw "Migration $number was not found." }
        [void] $builder.AppendLine([IO.File]::ReadAllText($path))
    }
    [void] $builder.AppendLine(@'
INSERT INTO publishers (id,slug,display_name,status) VALUES
('11111111-1111-4111-8111-111111111111','migration-publisher','Migration Publisher','active');
INSERT INTO publisher_members (publisher_id,principal_issuer,principal_subject,role) VALUES
('11111111-1111-4111-8111-111111111111','migration-issuer','migration-subject','owner');
INSERT INTO packages (id,publisher_id,slug,kind,status,name) VALUES
('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','migration-package','art','draft','Migration Package');
INSERT INTO releases (id,package_id,version,status,created_by_issuer,created_by_subject) VALUES
('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','1.0.0','draft','migration-issuer','migration-subject');
INSERT INTO submissions (id,release_id,status) VALUES
('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','open');
INSERT INTO reviews (submission_id,reviewer_issuer,reviewer_subject,status) VALUES
('44444444-4444-4444-8444-444444444444','migration-issuer','reviewer','pending');
INSERT INTO packages (id,publisher_id,slug,kind,status,name) VALUES
('66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','legacy-package','art','published','Legacy Package');
INSERT INTO releases (id,package_id,version,status,created_by_issuer,created_by_subject,published_at) VALUES
('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','0.9.0','published','migration-issuer','legacy',now());
INSERT INTO artifacts (id,release_id,status,object_key,sha256,canonical_sha256,size_bytes,media_type,
    verified_at,published_object_key,signature)
VALUES ('88888888-8888-4888-8888-888888888888','77777777-7777-4777-8777-777777777777','verified',
    'migration/legacy.zip',decode(repeat('88',32),'hex'),decode(repeat('88',32),'hex'),2048,
    'application/zip',now(),'sha256/88/' || repeat('88',32),'{"keyId":"legacy-key"}');
'@)
    $migration7 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0007_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration8 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0008_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration9 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0009_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration10 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0010_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration11 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0011_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration12 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0012_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration13 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0013_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration14 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0014_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration15 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0015_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $migration16 = Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '0016_*.sql' |
        Select-Object -First 1 -ExpandProperty FullName
    $lateMigrations = @($migration7, $migration8, $migration9, $migration10, $migration11, $migration12, $migration13, $migration14, $migration15, $migration16)
    foreach ($migration in @($lateMigrations; $lateMigrations)) {
        if (-not $migration) { throw 'Migration 0007 through 0016 was not found.' }
        [void] $builder.AppendLine([IO.File]::ReadAllText($migration))
    }
    [void] $builder.AppendLine(@'
BEGIN;
INSERT INTO artifacts (id,release_id,status,object_key,sha256,canonical_sha256,size_bytes,media_type,
    verified_at,published_object_key,signature)
VALUES ('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333','verified',
    'migration/fixture.zip',decode(repeat('55',32),'hex'),decode(repeat('55',32),'hex'),1024,
    'application/zip',now(),'sha256/55/' || repeat('55',32),'{"keyId":"migration-key"}');
UPDATE submissions SET status='approved',artifact_id='55555555-5555-4555-8555-555555555555'
WHERE id='44444444-4444-4444-8444-444444444444';
INSERT INTO published_release_artifacts(release_id,artifact_id,approval_submission_id,source,published_at)
VALUES ('33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555',
    '44444444-4444-4444-8444-444444444444','reviewed_submission',now());
UPDATE releases SET status='published',published_at=now()
WHERE id='33333333-3333-4333-8333-333333333333';
COMMIT;
'@)
    [IO.File]::WriteAllText($tempSql, $builder.ToString(), (New-Object Text.UTF8Encoding($false)))
    docker cp $tempSql "$container`:$containerSql" | Out-Null
    docker exec $container psql -U assetlibrary -d $database -v ON_ERROR_STOP=1 -f $containerSql | Out-Null
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $errorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    docker exec $container psql -U assetlibrary -d $database -v ON_ERROR_STOP=1 -c `
        "BEGIN; DELETE FROM published_release_artifacts WHERE release_id='33333333-3333-4333-8333-333333333333'; COMMIT;" 2>$null | Out-Null
    $bindingExit = $LASTEXITCODE
    $ErrorActionPreference = $errorAction
    if ($bindingExit -eq 0) { throw 'Publication binding constraint allowed the last approved artifact to be removed.' }

    $errorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    docker exec $container psql -U assetlibrary -d $database -v ON_ERROR_STOP=1 -c `
        "UPDATE releases SET created_by_subject='reassigned' WHERE id='33333333-3333-4333-8333-333333333333';" 2>$null | Out-Null
    $creatorExit = $LASTEXITCODE
    $ErrorActionPreference = $errorAction
    if ($creatorExit -eq 0) { throw 'Release creator fields were mutable after migration 0012.' }

    $result = docker exec $container psql -U assetlibrary -d $database -tAc `
        "SELECT (SELECT count(*) FROM migration_checkpoints WHERE migration_id IN ('0007_review_and_moderation','0008_library_and_downloads','0009_search_and_edge_policy','0010_public_catalog_read_indexes','0011_published_release_artifacts','0012_publisher_console_indexes','0013_operator_review_queue','0014_operator_moderation_queue','0015_publisher_moderation_cases')) || ':' || (SELECT revision FROM reviews LIMIT 1) || ':' || (SELECT visibility || ',' || cardinality(tags) FROM packages WHERE slug='migration-package') || ':' || (to_regclass('public.blocklist_entries') IS NOT NULL)::int || ':' || (to_regclass('public.projection_events') IS NOT NULL)::int || ':' || (to_regclass('public.edge_policy_projections') IS NOT NULL)::int || ':' || (to_regclass('public.packages_public_publisher_list_idx') IS NOT NULL)::int || ':' || (to_regclass('public.releases_public_package_list_idx') IS NOT NULL)::int || ':' || (to_regclass('public.publisher_members_principal_active_idx') IS NOT NULL)::int || ':' || (to_regclass('public.packages_owned_publisher_updated_idx') IS NOT NULL)::int || ':' || (to_regclass('public.releases_owned_package_created_idx') IS NOT NULL)::int || ':' || (to_regclass('public.review_queue_submitted_idx') IS NOT NULL)::int || ':' || (to_regclass('public.moderation_cases_operator_queue_idx') IS NOT NULL)::int || ':' || (to_regclass('public.moderation_actions_one_per_case_idx') IS NOT NULL)::int || ':' || (to_regclass('public.moderation_cases_publisher_list_idx') IS NOT NULL)::int || ':' || (SELECT count(*) FROM pg_constraint WHERE conrelid='submissions'::regclass AND conname='submissions_in_review_metadata_check' AND convalidated) || ':' || (SELECT count(*) FROM pg_constraint WHERE conrelid='moderation_actions'::regclass AND conname='moderation_actions_approval_actor_check' AND convalidated) || ':' || (SELECT count(*) FROM pg_constraint WHERE conrelid='moderation_cases'::regclass AND conname='moderation_cases_state_metadata_check' AND convalidated) || ':' || (SELECT count(*) FROM pg_trigger WHERE tgrelid='releases'::regclass AND tgname='protect_release_creator_fields' AND NOT tgisinternal) || ':' || (SELECT source FROM published_release_artifacts WHERE release_id='33333333-3333-4333-8333-333333333333') || ':' || (SELECT source FROM published_release_artifacts WHERE release_id='77777777-7777-4777-8777-777777777777')"
    if ($result.Trim() -ne '9:1:public,0:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:reviewed_submission:legacy_backfill') { throw "Migration invariant check failed: $result" }
    $proofResult = docker exec $container psql -U assetlibrary -d $database -tAc `
        "SELECT (SELECT count(*) FROM migration_checkpoints WHERE migration_id='0016_install_receipt_proof') || ':' || (to_regclass('public.install_receipts_download_session_idx') IS NOT NULL)::int || ':' || (SELECT count(*) FROM pg_constraint WHERE conrelid='install_receipts'::regclass AND conname='install_receipts_release_artifact_fkey');"
    if ($proofResult.Trim() -ne '1:1:1') { throw "Install receipt migration check failed: $proofResult" }
    Write-Output 'Migration runtime passed: clean install, legacy expansion, and replay through 0016.'
} finally {
    docker exec $container rm -f $containerSql *> $null
    docker exec $container psql -U assetlibrary -d postgres -c "DROP DATABASE IF EXISTS $database WITH (FORCE)" *> $null
    Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue
}
