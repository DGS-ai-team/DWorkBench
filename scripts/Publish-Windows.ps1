#Requires -Version 7.0
param([string]$Output)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $Output) { $Output = Join-Path $repo 'artifacts/windows/DWorkBench' }
$Output = [IO.Path]::GetFullPath($Output)
# Never package leftovers from a deployed installation or an earlier build.
if ((Test-Path -LiteralPath $Output) -and (Get-ChildItem -LiteralPath $Output -Force | Select-Object -First 1)) {
    throw 'Output must be an empty, dedicated build directory. Choose another -Output; do not publish over an installation.'
}
$project = [xml](Get-Content -LiteralPath (Join-Path $repo 'src/DWorkBench.Server/DWorkBench.Server.csproj') -Raw)
$version = [string]$project.Project.PropertyGroup.Version
$client = Get-Content -LiteralPath (Join-Path $repo 'src/DWorkBench.Client/package.json') -Raw | ConvertFrom-Json
if ($version -notmatch '^\d+\.\d+\.\d+$' -or $client.version -ne $version) { throw 'Server and client release versions must match.' }
$notes = Join-Path $repo "docs/releases/v$version.md"
if (-not (Test-Path -LiteralPath $notes)) { throw "Missing release notes: $notes" }
$revision = & git -C $repo rev-parse HEAD
if ($LASTEXITCODE) { throw 'Unable to identify source commit.' }
$dirty = @(& git -C $repo status --porcelain).Count -ne 0
if ($LASTEXITCODE) { throw 'Unable to inspect source state.' }
$localDotnet = Join-Path $repo '.tools/dotnet/dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { 'dotnet' }
Push-Location (Join-Path $repo 'src/DWorkBench.Client')
try { & npm.cmd ci; if ($LASTEXITCODE) { throw 'npm ci failed' }; & npm.cmd run build; if ($LASTEXITCODE) { throw 'Frontend build failed' } } finally { Pop-Location }
& $dotnet publish (Join-Path $repo 'src/DWorkBench.Server') -c Release -r win-x64 --self-contained true -o $Output --nologo
if ($LASTEXITCODE) { throw 'Publish failed' }
foreach ($file in @('Install.cmd', 'Start-Install.ps1', 'Install-Windows.ps1', 'Initialize-Database.ps1', 'Check-Installation.ps1', 'Verify-Package.ps1', 'QUICKSTART.zh-CN.md')) {
    Copy-Item -LiteralPath (Join-Path $repo "deploy/$file") -Destination $Output
}
Copy-Item -LiteralPath $notes -Destination (Join-Path $Output 'RELEASE-NOTES.md')
@{
    product = 'DWorkBench'; version = $version; runtime = 'win-x64'; selfContained = $true
    commit = $revision.Trim(); workingTreeDirty = $dirty; builtAtUtc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Output 'release-info.json') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $repo 'docs/DEPLOYMENT.md') -Destination $Output
Copy-Item -LiteralPath (Join-Path $repo 'docs/VALIDATION.md') -Destination $Output
Copy-Item -LiteralPath (Join-Path $repo 'docs/PERFORMANCE.md') -Destination $Output
Copy-Item -LiteralPath (Join-Path $repo 'docs/benchmarks') -Destination $Output -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination $Output
& (Join-Path $PSScriptRoot 'Collect-Licenses.ps1') -Output $Output
$sensitive = Get-ChildItem -LiteralPath $Output -Recurse -Force -File | Where-Object {
    $_.Name -eq 'appsettings.local.json' -or $_.Extension -in @('.pfx', '.p12', '.db', '.dpapi') -or
    $_.Name -match '\.db-(wal|shm)$' -or $_.FullName -match '[\\/](\.local|secrets|credentials)[\\/]'
}
if ($sensitive) { throw 'Refusing to package local configuration, databases or private keys. Use a clean checkout.' }
Compress-Archive -Path (Join-Path $Output '*') -DestinationPath "$Output.zip" -Force
Get-FileHash -LiteralPath "$Output.zip" -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName("$Output.zip"))" } | Set-Content -LiteralPath "$Output.zip.sha256" -Encoding ascii
Write-Host "Windows package: $Output.zip"
