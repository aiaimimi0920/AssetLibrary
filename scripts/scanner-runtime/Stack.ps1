# Shared run-owned dependency startup; no repository .env or global cleanup.
. "$PSScriptRoot/TestNetwork.ps1"
function Start-RunStack([string] $PostgresImage, [string] $NatsImage, [string] $MinioImage, [int] $ClamAvPort) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        if (-not $client.ConnectAsync('127.0.0.1', $ClamAvPort).Wait(3000)) { throw 'ClamAV connection timed out' }
        $stream = $client.GetStream(); $stream.ReadTimeout = 3000; $stream.WriteTimeout = 3000
        $bytes = [Text.Encoding]::ASCII.GetBytes("zVERSION`0"); $stream.Write($bytes, 0, $bytes.Length)
        $buffer = New-Object byte[] 4096; $count = $stream.Read($buffer, 0, $buffer.Length)
        $version = [Text.Encoding]::ASCII.GetString($buffer, 0, $count).Trim([char]0)
        if ($version -notmatch '^ClamAV ') { throw 'Unexpected ClamAV version response' }
    } finally { $client.Dispose() }
    $postgresPassword = New-RunSecret
    $minioPassword = New-RunSecret
    $Run.Secrets += @($postgresPassword, $minioPassword)
    [IO.File]::WriteAllText("$($Run.Root)/local-only.env", "POSTGRES_DB=assetlibrary`nPOSTGRES_USER=assetlibrary`nPOSTGRES_PASSWORD=$postgresPassword`nMINIO_ROOT_USER=isolated-scanner`nMINIO_ROOT_PASSWORD=$minioPassword`n", $Run.Utf8)
    # A distinct bridge with loopback bindings is not outbound network isolation.
    Initialize-RunTestNetwork
    $Run.Postgres = Start-RunContainer 'pg' $PostgresImage @('--memory=1g','--env-file',"$($Run.Root)/local-only.env",'-p','127.0.0.1::5432',
        '--mount',"type=bind,source=$($Run.Root)/postgres,target=/var/lib/postgresql",'--mount',"type=bind,source=$($Run.Repo)/migrations,target=/migrations,readonly")
    $Run.Nats = Start-RunContainer 'nats' $NatsImage @('--memory=256m','-p','127.0.0.1::4222','-p','127.0.0.1::8222',
        '--mount',"type=bind,source=$($Run.Root)/nats,target=/data")
    $Run.Minio = Start-RunContainer 'minio' $MinioImage @('--memory=1g','--env-file',"$($Run.Root)/local-only.env",'-p','127.0.0.1::9000',
        '--mount',"type=bind,source=$($Run.Root)/minio,target=/data",'--mount',"type=bind,source=$($Run.Root)/fixtures,target=/fixtures,readonly")
    Write-RunJson 'resources.json' @{ containers = @($Run.Containers); network = $Run.Network; network_reused = $Run.NetworkReused; loopback_only = $true; outbound_isolated = $false }
    # initdb's temporary Unix-socket server is not final TCP readiness.
    Wait-RunCondition 'PostgreSQL TCP readiness' { (Invoke-RunDocker @('exec',$Run.Postgres,'pg_isready','-h','127.0.0.1','-U','assetlibrary','-d','assetlibrary') -AllowFailure).Code -eq 0 } 180
    Wait-RunCondition 'MinIO readiness' { (Invoke-RunDocker @('exec',$Run.Minio,'curl','-fsS','http://127.0.0.1:9000/minio/health/live') -AllowFailure).Code -eq 0 }
    Wait-RunCondition 'NATS readiness' { (Invoke-RunDocker @('exec',$Run.Nats,'wget','-q','--spider','http://127.0.0.1:8222/healthz') -AllowFailure).Code -eq 0 }
    Invoke-RunDocker @('exec',$Run.Minio,'sh','-c','mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb local/assetlibrary-quarantine local/assetlibrary-published') | Out-Null
    $Run.NatsMonitorPort = Get-RunPort $Run.Nats 8222
    $Run.ClamAvVersion = $version
    $Run.Common = @{
        DATABASE_URL = "postgres://assetlibrary:$postgresPassword@127.0.0.1:$(Get-RunPort $Run.Postgres 5432)/assetlibrary"
        ASSETLIBRARY_NATS_URL = "nats://127.0.0.1:$(Get-RunPort $Run.Nats 4222)"
        ASSETLIBRARY_METRICS_BIND = '127.0.0.1:0'
    }
    $Run.Storage = @{
        ASSETLIBRARY_ENVIRONMENT = 'development'; ASSETLIBRARY_S3_ENDPOINT = "http://127.0.0.1:$(Get-RunPort $Run.Minio 9000)"
        ASSETLIBRARY_S3_REGION = 'us-east-1'; ASSETLIBRARY_S3_FORCE_PATH_STYLE = 'true'
        ASSETLIBRARY_QUARANTINE_BUCKET = 'assetlibrary-quarantine'; ASSETLIBRARY_PUBLISHED_BUCKET = 'assetlibrary-published'
        AWS_ACCESS_KEY_ID = 'isolated-scanner'; AWS_SECRET_ACCESS_KEY = $minioPassword
    }
}
