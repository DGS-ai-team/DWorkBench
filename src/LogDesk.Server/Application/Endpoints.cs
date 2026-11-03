using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Net.Http.Headers;

namespace LogDesk;

public static class Endpoints
{
    private static readonly SemaphoreSlim SetupGate = new(1);
    private static AppUser Current(HttpContext ctx) => ctx.Items["appUser"] as AppUser ?? throw new ApiError(401, "请先登录。");
    private static object UserView(AppUser u) => new { u.Id, username = u.UserName, u.DisplayName, u.Role, u.Enabled };
    private static object HostView(Host h, bool admin) => new { h.Id, h.Name, h.Address, h.Port, h.Username, h.Fingerprint,
        pendingFingerprint = admin ? h.PendingFingerprint : null, hasPassword = !string.IsNullOrEmpty(h.PasswordCipher) };
    private static void IdentityResult(IdentityResult result)
    {
        if (!result.Succeeded) throw new ApiError(400, string.Join(" ", result.Errors.Select(x => x.Code switch
        { "DuplicateUserName" => "用户名已存在。", "InvalidUserName" => "用户名只能包含字母、数字和 . _ - @ +。", _ => "密码需至少 12 位，包含大写、小写字母和数字。" })));
    }
    private static string Like(string value) => "%" + value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    public static void MapLogDesk(this WebApplication app)
    {
        app.MapGet("/api/health", () => Results.Ok(new { status = "ok", version = "0.1.0" }));
        app.MapGet("/api/session", async (HttpContext ctx, AppDb db, IAntiforgery antiforgery) => new
        {
            setupRequired = !await db.Users.AnyAsync(), user = ctx.Items["appUser"] is AppUser user ? UserView(user) : null,
            csrfToken = antiforgery.GetAndStoreTokens(ctx).RequestToken
        });
        app.MapPost("/api/setup", async (SessionInput input, IConfiguration config, AppDb db, UserManager<AppUser> users, SignInManager<AppUser> signIn, AuditWriter audit) =>
        {
            await SetupGate.WaitAsync();
            try
            {
                if (await db.Users.AnyAsync()) throw new ApiError(409, "系统已经初始化，请登录。");
                var expected = config["Bootstrap:Token"];
                if (string.IsNullOrWhiteSpace(expected) || !CryptographicOperations.FixedTimeEquals(
                    SHA256.HashData(Encoding.UTF8.GetBytes(expected)), SHA256.HashData(Encoding.UTF8.GetBytes(input.SetupToken ?? ""))))
                    throw new ApiError(403, "初始化令牌不正确，请联系部署管理员。");
                var user = new AppUser { UserName = Rules.Text(input.Username), DisplayName = input.Username.Trim(), Role = "Admin" };
                IdentityResult(await users.CreateAsync(user, input.Password));
                await signIn.SignInAsync(user, false);
                await audit.Write(user, "setup.completed", "workspace");
                return Results.Ok(UserView(user));
            }
            finally { SetupGate.Release(); }
        }).RequireRateLimiting("auth");
        app.MapPost("/api/login", async (SessionInput input, UserManager<AppUser> users, SignInManager<AppUser> signIn, AuditWriter audit) =>
        {
            var username = Rules.Text(input.Username);
            var user = await users.FindByNameAsync(username);
            var result = user is { Enabled: true } ? await signIn.PasswordSignInAsync(user, input.Password, false, true) : SignInResult.Failed;
            await audit.Write(user?.Id ?? "", username, "login", "session", result.Succeeded ? "success" : "failed");
            if (!result.Succeeded) throw new ApiError(401, "登录失败，请检查账号密码；多次失败后账号会暂时锁定。");
            return Results.Ok(UserView(user!));
        }).RequireRateLimiting("auth");

        var api = app.MapGroup("/api").RequireAuthorization();
        api.MapGet("/streams/status", async (HttpContext ctx, AccessService access, SharedLogBroker broker) =>
        { await access.Admin(Current(ctx)); return Results.Ok(broker.Status()); });
        api.MapPost("/logout", async (HttpContext ctx, SignInManager<AppUser> signIn, UserManager<AppUser> users, AuditWriter audit) =>
        { var user = await users.FindByIdAsync(Current(ctx).Id) ?? throw new ApiError(401, "登录已失效。"); await users.UpdateSecurityStampAsync(user); await audit.Write(user, "logout", "session"); await signIn.SignOutAsync(); return Results.NoContent(); });
        api.MapPost("/password", async (PasswordInput input, HttpContext ctx, UserManager<AppUser> users, SignInManager<AppUser> signIn, AuditWriter audit) =>
        {
            var user = await users.FindByIdAsync(Current(ctx).Id) ?? throw new ApiError(401, "请重新登录。");
            IdentityResult(await users.ChangePasswordAsync(user, input.CurrentPassword, input.NewPassword));
            await signIn.RefreshSignInAsync(user);
            await audit.Write(user, "password.changed", user.UserName ?? "");
            return Results.NoContent();
        });
        api.MapGet("/config", async (HttpContext ctx, AppDb db, ScanCoordinator scans) =>
        {
            var user = Current(ctx);
            var hosts = db.Hosts.AsNoTracking(); var groups = db.Groups.AsNoTracking(); var sources = db.Sources.AsNoTracking();
            if (user.Role != "Admin")
            {
                var grants = await db.Grants.Where(x => x.UserId == user.Id).ToListAsync();
                var hostIds = grants.Where(x => x.Scope == "host").Select(x => x.ResourceId).ToArray();
                var groupIds = grants.Where(x => x.Scope == "group").Select(x => x.ResourceId).ToArray();
                hosts = hosts.Where(x => hostIds.Contains(x.Id)); groups = groups.Where(x => groupIds.Contains(x.Id));
                sources = sources.Where(x => hostIds.Contains(x.HostId) && db.GroupSources.Any(g => groupIds.Contains(g.GroupId) && g.SourceId == x.Id));
            }
            var hostList = await hosts.OrderBy(x => x.Name).ToListAsync();
            var sourceList = await sources.OrderBy(x => x.Name).ToListAsync();
            var sourceIds = sourceList.Select(x => x.Id).ToArray();
            var groupList = await groups.OrderBy(x => x.Name).ToListAsync();
            var groupIdsVisible = groupList.Select(x => x.Id).ToArray();
            var links = await db.GroupSources.Where(x => groupIdsVisible.Contains(x.GroupId) && sourceIds.Contains(x.SourceId)).ToListAsync();
            return Results.Ok(new { hosts = hostList.Select(h => HostView(h, user.Role == "Admin")),
                sources = sourceList.Select(s => new { s.Id, s.HostId, s.Name, s.Directory, s.Pattern, s.Encoding, s.LastScanAt, s.LastScanError, scan = scans.Status(s.Id) }),
                groups = groupList.Select(g => new { g.Id, g.Name, g.Description, sourceIds = links.Where(l => l.GroupId == g.Id).Select(l => l.SourceId) }) });
        });

        api.MapPost("/hosts", async (HostInput input, HttpContext ctx, AppDb db, AccessService access, RemoteLogs remote, AuditWriter audit) =>
        {
            var user = Current(ctx); await access.Admin(user);
            var host = new Host(); SetHost(host, input, remote); db.Hosts.Add(host); await db.SaveChangesAsync();
            await audit.Write(user, "host.created", host.Name); return Results.Ok(HostView(host, true));
        });
        api.MapPut("/hosts/{id:guid}", async (Guid id, HostInput input, HttpContext ctx, AppDb db, AccessService access, RemoteLogs remote, AuditWriter audit) =>
        {
            var user = Current(ctx); await access.Admin(user);
            var host = await db.Hosts.FindAsync(id) ?? throw new ApiError(404, "主机不存在。");
            SetHost(host, input, remote); await db.SaveChangesAsync(); await audit.Write(user, "host.updated", host.Name);
            return Results.Ok(HostView(host, true));
        });
        api.MapDelete("/hosts/{id:guid}", async (Guid id, HttpContext ctx, AppDb db, AccessService access, AuditWriter audit) =>
        {
            var user = Current(ctx); await access.Admin(user);
            if (await db.Sources.AnyAsync(x => x.HostId == id)) throw new ApiError(409, "请先删除这台主机的日志源。");
            var host = await db.Hosts.FindAsync(id) ?? throw new ApiError(404, "主机不存在。");
            db.Hosts.Remove(host); await db.Grants.Where(x => x.Scope == "host" && x.ResourceId == id).ExecuteDeleteAsync();
            await db.SaveChangesAsync(); await audit.Write(user, "host.deleted", host.Name); return Results.NoContent();
        });
        api.MapPost("/hosts/{id:guid}/probe", async (Guid id, HttpContext ctx, AppDb db, AccessService access, RemoteLogs remote, AuditWriter audit) =>
        {
            var user = Current(ctx); await access.Admin(user);
            var host = await db.Hosts.FindAsync(id) ?? throw new ApiError(404, "主机不存在。");
            var result = await remote.Probe(host, ctx.RequestAborted);
            if (result.Fingerprint != null) { host.PendingFingerprint = result.Fingerprint; host.PendingAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); await db.SaveChangesAsync(); }
            await audit.Write(user, "host.probed", host.Name, result.Connected ? "success" : "blocked");
            return Results.Ok(new { result.Fingerprint, result.Connected, result.Message, previousFingerprint = host.Fingerprint });
        });
        api.MapPost("/hosts/{id:guid}/trust", async (Guid id, TrustInput input, HttpContext ctx, AppDb db, AccessService access, AuditWriter audit) =>
        {
            var user = Current(ctx); await access.Admin(user);
            var host = await db.Hosts.FindAsync(id) ?? throw new ApiError(404, "主机不存在。");
            if (host.PendingFingerprint != input.Fingerprint || host.PendingAt < DateTimeOffset.UtcNow.AddMinutes(-10).ToUnixTimeMilliseconds())
                throw new ApiError(409, "指纹探测结果已失效，请重新测试连接。");
            host.Fingerprint = host.PendingFingerprint; host.PendingFingerprint = null;
            await db.SaveChangesAsync(); await audit.Write(user, "host.fingerprint.confirmed", host.Name);
            return Results.Ok(HostView(host, true));
        });

