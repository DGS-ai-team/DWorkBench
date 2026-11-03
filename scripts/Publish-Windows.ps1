param([string]$Output)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $Output) { $Output = Join-Path $repo 'artifacts/windows/DWorkBench' }
$localDotnet = Join-Path $repo '.tools/dotnet/dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { 'dotnet' }
Push-Location (Join-Path $repo 'src/DWorkBench.Client')
try { & npm.cmd ci; if ($LASTEXITCODE) { throw 'npm ci failed' }; & npm.cmd run build; if ($LASTEXITCODE) { throw 'Frontend build failed' } } finally { Pop-Location }
& $dotnet publish (Join-Path $repo 'src/DWorkBench.Server') -c Release -r win-x64 --self-contained true -o $Output --nologo
if ($LASTEXITCODE) { throw 'Publish failed' }
Copy-Item -LiteralPath (Join-Path $repo 'deploy/Install-Windows.ps1') -Destination $Output
Copy-Item -LiteralPath (Join-Path $repo 'docs/DEPLOYMENT.md') -Destination $Output
Copy-Item -LiteralPath (Join-Path $repo 'docs/VALIDATION.md') -Destination $Output
Copy-Item -LiteralPath (Join-Path $repo 'docs/PERFORMANCE.md') -Destination $Output
Copy-Item -LiteralPath (Join-Path $repo 'docs/benchmarks') -Destination $Output -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination $Output
& (Join-Path $PSScriptRoot 'Collect-Licenses.ps1') -Output $Output
Compress-Archive -Path (Join-Path $Output '*') -DestinationPath "$Output.zip" -Force
Get-FileHash -LiteralPath "$Output.zip" -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLowerInvariant())  DWorkBench.zip" } | Set-Content -LiteralPath "$Output.zip.sha256" -Encoding ascii
Write-Host "Windows package: $Output.zip"
