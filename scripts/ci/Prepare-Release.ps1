#Requires -Version 7.0
param(
    [Parameter(Mandatory)][ValidatePattern('^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')][string]$Tag,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$Commit,
    [string]$InputDirectory = 'candidate-assets',
    [string]$OutputDirectory = 'release-assets'
)
$ErrorActionPreference = 'Stop'
$checkoutCommit = & git rev-parse 'HEAD^{commit}'
if ($LASTEXITCODE -ne 0 -or $checkoutCommit.Trim() -cne $Commit) { throw 'Release checkout must match the qualified commit.' }
$tagCommit = & git rev-parse "refs/tags/$Tag^{commit}"
if ($LASTEXITCODE -ne 0 -or $tagCommit.Trim() -cne $Commit) { throw 'Release tag no longer matches the qualified commit.' }
& git merge-base --is-ancestor $Commit refs/remotes/origin/main
if ($LASTEXITCODE -ne 0) { throw 'Release commit must remain on origin/main.' }
$package = Join-Path $InputDirectory 'DWorkBench.zip'
$record = (Get-Content -LiteralPath "$package.sha256" -Raw).Trim()
if ($record -notmatch '^([a-fA-F0-9]{64})\s+\*?DWorkBench\.zip$') { throw 'Expected one checksum record for DWorkBench.zip.' }
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ine $Matches[1]) { throw 'Candidate ZIP checksum mismatch.' }
if ((Test-Path -LiteralPath $OutputDirectory) -and (Get-ChildItem -LiteralPath $OutputDirectory -Force | Select-Object -First 1)) {
    throw 'Release output directory must be empty.'
}

# Inspect known entries without executing candidate scripts or extracting the archive.
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $package).Path)
try {
    $entries = [Collections.Generic.Dictionary[string, IO.Compression.ZipArchiveEntry]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ($name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..') -or ($name.Split('/') -contains '.')) {
            throw 'Unsafe path in candidate ZIP.'
        }
        if (-not $entries.TryAdd($name, $entry)) { throw "Duplicate ZIP entry: $name" }
    }
    $required = @(
        'DWorkBench.Server.exe', 'DWorkBench.Server.dll', 'DWorkBench.Server.runtimeconfig.json', 'coreclr.dll', 'hostfxr.dll',
        'wwwroot/index.html', 'appsettings.json', 'release-info.json', 'Install.cmd', 'Start-Install.ps1',
        'Install-Windows.ps1', 'Initialize-Database.ps1', 'Check-Installation.ps1', 'Verify-Package.ps1',
        'QUICKSTART.zh-CN.md', 'DEPLOYMENT.md', 'VALIDATION.md', 'PERFORMANCE.md', 'RELEASE-NOTES.md',
        'LICENSE', 'licenses/README.txt', 'licenses/SSH.NET.LICENSE', 'licenses/npm/re2js/LICENSE'
    )
    foreach ($name in $required) {
        if (-not $entries.ContainsKey($name) -or $entries[$name].Length -le 0) { throw "Missing required package file: $name" }
    }
    if ($entries['release-info.json'].Length -gt 65536) { throw 'Unexpectedly large release manifest.' }
    $reader = [IO.StreamReader]::new($entries['release-info.json'].Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json -AsHashtable } finally { $reader.Dispose() }
    if ($manifest.product -cne 'DWorkBench' -or $manifest.version -cne $Tag.Substring(1) -or
        $manifest.commit -cne $Commit -or $manifest.runtime -cne 'win-x64' -or
        $manifest.selfContained -isnot [bool] -or $manifest.selfContained -ne $true -or
        $manifest.workingTreeDirty -isnot [bool] -or $manifest.workingTreeDirty -ne $false -or
        $manifest.ciQualification -cne 'dworkbench-release-v1') {
        throw 'Candidate identity, clean-source state or release qualification policy does not match.'
    }
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    # Export just the two standalone installation aids from the verified ZIP itself.
    foreach ($name in @('Verify-Package.ps1', 'QUICKSTART.zh-CN.md')) {
        if ($entries[$name].Length -gt 1048576) { throw "Unexpectedly large standalone asset: $name" }
        $source = $entries[$name].Open()
        $destination = [IO.File]::Open((Join-Path $OutputDirectory $name), [IO.FileMode]::CreateNew)
        try { $source.CopyTo($destination) } finally { $destination.Dispose(); $source.Dispose() }
    }
} finally { $archive.Dispose() }
$filename = "DWorkBench-$Tag-win-x64.zip"
$target = Join-Path $OutputDirectory $filename
Copy-Item -LiteralPath $package -Destination $target
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $filename" | Set-Content -LiteralPath "$target.sha256" -Encoding ascii
Write-Host "Release assets ready: $Tag, commit $Commit, SHA-256 $hash"
