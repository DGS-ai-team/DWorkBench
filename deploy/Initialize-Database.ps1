#Requires -Version 5.1
<#
.SYNOPSIS
Creates a dedicated PostgreSQL role and database for a new DWorkBench install.
.DESCRIPTION
Requires an existing PostgreSQL server and psql.exe. This script does not install
software, alter existing roles/databases, or change server logging or OS settings.
Passwords are prompted securely. New application passwords must contain at least
16 printable ASCII characters so local SCRAM generation needs no SASLprep library.
Existing database connections do not need this script.
#>
[CmdletBinding()]
param(
    [string]$Server = '127.0.0.1',
    [ValidateRange(1, 65535)][int]$Port = 5432,
    [string]$Database = 'dworkbench',
    [string]$Username = 'dworkbench_app',
    [Security.SecureString]$Password,
    [string]$AdminUsername = 'postgres',
    [Security.SecureString]$AdminPassword,
    [string]$PsqlPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-RequiredText([string]$Value, [string]$Prompt) {
    if ([string]::IsNullOrWhiteSpace($Value)) { $Value = Read-Host $Prompt }
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Prompt cannot be empty." }
    if ($Value -match '[\x00-\x1f\x7f]') { throw "$Prompt cannot contain control characters." }
    return $Value
}

function Assert-DatabaseIdentifier([string]$Value, [string]$Label) {
    # PostgreSQL identifiers have a 63-byte limit in standard builds. Reject
    # truncation, rather than accidentally creating a different role/database.
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    if ($utf8.GetByteCount($Value) -gt 63) { throw "$Label must fit in 63 UTF-8 bytes." }
}

function Quote-SqlIdentifier([string]$Value) {
    return '"' + $Value.Replace('"', '""') + '"'
}

function Quote-SqlLiteral([string]$Value) {
    # E strings handle backslashes explicitly, independent of the server default.
    return "E'" + $Value.Replace('\', '\\').Replace("'", "''") + "'"
}

function Quote-ProcessArgument([string]$Value) {
    # Windows CRT command-line quoting, including quotes and trailing backslashes.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function ConvertFrom-Secret([Security.SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Find-Psql([string]$ExplicitPath) {
    if ($ExplicitPath) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
            throw 'The specified psql.exe does not exist.'
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).ProviderPath
    }
    $command = Get-Command psql.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $programFilesPath = [Environment]::GetEnvironmentVariable('ProgramFiles')
    if ($programFilesPath) {
        $postgresRoot = Join-Path $programFilesPath 'PostgreSQL'
        if (Test-Path -LiteralPath $postgresRoot -PathType Container) {
            $versions = Get-ChildItem -LiteralPath $postgresRoot -Directory | Sort-Object {
                $versionText = $_.Name
                if ($versionText -match '^\d+$') { $versionText += '.0' }
                try { [version]$versionText } catch { [version]'0.0' }
            } -Descending
            foreach ($version in $versions) {
                $candidate = Join-Path $version.FullName 'bin\psql.exe'
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
            }
        }
    }
    throw 'psql.exe was not found. Install PostgreSQL independently or pass -PsqlPath to its bin\psql.exe.'
}

function New-ScramVerifier([Security.SecureString]$Secret) {
    $plain = $null
    $passwordBytes = $null
    $saltedPassword = $null
    $clientKey = $null
    $serverKey = $null
    $storedKey = $null
    $derive = $null
    $hmac = $null
    $hash = $null
    $random = $null
    try {
        $plain = ConvertFrom-Secret $Secret
        if ($plain.Length -lt 16 -or $plain -match '[^\x20-\x7e]') {
            throw 'New application passwords must contain at least 16 printable ASCII characters (letters, digits, spaces or symbols). No database changes were made.'
        }
        # Printable ASCII is unchanged by SASLprep. Do not silently substitute
        # Normalize(FormKC) for SASLprep when adding Unicode password support.
        # RFC 5802 section 3 / RFC 7677, PostgreSQL SCRAM-SHA-256 verifier format.
        # https://www.rfc-editor.org/rfc/rfc5802.html#section-3
        # https://www.postgresql.org/docs/17/sasl-authentication.html
        $passwordBytes = [Text.Encoding]::UTF8.GetBytes($plain)
        $plain = $null
        $salt = New-Object byte[] 16
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        $random.GetBytes($salt)
        $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new($passwordBytes, $salt, 4096, [Security.Cryptography.HashAlgorithmName]::SHA256)
        $saltedPassword = $derive.GetBytes(32)
        $hmac = [Security.Cryptography.HMACSHA256]::new($saltedPassword)
        $clientKey = $hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Client Key'))
        $serverKey = $hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Server Key'))
        $hash = [Security.Cryptography.SHA256]::Create()
        $storedKey = $hash.ComputeHash($clientKey)
        return 'SCRAM-SHA-256$4096:' + [Convert]::ToBase64String($salt) + '$' + [Convert]::ToBase64String($storedKey) + ':' + [Convert]::ToBase64String($serverKey)
    }
    finally {
        $plain = $null
        foreach ($bytes in @($passwordBytes, $saltedPassword, $clientKey, $serverKey, $storedKey)) {
            if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        }
        foreach ($disposable in @($derive, $hmac, $hash, $random)) {
            if ($null -ne $disposable) { $disposable.Dispose() }
        }
    }
}

