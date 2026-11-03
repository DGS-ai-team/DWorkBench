using System.Diagnostics;
using System.Text;
using System.Threading.Channels;
using Renci.SshNet;
using Renci.SshNet.Common;
using Renci.SshNet.Sftp;

namespace LogDesk;

// Runs entirely on the LogDesk server. SFTP v3 has no portable inode or atomic
// no-follow open: canonical-path checks detect observed links, not hostile races.
internal sealed class SftpLogFollower(SftpClient client, string path, Encoding encoding, ChannelWriter<RemoteLogChunk> output)
{
    private const int AnchorBytes = 256;
    private readonly byte[] buffer = new byte[8192];
    private readonly char[] chars = new char[encoding.GetMaxCharCount(8192)];
    private readonly Decoder decoder = encoding.GetDecoder();
    private SftpFileStream? current;
    private long position;
    private byte[] prefix = [], suffix = [];

    internal static string Normalize(string path) => "/" + string.Join('/', path.Split('/', StringSplitOptions.RemoveEmptyEntries));

    internal static async Task CheckPath(SftpClient client, string path, bool directory, CancellationToken ct)
    {
        var expected = Normalize(path);
        var entry = await client.GetAsync(expected, ct); // REALPATH followed by LSTAT
        if (Normalize(entry.FullName) != expected || entry.IsSymbolicLink ||
            (directory ? !entry.IsDirectory : !entry.IsRegularFile))
            throw new ApiError(409, "路径已变化或包含符号链接，或目标不是所需的普通文件/目录。请检查来源并重新扫描。");
    }

    internal static async Task<SftpFileStream> OpenChecked(SftpClient client, string path, CancellationToken ct)
    {
        path = Normalize(path);
        await CheckPath(client, path, false, ct);
        var stream = await client.OpenAsync(path, FileMode.Open, FileAccess.Read, ct);
        try
        {
            await CheckPath(client, path, false, ct);
            if (!stream.CanSeek || Normalize(stream.Name) != path || stream.Length < 0)
                throw new ApiError(409, "目标不是可读取的普通日志文件。");
            return stream;
        }
        catch { await stream.DisposeAsync(); throw; }
    }

    private void Publish(string text, bool snapshotTruncated = false)
    {
        if (!output.TryWrite(new(text, snapshotTruncated)))
            throw new ApiError(429, "日志输出超过接收能力，已停止此流。请缩小查看范围后重试。");
    }

    private void Decode(ReadOnlySpan<byte> bytes, bool flush = false)
    {
        var count = decoder.GetChars(bytes, chars, flush);
        if (count != 0) Publish(new string(chars, 0, count));
    }

    // A seek outside the local read buffer discards SSH.NET's prefetched EOF.
    // Without invalidation, a file which was empty can remain at cached EOF.
    private static void FreshSeek(SftpFileStream stream, long offset)
    {
        stream.Seek(long.MaxValue, SeekOrigin.Begin);
        stream.Seek(offset, SeekOrigin.Begin);
    }

    private static async Task<byte[]> ReadAt(SftpFileStream stream, long offset, int count, CancellationToken ct)
    {
        FreshSeek(stream, offset);
        var bytes = new byte[count];
        var read = 0;
        while (read < count)
        {
            var next = await stream.ReadAsync(bytes.AsMemory(read), ct);
            if (next == 0) break;
            read += next;
        }
        return read == count ? bytes : bytes[..read];
    }

    private void Remember(ReadOnlySpan<byte> bytes)
    {
        if (position < AnchorBytes)
        {
            var count = Math.Min(bytes.Length, AnchorBytes - (int)position);
            prefix = [.. prefix, .. bytes[..count]];
        }
        var retained = Math.Min(AnchorBytes - Math.Min(AnchorBytes, bytes.Length), suffix.Length);
        suffix = [.. suffix.AsSpan(suffix.Length - retained), .. bytes[^Math.Min(AnchorBytes, bytes.Length)..]];
        position += bytes.Length;
    }

    private async Task<bool> Matches(SftpFileStream stream, CancellationToken ct)
    {
        if (stream.Length < position) return false;
        if (prefix.Length != 0 && !(await ReadAt(stream, 0, prefix.Length, ct)).AsSpan().SequenceEqual(prefix)) return false;
        return suffix.Length == 0 || (await ReadAt(stream, position - suffix.Length, suffix.Length, ct)).AsSpan().SequenceEqual(suffix);
    }

    private async Task Drain(long end, CancellationToken ct)
    {
        FreshSeek(current!, position);
        while (position < end)
        {
            var count = await current!.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, end - position)), ct);
            if (count == 0) break;
            Remember(buffer.AsSpan(0, count));
            Decode(buffer.AsSpan(0, count));
        }
    }

    private void Reset()
    {
        Decode([], flush: true);
        decoder.Reset();
        position = 0;
        prefix = suffix = [];
    }

    private async Task Snapshot(CancellationToken ct)
    {
        var end = current!.Length;
        var start = Math.Max(0, end - 128 * 1024);
        var bytes = await ReadAt(current, start, (int)(end - start), ct);
        position = start + bytes.Length;
        prefix = await ReadAt(current, 0, (int)Math.Min(AnchorBytes, position), ct);
        suffix = bytes[^Math.Min(AnchorBytes, bytes.Length)..];
        var first = 0;
        if (start > 0) { var newline = Array.IndexOf(bytes, (byte)'\n'); first = newline < 0 ? bytes.Length : newline + 1; }
        var lines = bytes.Length > first ? 1 : 0;
        for (var i = bytes.Length - 1; i >= first; i--)
        {
            if (bytes[i] != '\n' || i == bytes.Length - 1) continue;
            if (lines == 200) { first = i + 1; break; }
            lines++;
        }
        // Ordinary selection of the last 200 lines is expected. Report when the
        // byte window prevents returning those lines, even if zero text remains.
        if (start > 0 && lines < 200) Publish("", snapshotTruncated: true);
        // Decode in bounded chunks, retaining multibyte characters across them.
        for (var offset = first; offset < bytes.Length; offset += buffer.Length)
            Decode(bytes.AsSpan(offset, Math.Min(buffer.Length, bytes.Length - offset)));
    }

    internal async Task Run(CancellationToken ct)
    {
        try
        {
            current = await OpenChecked(client, path, ct);
            Publish("");
            await Snapshot(ct);
            var clock = Stopwatch.StartNew();
            long checkAt = 0;
            var delay = 250;
            var missing = false;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var before = position;
                if (clock.ElapsedMilliseconds >= checkAt)
                {
                    SftpFileStream? candidate = null;
                    try { candidate = await OpenChecked(client, path, ct); }
                    catch (SftpPathNotFoundException) { missing = true; }
                    if (candidate != null)
                    {
                        try
                        {
                            // Drain the old handle's observed suffix before switching,
                            // provided already-read anchors still belong to that content.
                            if (await Matches(current, ct)) await Drain(current.Length, ct);
                            var continued = !missing && await Matches(candidate, ct);
                            await current.DisposeAsync();
                            current = candidate;
                            candidate = null;
                            if (!continued) Reset();
                            missing = false;
                        }
                        finally { if (candidate != null) await candidate.DisposeAsync(); }
                    }
                    checkAt = clock.ElapsedMilliseconds + Math.Max(1000, delay);
                }
                var size = current.Length;
                if (size < position) Reset();
                await Drain(size, ct);
                delay = position == before ? Math.Min(2000, delay * 2) : 250;
                await Task.Delay(delay, ct);
            }
        }
        finally { if (current != null) await current.DisposeAsync(); }
    }
}
