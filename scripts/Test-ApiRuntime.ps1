param(
    [int] $Port = 18080
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root 'target/debug/assetlibrary-api.exe'
Push-Location $root
try {
    & cargo build -p assetlibrary-api --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath $executable)) {
    throw 'Build target/debug/assetlibrary-api.exe before running the runtime check.'
}

$env:ASSETLIBRARY_ENVIRONMENT = 'development'
$env:ASSETLIBRARY_BIND = "127.0.0.1:$Port"
$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
if (Test-Path -LiteralPath (Join-Path $root '.env')) {
    Get-Content -LiteralPath (Join-Path $root '.env') | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
    $env:DATABASE_URL = "postgresql://assetlibrary:$env:POSTGRES_PASSWORD@127.0.0.1:5432/assetlibrary"
    $env:ASSETLIBRARY_S3_ENDPOINT = 'http://127.0.0.1:9100'
    $env:ASSETLIBRARY_S3_REGION = 'us-east-1'
    $env:ASSETLIBRARY_QUARANTINE_BUCKET = 'assetlibrary-quarantine'
    $env:ASSETLIBRARY_PUBLISHED_BUCKET = 'assetlibrary-published'
    $env:ASSETLIBRARY_S3_FORCE_PATH_STYLE = 'true'
    $env:AWS_ACCESS_KEY_ID = $env:MINIO_ROOT_USER
    $env:AWS_SECRET_ACCESS_KEY = $env:MINIO_ROOT_PASSWORD
}
$stdout = Join-Path $env:TEMP 'assetlibrary-api.stdout.log'
$stderr = Join-Path $env:TEMP 'assetlibrary-api.stderr.log'
$process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr

