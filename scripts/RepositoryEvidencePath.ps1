function Resolve-RepositoryEvidencePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,
        [Parameter(Mandatory = $true)]
        [string]$RawPath
    )

    if ([string]::IsNullOrWhiteSpace($RawPath)) { throw 'EvidenceRoot is required.' }
    $root = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $base = $root + [IO.Path]::DirectorySeparatorChar
    $candidate = if ([IO.Path]::IsPathRooted($RawPath)) {
        [IO.Path]::GetFullPath($RawPath)
    } else {
        [IO.Path]::GetFullPath((Join-Path $root $RawPath))
    }
    if (-not $candidate.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'EvidenceRoot must remain inside the AssetLibrary repository.'
    }

    $cursor = $candidate
    while ($cursor.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'EvidenceRoot must not traverse a symbolic link or junction.'
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if (-not $parent) { break }
        $cursor = $parent.FullName
    }
    return $candidate
}
