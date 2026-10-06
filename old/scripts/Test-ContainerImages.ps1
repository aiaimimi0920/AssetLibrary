[CmdletBinding()]
param(
    [string]$ApiImage = 'assetlibrary-api:p9-local',
    [string]$WebImage = 'assetlibrary-web:p9-local'
)

$ErrorActionPreference = 'Stop'
$suffix = "$PID"
$network = "assetlibrary-image-smoke-$suffix"
$api = "assetlibrary-image-api-$suffix"
$web = "assetlibrary-image-web-$suffix"
$networkCreated = $false
$apiCreated = $false
$webCreated = $false

function Invoke-Docker([string[]]$Arguments, [string]$Failure) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker @Arguments 2>&1 | Out-Null
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw $Failure }
}

function Wait-ForProbe([string]$Container, [string]$Script, [string]$Failure) {
    $lastOutput = @()
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = @(& docker exec $Container node -e $Script 2>&1)
            $lastOutput = $output
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($exitCode -eq 0) {
            $output | ForEach-Object { Write-Output "$_" }
            return
        }
        Start-Sleep -Seconds 1
    }
    $detail = (($lastOutput | ForEach-Object { "$_" }) -join ' ').Trim()
    if ($detail.Length -gt 512) { $detail = $detail.Substring(0, 512) }
    throw "$Failure Last probe: $detail"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is required.' }
if ($ApiImage -match '[\r\n\x00]' -or $WebImage -match '[\r\n\x00]') {
    throw 'Image references contain invalid characters.'
}

try {
    Invoke-Docker @('image', 'inspect', $ApiImage) "API image does not exist: $ApiImage"
    Invoke-Docker @('image', 'inspect', $WebImage) "Web image does not exist: $WebImage"
    Invoke-Docker @('network', 'create', $network) 'Smoke network creation failed.'
    $networkCreated = $true
    Invoke-Docker @(
        'run', '-d', '--name', $api, '--network', $network,
        '-e', 'ASSETLIBRARY_BIND=0.0.0.0:8080', $ApiImage
    ) 'API container start failed.'
    $apiCreated = $true
    Invoke-Docker @(
        'run', '-d', '--name', $web, '--network', $network,
        '-e', "ASSETLIBRARY_API_URL=http://${api}:8080", $WebImage
    ) 'Web container start failed.'
    $webCreated = $true

    $apiProbe = @"
fetch('http://${api}:8080/healthz')
  .then(async response => {
    const body = await response.text();
    console.log(response.status + '|' + body);
    process.exit(response.ok ? 0 : 1);
  })
  .catch(error => { console.error(error.message); process.exit(2); });
"@
    Wait-ForProbe $web $apiProbe 'API image health probe did not become ready.'

    $webProbe = @'
fetch('http://127.0.0.1:3000/')
  .then(async response => {
    const body = await response.text();
    console.log(response.status + '|' + body.length);
    process.exit(response.ok && body.length > 100 ? 0 : 1);
  })
  .catch(error => { console.error(error.message); process.exit(2); });
'@
    Wait-ForProbe $web $webProbe 'Web image root probe did not become ready.'
    Write-Output 'Container image runtime smoke passed.'
} finally {
    $ErrorActionPreference = 'Continue'
    if ($webCreated) { & docker rm -f $web 2>&1 | Out-Null }
    if ($apiCreated) { & docker rm -f $api 2>&1 | Out-Null }
    if ($networkCreated) { & docker network rm $network 2>&1 | Out-Null }
}
