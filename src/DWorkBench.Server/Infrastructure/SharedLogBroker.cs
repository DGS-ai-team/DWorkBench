using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;

namespace DWorkBench;

public interface IRemoteLogReader
{
    IAsyncEnumerable<RemoteLogChunk> Watch(Source source, FileEntry file, CancellationToken cancellationToken);
}

// Keep reader metadata separate from log text, including omissions that occur
// before the broker's character-based replay buffer sees the snapshot.
public readonly record struct RemoteLogChunk(string Text, bool SnapshotTruncated = false);

public sealed record LogFrame(string Kind, long Sequence, string Text = "", string? Message = null);

// A connection identity is part of the key: never reuse a reader across credentials,
// changed host keys, encodings or host definitions, even when paths look identical.
public sealed record LogReaderKey(Guid HostId, string Identity, string Path, string Encoding)
{
    public static LogReaderKey For(Source source, FileEntry file)
    {
        var host = source.Host;
        var identity = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            System.Text.Json.JsonSerializer.Serialize(new { host.Address, host.Port, host.Username, host.Fingerprint, host.PasswordCipher }))));
        return new(host.Id, identity, file.Path, Rules.Encoding(source.Encoding).WebName);
    }
}

public sealed class SharedLogBroker : IHostedService
{
    private const string SnapshotCapacityMessage = "初始快照达到容量上限，较早的内容未包含；可下载原文件查看。";
    private readonly object gate = new();
    private readonly Dictionary<LogReaderKey, Reader> readers = [];
    private readonly HashSet<Subscription> reservations = [];
    private readonly IRemoteLogReader remote;
    private readonly StreamLimits limits;
    private bool stopping;
    private long slowDisconnected, publishedCharacters, publishedFrames;

