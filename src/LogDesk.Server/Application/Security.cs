using System.Security.Claims;
using System.Text;
using Microsoft.EntityFrameworkCore;

namespace LogDesk;

public static class Rules
{
    public static readonly string[] Roles = ["Admin", "Maintainer", "Viewer", "Auditor"];
    public static string Text(string? value, int max = 100)
    {
        value = value?.Trim();
        if (string.IsNullOrEmpty(value) || value.Length > max || value.Any(char.IsControl))
            throw new ApiError(400, $"请输入 1–{max} 个有效字符。");
        return value;
    }
    public static string Directory(string value)
    {
        value = Text(value, 1800);
        if (!value.StartsWith('/') || value.Split('/').Any(x => x is "." or ".."))
            throw new ApiError(400, "日志目录必须为绝对 Linux 路径，不能包含 . 或 .. 路径段。");
        return value == "/" ? value : value.TrimEnd('/');
    }
    public static string Pattern(string value)
    {
        value = Text(value, 200);
        if (value.Contains('/')) throw new ApiError(400, "文件名模式不能跨目录。");
        return value;
    }
    public static string RemotePath(string directory, string basename)
    {
        if (basename is "." or ".." || basename.Contains('/') || basename.Any(char.IsControl))
            throw new ApiError(400, "远程文件名无效。");
        return directory.TrimEnd('/') + "/" + basename;
    }
    public static string Quote(string value) => "'" + value.Replace("'", "'\"'\"'") + "'";
    public static Encoding Encoding(string name)
    {
        try { return System.Text.Encoding.GetEncoding(name); }
        catch (ArgumentException) { throw new ApiError(400, "不支持的日志编码。"); }
    }
}

public static class UserContext
{
    public static string UserId(this ClaimsPrincipal user) => user.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new ApiError(401, "请先登录。");
}

public sealed class AuditWriter(IDbContextFactory<AppDb> factory, IHttpContextAccessor accessor)
{
    public async Task Write(string userId, string actor, string action, string target, string result = "success")
    {
        using var db = await factory.CreateDbContextAsync();
        db.Audit.Add(new AuditEvent { ActorId = userId, Actor = actor, Action = action, Target = target.Length > 1000 ? target[..1000] : target,
            Result = result, ClientAddress = accessor.HttpContext?.Connection.RemoteIpAddress?.ToString() ?? "",
            CorrelationId = accessor.HttpContext?.TraceIdentifier ?? Guid.NewGuid().ToString("N") });
        await db.SaveChangesAsync();
    }
    public Task Write(AppUser user, string action, string target, string result = "success") => Write(user.Id, user.UserName ?? "", action, target, result);
}

public sealed class AccessService(IDbContextFactory<AppDb> factory, AuditWriter audit)
{
    public async Task<AppUser> User(string id)
    {
        using var db = await factory.CreateDbContextAsync();
        return await db.Users.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.Enabled) ?? throw new ApiError(401, "账号已停用或登录已失效。");
    }
    public async Task Admin(AppUser user)
    {
        if (user.Role != "Admin") await Deny(user, "admin");
    }
    public async Task Deny(AppUser user, string target)
    {
        await audit.Write(user, "access.denied", target, "denied");
        throw new ApiError(403, "你没有执行此操作的权限。");
    }
    public async Task<List<Source>> Sources(AppUser user, Guid groupId, string action = "read")
    {
        using var db = await factory.CreateDbContextAsync();
        var query = db.Sources.Include(x => x.Host).AsNoTracking().Where(s => db.GroupSources.Any(g => g.GroupId == groupId && g.SourceId == s.Id));
        if (user.Role != "Admin")
        {
            var grants = await db.Grants.Where(x => x.UserId == user.Id).ToListAsync();
            bool Has(Grant x) => action == "download" ? x.Download : action == "manage" ? x.Manage && user.Role == "Maintainer" : true;
            if (!grants.Any(x => x.Scope == "group" && x.ResourceId == groupId && Has(x))) { await Deny(user, $"group:{groupId}"); }
            var hosts = grants.Where(x => x.Scope == "host" && Has(x)).Select(x => x.ResourceId).ToArray();
            query = query.Where(x => hosts.Contains(x.HostId));
        }
        return await query.ToListAsync();
    }
    public async Task<(FileEntry File, Source Source)> File(AppUser user, Guid groupId, long fileId, string action = "read")
    {
        var sources = await Sources(user, groupId, action);
        using var db = await factory.CreateDbContextAsync();
        var ids = sources.Select(x => x.Id).ToArray();
        var file = await db.Files.AsNoTracking().SingleOrDefaultAsync(x => x.Id == fileId && !x.Missing && ids.Contains(x.SourceId));
        if (file == null) { await Deny(user, $"file:{fileId}"); }
        var source = sources.Single(x => x.Id == file!.SourceId);
        if (file!.Path != Rules.RemotePath(source.Directory, file.Name)) throw new ApiError(409, "日志源已修改，请重新扫描。");
        return (file, source);
    }
    public async Task ManageSource(AppUser user, Source source)
    {
        if (user.Role == "Admin") return;
        if (user.Role != "Maintainer") await Deny(user, $"source:{source.Id}");
        using var db = await factory.CreateDbContextAsync();
        var grants = await db.Grants.Where(x => x.UserId == user.Id && x.Manage).ToListAsync();
        var groupIds = await db.GroupSources.Where(x => x.SourceId == source.Id).Select(x => x.GroupId).ToListAsync();
        if (!grants.Any(x => x.Scope == "host" && x.ResourceId == source.HostId) || groupIds.Any(g => !grants.Any(x => x.Scope == "group" && x.ResourceId == g)))
            await Deny(user, $"source:{source.Id}");
    }
}
