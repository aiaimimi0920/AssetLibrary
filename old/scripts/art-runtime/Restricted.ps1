function Test-ArtRestrictedDownload($Fixture) {
    $ticket = Invoke-ArtRequest 'POST' "/v1/me/artifacts/$($Run.Artifact.Id)/download-sessions" 'art-publisher' @{
        client_type = 'cli'
    } 201 'restricted-before-revoke'
    $expected = "$($Run.EdgeOrigin)/restricted/sha256/$($Fixture.canonical_digest)/neuro-starter-art-1.0.0-dev.zip"
    if ($ticket.download_url -ne $expected -or $ticket.access_token.Length -gt 8192) { throw 'Unexpected restricted ticket metadata' }
    $Run.RestrictedTicket = $ticket
    $Run.Secrets += @($ticket.access_token)
    Invoke-WebRequest -UseBasicParsing -Uri $ticket.download_url -Headers @{ Authorization = "Bearer $($ticket.access_token)" } `
        -OutFile "$($Run.Root)/restricted.zip" -TimeoutSec 10 | Out-Null
    if ((Get-FileHash -LiteralPath "$($Run.Root)/restricted.zip").Hash.ToLowerInvariant() -ne $Fixture.digest) {
        throw 'Restricted Edge bytes differ from uploaded ZIP'
    }
    Write-RunJson 'restricted-before-revoke.json' @{ session_id = $ticket.session_id; expires_at = $ticket.expires_at
        status = 200; raw_sha256 = $Fixture.digest; token_recorded = $false }
}

function Test-ArtRestrictedRevocation {
    $ticket = $Run.RestrictedTicket
    if ([DateTimeOffset]::Parse($ticket.expires_at) -le [DateTimeOffset]::UtcNow.AddSeconds(5)) {
        throw 'Ticket expired; cannot attribute restricted rejection to revocation'
    }
    Add-Type -AssemblyName System.Net.Http
    $client = [Net.Http.HttpClient]::new(); $client.Timeout = [TimeSpan]::FromSeconds(10)
    $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $ticket.download_url)
    [void]$message.Headers.TryAddWithoutValidation('Authorization', "Bearer $($ticket.access_token)")
    try {
        $response = $client.SendAsync($message, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        try { $status = [int]$response.StatusCode; $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
        finally { $response.Dispose() }
    } finally { $message.Dispose(); $client.Dispose() }
    if ($status -ne 403 -or $body -ne 'revoked bearer ticket') { throw 'Old unexpired restricted ticket was not rejected for revocation' }
    Write-RunJson 'restricted-revoked.json' @{ session_id = $ticket.session_id; status = $status
        unexpired = $true; exact_reason = $body; token_recorded = $false }
}
