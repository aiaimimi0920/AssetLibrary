# All package/release/key/upload/review/publication mutations use the real API.
function Invoke-ArtRequest([string] $Method, [string] $Path, [string] $Subject = '', $Body = $null,
    [int] $Expected = 200, [string] $Key = '') {
    $headers = @{ 'X-Request-ID' = [guid]::NewGuid().ToString() }
    if ($Subject) { $headers.Authorization = "Bearer dev-$Subject" }
    if ($Key) { $headers['Idempotency-Key'] = $Key }
    $arguments = @{ UseBasicParsing = $true; Method = $Method; Uri = $Run.ApiOrigin + $Path
        Headers = $headers; TimeoutSec = 10; ErrorAction = 'Stop' }
    if ($null -ne $Body) {
        $arguments.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 8))
        $arguments.ContentType = 'application/json'
    }
    try { $response = Invoke-WebRequest @arguments; $status = [int]$response.StatusCode }
    catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($status -ne $Expected) { throw "Art API $Method $Path returned $status; expected $Expected" }
        return
    }
    if ($status -ne $Expected) { throw "Art API $Method $Path returned $status; expected $Expected" }
    if ($response.Content) { $response.Content | ConvertFrom-Json }
}

function Initialize-ArtPrincipals {
    # Fixture bootstrap only; no account tables or real login/OIDC claims.
    $Run.PublisherId = '018f47d2-4a75-7fa1-a12b-9a1f19d46ea1'
    Invoke-RunSql @'
INSERT INTO publishers (id,slug,display_name,status)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea1','neuro-fixture-publisher','Isolated Art Publisher','active');
INSERT INTO publisher_members (publisher_id,principal_issuer,principal_subject,role,status)
VALUES ('018f47d2-4a75-7fa1-a12b-9a1f19d46ea1','assetlibrary-development','art-publisher','owner','active');
INSERT INTO store_roles (principal_issuer,principal_subject,role) VALUES
('assetlibrary-development','art-publisher','reviewer'),
('assetlibrary-development','art-reviewer','reviewer'),
('assetlibrary-development','art-operator','operator');
'@ | Out-Null
}

