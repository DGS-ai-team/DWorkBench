param([int]$Port = 5080, [switch]$NoBuild)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$localDotnet = Join-Path $repo '.tools/dotnet/dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { 'dotnet' }
if (-not $NoBuild) {
    Push-Location (Join-Path $repo 'src/LogDesk.Client')
    try { if (-not (Test-Path node_modules)) { & npm.cmd ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }; & npm.cmd run build; if ($LASTEXITCODE) { throw 'Frontend build failed' } } finally { Pop-Location }
    & $dotnet build (Join-Path $repo 'src/LogDesk.Server') --nologo
    if ($LASTEXITCODE) { throw 'Backend build failed' }
}
$localDir = Join-Path $repo '.local'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$settingsFile = Join-Path $localDir 'dev-settings.json'
if (-not (Test-Path -LiteralPath $settingsFile)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    @{ BootstrapToken = [Convert]::ToBase64String($bytes) } | ConvertTo-Json | Set-Content -LiteralPath $settingsFile -Encoding utf8
}
$settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:ASPNETCORE_URLS = "http://127.0.0.1:$Port"
$env:Database__Provider = 'Sqlite'
$env:Storage__Root = Join-Path $localDir 'dev-data'
$env:Bootstrap__Token = $settings.BootstrapToken
Write-Host "LogDesk: http://127.0.0.1:$Port"
Write-Host "First-run initialization token is in: $settingsFile"
Push-Location (Join-Path $repo 'src/LogDesk.Server')
try { & $dotnet (Join-Path $repo 'src/LogDesk.Server/bin/Debug/net10.0/LogDesk.Server.dll') } finally { Pop-Location }
