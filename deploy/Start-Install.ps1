#Requires -Version 5.1
param([switch]$Elevated)
$ErrorActionPreference = 'Stop'
# Use the inbox Windows PowerShell APIs; execution policy is changed only for this process.
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($Elevated) { throw 'Administrator access is required.' }
    $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Elevated'
    try {
        $child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
        exit $child.ExitCode
    } catch { Write-Host 'Administrator approval was cancelled or PowerShell could not start.'; exit 1 }
}
function Read-Value([string]$Label, [string]$Default = '') {
    $suffix = if ($Default) { " [$Default]" } else { '' }
    while ($true) {
        $value = (Read-Host "$Label$suffix").Trim()
        if (-not $value) { $value = $Default }
        if ($value) { return $value }
    }
}
function Read-Yes([string]$Label, [bool]$Default = $false) {
    $suffix = if ($Default) { 'Y/n' } else { 'y/N' }
    while ($true) {
        $value = (Read-Host "$Label [$suffix]").Trim()
        if (-not $value) { return $Default }
        if ($value -match '^(y|yes)$') { return $true }
        if ($value -match '^(n|no)$') { return $false }
    }
}
function Read-Port([string]$Label, [int]$Default) {
    while ($true) {
        $text = Read-Value $Label ([string]$Default)
        $number = 0
        if ([int]::TryParse($text, [ref]$number) -and $number -ge 1 -and $number -le 65535) { return $number }
        Write-Host 'Enter a port between 1 and 65535.'
    }
}
function Read-Secret([string]$Label, [int]$MinimumLength = 1, [bool]$PrintableAscii = $false) {
    while ($true) {
        $secret = Read-Host $Label -AsSecureString
        $repeat = Read-Host 'Repeat password' -AsSecureString
        $plain = [Management.Automation.PSCredential]::new('unused', $secret).GetNetworkCredential().Password
        $confirmation = [Management.Automation.PSCredential]::new('unused', $repeat).GetNetworkCredential().Password
        $valid = $plain.Length -ge $MinimumLength -and $plain -ceq $confirmation -and (-not $PrintableAscii -or $plain -cmatch '^[\x20-\x7e]+$')
        $plain = $null
        $confirmation = $null
        $repeat.Dispose()
        if ($valid) { return $secret }
        $secret.Dispose()
        Write-Host "Passwords must match and contain at least $MinimumLength characters."
        if ($PrintableAscii) { Write-Host 'Use printable ASCII characters (spaces are allowed).' }
    }
}
function Select-HttpsCertificate([string]$CurrentThumbprint) {
    $certificates = @(Get-ChildItem Cert:\LocalMachine\My | Where-Object {
        $_.HasPrivateKey -and $_.PublicKey.Oid.Value -eq '1.2.840.113549.1.1.1' -and $_.NotAfter -gt (Get-Date) -and $_.NotBefore -le (Get-Date)
    } | Sort-Object Subject, NotAfter)
    Write-Host ''
    Write-Host 'HTTPS certificate (must be issued by a CA trusted by this server and team browsers):'
    $default = 'I'
    for ($index = 0; $index -lt $certificates.Count; $index++) {
        $cert = $certificates[$index]
        Write-Host ("{0}. {1} | expires {2:yyyy-MM-dd} | {3}" -f ($index + 1), $cert.Subject, $cert.NotAfter, $cert.Thumbprint)
        if ($cert.Thumbprint -ieq ($CurrentThumbprint -replace '\s','')) { $default = [string]($index + 1) }
    }
    Write-Host 'I. Import an HTTPS PFX file'
    while ($true) {
        $selection = Read-Value 'Certificate number or I' $default
        if ($selection -ieq 'I') {
            $path = [IO.Path]::GetFullPath((Read-Value 'HTTPS PFX full path').Trim('"'))
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-Host 'PFX file not found.'; continue }
            $password = Read-Host 'HTTPS PFX password' -AsSecureString
            return @{ PfxPath = $path; Password = $password; Thumbprint = $null }
        }
        $number = 0
        if ([int]::TryParse($selection, [ref]$number) -and $number -ge 1 -and $number -le $certificates.Count) { return @{ Thumbprint = $certificates[$number - 1].Thumbprint; PfxPath = $null; Password = $null } }
    }
}
function Assert-LocalDirectory([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.TrimEnd('\') -eq [IO.Path]::GetPathRoot($Path).TrimEnd('\')) { throw 'Choose a dedicated local directory, not a drive root or network share.' }
    $cursor = $Path
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Do not use junctions or symbolic links for installation/backup directories.' }
        $parent = Split-Path $cursor -Parent
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
$exitCode = 1
$dbPassword = $null
$backupPassword = $null
$httpsChoice = $null
$connection = $null
try {
    Write-Host 'DWorkBench installation'
    Write-Host 'Extract the release into its final dedicated application directory before continuing.'
    Write-Host 'Prepare local PostgreSQL, your internal DNS name and a trusted HTTPS RSA certificate.'
    Write-Host 'Keep your database, original configuration, key ring and protection certificate backups when upgrading.'
    Write-Host ''
    $appPath = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
    Assert-LocalDirectory $appPath
    if (-not (Test-Path -LiteralPath (Join-Path $appPath 'DWorkBench.Server.exe'))) { throw 'Run this wizard from the extracted Windows release package.' }
    $settingsFile = Join-Path $appPath 'appsettings.local.json'
    $existing = $null
    if (Test-Path -LiteralPath $settingsFile) {
        if ((Get-Item -LiteralPath $settingsFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The local configuration must not be a symbolic link.' }
        try { $existing = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json }
        catch { throw 'The local configuration could not be parsed. Correct appsettings.local.json before installing.' }
        if (-not $existing) { throw 'The local configuration is empty. Restore the original configuration before continuing.' }
    }
    $service = Get-Service DWorkBench -ErrorAction SilentlyContinue
    $legacy = Get-Service LogDesk -ErrorAction SilentlyContinue
    if ($legacy -and ($legacy.Status -ne 'Stopped' -or $legacy.StartType -ne 'Disabled')) { throw 'Stop and disable the old LogDesk service first. See DEPLOYMENT.md.' }
    if (($service -or $legacy) -and -not $existing) { throw 'Existing service detected. Copy the original appsettings.local.json into this release directory before upgrading.' }
    $initializeDatabase = $false
    if ($existing) {
        $dataRoot = $existing.Storage.Root
        $protectionThumbprint = $existing.Protection.CertificateThumbprint
        $connection = $existing.ConnectionStrings.DWorkBench
        if (-not $connection) { $connection = $existing.ConnectionStrings.LogDesk }
        if (-not $dataRoot -or -not $protectionThumbprint -or -not $connection -or $existing.Protection.CertificatePath) { throw 'The existing configuration is incomplete or uses a PFX path. Use the manual migration instructions; no settings have been changed.' }
        Write-Host 'Upgrade: preserving database credentials, DataRoot, protection certificate and custom settings.'
        $portDefault = if ($existing.Hosting.Port) { [int]$existing.Hosting.Port } else { 443 }
        $httpsDefault = $existing.Hosting.HttpsCertificateThumbprint
        $backupPath = $null
    } else {
        $dataRoot = Read-Value 'Dedicated data directory' 'D:\DWorkBench'
        $dataRoot = [IO.Path]::GetFullPath($dataRoot.Trim('"')).TrimEnd('\')
        if (Test-Path -LiteralPath (Join-Path $dataRoot 'secrets\keys')) { throw 'An existing key ring was found. Restore the original configuration and protection certificate; do not create a replacement.' }
        $initializeDatabase = Read-Yes 'Create a NEW database and application role using the bundled helper' $true
        $dbServer = Read-Value 'PostgreSQL host' '127.0.0.1'
        $dbPort = Read-Port 'PostgreSQL port' 5432
        $dbName = Read-Value 'Application database name' 'dworkbench'
        $dbUser = Read-Value 'Application database user' 'dworkbench_app'
        if ($initializeDatabase) { $dbPassword = Read-Secret 'NEW database password (16+ printable ASCII characters)' 16 $true }
        else { $dbPassword = Read-Secret 'Existing application database password' }
        $builder = [System.Data.Common.DbConnectionStringBuilder]::new()
        $builder['Host'] = $dbServer
        $builder['Port'] = $dbPort
        $builder['Database'] = $dbName
        $builder['Username'] = $dbUser
        $builder['Password'] = [Management.Automation.PSCredential]::new('unused', $dbPassword).GetNetworkCredential().Password
        $connection = $builder.ConnectionString
        $builder.Clear()
        if ($initializeDatabase) {
            $adminUsername = Read-Value 'PostgreSQL administrator user' 'postgres'
            $psqlPath = (Read-Host 'Full path to psql.exe (Enter to auto-detect)').Trim().Trim('"')
        }
        $portDefault = 443
        $httpsDefault = ''
        $protectionThumbprint = $null
        Write-Host ''
        Write-Host 'A separate credential protection certificate will be created and exported as a password-protected PFX.'
        Write-Host 'Store this backup outside the application/data directories; archive it securely with the database and key ring.'
        $backupPath = [IO.Path]::GetFullPath((Read-Value 'New protection PFX backup file path' 'D:\DWorkBench-Backup\credential-protection.pfx').Trim('"'))
        if (Test-Path -LiteralPath $backupPath) { throw 'The backup path already exists. Choose a new filename; existing backups are never overwritten.' }
        Assert-LocalDirectory (Split-Path $backupPath -Parent)
        $backupPassword = Read-Secret 'Protection PFX backup password (12+ characters)' 12
    }
    $dataRoot = [IO.Path]::GetFullPath($dataRoot).TrimEnd('\')
    Assert-LocalDirectory $dataRoot
    if ($dataRoot -ieq $appPath -or $dataRoot.StartsWith($appPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Data directory must be outside the application directory.' }
    foreach ($name in @('secrets','temp','logs')) {
        $writablePath = Join-Path $dataRoot $name
        if ($appPath -ieq $writablePath -or $appPath.StartsWith($writablePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Application directory must be outside writable secrets, temp and logs directories. Use DataRoot\app or a separate dedicated directory.' }
    }
    if ($backupPath) {
        foreach ($excluded in @($appPath, $dataRoot)) {
            if ($backupPath.StartsWith($excluded + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Store the protection PFX outside the application and data directories.' }
        }
    } else {
        $protectionCert = Get-Item -LiteralPath "Cert:\LocalMachine\My\$protectionThumbprint"
        if (-not $protectionCert.HasPrivateKey -or $protectionCert.PublicKey.Oid.Value -ne '1.2.840.113549.1.1.1') { throw 'Restore the original RSA protection certificate with its private key before upgrading.' }
    }
    $httpsChoice = Select-HttpsCertificate $httpsDefault
    $port = Read-Port 'HTTPS port' $portDefault
    $dnsName = Read-Value 'HTTPS DNS name (must match certificate SAN)' $env:COMPUTERNAME
    $url = 'https://' + $dnsName
    if ($port -ne 443) { $url += ':' + $port }
    $parsedUrl = $null
    if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$parsedUrl) -or $parsedUrl.UserInfo -or $parsedUrl.AbsolutePath -ne '/' -or $parsedUrl.Query -or $parsedUrl.Fragment -or $parsedUrl.Port -ne $port) { throw 'Enter only a DNS host name or an IPv4 address.' }
    $networkDefault = 'LocalSubnet'
    $firewall = Get-NetFirewallRule -Name DWorkBench-HTTPS -ErrorAction SilentlyContinue
    if ($firewall) { $networkDefault = ((Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $firewall).RemoteAddress -join ',') }
    $networks = @((Read-Value 'Allowed team addresses/subnets (comma-separated)' $networkDefault).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    Write-Host ''
    Write-Host "Application: $appPath"
    Write-Host "Data:        $dataRoot"
    Write-Host "URL:         $url"
    Write-Host "Allowed:     $($networks -join ', ')"
    if ($backupPath) { Write-Host "PFX backup:  $backupPath" }
    Write-Host 'Installation updates the Windows service, dedicated directory ACLs and HTTPS firewall rule.'
    if (-not (Read-Yes 'These are dedicated DWorkBench directories. Proceed with installation' $false)) { throw 'Installation cancelled; no installation changes were made.' }
    if ($httpsChoice.PfxPath) {
        $imported = @(Import-PfxCertificate -FilePath $httpsChoice.PfxPath -CertStoreLocation Cert:\LocalMachine\My -Password $httpsChoice.Password)
        $leaves = @($imported | Where-Object { $_.HasPrivateKey -and $_.PublicKey.Oid.Value -eq '1.2.840.113549.1.1.1' })
        if ($leaves.Count -ne 1) { throw 'PFX must contain exactly one RSA certificate with a private key.' }
        $httpsChoice.Thumbprint = $leaves[0].Thumbprint
    }
    $httpsCert = Get-Item -LiteralPath "Cert:\LocalMachine\My\$($httpsChoice.Thumbprint)"
    $httpsEku = @($httpsCert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
    if ($httpsEku.Count -gt 0 -and -not @($httpsEku[0].EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.1' -or $_.Value -eq '2.5.29.37.0' }).Count) { throw 'The HTTPS certificate does not allow server authentication.' }
    if (-not $httpsCert.Verify()) { throw 'HTTPS certificate validation failed. Install the trusted CA chain and ensure its revocation services are reachable.' }
    if ($backupPath) {
        New-Item -ItemType Directory -Path (Split-Path $backupPath -Parent) -Force | Out-Null
        $protectionCert = New-SelfSignedCertificate -Subject 'CN=DWorkBench-CredentialProtection' -CertStoreLocation Cert:\LocalMachine\My -KeyAlgorithm RSA -KeyLength 3072 -KeyExportPolicy Exportable -KeyUsage KeyEncipherment,DataEncipherment -NotAfter (Get-Date).AddYears(3)
        Export-PfxCertificate -Cert $protectionCert -FilePath $backupPath -Password $backupPassword | Out-Null
        $backupAcl = Get-Acl -LiteralPath $backupPath
        $backupAcl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($backupAcl.Access)) { $backupAcl.RemoveAccessRuleSpecific($rule) }
        foreach ($sid in @('S-1-5-32-544', 'S-1-5-18')) { $backupAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow')) }
        Set-Acl -LiteralPath $backupPath -AclObject $backupAcl
        $protectionThumbprint = $protectionCert.Thumbprint
        Write-Host "Protection certificate backup created: $backupPath"
        Write-Host 'Keep this PFX password separate from the backup file.'
    }
    if ($initializeDatabase) {
        $dbArguments = @{ Server = $dbServer; Port = $dbPort; Database = $dbName; Username = $dbUser; Password = $dbPassword; AdminUsername = $adminUsername }
        if ($psqlPath) { $dbArguments.PsqlPath = $psqlPath }
        & (Join-Path $appPath 'Initialize-Database.ps1') @dbArguments
    }
    & (Join-Path $appPath 'Install-Windows.ps1') -AppPath $appPath -DataRoot $dataRoot -DatabaseConnectionString $connection -HttpsCertificateThumbprint $httpsChoice.Thumbprint -ProtectionCertificateThumbprint $protectionThumbprint -AllowedRemoteAddress $networks -Port $port
    & (Join-Path $appPath 'Check-Installation.ps1') -AppPath $appPath -Url $url -WaitSeconds 30
    Write-Host ''
    Write-Host "Open $url in a team browser."
    if (-not $existing -and (Read-Yes 'Display the first-admin initialization token in this terminal now' $true)) {
        $token = (Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json).Bootstrap.Token
        Write-Host "Initialization token: $token"
        $token = $null
        Write-Host 'Use this token only on the first-admin setup page. Do not copy it into shared logs or tickets.'
    } else { Write-Host "If first-admin setup is needed, its token is in Bootstrap.Token in $settingsFile" }
    $exitCode = 0
} catch {
    Write-Host ''
    Write-Host ('Installation stopped: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Completed setup steps are not automatically undone. Preserve any created certificate/PFX and database.'
    Write-Host 'See QUICKSTART.zh-CN.md or DEPLOYMENT.md before retrying.'
} finally {
    $connection = $null
    if ($dbPassword) { $dbPassword.Dispose() }
    if ($backupPassword) { $backupPassword.Dispose() }
    if ($httpsChoice -and $httpsChoice.Password) { $httpsChoice.Password.Dispose() }
}
[void](Read-Host 'Press Enter to close')
exit $exitCode
