using Microsoft.AspNetCore.Identity;

namespace LogDesk;

public class AppUser : IdentityUser
{
    public string DisplayName { get; set; } = "";
    public string Role { get; set; } = "Viewer";
    public bool Enabled { get; set; } = true;
}

public class Host
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string Address { get; set; } = "";
    public int Port { get; set; } = 22;
    public string Username { get; set; } = "";
    public string PasswordCipher { get; set; } = "";
    public string? Fingerprint { get; set; }
    public string? PendingFingerprint { get; set; }
    public long PendingAt { get; set; }
}

public class Source
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid HostId { get; set; }
    public Host Host { get; set; } = null!;
    public string Name { get; set; } = "";
    public string Directory { get; set; } = "";
    public string Pattern { get; set; } = "*.log";
    public string Encoding { get; set; } = "utf-8";
    public long? LastScanAt { get; set; }
    public string? LastScanError { get; set; }
}

public class LogGroup
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
}

public class GroupSource
{
    public Guid GroupId { get; set; }
    public Guid SourceId { get; set; }
    public LogGroup Group { get; set; } = null!;
    public Source Source { get; set; } = null!;
}

public class FileEntry
{
    public long Id { get; set; }
    public Guid SourceId { get; set; }
    public Source Source { get; set; } = null!;
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    public long Size { get; set; }
    public long ModifiedAt { get; set; }
    public string Generation { get; set; } = "";
    public bool Missing { get; set; }
}

public class Grant
{
    public long Id { get; set; }
    public string UserId { get; set; } = "";
    public AppUser User { get; set; } = null!;
    public string Scope { get; set; } = "";
    public Guid ResourceId { get; set; }
    public bool Download { get; set; }
    public bool Manage { get; set; }
}

public class AuditEvent
{
    public long Id { get; set; }
    public long At { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public string ActorId { get; set; } = "";
    public string Actor { get; set; } = "";
    public string Action { get; set; } = "";
    public string Target { get; set; } = "";
    public string Result { get; set; } = "success";
    public string ClientAddress { get; set; } = "";
    public string CorrelationId { get; set; } = "";
}

public class ApiError(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

public class AppMetadata
{
    public string Key { get; set; } = "";
    public string Value { get; set; } = "";
}

public class UserWorkspace
{
    public string UserId { get; set; } = "";
    public AppUser User { get; set; } = null!;
    public string Revision { get; set; } = "";
    public long UpdatedAt { get; set; }
    public string Document { get; set; } = "";
}

public record HostInput(string Name, string Address, int Port, string Username, string? Password);
public record SourceInput(Guid HostId, string Name, string Directory, string Pattern, string Encoding);
public record GroupInput(string Name, string Description, Guid[] SourceIds);
public record GrantInput(string Scope, Guid ResourceId, bool Download, bool Manage);
public record UserInput(string Username, string DisplayName, string Role, string? Password, bool Enabled);
public record SessionInput(string Username, string Password, string? SetupToken);
public record PasswordInput(string CurrentPassword, string NewPassword);
public record ScanInput(Guid[] SourceIds);
public record TrustInput(string Fingerprint);
