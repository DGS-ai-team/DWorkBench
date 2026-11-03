using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace LogDesk;

[Authorize]
public sealed class LogsHub(AccessService access, SharedLogBroker broker, AuditWriter audit,
    IHostApplicationLifetime lifetime) : Hub
{
    public async IAsyncEnumerable<string> Watch(Guid groupId, long fileId, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var frame in Read(groupId, fileId, cancellationToken))
            if (frame.Kind != "notice") yield return frame.Text;
    }
    public async IAsyncEnumerable<LogFrame> WatchV2(Guid groupId, long fileId, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var frame in Read(groupId, fileId, cancellationToken)) yield return frame;
    }
    private async IAsyncEnumerable<LogFrame> Read(Guid groupId, long fileId, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        AppUser user; FileEntry file; Source source; SharedLogBroker.Subscription subscription;
        try
        {
            user = await access.User(Context.User!.UserId());
            if (Context.User!.FindFirst("AspNet.Identity.SecurityStamp")?.Value != user.SecurityStamp) throw new ApiError(401, "登录已失效，请重新登录。");
            (file, source) = await access.File(user, groupId, fileId);
            subscription = broker.Subscribe(user.Id, source, file);
        }
        catch (ApiError error) { throw new HubException(error.Message); }
        using var acquired = subscription;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, Context.ConnectionAborted, lifetime.ApplicationStopping);
        var monitor = Monitor(user.Id, user.SecurityStamp, groupId, fileId, LogReaderKey.For(source, file), linked);
        var ended = "stopped";
        try
        {
            await audit.Write(user, "stream.started", $"{source.Host.Name}:{file.Path}");
            var enumerator = subscription.Read(linked.Token).GetAsyncEnumerator(linked.Token);
            await using (enumerator)
            {
                while (true)
                {
                    bool next;
                    try { next = await enumerator.MoveNextAsync(); }
                    catch (OperationCanceledException) when (linked.IsCancellationRequested) { break; }
                    catch (Exception e) { ended = "failed"; throw new HubException(RemoteLogs.SafeError(e)); }
                    if (!next) break;
                    yield return enumerator.Current;
                }
            }
        }
        finally
        {
            subscription.Dispose();
            await linked.CancelAsync();
            await monitor;
            await audit.Write(user, "stream." + ended, $"{source.Host.Name}:{file.Path}", ended == "failed" ? "failed" : "success");
        }
    }
    private async Task Monitor(string userId, string? securityStamp, Guid groupId, long fileId, LogReaderKey initialKey, CancellationTokenSource linked)
    {
        try
        {
            while (!linked.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(5), linked.Token);
                var current = await access.User(userId);
                if (current.SecurityStamp != securityStamp) throw new ApiError(401, "登录已失效。");
                var resource = await access.File(current, groupId, fileId);
                if (LogReaderKey.For(resource.Source, resource.File) != initialKey)
                    throw new ApiError(409, "主机凭据、文件路径或编码已变更。");
            }
        }
        catch { await linked.CancelAsync(); }
    }
}