        api.MapPost("/sources/preview", async (SourceInput input, Guid? sourceId, HttpContext ctx, AppDb db, AccessService access, RemoteLogs remote, AuditWriter audit) =>
        {
            var user = Current(ctx);
            if (user.Role != "Admin")
            {
                var existing = sourceId.HasValue ? await db.Sources.FindAsync(sourceId.Value) : null;
                if (existing == null) await access.Deny(user, "source.preview");
                await access.ManageSource(user, existing!);
                if (existing!.HostId != input.HostId) await access.Deny(user, "source.preview.move");
            }
            var source = new Source(); await SetSource(source, input, db);
            source.Host = await db.Hosts.AsNoTracking().SingleAsync(h => h.Id == source.HostId);
            try
            {
                var result = await remote.Preview(source, ctx.RequestAborted);
                await audit.Write(user, "source.previewed", source.Host.Name + ":" + source.Directory);
                return Results.Ok(result);
            }
            catch { await audit.Write(user, "source.previewed", source.Host.Name + ":" + source.Directory, "failed"); throw; }
        }).RequireRateLimiting("source-preview");
        api.MapPost("/sources", async (SourceInput input, HttpContext ctx, AppDb db, AccessService access, AuditWriter audit) =>
        {
            var user = Current(ctx); await access.Admin(user);
            var source = new Source(); await SetSource(source, input, db); db.Sources.Add(source); await db.SaveChangesAsync();
            await audit.Write(user, "source.created", source.Name); return Results.Ok(new { source.Id });
        });
        api.MapPut("/sources/{id:guid}", async (Guid id, SourceInput input, HttpContext ctx, AppDb db, AccessService access, ScanCoordinator scans, AuditWriter audit) =>
        {
            var user = Current(ctx);
            var source = await db.Sources.FindAsync(id) ?? throw new ApiError(404, "日志源不存在。");
            await access.ManageSource(user, source);
            if (user.Role != "Admin" && source.HostId != input.HostId) await access.Deny(user, "source.move");
            if (scans.Status(id)?.State is "queued" or "scanning") throw new ApiError(409, "扫描中，请完成后再修改来源。");
            await SetSource(source, input, db); source.LastScanAt = null; source.LastScanError = null;
            await db.Files.Where(x => x.SourceId == id).ExecuteDeleteAsync();
            await db.SaveChangesAsync(); await audit.Write(user, "source.updated", source.Name); return Results.NoContent();
        });
        api.MapDelete("/sources/{id:guid}", async (Guid id, HttpContext ctx, AppDb db, AccessService access, ScanCoordinator scans, AuditWriter audit) =>
        {
            var user = Current(ctx); var source = await db.Sources.FindAsync(id) ?? throw new ApiError(404, "日志源不存在。");
            await access.ManageSource(user, source);
            if (scans.Status(id)?.State is "queued" or "scanning") throw new ApiError(409, "请等待扫描完成。");
            db.Sources.Remove(source); await db.SaveChangesAsync(); await audit.Write(user, "source.deleted", source.Name); return Results.NoContent();
        });
        api.MapPost("/groups", async (GroupInput input, HttpContext ctx, AppDb db, AccessService access, AuditWriter audit) =>
        {
            var user = Current(ctx); await access.Admin(user); var group = new LogGroup();
            await SetGroup(group, input, db); db.Groups.Add(group); await db.SaveChangesAsync();
            await audit.Write(user, "group.created", group.Name); return Results.Ok(new { group.Id });
        });
        api.MapPut("/groups/{id:guid}", async (Guid id, GroupInput input, HttpContext ctx, AppDb db, AccessService access, AuditWriter audit) =>
        {
            var user = Current(ctx); var group = await db.Groups.FindAsync(id) ?? throw new ApiError(404, "日志组不存在。");
            if (user.Role != "Admin")
            {
                var existing = await db.GroupSources.Where(x => x.GroupId == id).Select(x => x.SourceId).ToArrayAsync();
                await access.ManageGroupSources(user, id, existing.Concat(input.SourceIds).Distinct().ToArray());
            }
            await SetGroup(group, input, db); await db.SaveChangesAsync(); await audit.Write(user, "group.updated", group.Name); return Results.NoContent();
        });
        api.MapDelete("/groups/{id:guid}", async (Guid id, HttpContext ctx, AppDb db, AccessService access, AuditWriter audit) =>
        {
            var user = Current(ctx); await access.Admin(user); var group = await db.Groups.FindAsync(id) ?? throw new ApiError(404, "日志组不存在。");
            db.Groups.Remove(group); await db.Grants.Where(x => x.Scope == "group" && x.ResourceId == id).ExecuteDeleteAsync();
            await db.SaveChangesAsync(); await audit.Write(user, "group.deleted", group.Name); return Results.NoContent();
        });
        api.MapPost("/groups/{id:guid}/scan", async (Guid id, ScanInput input, HttpContext ctx, AccessService access, ScanCoordinator scans) =>
        {
            var user = Current(ctx); var sources = await access.Sources(user, id);
            if (input.SourceIds.Length == 0) throw new ApiError(400, "请选择需要扫描的日志源。");
            if (input.SourceIds.Except(sources.Select(x => x.Id)).Any()) await access.Deny(user, "scan");
            foreach (var source in sources.Where(x => input.SourceIds.Contains(x.Id))) scans.Start(source, user, id);
            return Results.Accepted();
        });
        api.MapGet("/groups/{id:guid}/files", async (Guid id, string? q, Guid? hostId, Guid? sourceId, long? since, string? cursor, HttpContext ctx, AppDb db, AccessService access, ScanCoordinator scans) =>
        {
            var sources = await access.Sources(Current(ctx), id); var ids = sources.Select(x => x.Id).ToArray();
            var query = db.Files.AsNoTracking().Where(x => !x.Missing && ids.Contains(x.SourceId));
            if (!string.IsNullOrWhiteSpace(q)) { var term = Like(q.Trim()); query = query.Where(x => EF.Functions.Like(x.Name, term, "\\")); }
            if (sourceId.HasValue) query = query.Where(x => x.SourceId == sourceId);
            if (hostId.HasValue) { var hostSources = sources.Where(x => x.HostId == hostId).Select(x => x.Id).ToArray(); query = query.Where(x => hostSources.Contains(x.SourceId)); }
            if (since.HasValue) query = query.Where(x => x.ModifiedAt >= since);
            var total = await query.CountAsync();
            if (!string.IsNullOrWhiteSpace(cursor))
            {
                var parts = cursor.Split(':');
                if (parts.Length != 2 || !long.TryParse(parts[0], out var lastTime) || !long.TryParse(parts[1], out var lastId)) throw new ApiError(400, "分页游标无效。");
                query = query.Where(x => x.ModifiedAt < lastTime || x.ModifiedAt == lastTime && x.Id < lastId);
            }
            var files = await query.OrderByDescending(x => x.ModifiedAt).ThenByDescending(x => x.Id).Take(201).ToListAsync();
            var more = files.Count > 200; var page = files.Take(200).ToArray();
            return Results.Ok(new { total, files = page.Select(f => { var source = sources.Single(s => s.Id == f.SourceId); return new { f.Id, f.SourceId, f.Name, f.Path, f.Size, f.ModifiedAt, hostName = source.Host.Name, hostId = source.HostId, sourceName = source.Name, encoding = source.Encoding }; }),
                nextCursor = more ? $"{page[^1].ModifiedAt}:{page[^1].Id}" : null,
                sources = sources.Select(s => new { s.Id, s.LastScanAt, s.LastScanError, scan = scans.Status(s.Id) }) });
        });

