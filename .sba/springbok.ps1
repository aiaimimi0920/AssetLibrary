[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
if ($PSScriptRoot.StartsWith('\\') -or (Get-Location).Path.StartsWith('\\')) {
    throw 'Use a local checkout or an existing persistent mapped drive.'
}
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$script = Join-Path $PSScriptRoot 'springbok.py'
if (Get-Command rtk -ErrorAction SilentlyContinue) {
    & rtk proxy python $script --request $RequestPath --result $ResultPath
} else {
    & python $script --request $RequestPath --result $ResultPath
}
exit $LASTEXITCODE