    public SharedLogBroker(IRemoteLogReader remote, IConfiguration configuration)
    {
        this.remote = remote;
        limits = StreamLimits.From(configuration);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Subscription Subscribe(string userId, Source source, FileEntry file)
    {
        var key = LogReaderKey.For(source, file);
        lock (gate)
        {
            if (stopping) throw new ApiError(503, "日志服务正在停止。");
            var all = reservations;
            if (all.Count() >= limits.SubscribersGlobal ||
                all.Count(s => s.UserId == userId) >= limits.SubscribersPerUser ||
                all.Count(s => s.HostId == source.HostId) >= limits.SubscribersPerHost)
                throw new ApiError(429, "日志订阅数已达用户、主机或服务配额，请先停止部分窗格。");

            if (!readers.TryGetValue(key, out var reader))
            {
                if (readers.Count >= limits.ReadersGlobal || readers.Keys.Count(k => k.HostId == key.HostId) >= limits.ReadersPerHost)
                    throw new ApiError(429, "远端文件读取数已达主机或服务配额，请稍后重试。");
                reader = new Reader(key, source, file, limits);
                readers.Add(key, reader);
                reader.Runner = Task.Run(() => Run(reader));
            }
            if (reader.Closing) throw new ApiError(409, "上一条读取正在释放，请稍后重试。");
            reader.IdleCancellation?.Cancel();
            var subscription = new Subscription(this, reader, userId, source.HostId, limits.SubscriberFrames);
            reservations.Add(subscription);
            reader.Subscribers.Add(subscription.Id, subscription);
            if (reader.Ready)
            {
                Enqueue(reader, subscription, new("ready", reader.Sequence));
                if (reader.InitialSnapshotTruncated || reader.History.Truncated)
                    Enqueue(reader, subscription, new("notice", reader.Sequence, Message: SnapshotCapacityMessage));
                var snapshot = reader.History.Snapshot();
                if (snapshot.Length > 0) Enqueue(reader, subscription, new("snapshot", reader.Sequence, snapshot));
            }
            return subscription;
        }
    }

    private async Task Run(Reader reader)
    {
        Exception? failure = null;
        using var flushCancellation = CancellationTokenSource.CreateLinkedTokenSource(reader.Lifetime.Token);
        var flush = FlushPeriodically(reader, flushCancellation.Token);
        try
        {
            await foreach (var chunk in remote.Watch(reader.Source, reader.File, reader.Lifetime.Token))
            {
                lock (gate)
                {
                    if (chunk.SnapshotTruncated && !reader.InitialSnapshotTruncated)
                    {
                        reader.InitialSnapshotTruncated = true;
                        Broadcast(reader, new("notice", reader.Sequence, Message: SnapshotCapacityMessage));
                    }
                    var text = chunk.Text;
                    if (text.Length == 0)
                    {
                        if (!reader.Ready)
                        {
                            reader.Ready = true;
                            Broadcast(reader, new("ready", reader.Sequence));
                        }
                        continue;
                    }
                    // Split defensively: the remote adapter normally produces at most 8K chars.
                    for (var offset = 0; offset < text.Length;)
                    {
                        var length = Math.Min(limits.FrameCharacters - reader.Pending.Length, text.Length - offset);
                        reader.Pending.Append(text, offset, length);
                        offset += length;
                        if (reader.Pending.Length >= limits.FrameCharacters) Flush(reader);
                    }
                }
            }
        }
        catch (OperationCanceledException) when (reader.Lifetime.IsCancellationRequested) { }
        catch (Exception error) { failure = new ApiError(502, RemoteLogs.SafeError(error)); }
        finally
        {
            await flushCancellation.CancelAsync();
            await flush;
            lock (gate)
            {
                Flush(reader, final: true);
                foreach (var subscriber in reader.Subscribers.Values) subscriber.Queue.Writer.TryComplete(failure);
                reader.Subscribers.Clear();
                reader.Closing = true;
                reader.IdleCancellation?.Cancel();
                readers.Remove(reader.Key);
            }
            reader.Lifetime.Dispose();
        }
    }

    private async Task FlushPeriodically(Reader reader, CancellationToken cancellationToken)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(limits.BatchMilliseconds));
            while (await timer.WaitForNextTickAsync(cancellationToken))
                lock (gate) Flush(reader);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    private void Flush(Reader reader, bool final = false)
    {
        var length = reader.Pending.Length;
        if (length == 0) return;
        // StreamReader and frame limits can split a UTF-16 surrogate pair.
        // Keep its high surrogate until the next chunk, including timer flushes.
        if (char.IsHighSurrogate(reader.Pending[length - 1]))
        {
            if (final) reader.Pending[length - 1] = '\uFFFD';
            else length--;
        }
        if (length == 0) return;
        var text = reader.Pending.ToString(0, length);
        reader.Pending.Remove(0, length);
        reader.History.Append(text);
        reader.Sequence++;
        publishedCharacters += text.Length;
        publishedFrames++;
        Broadcast(reader, new("data", reader.Sequence, text));
    }

    private void Broadcast(Reader reader, LogFrame frame)
    {
        List<Subscription>? slow = null;
        foreach (var subscriber in reader.Subscribers.Values)
            if (!TryEnqueue(subscriber, frame)) (slow ??= []).Add(subscriber);
        if (slow is null) return;
        foreach (var subscriber in slow)
        {
            slowDisconnected++;
            Remove(reader, subscriber, new ApiError(429, "接收速度不足，已停止此订阅；其他用户不受影响。请缩小查看范围后重新连接。"));
        }
    }

    private bool TryEnqueue(Subscription subscriber, LogFrame frame)
    {
        if (subscriber.PendingCharacters + frame.Text.Length > limits.SubscriberCharacters || !subscriber.Queue.Writer.TryWrite(frame)) return false;
        subscriber.PendingCharacters += frame.Text.Length;
        return true;
    }

