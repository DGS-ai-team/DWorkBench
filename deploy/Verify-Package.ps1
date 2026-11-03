#Requires -Version 5.1
param(
    [string]$PackagePath,
    [string]$ChecksumPath
)
$ErrorActionPreference = 'Stop'
if (-not $PackagePath) { $PackagePath = Read-Host 'Path to DWorkBench ZIP' }
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if (-not $ChecksumPath) { $ChecksumPath = "$PackagePath.sha256" }
$record = (Get-Content -LiteralPath $ChecksumPath -Raw).Trim()
if ($record -notmatch '^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$') { throw 'Expected a single SHA-256 checksum record.' }
$expected = $Matches[1]
if ($Matches[2] -cne [IO.Path]::GetFileName($PackagePath)) { throw 'The checksum record names a different package.' }
$actual = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash
if ($actual -ine $expected) { throw 'SHA-256 mismatch. Do not install this package; obtain the matching files again.' }
Write-Host "SHA-256 OK: $([IO.Path]::GetFileName($PackagePath))"
Write-Host 'This checks file integrity. Obtain both files from the trusted release or your internal software repository.'
