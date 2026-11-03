using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace DWorkBench;

public sealed record WorkspaceSettings(string Include, string Exclude, string Mode, bool CaseSensitive,
    string Format, string JsonField, string LevelPattern, string Levels, int Context);
public sealed record WorkspaceWatchRule(string Pattern, string Mode, bool CaseSensitive);
public sealed record WorkspaceItem(string Key, Guid GroupId, Guid SourceId, Guid HostId, string Path,
    string Encoding, WorkspaceSettings Settings, bool Wrap, WorkspaceWatchRule WatchRule);
public sealed record WorkspaceDocument(int Version, Guid? GroupId, WorkspaceItem[] Items, string[] Reading,
    string Active, string Pinned, bool Vertical, double Split, bool WatchOpen);
public sealed record WorkspaceSave(string OwnerId, string? Revision, WorkspaceDocument Document);
public sealed record WorkspaceResolve(string OwnerId, WorkspaceItem[] Items);

public static class Workspaces
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static AppUser Current(HttpContext context) => context.Items["appUser"] as AppUser ?? throw new ApiError(401, "请先登录。");
    private static void Owner(AppUser user, string owner)
    {
        if (user.Id != owner) throw new ApiError(401, "账号已切换，请刷新页面后操作。");
    }
    private static void Text(string? text, int length)
    {
        if (text is null || text.Length > length || text.Contains('\0')) throw new ApiError(400, "工作台配置包含无效或过长的内容。");
    }
    private static void Items(WorkspaceItem[]? items)
    {
        if (items is null || items.Length > 4) throw new ApiError(400, "工作台最多保存四个日志。");
        var keys = new HashSet<string>();
        foreach (var item in items)
        {
            if (item is null || !Guid.TryParse(item.Key, out _) || !keys.Add(item.Key) ||
                item.GroupId == Guid.Empty || item.SourceId == Guid.Empty || item.HostId == Guid.Empty || item.Settings is null || item.WatchRule is null)
                throw new ApiError(400, "日志引用无效。");
            Text(item.Path, 2048);
            if (!item.Path.StartsWith('/') || item.Path.Split('/').Any(x => x is "." or "..") || item.Path.Any(char.IsControl))
                throw new ApiError(400, "日志路径无效。");
            Text(item.Encoding, 80); Rules.Encoding(item.Encoding);
            var s = item.Settings;
            Text(s.Include, 512); Text(s.Exclude, 512); Text(s.JsonField, 512); Text(s.LevelPattern, 512); Text(item.WatchRule.Pattern, 512);
            if (s.Mode is not ("text" or "glob" or "regex") || item.WatchRule.Mode is not ("text" or "glob" or "regex") ||
                s.Format is not ("auto" or "text" or "json" or "custom") || s.Levels is not ("all" or "warnings" or "errors" or "unknown") || s.Context is < 0 or > 10)
                throw new ApiError(400, "日志筛选配置无效。");
        }
    }
    private static void Validate(WorkspaceDocument? document)
    {
        if (document is null || document.Version != 1) throw new ApiError(400, "不支持此工作台配置版本。");
        Items(document.Items);
        var keys = document.Items.Select(x => x.Key).ToHashSet();
        if (document.Reading is null || document.Reading.Length > 2 || document.Reading.Distinct().Count() != document.Reading.Length ||
            document.Reading.Any(x => !keys.Contains(x)) || document.Active is null || document.Pinned is null ||
            (document.Active != "" && !document.Reading.Contains(document.Active)) ||
            (document.Pinned != "" && !document.Reading.Contains(document.Pinned)) ||
            !double.IsFinite(document.Split) || document.Split is < 25 or > 75)
            throw new ApiError(400, "工作台布局无效。");
        if (Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(document, Json)) > 60_000) throw new ApiError(400, "工作台配置过大。");
    }
    private static async Task<object[]> Resolve(AppUser user, WorkspaceItem[] items, AppDb db, AccessService access, CancellationToken ct)
    {
        var resolved = new List<object>();
        foreach (var item in items)
        {
            object? file = null; string? issue = null;
            try
            {
                // References are never authority: use current group + host grants.
                var sources = await access.Sources(user, item.GroupId);
                var source = sources.SingleOrDefault(s => s.Id == item.SourceId && s.HostId == item.HostId);
                if (source is null) issue = "日志组或来源已删除，或当前账号已无访问权限。";
                else if (Rules.Encoding(source.Encoding).WebName != Rules.Encoding(item.Encoding).WebName ||
                    item.Path != Rules.RemotePath(source.Directory, item.Path.Split('/').Last()) ||
                    !System.IO.Enumeration.FileSystemName.MatchesSimpleExpression(source.Pattern, item.Path.Split('/').Last(), false))
                    issue = "日志来源的目录、模式或编码已改变，请从清单重新选择。";
                else
                {
                    var entry = await db.Files.AsNoTracking().SingleOrDefaultAsync(f => f.SourceId == source.Id && f.Path == item.Path && !f.Missing, ct);
                    if (entry is null) issue = "文件已移除或不在当前清单中，请刷新清单后重试。";
                    else file = new { entry.Id, entry.SourceId, entry.Name, entry.Path, entry.Size, entry.ModifiedAt,
                        hostName = source.Host.Name, hostId = source.HostId, sourceName = source.Name, encoding = source.Encoding };
                }
            }
            catch (ApiError error) when (error.Status is 403 or 404 or 409) { issue = "日志组或来源已删除，或当前账号已无访问权限。"; }
            resolved.Add(new { item.Key, file, issue });
        }
        return resolved.ToArray();
    }

    public static void MapWorkspaces(this WebApplication app)
    {
        var api = app.MapGroup("/api/workspace").RequireAuthorization();
        api.MapGet("", async (HttpContext context, AppDb db, AccessService access, CancellationToken ct) =>
        {
            var user = Current(context);
            var stored = await db.Workspaces.AsNoTracking().SingleOrDefaultAsync(w => w.UserId == user.Id, ct);
            var document = stored is null ? null : JsonSerializer.Deserialize<WorkspaceDocument>(stored.Document, Json);
            if (document is not null) Validate(document);
            return Results.Ok(new { ownerId = user.Id, revision = stored?.Revision, updatedAt = stored?.UpdatedAt, document,
                resolved = document is null ? [] : await Resolve(user, document.Items, db, access, ct) });
        });
        api.MapPut("", async (WorkspaceSave input, HttpContext context, AppDb db, CancellationToken ct) =>
        {
            var user = Current(context); Owner(user, input.OwnerId); Validate(input.Document);
            var revision = Guid.NewGuid().ToString("N"); var at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var document = JsonSerializer.Serialize(input.Document, Json);
            if (input.Revision is null)
            {
                db.Workspaces.Add(new UserWorkspace { UserId = user.Id, Revision = revision, UpdatedAt = at, Document = document });
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException)
                {
                    if (await db.Workspaces.AsNoTracking().AnyAsync(w => w.UserId == user.Id, ct))
                        throw new ApiError(409, "其他页面已保存工作台，请选择要保留的版本。");
                    throw;
                }
            }
            else
            {
                var count = await db.Workspaces.Where(w => w.UserId == user.Id && w.Revision == input.Revision)
                    .ExecuteUpdateAsync(s => s.SetProperty(w => w.Revision, revision).SetProperty(w => w.UpdatedAt, at).SetProperty(w => w.Document, document), ct);
                if (count != 1) throw new ApiError(409, "其他页面已更新工作台，请选择要保留的版本。");
            }
            return Results.Ok(new { ownerId = user.Id, revision, updatedAt = at });
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(65_536));
        api.MapPost("/resolve", async (WorkspaceResolve input, HttpContext context, AppDb db, AccessService access, CancellationToken ct) =>
        {
            var user = Current(context); Owner(user, input.OwnerId); Items(input.Items);
            return Results.Ok(new { resolved = await Resolve(user, input.Items, db, access, ct) });
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(65_536));
    }
}
