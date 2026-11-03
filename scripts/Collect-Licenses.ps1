param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$noticeRoot = Join-Path $Output 'licenses'
New-Item -ItemType Directory -Force -Path $noticeRoot | Out-Null
Copy-Item -Path (Join-Path $repo 'third-party/*') -Destination $noticeRoot -Recurse -Force
$npmRoot = Join-Path $repo 'src/LogDesk.Client/node_modules'
Get-ChildItem -LiteralPath $npmRoot -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|COPYING)(\.|$|-)' } | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($npmRoot,$_.FullName)
    $destination = Join-Path $noticeRoot (Join-Path 'npm' $relative)
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
$assets = Get-Content (Join-Path $repo 'src/LogDesk.Server/obj/project.assets.json') -Raw | ConvertFrom-Json -AsHashtable
foreach ($package in $assets.libraries.GetEnumerator() | Where-Object { $_.Value.type -eq 'package' }) {
    foreach ($packageRoot in $assets.packageFolders.Keys) {
        $folder = Join-Path $packageRoot $package.Value.path
        if (-not (Test-Path -LiteralPath $folder)) { continue }
        $destination = Join-Path $noticeRoot (Join-Path 'nuget' $package.Key)
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        Get-ChildItem -LiteralPath $folder -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|COPYING|THIRD-PARTY)(\.|$|-)' -or $_.Extension -eq '.nuspec' } | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destination $_.Name) -Force
        }
        break
    }
}
# The self-contained runtime ships separate third-party notices in its NuGet pack.
foreach ($packageRoot in $assets.packageFolders.Keys) {
    $runtimeRoot = Join-Path $packageRoot 'microsoft.netcore.app.runtime.win-x64'
    if (Test-Path -LiteralPath $runtimeRoot) {
        $runtimeVersion = Get-ChildItem -LiteralPath $runtimeRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
        Get-ChildItem -LiteralPath $runtimeVersion.FullName -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|THIRD-PARTY-NOTICES)' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $noticeRoot ('dotnet-' + $_.Name)) -Force }
    }
}