    private void Enqueue(Reader reader, Subscription subscriber, LogFrame frame)
    {
        if (!TryEnqueue(subscriber, frame))
            Remove(reader, subscriber, new ApiError(429, "初始日志快照超过订阅缓冲上限，请重新连接。"));
    }

    private void Remove(Reader reader, Subscription subscriber, Exception? error)
    {
        if (!reader.Subscribers.Remove(subscriber.Id)) return;
        subscriber.Queue.Writer.TryComplete(error);
        if (reader.Subscribers.Count != 0 || reader.Closing || stopping) return;
        reader.IdleCancellation?.Cancel();
        var idle = new CancellationTokenSource();
        reader.IdleCancellation = idle;
        reader.IdleTask = ReleaseIdle(reader, idle);
    }

    private async Task ReleaseIdle(Reader reader, CancellationTokenSource idle)
    {
        // Yield before entering the broker lock; this method is called while it is held.
        await Task.Yield();
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(limits.ReaderIdleSeconds), idle.Token);
            lock (gate)
            {
                if (reader.Closing || reader.Subscribers.Count > 0 || reader.IdleCancellation != idle) return;
                reader.Closing = true;
            }
            await reader.Lifetime.CancelAsync();
        }
        catch (OperationCanceledException) when (idle.IsCancellationRequested) { }
        catch (ObjectDisposedException) { }
        finally
        {
            lock (gate) { if (reader.IdleCancellation == idle) reader.IdleCancellation = null; }
            idle.Dispose();
        }
    }

    private void Unsubscribe(Subscription subscription)
    {
        lock (gate)
        {
            Remove(subscription.Owner, subscription, null);
            reservations.Remove(subscription);
        }
    }

    public object Status()
    {
        lock (gate)
            return new
            {
                readers = readers.Count,
                subscriptions = reservations.Count,
                activeSubscriptions = readers.Values.Sum(r => r.Subscribers.Count),
                drainingSubscriptions = reservations.Count - readers.Values.Sum(r => r.Subscribers.Count),
                idleReaders = readers.Values.Count(r => r.Subscribers.Count == 0),
                bufferedCharacters = reservations.Sum(s => (long)s.PendingCharacters),
                replayCharacters = readers.Values.Sum(r => r.History.Characters),
                slowDisconnected,
                publishedCharacters,
                publishedFrames,
                limits
            };
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        Reader[] active;
        lock (gate)
        {
            stopping = true;
            active = readers.Values.ToArray();
            foreach (var reader in active)
            {
                reader.Closing = true;
                reader.IdleCancellation?.Cancel();
                foreach (var subscriber in reader.Subscribers.Values) subscriber.Queue.Writer.TryComplete(new ApiError(503, "日志服务正在停止。"));
                reader.Subscribers.Clear();
            }
        }
        foreach (var reader in active) { try { await reader.Lifetime.CancelAsync(); } catch (ObjectDisposedException) { } }
        await Task.WhenAll(active.Select(r => r.Runner)).WaitAsync(cancellationToken);
    }

    public sealed class Subscription : IDisposable
    {
        private readonly SharedLogBroker broker;
        private int disposed;
        internal readonly Reader Owner;
        internal readonly Channel<LogFrame> Queue;
        internal int PendingCharacters;
        internal Guid Id { get; } = Guid.NewGuid();
        internal string UserId { get; }
        internal Guid HostId { get; }

        internal Subscription(SharedLogBroker broker, Reader owner, string userId, Guid hostId, int frames)
        {
            this.broker = broker; Owner = owner; UserId = userId; HostId = hostId;
            Queue = Channel.CreateBounded<LogFrame>(new BoundedChannelOptions(frames) { SingleWriter = true, SingleReader = true, AllowSynchronousContinuations = false });
        }
        public async IAsyncEnumerable<LogFrame> Read([EnumeratorCancellation] CancellationToken cancellationToken)
        {
            using var cancelled = cancellationToken.Register(Dispose);
            await foreach (var frame in Queue.Reader.ReadAllAsync(cancellationToken))
            {
                lock (broker.gate) PendingCharacters -= frame.Text.Length;
                yield return frame;
            }
        }
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) broker.Unsubscribe(this); }
    }

    internal sealed class Reader(LogReaderKey key, Source source, FileEntry file, StreamLimits limits)
    {
        internal readonly LogReaderKey Key = key;
        internal readonly Source Source = source;
        internal readonly FileEntry File = file;
        internal readonly CancellationTokenSource Lifetime = new();
        internal readonly Dictionary<Guid, Subscription> Subscribers = [];
        internal readonly ReplayBuffer History = new(limits.ReplayLines, limits.ReplayCharacters);
        internal readonly StringBuilder Pending = new();
        internal Task Runner = Task.CompletedTask;
        internal Task IdleTask = Task.CompletedTask;
        internal CancellationTokenSource? IdleCancellation;
        internal long Sequence;
        internal bool Ready, Closing, InitialSnapshotTruncated;
    }
}

