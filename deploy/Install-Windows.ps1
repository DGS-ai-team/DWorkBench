#Requires -Version 5.1
#Requires -RunAsAdministrator
param(
    [string]$AppPath = $PSScriptRoot,
    [string]$DataRoot = 'D:\DWorkBench',
    [Parameter(Mandatory)][string]$DatabaseConnectionString,
    [Parameter(Mandatory)][string]$HttpsCertificateThumbprint,
    [Parameter(Mandatory)][string]$ProtectionCertificateThumbprint,
    [string[]]$AllowedRemoteAddress = @('LocalSubnet'),
    [int]$Port = 443
)
$ErrorActionPreference = 'Stop'

function ConvertTo-SettingsMap($Value) {
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $map = @{}
        foreach ($property in $Value.PSObject.Properties) { $map[$property.Name] = ConvertTo-SettingsMap $property.Value }
        return $map
    }
    if ($Value -is [Array]) { return ,@($Value | ForEach-Object { ConvertTo-SettingsMap $_ }) }
    return $Value
}
function Set-Setting([hashtable]$Settings, [string]$Section, [string]$Name, $Value) {
    if (-not $Settings.ContainsKey($Section)) { $Settings[$Section] = @{} }
    if ($Settings[$Section] -isnot [hashtable]) { throw "Invalid configuration section: $Section" }
    $Settings[$Section][$Name] = $Value
}
function Assert-DedicatedPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.TrimEnd('\') -eq [IO.Path]::GetPathRoot($Path).TrimEnd('\')) { throw 'Use dedicated local directories, not drive roots or network shares.' }
    foreach ($reserved in @($env:windir, $env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:ProgramData, $env:USERPROFILE, (Join-Path $env:SystemDrive 'Users'))) {
        if ($reserved -and $Path.TrimEnd('\') -ieq $reserved.TrimEnd('\')) { throw "A shared system directory cannot be used: $Path" }
    }
    if ($env:windir -and $Path.StartsWith($env:windir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Do not install inside Windows.' }
    $cursor = $Path
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse points are not supported in installation paths: $cursor" }
        $parent = Split-Path -Path $cursor -Parent
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Get-CertificateKeyPath([string]$Thumbprint, [bool]$RequireHttps) {
    $cert = Get-Item -LiteralPath "Cert:\LocalMachine\My\$Thumbprint"
    if (-not $cert.HasPrivateKey) { throw 'Certificate private key is missing.' }
    if ($RequireHttps) {
        if ((Get-Date) -lt $cert.NotBefore -or (Get-Date) -ge $cert.NotAfter) { throw 'The HTTPS certificate is not currently valid.' }
        $eku = @($cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
        if ($eku.Count -gt 0 -and -not @($eku[0].EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.1' -or $_.Value -eq '2.5.29.37.0' }).Count) { throw 'The HTTPS certificate does not allow server authentication.' }
        if (-not $cert.Verify()) { throw 'The HTTPS chain is not trusted or cannot be validated. Install the organization CA chain and make its revocation services reachable.' }
    }
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
    try {
        if ($rsa -is [Security.Cryptography.RSACng]) { $keyFile = Join-Path $env:ProgramData "Microsoft\Crypto\Keys\$($rsa.Key.UniqueName)" }
        elseif ($rsa -is [Security.Cryptography.RSACryptoServiceProvider]) { $keyFile = Join-Path $env:ProgramData "Microsoft\Crypto\RSA\MachineKeys\$($rsa.CspKeyContainerInfo.UniqueKeyContainerName)" }
        else { throw 'This installer expects RSA certificates with persisted machine private keys.' }
        if (-not (Test-Path -LiteralPath $keyFile -PathType Leaf)) { throw 'The machine certificate private key file was not found.' }
        return $keyFile
    } finally { if ($rsa) { $rsa.Dispose() } }
}
$AppPath = [IO.Path]::GetFullPath($AppPath).TrimEnd('\')
$DataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
Assert-DedicatedPath $AppPath
Assert-DedicatedPath $DataRoot
if ($AppPath -ieq $DataRoot -or $DataRoot.StartsWith($AppPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'DataRoot must be outside AppPath; AppPath may be a child of DataRoot.' }
foreach ($name in @('secrets','temp','logs')) {
    $writablePath = Join-Path $DataRoot $name
    if ($AppPath -ieq $writablePath -or $AppPath.StartsWith($writablePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'AppPath must not be inside writable secrets, temp or logs directories. Use a separate app directory.' }
}
$exe = Join-Path $AppPath 'DWorkBench.Server.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Extract the published Windows package before installing.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid HTTPS port.' }
if ([string]::IsNullOrWhiteSpace($DatabaseConnectionString)) { throw 'A PostgreSQL connection string is required.' }
if ($AllowedRemoteAddress.Count -eq 0 -or @($AllowedRemoteAddress | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count) { throw 'Specify at least one team IP address or subnet.' }
$HttpsCertificateThumbprint = ($HttpsCertificateThumbprint -replace '\s','').ToUpperInvariant()
$ProtectionCertificateThumbprint = ($ProtectionCertificateThumbprint -replace '\s','').ToUpperInvariant()
if ($HttpsCertificateThumbprint -notmatch '^[0-9A-F]{40}$' -or $ProtectionCertificateThumbprint -notmatch '^[0-9A-F]{40}$') { throw 'Invalid certificate thumbprint.' }
$settingsFile = Join-Path $AppPath 'appsettings.local.json'
if ((Test-Path -LiteralPath $settingsFile) -and ((Get-Item -LiteralPath $settingsFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The local configuration must not be a reparse point.' }
$settings = @{}
if (Test-Path -LiteralPath $settingsFile) {
    try { $settings = ConvertTo-SettingsMap (Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json) }
    catch { throw 'The local configuration could not be parsed. Correct appsettings.local.json before installing.' }
    if ($settings -isnot [hashtable]) { throw 'Invalid local configuration.' }
    if ($settings.Storage.Root -and [IO.Path]::GetFullPath($settings.Storage.Root).TrimEnd('\') -ine $DataRoot) { throw 'Keep the existing DataRoot and key ring. Migrations require a separate backup/restore procedure.' }
    if ($settings.Protection.CertificatePath) { throw 'Existing protection uses a PFX path. This installer will not replace it; follow the manual migration procedure.' }
    if ($settings.Protection.CertificateThumbprint -and ($settings.Protection.CertificateThumbprint -replace '\s','') -ine $ProtectionCertificateThumbprint) { throw 'Keep the existing credential protection certificate. Automatic replacement is not supported.' }
}
foreach ($section in @('Database','ConnectionStrings','Storage','Hosting','Protection','Bootstrap')) {
    if ($settings.ContainsKey($section) -and $settings[$section] -isnot [hashtable]) { throw "Invalid configuration section: $section" }
}
$service = Get-Service -Name DWorkBench -ErrorAction SilentlyContinue
$legacyService = Get-Service -Name LogDesk -ErrorAction SilentlyContinue
if ($legacyService) {
    if ($legacyService.Status -ne 'Stopped' -or $legacyService.StartType -ne 'Disabled') { throw 'Stop and disable the legacy LogDesk service first. See DEPLOYMENT.md.' }
    if (-not $PSBoundParameters.ContainsKey('DataRoot')) { throw 'Specify the existing -DataRoot explicitly when upgrading.' }
}
if (($service -or $legacyService -or (Test-Path -LiteralPath (Join-Path $DataRoot 'secrets\keys'))) -and -not (Test-Path -LiteralPath $settingsFile)) { throw 'Existing installation detected. Copy its original appsettings.local.json into this application directory before upgrading.' }
# Validate before stopping the current application or changing ACLs.
$httpsKey = Get-CertificateKeyPath $HttpsCertificateThumbprint $true
$protectionKey = Get-CertificateKeyPath $ProtectionCertificateThumbprint $false
$sidService = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
$sidAdmins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$sidSystem = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Protect-Directory([string]$Path, [string]$ServiceRights) {
    Assert-DedicatedPath $Path
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    foreach ($sid in @($sidAdmins, $sidSystem)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sidService,$ServiceRights,'ContainerInherit,ObjectInherit','None','Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
foreach ($name in @('secrets','temp','logs')) { Assert-DedicatedPath (Join-Path $DataRoot $name) }
if ($service) {
    Stop-Service -Name DWorkBench
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
}
foreach ($keyFile in @($httpsKey, $protectionKey)) {
    $acl = Get-Acl -LiteralPath $keyFile
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sidService,'Read','Allow'))
    Set-Acl -LiteralPath $keyFile -AclObject $acl
}
Protect-Directory $DataRoot 'ReadAndExecute'
Protect-Directory $AppPath 'ReadAndExecute'
foreach ($name in @('secrets','temp','logs')) { Protect-Directory (Join-Path $DataRoot $name) 'Modify' }
if (Test-Path -LiteralPath $settingsFile) {
    # A copied file may retain explicit grants even after its parent ACL is restricted.
    $settingsAcl = Get-Acl -LiteralPath $settingsFile
    $settingsAcl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($settingsAcl.Access)) { $settingsAcl.RemoveAccessRuleSpecific($rule) }
    foreach ($sid in @($sidAdmins, $sidSystem)) { $settingsAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')) }
    $settingsAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sidService, 'Read', 'Allow'))
    Set-Acl -LiteralPath $settingsFile -AclObject $settingsAcl
}
$bootstrap = $settings.Bootstrap.Token
if (-not $bootstrap) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $bootstrap = [Convert]::ToBase64String($bytes)
}
Set-Setting $settings 'Database' 'Provider' 'Postgres'
Set-Setting $settings 'ConnectionStrings' 'DWorkBench' $DatabaseConnectionString
Set-Setting $settings 'Storage' 'Root' $DataRoot
Set-Setting $settings 'Hosting' 'HttpsCertificateThumbprint' $HttpsCertificateThumbprint
Set-Setting $settings 'Hosting' 'Port' $Port
Set-Setting $settings 'Protection' 'CertificateThumbprint' $ProtectionCertificateThumbprint
Set-Setting $settings 'Bootstrap' 'Token' $bootstrap
# Retain Limits, logging, Bootstrap and all other operator settings.
$temporarySettings = Join-Path $AppPath ([IO.Path]::GetRandomFileName())
try {
    $settings | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $temporarySettings -Encoding utf8
    if (Test-Path -LiteralPath $settingsFile) { [IO.File]::Replace($temporarySettings, $settingsFile, $null) }
    else { Move-Item -LiteralPath $temporarySettings -Destination $settingsFile }
} finally { if (Test-Path -LiteralPath $temporarySettings) { Remove-Item -LiteralPath $temporarySettings } }
if (-not [Diagnostics.EventLog]::SourceExists('DWorkBench')) { New-EventLog -LogName Application -Source DWorkBench }
$binary = '"' + $exe + '" --contentRoot "' + $AppPath + '" --environment Production'
if ($service) {
    $serviceRecord = Get-CimInstance -ClassName Win32_Service -Filter "Name='DWorkBench'"
    $change = Invoke-CimMethod -InputObject $serviceRecord -MethodName Change -Arguments @{ PathName = $binary }
    if ($change.ReturnValue -ne 0) { throw 'Unable to update the service executable path.' }
} else { New-Service -Name DWorkBench -BinaryPathName $binary -DisplayName 'DWorkBench Team Workspace' -StartupType Automatic | Out-Null }
if ((Get-CimInstance -ClassName Win32_Service -Filter "Name='DWorkBench'").PathName -cne $binary) { throw 'The registered service path does not match the application path. The service has not been started.' }
& sc.exe config DWorkBench obj= 'NT AUTHORITY\LocalService' start= auto
if ($LASTEXITCODE) { throw 'Unable to configure service identity.' }
& sc.exe failure DWorkBench reset= 86400 actions= restart/5000/restart/15000/restart/60000
if ($LASTEXITCODE) { throw 'Unable to configure service recovery.' }
if (Get-NetFirewallRule -Name DWorkBench-HTTPS -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name DWorkBench-HTTPS }
New-NetFirewallRule -Name DWorkBench-HTTPS -DisplayName 'DWorkBench HTTPS' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $AllowedRemoteAddress -Action Allow -Program $exe | Out-Null
if ($legacyService -and (Get-NetFirewallRule -Name LogDesk-HTTPS -ErrorAction SilentlyContinue)) { Disable-NetFirewallRule -Name LogDesk-HTTPS | Out-Null }
Start-Service -Name DWorkBench
(Get-Service -Name DWorkBench).WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
Write-Host 'DWorkBench service is running. Verify /api/health over HTTPS before initializing.'
Write-Host "Initialization token is stored in Bootstrap.Token in: $settingsFile"
