#Requires -Version 5.1
param(
    [string]$Url,
    [string]$AppPath = $PSScriptRoot,
    [ValidateRange(0, 60)][int]$WaitSeconds = 0
)
$ErrorActionPreference = 'Stop'
if (-not $Url) { $Url = Read-Host 'DWorkBench HTTPS URL (for example https://dworkbench.example.internal)' }
$address = $null
if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$address) -or $address.Scheme -ne 'https' -or $address.UserInfo -or $address.Query -or $address.Fragment -or $address.AbsolutePath -notin @('/', '/api/health')) {
    throw 'Enter the HTTPS application origin or /api/health URL, without credentials or query parameters.'
}
$healthUrl = $address.GetLeftPart([UriPartial]::Authority) + '/api/health'
$failures = New-Object System.Collections.Generic.List[string]
$service = Get-Service -Name DWorkBench -ErrorAction SilentlyContinue
if (-not $service) { $failures.Add('DWorkBench service is not installed.'); Write-Host 'Service: NOT INSTALLED' }
else {
    Write-Host "Service: $($service.Status)"
    if ($service.Status -ne 'Running') { $failures.Add('DWorkBench service is not running.') }
}
$settingsFile = Join-Path $AppPath 'appsettings.local.json'
if (Test-Path -LiteralPath $settingsFile) {
    try {
        $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        Write-Host "Data directory: $($settings.Storage.Root)"
        if ($settings.Hosting.Port -and [int]$settings.Hosting.Port -ne $address.Port) { $failures.Add('The URL port differs from Hosting.Port in the local configuration.') }
    } catch { $failures.Add('Cannot read the local configuration. Run this check as administrator.') }
} else { $failures.Add('appsettings.local.json is missing from AppPath.') }
# Keep normal Windows certificate-chain and hostname validation. No trust override.
$previousProtocol = [Net.ServicePointManager]::SecurityProtocol
$previousRevocation = [Net.ServicePointManager]::CheckCertificateRevocationList
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::CheckCertificateRevocationList = $true
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $healthy = $false
    do {
        try {
            $result = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 10 -MaximumRedirection 0
            if ($result.status -ne 'ok') { throw 'The endpoint did not report status ok.' }
            $healthy = $true
        } catch {
            # Do not print response bodies or exception details that may contain configuration.
            if ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
        }
    } while (-not $healthy -and (Get-Date) -lt $deadline)
    if ($healthy) { Write-Host "HTTPS health: OK ($healthUrl)" }
    else {
        $failures.Add('HTTPS health check failed. Check service events, DNS, port, certificate SAN, trusted CA chain and revocation availability.')
        Write-Host "HTTPS health: FAILED ($healthUrl)"
    }
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
    [Net.ServicePointManager]::CheckCertificateRevocationList = $previousRevocation
}
Write-Host ''
Write-Host 'Recent application events (metadata only; inspect full messages in Event Viewer):'
try {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'DWorkBench' } -MaxEvents 10 -ErrorAction Stop)
    $events | Select-Object TimeCreated, LevelDisplayName, Id | Format-Table -AutoSize | Out-Host
} catch { Write-Host 'No readable DWorkBench events. Use an elevated terminal if event access is denied.' }
if ($failures.Count) { throw ($failures -join ' ') }
Write-Host 'Installation checks passed. Complete first-admin setup in your browser, then configure a host.'
