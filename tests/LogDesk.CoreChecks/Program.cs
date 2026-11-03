using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;
using LogDesk;
using Microsoft.Extensions.Configuration;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static async Task Until(Func<bool> check, string message, int milliseconds = 5000)
{
    var end = DateTime.UtcNow.AddMilliseconds(milliseconds);
    while (DateTime.UtcNow < end) { if (check()) return; await Task.Delay(10); }
    throw new Exception("Timed out: " + message);
}
static long Metric(SharedLogBroker broker, string name) { using var json = JsonDocument.Parse(JsonSerializer.Serialize(broker.Status())); return json.RootElement.GetProperty(name).GetInt64(); }
static SharedLogBroker Broker(FakeReader reader, params (string Key, string Value)[] settings)
{
    var values = new Dictionary<string, string?> { ["Limits:ReaderIdleSeconds"] = "0", ["Limits:BatchMilliseconds"] = "10" };
    foreach (var pair in settings) values["Limits:" + pair.Key] = pair.Value;
    return new(reader, new ConfigurationBuilder().AddInMemoryCollection(values).Build());
}
var host = new Host { Name = "test", Address = "127.0.0.1", Username = "reader", PasswordCipher = "version-1", Fingerprint = "SHA256:test" };
var source = new Source { HostId = host.Id, Host = host, Directory = "/logs", Encoding = "utf-8" };
var file = new FileEntry { SourceId = source.Id, Name = "app.log", Path = "/logs/app.log" };

// Same physical file through distinct source/group aliases must share a single upstream.
{
    var remote = new FakeReader(); var broker = Broker(remote); var subscribers = new List<SharedLogBroker.Subscription>();
    try
    {
        for (var i = 0; i < 32; i++) subscribers.Add(broker.Subscribe("user-" + i, i % 2 == 0 ? source : new Source { HostId = host.Id, Host = host, Encoding = "utf-8" }, file));
        await Until(() => remote.Active == 1, "one upstream");
        Check(remote.Starts == 1 && Metric(broker, "subscriptions") == 32, "32 users must share one reader");
        var first = subscribers[0].Read(CancellationToken.None).GetAsyncEnumerator();
        Check(await first.MoveNextAsync() && first.Current.Kind == "ready", "ready frame");
        remote.Feed("initial marker\n");
        await Until(() => Metric(broker, "publishedFrames") > 0, "initial publish");
        using var late = broker.Subscribe("late", source, file);
        await using var later = late.Read(CancellationToken.None).GetAsyncEnumerator();
        await later.MoveNextAsync(); await later.MoveNextAsync();
        Check(later.Current.Kind == "snapshot" && later.Current.Text == "initial marker\n", "late replay must include history exactly once");
        var replaySequence = later.Current.Sequence;
        remote.Feed("next marker\n");
        Check(await later.MoveNextAsync() && later.Current.Sequence > replaySequence && later.Current.Text == "next marker\n", "atomic replay/live boundary");
        await first.DisposeAsync();
        Console.WriteLine("PASS 32 users / aliases share one upstream; ordered atomic replay");
    }
    finally { subscribers.ForEach(s => s.Dispose()); await broker.StopAsync(CancellationToken.None); }
    Check(remote.Active == 0, "shutdown must release remote reader");
}

// Config/credentials and encoding changes must never inherit the old reader/cache.
{
    var remote = new FakeReader(); var broker = Broker(remote);
    using var a = broker.Subscribe("a", source, file);
    var otherHost = new Host { Id = host.Id, Address = host.Address, Username = host.Username, PasswordCipher = "version-2", Fingerprint = host.Fingerprint };
    using var b = broker.Subscribe("b", new Source { HostId = host.Id, Host = otherHost, Encoding = "utf-8" }, file);
    using var c = broker.Subscribe("c", new Source { HostId = host.Id, Host = host, Encoding = "utf-16" }, file);
    await Until(() => remote.Active == 3, "identity separation");
    await broker.StopAsync(CancellationToken.None);
    Console.WriteLine("PASS credential and encoding isolation; shutdown cancellation");
}

