using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;

namespace LogDesk;

public record ScanStatus(string State, long Count, string? Error, long StartedAt);

public sealed class ScanCoordinator(IDbContextFactory<AppDb> factory, RemoteLogs remote, AuditWriter audit,
    AccessService access, IHostApplicationLifetime lifetime, ILogger<ScanCoordinator> logger) : IHostedService
{
    private readonly ConcurrentDictionary<Guid, ScanStatus> states = new();
    private readonly ConcurrentDictionary<Guid, SemaphoreSlim> hostGates = new();
    private readonly SemaphoreSlim global = new(3);
    private readonly object gate = new();
    private readonly HashSet<Task> running = [];
    public Task StartAsync(CancellationToken ct) => Task.CompletedTask;
    public async Task StopAsync(CancellationToken ct)
    {
        Task[] tasks;
        lock (gate) tasks = running.ToArray();
        try { await Task.WhenAll(tasks).WaitAsync(ct); } catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }
    public ScanStatus? Status(Guid source) => states.GetValueOrDefault(source);
    public void Start(Source source, AppUser actor, Guid groupId)
    {
        lock (gate)
        {
            if (states.TryGetValue(source.Id, out var current) && current.State is "queued" or "scanning") return;
            states[source.Id] = new("queued", 0, null, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            var task = Task.Run(() => Run(source, actor, groupId, lifetime.ApplicationStopping));
            running.Add(task);
            _ = task.ContinueWith(completed => { lock (gate) running.Remove(completed); }, TaskScheduler.Default);
        }
    }
    private async Task Run(Source source, AppUser actor, Guid groupId, CancellationToken ct)
    {
        var started = states[source.Id].StartedAt;
        var hostGate = hostGates.GetOrAdd(source.HostId, _ => new(1));
        bool globalHeld = false, hostHeld = false;
        long count = 0;
        try
        {
            await hostGate.WaitAsync(ct); hostHeld = true;
            await global.WaitAsync(ct); globalHeld = true;
            var currentUser = await access.User(actor.Id);
            var permitted = await access.Sources(currentUser, groupId);
            source = permitted.SingleOrDefault(x => x.Id == source.Id) ?? throw new ApiError(403, "扫描权限已失效。");
            states[source.Id] = new("scanning", 0, null, started);
            await audit.Write(actor, "scan.started", source.Name);
            var generation = Guid.NewGuid().ToString("N");
            var batch = new List<RemoteFile>(200);
            await foreach (var file in remote.List(source, ct))
            {
                batch.Add(file); count++;
                if (batch.Count >= 200)
                {
                    await SaveBatch(source.Id, generation, batch, ct); batch.Clear();
                    states[source.Id] = new("scanning", count, null, started);
                }
            }
            if (batch.Count > 0) await SaveBatch(source.Id, generation, batch, ct);
            using var db = await factory.CreateDbContextAsync(ct);
            await db.Files.Where(x => x.SourceId == source.Id && x.Generation != generation).ExecuteUpdateAsync(p => p.SetProperty(x => x.Missing, true), ct);
            await db.Sources.Where(x => x.Id == source.Id).ExecuteUpdateAsync(p => p
                .SetProperty(x => x.LastScanAt, (long?)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).SetProperty(x => x.LastScanError, (string?)null), ct);
            states[source.Id] = new("completed", count, null, started);
            await audit.Write(actor, "scan.completed", $"{source.Name} ({count} files)");
        }
        catch (Exception e)
        {
            var message = RemoteLogs.SafeError(e);
            states[source.Id] = new("failed", count, message, started);
            logger.LogWarning("Scan {SourceId} failed: {ErrorType}", source.Id, e.GetType().Name);
            try
            {
                using var db = await factory.CreateDbContextAsync();
                await db.Sources.Where(x => x.Id == source.Id).ExecuteUpdateAsync(p => p.SetProperty(x => x.LastScanError, message));
                await audit.Write(actor, "scan.failed", source.Name, "failed");
            }
            catch (Exception persistError) { logger.LogError("Unable to persist scan status: {ErrorType}", persistError.GetType().Name); }
        }
        finally { if (globalHeld) global.Release(); if (hostHeld) hostGate.Release(); }
    }
    private async Task SaveBatch(Guid source, string generation, List<RemoteFile> batch, CancellationToken ct)
    {
        using var db = await factory.CreateDbContextAsync(ct);
        var paths = batch.Select(x => x.Path).ToArray();
        var known = await db.Files.Where(x => x.SourceId == source && paths.Contains(x.Path)).ToDictionaryAsync(x => x.Path, ct);
        foreach (var remoteFile in batch)
        {
            if (!known.TryGetValue(remoteFile.Path, out var item))
            {
                item = new FileEntry { SourceId = source, Path = remoteFile.Path };
                db.Files.Add(item);
                known[item.Path] = item;
            }
            item.Name = remoteFile.Name; item.Size = remoteFile.Size; item.ModifiedAt = remoteFile.ModifiedAt;
            item.Generation = generation; item.Missing = false;
        }
        await db.SaveChangesAsync(ct);
    }
}