function Invoke-DatabaseSql([string]$Sql, [string]$Stage) {
    $process = [Diagnostics.Process]::new()
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $script:resolvedPsql
    $arguments = @('-X', '--no-password', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=terse', '--set=SHOW_CONTEXT=never', '--host', $Server, '--port', [string]$Port, '--username', $AdminUsername, '--dbname', 'postgres')
    $start.Arguments = ($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    # Only the child receives these values; parent environment is never changed.
    $start.EnvironmentVariables['PGPASSWORD'] = ConvertFrom-Secret $AdminPassword
    $start.EnvironmentVariables['PGCONNECT_TIMEOUT'] = '10'
    $start.EnvironmentVariables['PGCLIENTENCODING'] = 'UTF8'
    $start.EnvironmentVariables['PGAPPNAME'] = 'DWorkBench database initialization'
    $process.StartInfo = $start
    $sqlBytes = $null
    $started = $false
    try {
        if (-not $process.Start()) { throw "Unable to start psql during $Stage." }
        $started = $true
        $start.EnvironmentVariables.Remove('PGPASSWORD')
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        # No SQL on the command line, in a temporary file, or in psql history.
        $sqlBytes = [Text.Encoding]::UTF8.GetBytes($Sql)
        $process.StandardInput.BaseStream.Write($sqlBytes, 0, $sqlBytes.Length)
        # Close the byte stream directly, without flushing the wrapper's default
        # console encoding or appending a byte-order mark to the UTF-8 SQL.
        $process.StandardInput.BaseStream.Close()
        if (-not $process.WaitForExit(60000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "PostgreSQL timed out during $Stage. Check the server before retrying."
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            # Do not echo SQL, stderr, passwords, or verifiers. Extensions can
            # include a failing statement in diagnostics even with terse output.
            throw "psql failed during $Stage (exit code $($process.ExitCode)). Check the server address, administrator credentials, permissions and PostgreSQL logs."
        }
        return $stdout.Trim()
    }
    finally {
        $start.EnvironmentVariables.Remove('PGPASSWORD')
        if ($null -ne $sqlBytes) { [Array]::Clear($sqlBytes, 0, $sqlBytes.Length) }
        $Sql = $null
        $stderr = $null
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

$Server = Read-RequiredText $Server 'PostgreSQL server'
$Database = Read-RequiredText $Database 'Application database name'
$Username = Read-RequiredText $Username 'Application database username'
$AdminUsername = Read-RequiredText $AdminUsername 'PostgreSQL administrator username'
Assert-DatabaseIdentifier $Database 'Database name'
Assert-DatabaseIdentifier $Username 'Application username'
Assert-DatabaseIdentifier $AdminUsername 'Administrator username'
$script:resolvedPsql = Find-Psql $PsqlPath
if ($null -eq $Password) { $Password = Read-Host 'New application password (at least 16 printable ASCII characters)' -AsSecureString }
if ($null -eq $AdminPassword) { $AdminPassword = Read-Host 'PostgreSQL administrator password' -AsSecureString }
if ($AdminPassword.Length -eq 0) { throw 'The PostgreSQL administrator password cannot be empty.' }

$verifier = $null
$createSql = $null
$creationStarted = $false
try {
    # Compute before connecting or changing anything. The plaintext application
    # password is never sent in SQL or printed. Keep the verifier private too.
    $verifier = New-ScramVerifier $Password
    $roleLiteral = Quote-SqlLiteral $Username
    $databaseLiteral = Quote-SqlLiteral $Database
    $preflight = @"
SELECT (EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $roleLiteral))::int || '|' || (EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $databaseLiteral))::int;
"@
    $existing = Invoke-DatabaseSql $preflight 'preflight'
    if ($existing -notin @('0|0', '0|1', '1|0', '1|1')) {
        throw 'Unexpected PostgreSQL preflight result. No database changes were made.'
    }
    if ($existing -ne '0|0') {
        throw 'The requested role or database already exists. No changes were made. Use the existing connection in Start-Install.ps1, or choose new names after administrator review; this script never alters or drops existing objects.'
    }
    $roleIdentifier = Quote-SqlIdentifier $Username
    $databaseIdentifier = Quote-SqlIdentifier $Database
    $verifierLiteral = Quote-SqlLiteral $verifier
    $createSql = @"
CREATE ROLE $roleIdentifier WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD $verifierLiteral;
CREATE DATABASE $databaseIdentifier WITH OWNER = $roleIdentifier TEMPLATE = template0 ENCODING = 'UTF8';
REVOKE ALL ON DATABASE $databaseIdentifier FROM PUBLIC;
"@
    # CREATE DATABASE cannot be wrapped in a transaction. On failure preserve
    # all objects for administrator review instead of attempting destructive undo.
    $creationStarted = $true
    $null = Invoke-DatabaseSql $createSql 'role/database creation'
    Write-Host "Created PostgreSQL database '$Database' and dedicated application role '$Username'."
    Write-Host 'Continue setup with the same application password. No server or OS configuration was changed.'
}
catch {
    if ($creationStarted) {
        Write-Warning 'Creation did not finish. A role and/or database may already exist. Ask the database administrator to inspect them before retrying; no objects were automatically dropped.'
    }
    throw
}
finally {
    $verifier = $null
    $verifierLiteral = $null
    $createSql = $null
    $Password = $null
    $AdminPassword = $null
}