// Independent quotas: same file costs one reader, while each user still has a limit.
{
    var remote = new FakeReader(); var broker = Broker(remote, ("ReadersPerHost", "1"));
    var subscriptions = Enumerable.Range(0, 4).Select(_ => broker.Subscribe("same-user", source, file)).ToList();
    try
    {
        try { using var unexpected = broker.Subscribe("same-user", source, file); throw new Exception("user quota was not enforced"); } catch (ApiError e) when (e.Status == 429) { }
        try { using var unexpected = broker.Subscribe("another", source, new FileEntry { Path = "/logs/other.log" }); throw new Exception("reader quota was not enforced"); } catch (ApiError e) when (e.Status == 429) { }
    }
    finally { subscriptions.ForEach(s => s.Dispose()); await broker.StopAsync(CancellationToken.None); }
    Console.WriteLine("PASS separate reader and subscriber quotas");
}

// A slow consumer is detached alone. Its quota reservation lasts until transport cleanup,
// bounding abandoned queues even when a peer stops reading its socket.
{
    var remote = new FakeReader(); var broker = Broker(remote);
    using var slow = broker.Subscribe("slow", source, file);
    using var fast = broker.Subscribe("fast", source, file);
    var fastBytes = 0;
    var pump = Task.Run(async () => { await foreach (var frame in fast.Read(CancellationToken.None)) Interlocked.Add(ref fastBytes, frame.Text.Length); });
    await Until(() => remote.Active == 1, "reader active");
    for (var i = 0; i < 140; i++) { remote.Feed(new string('x', 4095) + "\n"); await Task.Delay(2); }
    await Until(() => Metric(broker, "slowDisconnected") == 1, "slow client detached");
    Check(Metric(broker, "activeSubscriptions") == 1 && Metric(broker, "subscriptions") == 2, "quota must bound draining slow consumers");
    var before = fastBytes; remote.Feed("healthy client continues\n");
    await Until(() => fastBytes > before, "healthy client unaffected");
    slow.Dispose(); fast.Dispose(); await pump;
    await broker.StopAsync(CancellationToken.None);
    Console.WriteLine("PASS bounded slow-client isolation; draining reservation; fast reader survives");
}

// Brief idle grace reuses an upstream; the last subscriber eventually releases it.
{
    var remote = new FakeReader(); var broker = Broker(remote, ("ReaderIdleSeconds", "1"));
    var first = broker.Subscribe("a", source, file); await Until(() => remote.Active == 1, "active"); first.Dispose();
    using var second = broker.Subscribe("b", source, file); await Task.Delay(100);
    Check(remote.Starts == 1, "idle grace should reuse reader"); second.Dispose();
    await Until(() => remote.Active == 0 && Metric(broker, "readers") == 0, "last-reader release");
    await broker.StopAsync(CancellationToken.None);
    Console.WriteLine("PASS idle grace and last subscriber cleanup");
}
// A failed SSH reader terminates only that file. A new subscription gets a fresh
// reader/cache, while a different file continues publishing.
{
    var remote = new FakeReader(); var broker = Broker(remote);
    var other = new FileEntry { Path = "/logs/healthy.log" };
    var failed = broker.Subscribe("failed", source, file);
    var healthy = broker.Subscribe("healthy", source, other);
    Exception? error = null; var healthyBytes = 0;
    var failurePump = Task.Run(async () => { try { await foreach (var _ in failed.Read(CancellationToken.None)) { } } catch (ApiError e) { error = e; } finally { failed.Dispose(); } });
    var healthyPump = Task.Run(async () => { await foreach (var frame in healthy.Read(CancellationToken.None)) Interlocked.Add(ref healthyBytes, frame.Text.Length); });
    try
    {
        await Until(() => remote.Active == 2, "two independent readers");
        remote.Fail(file.Path);
        await failurePump.WaitAsync(TimeSpan.FromSeconds(5));
        Check(error is ApiError { Status: 502 }, "upstream errors must reach affected subscriber");
        remote.Feed("healthy after other SSH failure\n", other.Path);
        await Until(() => healthyBytes > 0, "other file remains live");
        using var recovered = broker.Subscribe("failed", source, file);
        await using var frames = recovered.Read(CancellationToken.None).GetAsyncEnumerator();
        Check(await frames.MoveNextAsync() && frames.Current.Kind == "ready", "retry readiness");
        remote.Feed("fresh recovery marker\n", file.Path);
        Check(await frames.MoveNextAsync() && frames.Current.Kind == "data" && frames.Current.Text == "fresh recovery marker\n", "retry must use fresh cache");
        Check(remote.Starts == 3, "only failed reader restarted");
    }
    finally { failed.Dispose(); healthy.Dispose(); await healthyPump; await broker.StopAsync(CancellationToken.None); }
    Check(remote.Active == 0 && Metric(broker, "subscriptions") == 0, "failure/recovery cleanup");
    Console.WriteLine("PASS upstream failure isolation, fresh retry and healthy-file continuity");
}