        api.MapGet("/groups/{id:guid}/files/{fileId:long}/download-check", async (Guid id, long fileId, HttpContext ctx, AccessService access) =>
        { await access.File(Current(ctx), id, fileId, "download"); return Results.Ok(new { allowed = true }); });
        api.MapGet("/groups/{id:guid}/files/{fileId:long}/download", Download);
        MapUsers(api);
        api.MapGet("/audit", async (string? q, string? result, long? before, long? since, HttpContext ctx, AppDb db, AccessService access) =>
        {
            var user = Current(ctx); if (user.Role is not ("Admin" or "Auditor")) await access.Deny(user, "audit");
            var query = db.Audit.AsNoTracking();
            if (!string.IsNullOrWhiteSpace(q)) { var term = Like(q.Trim()); query = query.Where(x => EF.Functions.Like(x.Actor, term, "\\") || EF.Functions.Like(x.Target, term, "\\") || EF.Functions.Like(x.Action, term, "\\")); }
            if (before.HasValue) query = query.Where(x => x.Id < before);
            if (since.HasValue) query = query.Where(x => x.At >= since);
            if (!string.IsNullOrEmpty(result)) query = query.Where(x => x.Result == result);
            return Results.Ok(await query.OrderByDescending(x => x.Id).Take(100).ToArrayAsync());
        });
    }

    private static void SetHost(Host host, HostInput input, RemoteLogs remote)
    {
        var address = Rules.Text(input.Address, 253);
        if (address.Any(char.IsWhiteSpace) || input.Port is < 1 or > 65535) throw new ApiError(400, "主机地址或 SSH 端口无效。");
        if (host.Address != address || host.Port != input.Port) { host.Fingerprint = null; host.PendingFingerprint = null; }
        host.Name = Rules.Text(input.Name); host.Address = address; host.Port = input.Port; host.Username = Rules.Text(input.Username);
        if (!string.IsNullOrEmpty(input.Password))
        {
            if (input.Password.Length > 4096) throw new ApiError(400, "密码过长。");
            host.PasswordCipher = remote.Protect(input.Password);
        }
        if (string.IsNullOrEmpty(host.PasswordCipher)) throw new ApiError(400, "请输入 SSH 密码。");
    }
    private static async Task SetSource(Source source, SourceInput input, AppDb db)
    {
        if (!await db.Hosts.AnyAsync(x => x.Id == input.HostId)) throw new ApiError(400, "请选择有效主机。");
        source.HostId = input.HostId; source.Name = Rules.Text(input.Name); source.Directory = Rules.Directory(input.Directory);
        source.Pattern = Rules.Pattern(input.Pattern); source.Encoding = Rules.StreamEncoding(input.Encoding).WebName;
    }
    private static async Task SetGroup(LogGroup group, GroupInput input, AppDb db)
    {
        group.Name = Rules.Text(input.Name); group.Description = input.Description?.Trim() ?? "";
        if (group.Description.Length > 500) throw new ApiError(400, "描述最长 500 字。");
        var ids = input.SourceIds.Distinct().ToArray();
        if (await db.Sources.CountAsync(x => ids.Contains(x.Id)) != ids.Length) throw new ApiError(400, "包含无效日志源。");
        var old = await db.GroupSources.Where(x => x.GroupId == group.Id).ToListAsync();
        db.GroupSources.RemoveRange(old.Where(x => !ids.Contains(x.SourceId)));
        foreach (var id in ids.Except(old.Select(x => x.SourceId))) db.GroupSources.Add(new GroupSource { GroupId = group.Id, SourceId = id });
    }

    private static void MapUsers(RouteGroupBuilder api)
    {
        api.MapGet("/users", async (HttpContext ctx, AppDb db, AccessService access) =>
        { await access.Admin(Current(ctx)); return Results.Ok((await db.Users.AsNoTracking().OrderBy(x => x.UserName).ToListAsync()).Select(UserView)); });
        api.MapPost("/users", async (UserInput input, HttpContext ctx, UserManager<AppUser> users, AccessService access, AuditWriter audit) =>
        {
            var actor = Current(ctx); await access.Admin(actor);
            if (!Rules.Roles.Contains(input.Role)) throw new ApiError(400, "角色无效。");
            var user = new AppUser { UserName = Rules.Text(input.Username), DisplayName = Rules.Text(input.DisplayName), Role = input.Role, Enabled = input.Enabled };
            IdentityResult(await users.CreateAsync(user, input.Password ?? "")); await audit.Write(actor, "user.created", user.UserName!); return Results.Ok(UserView(user));
        });
        api.MapPut("/users/{id}", async (string id, UserInput input, HttpContext ctx, AppDb db, UserManager<AppUser> users, AccessService access, AuditWriter audit) =>
        {
            var actor = Current(ctx); await access.Admin(actor);
            var user = await users.FindByIdAsync(id) ?? throw new ApiError(404, "账号不存在。");
            if (!Rules.Roles.Contains(input.Role)) throw new ApiError(400, "角色无效。");
            if (actor.Id == id && (!input.Enabled || input.Role != "Admin")) throw new ApiError(409, "不能停用自己的账号或移除自己的管理员角色。");
            await using var transaction = await db.Database.BeginTransactionAsync();
            user.DisplayName = Rules.Text(input.DisplayName); user.Role = input.Role; user.Enabled = input.Enabled;
            IdentityResult(await users.UpdateAsync(user));
            if (!string.IsNullOrEmpty(input.Password)) IdentityResult(await users.ResetPasswordAsync(user, await users.GeneratePasswordResetTokenAsync(user), input.Password));
            await users.UpdateSecurityStampAsync(user);
            await transaction.CommitAsync();
            await audit.Write(actor, "user.updated", user.UserName!); return Results.Ok(UserView(user));
        });
        api.MapGet("/users/{id}/grants", async (string id, HttpContext ctx, AppDb db, AccessService access) =>
        { await access.Admin(Current(ctx)); return Results.Ok(await db.Grants.Where(x => x.UserId == id).Select(x => new { x.Scope, x.ResourceId, x.Download, x.Manage }).ToArrayAsync()); });
        api.MapPut("/users/{id}/grants", async (string id, GrantInput[] input, HttpContext ctx, AppDb db, AccessService access, AuditWriter audit) =>
        {
            var actor = Current(ctx); await access.Admin(actor);
            var user = await db.Users.FindAsync(id) ?? throw new ApiError(404, "账号不存在。");
            if (input.Length > 1000 || input.Select(x => (x.Scope, x.ResourceId)).Distinct().Count() != input.Length) throw new ApiError(400, "授权项过多或重复。");
            foreach (var grant in input)
            {
                var exists = grant.Scope switch { "host" => await db.Hosts.AnyAsync(x => x.Id == grant.ResourceId), "group" => await db.Groups.AnyAsync(x => x.Id == grant.ResourceId), _ => false };
                if (!exists) throw new ApiError(400, "授权包含无效资源。");
            }
            await using var transaction = await db.Database.BeginTransactionAsync();
            await db.Grants.Where(x => x.UserId == id).ExecuteDeleteAsync();
            db.Grants.AddRange(input.Select(x => new Grant { UserId = id, Scope = x.Scope, ResourceId = x.ResourceId, Download = x.Download, Manage = x.Manage }));
            await db.SaveChangesAsync(); await transaction.CommitAsync();
            await audit.Write(actor, "permissions.updated", user.UserName!); return Results.NoContent();
        });
    }

    private static async Task Download(Guid id, long fileId, HttpContext ctx, AccessService access, RemoteLogs remote, AuditWriter audit, DownloadQuota quota)
    {
        var user = Current(ctx); var (file, source) = await access.File(user, id, fileId, "download");
        using var lease = await quota.Acquire(user.Id, ctx.RequestAborted);
        // A quota wait can outlive the request's original authorization.
        var stamp = user.SecurityStamp;
        user = await access.User(user.Id);
        if (user.SecurityStamp != stamp) throw new ApiError(401, "登录已失效，请重新登录。");
        (file, source) = await access.File(user, id, fileId, "download");
        await audit.Write(user, "download.started", $"{source.Host.Name}:{file.Path}");
        try
        {
            var recheckAt = DateTimeOffset.UtcNow.AddSeconds(5);
            await remote.Download(source, file, length =>
            {
                ctx.Response.ContentType = "application/octet-stream";
                ctx.Response.ContentLength = length;
                ctx.Response.Headers.ContentDisposition = new ContentDispositionHeaderValue("attachment") { FileNameStar = file.Name }.ToString();
            }, async (chunk, transferToken) =>
            {
                if (DateTimeOffset.UtcNow >= recheckAt) { await access.File(await access.User(user.Id), id, fileId, "download"); recheckAt = DateTimeOffset.UtcNow.AddSeconds(5); }
                await ctx.Response.Body.WriteAsync(chunk, transferToken);
            }, ctx.RequestAborted);
            await audit.Write(user, "download.completed", $"{source.Host.Name}:{file.Path}");
        }
        catch (Exception error)
        {
            await audit.Write(user, "download.failed", $"{source.Host.Name}:{file.Path}", "failed");
            if (ctx.Response.HasStarted) { ctx.Abort(); return; }
            ctx.Response.ContentLength = null; ctx.Response.Headers.Remove(HeaderNames.ContentDisposition);
            throw new ApiError(502, RemoteLogs.SafeError(error));
        }
    }
}

public sealed class DownloadQuota(IConfiguration configuration)
{
    private readonly SemaphoreSlim global = new(configuration.GetValue("Limits:DownloadsGlobal", 2));
    private readonly ConcurrentDictionary<string, SemaphoreSlim> users = new();
    public async Task<IDisposable> Acquire(string user, CancellationToken ct)
    {
        var userGate = users.GetOrAdd(user, _ => new(2));
        if (!await userGate.WaitAsync(0, ct)) throw new ApiError(429, "每位用户最多同时下载两个文件。");
        try { await global.WaitAsync(ct); return new Lease(() => { global.Release(); userGate.Release(); }); }
        catch { userGate.Release(); throw; }
    }
    private sealed class Lease(Action release) : IDisposable { public void Dispose() => release(); }
}