// Stores raw text without reparsing formats. Subscription and replay registration happen
// under the same lock as publishing, so joining cannot duplicate or miss a published frame.
internal sealed class ReplayBuffer(int maxLines, int maxCharacters)
{
    private readonly LinkedList<string> parts = [];
    private int lines;
    private bool skipPartial;
    internal int Characters { get; private set; }
    internal bool Truncated { get; private set; }
    internal string Snapshot() => string.Concat(parts);

    internal void Append(string text)
    {
        if (skipPartial)
        {
            var end = text.IndexOf('\n');
            if (end < 0) return;
            text = text[(end + 1)..];
            skipPartial = false;
        }
        if (text.Length == 0) return;
        parts.AddLast(text); Characters += text.Length; lines += text.Count(c => c == '\n');
        while (Characters > maxCharacters || lines > maxLines)
        {
            if (Characters > maxCharacters) Truncated = true;
            var found = false;
            while (parts.First is { } node)
            {
                var end = node.Value.IndexOf('\n');
                if (end >= 0)
                {
                    Characters -= end + 1; lines--;
                    if (end + 1 == node.Value.Length) parts.RemoveFirst(); else node.Value = node.Value[(end + 1)..];
                    found = true; break;
                }
                Characters -= node.Value.Length; parts.RemoveFirst();
            }
            if (!found) { skipPartial = true; break; }
        }
    }
}

public sealed record StreamLimits(int ReadersPerHost, int ReadersGlobal, int SubscribersPerUser, int SubscribersPerHost,
    int SubscribersGlobal, int SubscriberFrames, int SubscriberCharacters, int ReplayLines, int ReplayCharacters,
    int FrameCharacters, int BatchMilliseconds, int ReaderIdleSeconds)
{
    public static StreamLimits From(IConfiguration c)
    {
        int Value(string name, int fallback, int min, int max) => Math.Clamp(c.GetValue("Limits:" + name, fallback), min, max);
        var subscriberCharacters = Value("SubscriberBufferCharacters", 262144, 32768, 2097152);
        return new(Value("ReadersPerHost", c.GetValue("Limits:StreamsPerHost", 8), 1, 128),
            Value("ReadersGlobal", c.GetValue("Limits:StreamsGlobal", 32), 1, 512),
            Value("SubscribersPerUser", c.GetValue("Limits:StreamsPerUser", 4), 1, 32),
            Value("SubscribersPerHost", 128, 1, 4096), Value("SubscribersGlobal", 512, 1, 8192),
            Value("SubscriberBufferFrames", 64, 4, 1024), subscriberCharacters,
            Value("ReplayLines", 200, 1, 1000), Math.Min(Value("ReplayCharacters", 131072, 16384, 1048576), subscriberCharacters),
            32768, Value("BatchMilliseconds", 40, 10, 200), Value("ReaderIdleSeconds", 3, 0, 30));
    }
}