function New-ArtUploadedFixture($Fixture) {
    $keyBytes = New-Object byte[] 32
    for ($index = 0; $index -lt 32; $index++) { $keyBytes[$index] = [Convert]::ToByte($Fixture.public_key.Substring($index * 2, 2), 16) }
    $key = Invoke-ArtRequest 'POST' "/v1/me/publishers/$($Run.PublisherId)/signing-keys" 'art-publisher' @{
        key_id = 'local-test-key'; algorithm = 'ed25519'; public_key_base64 = [Convert]::ToBase64String($keyBytes)
    } 200 'register-key'
    if ($key.status -ne 'active') { throw 'Signing-key registration was not active' }
    $package = Invoke-ArtRequest 'POST' "/v1/me/publishers/$($Run.PublisherId)/packages" 'art-publisher' @{
        slug = 'neuro-starter-art'; kind = 'art'; visibility = 'public'; name = 'Isolated Art Flow'
        summary = 'Signed Art API-to-Edge fixture'; description = 'Harmless isolated fixture'; tags = @('art', 'isolated')
    } 200 'create-package'
    $Run.PackageId = [guid]::Parse($package.id).ToString()
    $release = Invoke-ArtRequest 'POST' "/v1/me/packages/$($Run.PackageId)/releases" 'art-publisher' @{
        version = '1.0.0-dev'; compatibility = @{ products = @(@{ name = 'loom'; version_requirement = '>=0.1.0' }) }; permissions = @()
    } 200 'create-release'
    $Run.ReleaseId = [guid]::Parse($release.id).ToString()
    $uploadPath = "/v1/me/releases/$($Run.ReleaseId)/upload-sessions"
    $body = @{ file_name = 'signed.zip'; media_type = 'application/zip'; size_bytes = $Fixture.size_bytes
        part_size_bytes = 5242880; part_count = 1; expected_digest = @{ algorithm = 'sha256'; value = "sha256:$($Fixture.digest)" } }
    $upload = Invoke-ArtRequest 'POST' $uploadPath 'art-publisher' $body 200 'create-upload'
    $replay = Invoke-ArtRequest 'POST' $uploadPath 'art-publisher' $body 200 'create-upload'
    if ($upload.id -ne $replay.id -or $upload.artifact_id -ne $replay.artifact_id) { throw 'Upload reservation replay changed identity' }
    $Run.Artifact = [pscustomobject]@{ Id = [guid]::Parse($upload.artifact_id).ToString() }
    $Run.UploadId = [guid]::Parse($upload.id).ToString()
    Invoke-ArtRequest 'POST' "/v1/me/releases/$($Run.ReleaseId)/submissions" 'art-publisher' @{
        artifact_id = $Run.Artifact.Id
    } 409 'submit-unverified' | Out-Null
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $checksum = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes("$($Run.Root)/fixtures/signed.zip"))) }
    finally { $sha.Dispose() }
    $part = Invoke-ArtRequest 'POST' "/v1/me/upload-sessions/$($Run.UploadId)/parts/1" 'art-publisher' @{
        size_bytes = $Fixture.size_bytes; checksum_sha256_base64 = $checksum
    }
    $uri = [uri]$part.url
    if ($part.method -ne 'PUT' -or $uri.GetLeftPart([UriPartial]::Authority) -ne $Run.Storage.ASSETLIBRARY_S3_ENDPOINT) {
        throw 'Upload signature did not target the run-owned object store'
    }
    $headers = @{}
    $part.headers.PSObject.Properties | ForEach-Object { $headers[$_.Name] = [string]$_.Value }
    try {
        $put = Invoke-WebRequest -UseBasicParsing -Method Put -Uri $part.url -Headers $headers `
            -InFile "$($Run.Root)/fixtures/signed.zip" -ContentType 'application/octet-stream' -TimeoutSec 10
    } catch { throw 'Run-owned signed multipart PUT failed; signed URL omitted' }
    $etag = [string]$put.Headers['ETag']
    if (-not $etag) { throw 'Multipart PUT did not return ETag' }
    $completed = Invoke-ArtRequest 'POST' "/v1/me/upload-sessions/$($Run.UploadId)/complete" 'art-publisher' @{
        parts = @(@{ part_number = 1; etag = $etag; checksum_sha256_base64 = $checksum })
    }
    if ($completed.artifact_id -ne $Run.Artifact.Id -or $completed.status -ne 'uploaded') { throw 'Completion lost artifact identity or uploaded state' }
    Write-RunJson 'upload.json' @{ package_id = $Run.PackageId; release_id = $Run.ReleaseId
        upload_id = $Run.UploadId; artifact_id = $Run.Artifact.Id; signed_put_status = $put.StatusCode
        idempotent_reservation = $true; unverified_submission_status = 409 }
}

function Publish-ArtFixture {
    $path = "/v1/me/releases/$($Run.ReleaseId)/submissions"
    $body = @{ artifact_id = $Run.Artifact.Id }
    $submission = Invoke-ArtRequest 'POST' $path 'art-publisher' $body 200 'submit-verified'
    $replay = Invoke-ArtRequest 'POST' $path 'art-publisher' $body 200 'submit-verified'
    $Run.SubmissionId = [guid]::Parse($submission.id).ToString()
    if ($submission.id -ne $replay.id -or $submission.required_approvals -ne 1) { throw 'Art submission identity or approval gate changed' }
    $publishPath = "/v1/internal/submissions/$($Run.SubmissionId)/publish"
    Invoke-ArtRequest 'POST' $publishPath 'art-operator' $null 409 'publish-unapproved' | Out-Null
    $reviewBody = @{ decision = 'approved'; reason = 'Isolated harmless Art fixture verified'; findings = @() }
    $reviewPath = "/v1/internal/submissions/$($Run.SubmissionId)/reviews"
    Invoke-ArtRequest 'POST' $reviewPath 'art-publisher' $reviewBody 403 'self-review' | Out-Null
    $review = Invoke-ArtRequest 'POST' $reviewPath 'art-reviewer' $reviewBody 200 'independent-review'
    if ($review.submission.status -ne 'approved' -or $review.submission.approval_count -ne 1) { throw 'Independent Art approval did not satisfy review gate' }
    $published = Invoke-ArtRequest 'POST' $publishPath 'art-operator' $null 200 'publish-approved'
    $again = Invoke-ArtRequest 'POST' $publishPath 'art-operator' $null 200 'publish-approved'
    if ($published.id -ne $again.id -or $published.status -ne 'approved') { throw 'Publication replay changed result' }
    $bound = Invoke-RunSql "SELECT artifact_id FROM published_release_artifacts WHERE release_id='$($Run.ReleaseId)'"
    if ($bound -ne $Run.Artifact.Id) { throw 'Publication did not bind this scanned artifact' }
    Write-RunJson 'publication.json' @{ submission_id = $Run.SubmissionId; artifact_id = $bound
        approvals = $review.submission.approval_count; self_review_status = 403; unapproved_publish_status = 409
        idempotent_publication = $true }
}

function Get-ArtSearch {
    Invoke-ArtRequest 'GET' '/v1/public/search?q=Isolated%20Art%20Flow&kind=art&tag=isolated&limit=2'
}