try {
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
        } catch {
            $health = $null
        }
    } while (-not $health -and (Get-Date) -lt $deadline)
    if (-not $health) { throw 'API did not become healthy.' }

    $ready = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/readyz"
    $packages = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/public/packages?kind=art&limit=10"
    if ($packages.Content -notmatch 'neuro-starter-art') { throw 'PostgreSQL catalog fixture was not returned by the API.' }
    $package = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/public/packages/neuro-starter-art"
    if ($package.StatusCode -ne 200) { throw 'Published package detail did not return 200.' }
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/me" -ErrorAction Stop | Out-Null
        throw 'Unauthenticated /v1/me unexpectedly succeeded.'
    } catch {
        if ([int] $_.Exception.Response.StatusCode -ne 401) { throw }
    }
    $me = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/me" `
        -Headers @{ Authorization = 'Bearer dev-runtime-check' }
    $uploadUri = "http://127.0.0.1:$Port/v1/me/releases/018f47d2-4a75-7fa1-a12b-9a1f19d46ea3/upload-sessions"
    $uploadHeaders = @{
        Authorization = 'Bearer dev-publisher-fixture'
        'Idempotency-Key' = "runtime-upload-$Port-$runId"
        'Content-Type' = 'application/json'
    }
    $partFile = Join-Path $env:TEMP "assetlibrary-part-$Port.bin"
    $fullFile = Join-Path $env:TEMP "assetlibrary-full-$Port.bin"
    $wrongFile = Join-Path $env:TEMP "assetlibrary-wrong-$Port.bin"
    $partStream = [IO.File]::Create($partFile)
    try { $partStream.SetLength(5242880) } finally { $partStream.Dispose() }
    $fullStream = [IO.File]::Create($fullFile)
    try { $fullStream.SetLength(10485760) } finally { $fullStream.Dispose() }
    $wrongStream = [IO.File]::Create($wrongFile)
    try {
        $wrongStream.SetLength(10485760)
        $wrongStream.Position = 0
        $wrongStream.WriteByte(1)
    } finally { $wrongStream.Dispose() }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $partInput = [IO.File]::OpenRead($partFile)
        try { $partChecksum = [Convert]::ToBase64String($sha.ComputeHash($partInput)) } finally { $partInput.Dispose() }
        $fullInput = [IO.File]::OpenRead($fullFile)
        try { $fullDigest = ([BitConverter]::ToString($sha.ComputeHash($fullInput))).Replace('-', '').ToLowerInvariant() } finally { $fullInput.Dispose() }
    } finally {
        $sha.Dispose()
    }
    $uploadBody = @{
        file_name = "runtime-package-$Port.zip"
        media_type = 'application/zip'
        size_bytes = 10485760
        part_size_bytes = 5242880
        part_count = 2
        expected_digest = @{
            algorithm = 'sha256'
            value = "sha256:$fullDigest"
        }
    } | ConvertTo-Json -Depth 5
    $upload = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $uploadHeaders -Body $uploadBody
    $uploadRepeat = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $uploadHeaders -Body $uploadBody
    if ($upload.id -ne $uploadRepeat.id) { throw 'Idempotent upload session returned a different ID.' }
    $recoveryUri = "http://127.0.0.1:$Port/v1/me/upload-sessions/$($upload.id)"
    $recoveryResponse = Invoke-WebRequest -UseBasicParsing -Uri $recoveryUri `
        -Headers @{ Authorization = 'Bearer dev-publisher-fixture' }
    if ($recoveryResponse.Headers['Cache-Control'] -ne 'private, no-store' `
        -or $recoveryResponse.Content -match 'object_key|storage_upload_id') {
        throw 'Upload recovery leaked storage metadata or was cacheable.'
    }
    $recovery = $recoveryResponse.Content | ConvertFrom-Json
    if ($recovery.id -ne $upload.id -or $recovery.size_bytes -ne 10485760 `
        -or $recovery.uploaded_parts.Count -ne 0) {
        throw 'New upload recovery projection did not match the reservation.'
    }
    $completedParts = @()
    $browserOrigin = 'http://127.0.0.1:3000'
    foreach ($partNumber in 1..2) {
        $partUri = "http://127.0.0.1:$Port/v1/me/upload-sessions/$($upload.id)/parts/$partNumber"
        $partBody = @{ size_bytes = 5242880; checksum_sha256_base64 = $partChecksum } | ConvertTo-Json
        $part = Invoke-RestMethod -Method Post -Uri $partUri -Headers @{ Authorization = 'Bearer dev-publisher-fixture'; 'Content-Type' = 'application/json' } -Body $partBody
        if ($part.method -ne 'PUT' -or $part.url -notmatch '^http://127\.0\.0\.1:9100/') {
            throw 'Multipart part request was not signed for the local object store.'
        }
        $putHeaders = @{}
        $part.headers.PSObject.Properties | ForEach-Object { $putHeaders[$_.Name] = [string] $_.Value }
        if ($partNumber -eq 1) {
            $requestedHeaders = @('content-type') + @($putHeaders.Keys | Where-Object { $_ -notin @('host','content-length') })
            $preflight = Invoke-WebRequest -UseBasicParsing -Method Options -Uri $part.url -Headers @{
                Origin = $browserOrigin
                'Access-Control-Request-Method' = 'PUT'
                'Access-Control-Request-Headers' = ($requestedHeaders -join ',')
            }
            if ($preflight.StatusCode -ne 204 -or $preflight.Headers['Access-Control-Allow-Origin'] -ne $browserOrigin `
                -or $preflight.Headers['Access-Control-Allow-Methods'] -notmatch 'PUT') {
                throw 'Object store did not authorize the browser multipart CORS preflight.'
            }
        }
        $putHeaders['Origin'] = $browserOrigin
        $put = Invoke-WebRequest -UseBasicParsing -Method Put -Uri $part.url -Headers $putHeaders -InFile $partFile -ContentType 'application/octet-stream'
        $etag = [string] $put.Headers['ETag']
        if (-not $etag) { throw "Part $partNumber response did not contain an ETag." }
        if ($put.Headers['Access-Control-Allow-Origin'] -ne $browserOrigin `
            -or $put.Headers['Access-Control-Expose-Headers'] -notmatch '(?i)etag|\*') {
            throw 'Object store did not expose the browser upload ETag through CORS.'
        }
        $completedParts += @{ part_number = $partNumber; etag = $etag; checksum_sha256_base64 = $partChecksum }
        $recovery = Invoke-RestMethod -Uri $recoveryUri `
            -Headers @{ Authorization = 'Bearer dev-publisher-fixture' }
        if ($recovery.uploaded_parts.Count -ne $partNumber `
            -or $recovery.uploaded_parts[$partNumber - 1].part_number -ne $partNumber `
            -or $recovery.uploaded_parts[$partNumber - 1].etag -ne $etag `
            -or $recovery.uploaded_parts[$partNumber - 1].checksum_sha256_base64 -ne $partChecksum) {
            throw "Upload recovery did not return authoritative part $partNumber."
        }
    }
    $completeBody = @{ parts = $completedParts } | ConvertTo-Json -Depth 5
    $completeUri = "http://127.0.0.1:$Port/v1/me/upload-sessions/$($upload.id)/complete"
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_members SET status='revoked' WHERE principal_issuer='assetlibrary-development' AND principal_subject='publisher-fixture'" | Out-Null
    try {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $recoveryUri `
                -Headers @{ Authorization = 'Bearer dev-publisher-fixture' } -ErrorAction Stop | Out-Null
            throw 'Revoked publisher unexpectedly recovered an upload session.'
        } catch {
            if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne 403) { throw }
        }
        foreach ($deniedWrite in @(
            @{ Uri = "http://127.0.0.1:$Port/v1/me/upload-sessions/$($upload.id)/parts/1"; Body = (@{ size_bytes = 5242880; checksum_sha256_base64 = $partChecksum } | ConvertTo-Json) },
            @{ Uri = $completeUri; Body = $completeBody }
        )) {
            try {
                Invoke-WebRequest -UseBasicParsing -Method Post -Uri $deniedWrite.Uri `
                    -Headers @{ Authorization = 'Bearer dev-publisher-fixture'; 'Content-Type' = 'application/json' } `
                    -Body $deniedWrite.Body -ErrorAction Stop | Out-Null
                throw 'Revoked publisher unexpectedly continued an upload session.'
            } catch {
                if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne 403) { throw }
            }
        }
    } finally {
        docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
            "UPDATE publisher_members SET status='active' WHERE principal_issuer='assetlibrary-development' AND principal_subject='publisher-fixture'" | Out-Null
    }
    $completed = Invoke-RestMethod -Method Post -Uri $completeUri -Headers @{ Authorization = 'Bearer dev-publisher-fixture'; 'Content-Type' = 'application/json' } -Body $completeBody
    if ($completed.status -ne 'uploaded') { throw 'Completed multipart upload did not enter uploaded state.' }
    $completedRecovery = Invoke-RestMethod -Uri $recoveryUri `
        -Headers @{ Authorization = 'Bearer dev-publisher-fixture' }
    if ($completedRecovery.status -ne 'uploaded' -or $completedRecovery.uploaded_parts.Count -ne 0) {
        throw 'Completed session recovery did not converge without querying a closed multipart upload.'
    }
    $completedAgain = Invoke-RestMethod -Method Post -Uri $completeUri -Headers @{ Authorization = 'Bearer dev-publisher-fixture'; 'Content-Type' = 'application/json' } -Body $completeBody
    if ($completedAgain.id -ne $completed.id) { throw 'Repeated Complete did not return the same session.' }
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE publisher_members SET status='revoked' WHERE principal_issuer='assetlibrary-development' AND principal_subject='publisher-fixture'" | Out-Null
    try {
        try {
            Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uploadUri -Headers $uploadHeaders `
                -Body $uploadBody -ErrorAction Stop | Out-Null
            throw 'Revoked publisher unexpectedly replayed an upload session.'
        } catch {
            if (-not $_.Exception.Response -or [int] $_.Exception.Response.StatusCode -ne 403) { throw }
        }
    } finally {
        docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
            "UPDATE publisher_members SET status='active' WHERE principal_issuer='assetlibrary-development' AND principal_subject='publisher-fixture'" | Out-Null
    }
    $boundCount = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc "SELECT count(*) FROM upload_sessions WHERE id='$($upload.id)' AND storage_upload_id IS NOT NULL"
    if ([int] $boundCount.Trim() -ne 1) { throw 'Upload session was not bound to a storage multipart ID.' }
    $objectSize = docker exec assetlibrary-object-store-1 mc stat --json "local/assetlibrary-quarantine/$($upload.object_key)" | ConvertFrom-Json | Select-Object -ExpandProperty size
    if ([long] $objectSize -ne 10485760) { throw "Completed object has unexpected size $objectSize." }
    $eventCount = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc "SELECT count(*) FROM outbox_events WHERE aggregate_id='$($upload.artifact_id)' AND subject='assetlibrary.artifact.verification_requested.v1'"
    if ([int] $eventCount.Trim() -ne 1) { throw "Expected one verification Outbox event, found $eventCount." }
    $badHeaders = $uploadHeaders.Clone()
    $badHeaders['Idempotency-Key'] = "runtime-invalid-complete-$Port-$runId"
    $badBody = $uploadBody -replace "runtime-package-$Port.zip", "runtime-invalid-$Port.zip"
    docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
        "UPDATE releases SET status='rejected' WHERE id='018f47d2-4a75-7fa1-a12b-9a1f19d46ea3'" | Out-Null
    try {
        $badUpload = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $badHeaders -Body $badBody
    } finally {
        docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -v ON_ERROR_STOP=1 -c `
            "UPDATE releases SET status='draft' WHERE id='018f47d2-4a75-7fa1-a12b-9a1f19d46ea3'" | Out-Null
    }
    docker cp $wrongFile "assetlibrary-object-store-1:/tmp/runtime-invalid-$Port.zip" | Out-Null
    docker exec assetlibrary-object-store-1 mc cp "/tmp/runtime-invalid-$Port.zip" "local/assetlibrary-quarantine/$($badUpload.object_key)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to seed the conflicting quarantine object.' }
    $badParts = foreach ($partNumber in 1..2) {
        @{ part_number = $partNumber; etag = '"invalid-etag"'; checksum_sha256_base64 = $partChecksum }
    }
    try {
        Invoke-WebRequest -UseBasicParsing -Method Post `
            -Uri "http://127.0.0.1:$Port/v1/me/upload-sessions/$($badUpload.id)/complete" `
            -Headers @{ Authorization = 'Bearer dev-publisher-fixture'; 'Content-Type' = 'application/json' } `
            -Body (@{ parts = $badParts } | ConvertTo-Json -Depth 5) -ErrorAction Stop | Out-Null
        throw 'Failed multipart completion accepted an unrelated existing object.'
    } catch {
        if ([int] $_.Exception.Response.StatusCode -ne 503) { throw }
    }
    $badState = docker exec assetlibrary-postgres-1 psql -U assetlibrary -d assetlibrary -tAc "SELECT status FROM artifacts WHERE id='$($badUpload.artifact_id)'"
    if ($badState.Trim() -ne 'pending_upload') { throw "Invalid completion advanced artifact to $badState." }
    $conflictBody = $uploadBody -replace "runtime-package-$Port.zip", "different-package-$Port.zip"
    try {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uploadUri -Headers $uploadHeaders -Body $conflictBody -ErrorAction Stop | Out-Null
        throw 'Changed upload request unexpectedly reused the idempotency key.'
    } catch {
        if ([int] $_.Exception.Response.StatusCode -ne 409) { throw }
    }
    try {
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uploadUri `
            -Headers @{ Authorization = 'Bearer dev-other'; 'Idempotency-Key' = "runtime-other-$Port-$runId"; 'Content-Type' = 'application/json' } `
            -Body $uploadBody -ErrorAction Stop | Out-Null
        throw 'Unauthorized publisher principal unexpectedly created an upload session.'
    } catch {
        if ([int] $_.Exception.Response.StatusCode -ne 403) { throw }
    }
    $requestId = $health.Headers['x-request-id']
    if (-not $requestId) { throw 'Health response did not propagate x-request-id.' }
    Write-Output "API runtime passed: health=$($health.StatusCode), ready=$($ready.StatusCode), catalog=$($packages.StatusCode), package=$($package.StatusCode), identity=$($me.StatusCode), upload=$($upload.id), recovery=authoritative, revoked-session=denied."
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $env:TEMP "assetlibrary-part-$Port.bin") -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $env:TEMP "assetlibrary-full-$Port.bin") -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $env:TEMP "assetlibrary-wrong-$Port.bin") -Force -ErrorAction SilentlyContinue
    if ($badUpload -and $badUpload.object_key) {
        docker exec assetlibrary-object-store-1 mc rm --force "local/assetlibrary-quarantine/$($badUpload.object_key)" *> $null
        $badPrefix = $badUpload.object_key.Substring(0, $badUpload.object_key.LastIndexOf('/') + 1)
        docker exec assetlibrary-object-store-1 mc rm --incomplete --recursive --force "local/assetlibrary-quarantine/$badPrefix" *> $null
        docker exec assetlibrary-object-store-1 rm -f "/tmp/runtime-invalid-$Port.zip" *> $null
    }
}
