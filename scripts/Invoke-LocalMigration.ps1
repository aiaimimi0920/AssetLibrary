$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
$migrationPaths = @(Get-ChildItem -LiteralPath (Join-Path $root 'migrations') -Filter '*.sql' |
    Sort-Object Name | Select-Object -ExpandProperty FullName)
$copiedNames = New-Object Collections.Generic.List[string]

if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}

$container = 'assetlibrary-postgres-1'
$tempSql = Join-Path $env:TEMP 'assetlibrary-migration.sql'
try {
    foreach ($migrationPath in $migrationPaths) {
        if (-not (Test-Path -LiteralPath $migrationPath)) { throw "Missing migration: $migrationPath" }
        $name = [IO.Path]::GetFileName($migrationPath)
        if ($name.StartsWith('0001')) {
            $exists = docker exec $container psql -U assetlibrary -d assetlibrary -tAc "SELECT to_regclass('public.publishers') IS NOT NULL"
            if ($exists.Trim() -eq 't') { continue }
        } else {
            $migrationId = [IO.Path]::GetFileNameWithoutExtension($migrationPath)
            $applied = docker exec $container psql -U assetlibrary -d assetlibrary -tAc "SELECT EXISTS (SELECT 1 FROM migration_checkpoints WHERE migration_id = '$migrationId')"
            if ($applied.Trim() -eq 't') { continue }
        }
        Copy-Item -LiteralPath $migrationPath -Destination $tempSql -Force
        docker cp $tempSql "$container`:/tmp/$name"
        $copiedNames.Add($name)
        docker exec -e "PGPASSWORD=$env:POSTGRES_PASSWORD" $container psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -f "/tmp/$name"
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    $tableCount = docker exec $container psql -U assetlibrary -d assetlibrary -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('publishers','packages','releases','artifacts','outbox_events')"
    if ([int] $tableCount.Trim() -ne 5) { throw "Expected five catalog tables, found $tableCount" }
    $extensions = docker exec $container psql -U assetlibrary -d assetlibrary -tAc "SELECT extname FROM pg_extension WHERE extname IN ('citext','pgcrypto') ORDER BY extname"
    if (($extensions -split '\r?\n' | Where-Object { $_.Trim() }).Count -ne 2) { throw 'Required PostgreSQL extensions are missing.' }
    Write-Output 'PostgreSQL migration passed: catalog tables and extensions are present.'
} finally {
    $copiedNames | ForEach-Object { docker exec $container rm -f "/tmp/$_" *> $null }
    Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue
}
