param([int] $TimeoutSeconds = 20)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run Start-LocalDependencies.ps1 first.' }
Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
$env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
$env:ASSETLIBRARY_NATS_URL = 'nats://127.0.0.1:4222'

Push-Location $root
try {
    cargo build -p assetlibrary-outbox-worker --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
$executable = Join-Path $root 'target/debug/assetlibrary-outbox-worker.exe'
$stdout = Join-Path $env:TEMP 'assetlibrary-outbox.stdout.log'
$stderr = Join-Path $env:TEMP 'assetlibrary-outbox.stderr.log'
$process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
try {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $pending = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc "SELECT count(*) FROM outbox_events WHERE published_at IS NULL"
    } while ([int] $pending.Trim() -ne 0 -and (Get-Date) -lt $deadline)
    if ([int] $pending.Trim() -ne 0) { throw "Outbox Worker left $pending events unpublished." }
    $jetstream = Invoke-RestMethod -Uri 'http://127.0.0.1:8222/jsz?streams=true'
    $stream = $jetstream.account_details.stream_detail | Where-Object { $_.name -eq 'ASSETLIBRARY_EVENTS' }
    if (-not $stream -or [long] $stream.state.messages -lt 1) {
        throw 'JetStream does not contain the dispatched AssetLibrary events.'
    }
    Write-Output "Outbox runtime passed: stream_messages=$($stream.state.messages), pending=0."
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
}
