#Requires -RunAsAdministrator
param(
    [string]$AppPath = $PSScriptRoot,
    [string]$DataRoot = 'D:\LogDesk',
    [Parameter(Mandatory)][string]$DatabaseConnectionString,
    [Parameter(Mandatory)][string]$HttpsCertificateThumbprint,
    [Parameter(Mandatory)][string]$ProtectionCertificateThumbprint,
    [string[]]$AllowedRemoteAddress = @('LocalSubnet'),
    [int]$Port = 443
)
$ErrorActionPreference = 'Stop'
$AppPath = [IO.Path]::GetFullPath($AppPath)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if ($AppPath.TrimEnd('\') -eq [IO.Path]::GetPathRoot($AppPath).TrimEnd('\') -or $DataRoot.TrimEnd('\') -eq [IO.Path]::GetPathRoot($DataRoot).TrimEnd('\')) { throw 'Application and data paths must be dedicated directories, not drive roots.' }
$exe = Join-Path $AppPath 'LogDesk.Server.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Extract the published Windows package before installing.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid HTTPS port.' }
$sidService = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
$sidAdmins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$sidSystem = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Protect-Directory([string]$Path, [string]$ServiceRights) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    foreach ($sid in @($sidAdmins, $sidSystem)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sidService,$ServiceRights,'ContainerInherit,ObjectInherit','None','Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Allow-Certificate([string]$Thumbprint) {
    $cert = Get-Item -LiteralPath "Cert:\LocalMachine\My\$Thumbprint"
    if (-not $cert.HasPrivateKey) { throw 'Certificate private key is missing.' }
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
    if ($rsa -is [Security.Cryptography.RSACng]) { $keyFile = Join-Path $env:ProgramData "Microsoft\Crypto\Keys\$($rsa.Key.UniqueName)" }
    elseif ($rsa -is [Security.Cryptography.RSACryptoServiceProvider]) { $keyFile = Join-Path $env:ProgramData "Microsoft\Crypto\RSA\MachineKeys\$($rsa.CspKeyContainerInfo.UniqueKeyContainerName)" }
    else { throw 'This installer expects RSA certificates with a persisted private key.' }
    $acl = Get-Acl -LiteralPath $keyFile
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sidService,'Read','Allow'))
    Set-Acl -LiteralPath $keyFile -AclObject $acl
    $rsa.Dispose()
}
Allow-Certificate $HttpsCertificateThumbprint
Allow-Certificate $ProtectionCertificateThumbprint
Protect-Directory $DataRoot 'ReadAndExecute'
Protect-Directory $AppPath 'ReadAndExecute'
foreach ($name in @('secrets','temp','logs')) { Protect-Directory (Join-Path $DataRoot $name) 'Modify' }
$settingsFile = Join-Path $AppPath 'appsettings.local.json'
$bootstrap = if (Test-Path -LiteralPath $settingsFile) { (Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json).Bootstrap.Token } else { $null }
if (-not $bootstrap) { $bytes=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); $bootstrap=[Convert]::ToBase64String($bytes) }
$settings = @{
    Database = @{ Provider = 'Postgres' }; ConnectionStrings = @{ LogDesk = $DatabaseConnectionString }
    Storage = @{ Root = $DataRoot }; Hosting = @{ HttpsCertificateThumbprint = $HttpsCertificateThumbprint; Port = $Port }
    Protection = @{ CertificateThumbprint = $ProtectionCertificateThumbprint }; Bootstrap = @{ Token = $bootstrap }
}
$settings | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $settingsFile -Encoding utf8
if (-not [Diagnostics.EventLog]::SourceExists('LogDesk')) { New-EventLog -LogName Application -Source LogDesk }
$binary = '"' + $exe + '" --contentRoot "' + $AppPath + '" --environment Production'
$service = Get-Service -Name LogDesk -ErrorAction SilentlyContinue
if ($service) { Stop-Service LogDesk; & sc.exe config LogDesk binPath= $binary } else { New-Service -Name LogDesk -BinaryPathName $binary -DisplayName 'LogDesk Team Workspace' -StartupType Automatic | Out-Null }
& sc.exe config LogDesk obj= 'NT AUTHORITY\LocalService' start= auto
if ($LASTEXITCODE) { throw 'Unable to configure service identity.' }
& sc.exe failure LogDesk reset= 86400 actions= restart/5000/restart/15000/restart/60000
if ($LASTEXITCODE) { throw 'Unable to configure service recovery.' }
if (Get-NetFirewallRule -Name LogDesk-HTTPS -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name LogDesk-HTTPS }
New-NetFirewallRule -Name LogDesk-HTTPS -DisplayName 'LogDesk HTTPS' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $AllowedRemoteAddress -Action Allow -Program $exe | Out-Null
Start-Service LogDesk
Write-Host 'LogDesk service installed. Verify /api/health over HTTPS before initializing.'
Write-Host "Initialization token is stored in Bootstrap.Token in: $settingsFile"