// Repeat cancellation/open/close to expose idle/disposal races and retained queues.
{
    var remote = new FakeReader(); var broker = Broker(remote);
    try
    {
        for (var cycle = 0; cycle < 50; cycle++)
        {
            using var cancel = new CancellationTokenSource();
            var subscriptions = Enumerable.Range(0, 4).Select(i => broker.Subscribe("churn-" + i, source, file)).ToArray();
            var pumps = subscriptions.Select(async s => { try { await foreach (var _ in s.Read(cancel.Token)) { } } catch (OperationCanceledException) when (cancel.IsCancellationRequested) { } finally { s.Dispose(); } }).ToArray();
            await Until(() => remote.Active == 1, "churn reader ready");
            remote.Feed(new string('x', 8000) + "\n");
            await cancel.CancelAsync();
            foreach (var s in subscriptions) { s.Dispose(); s.Dispose(); }
            await Task.WhenAll(pumps).WaitAsync(TimeSpan.FromSeconds(5));
            await Until(() => remote.Active == 0 && Metric(broker, "readers") == 0, "churn cleanup");
            Check(Metric(broker, "subscriptions") == 0 && Metric(broker, "bufferedCharacters") == 0 && Metric(broker, "replayCharacters") == 0, "no retained reservations, queues or history after cycle");
        }
    }
    finally { await broker.StopAsync(CancellationToken.None); }
    Console.WriteLine("PASS 50 open/cancel/close cycles: readers, reservations and buffers return to zero");
}
Console.WriteLine("All broker checks passed.");

sealed class FakeReader : IRemoteLogReader
{
    private readonly ConcurrentDictionary<Guid, (string Path, Channel<string> Queue)> channels = new();
    private int starts;
    public int Active => channels.Count;
    public int Starts => Volatile.Read(ref starts);
    public void Feed(string text, string? path = null) { foreach (var entry in channels.Values) if (path == null || entry.Path == path) entry.Queue.Writer.TryWrite(text); }
    public void Fail(string path) { foreach (var entry in channels.Values) if (entry.Path == path) entry.Queue.Writer.TryComplete(new IOException("Simulated upstream disconnect")); }
    public async IAsyncEnumerable<string> Watch(Source source, FileEntry file, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid(); var channel = Channel.CreateUnbounded<string>();
        channels[id] = (file.Path, channel); Interlocked.Increment(ref starts);
        try { yield return ""; await foreach (var text in channel.Reader.ReadAllAsync(cancellationToken)) yield return text; }
        finally { channels.TryRemove(id, out _); }
    }
}
