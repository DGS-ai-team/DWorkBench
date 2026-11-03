using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Threading.Channels;
using Microsoft.AspNetCore.DataProtection;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace DWorkBench;

public record RemoteFile(string Name, string Path, long Size, long ModifiedAt);

public sealed class RemoteLogs(IDataProtectionProvider protection) : IRemoteLogReader
{
    private readonly SemaphoreSlim previewSlots = new(4);
    public async Task<object> Preview(Source source, CancellationToken ct)
    {
        if (!await previewSlots.WaitAsync(0, ct)) throw new ApiError(429, "目录预览繁忙，请稍后重试。");
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            using var client = await Sftp(source.Host, timeout.Token);
            using var cancel = timeout.Token.Register(() => { try { client.Disconnect(); } catch { } });
            await SftpLogFollower.CheckPath(client, source.Directory, true, timeout.Token);
            var files = new List<RemoteFile>();
            var examined = 0; var limited = false;
            await foreach (var file in client.ListDirectoryAsync(source.Directory, timeout.Token))
            {
                examined++;
                if (file.IsRegularFile && !file.IsSymbolicLink && FileSystemName.MatchesSimpleExpression(source.Pattern, file.Name, false))
                    files.Add(new(file.Name, Rules.RemotePath(source.Directory, file.Name), file.Length,
                        new DateTimeOffset(DateTime.SpecifyKind(file.LastWriteTimeUtc, DateTimeKind.Utc)).ToUnixTimeMilliseconds()));
                if (files.Count >= 20 || examined >= 5000) { limited = true; break; }
            }
            return new { files, examined, limited, checkedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        }
        catch (Exception error) when (!ct.IsCancellationRequested)
        {
            throw new ApiError(error is ApiError api ? api.Status : 502, SafeError(error));
        }
        finally { previewSlots.Release(); }
    }
    // This purpose is part of the saved ciphertext format, not a display name.
    private readonly IDataProtector protector = protection.CreateProtector("LogDesk.SshCredential.v1");
    public string Protect(string password) => protector.Protect(password);
    private Renci.SshNet.ConnectionInfo Info(Host host) => new(host.Address, host.Port, host.Username,
        new PasswordAuthenticationMethod(host.Username, protector.Unprotect(host.PasswordCipher))) { Timeout = TimeSpan.FromSeconds(12) };
    private static void Configure(BaseClient client, Host host, Action<string>? candidate = null)
    {
        client.KeepAliveInterval = TimeSpan.FromSeconds(15);
        client.HostKeyReceived += (_, e) =>
        {
            var fingerprint = "SHA256:" + Convert.ToBase64String(SHA256.HashData(e.HostKey)).TrimEnd('=');
            candidate?.Invoke(fingerprint);
            e.CanTrust = host.Fingerprint == fingerprint;
        };
    }
    public async Task<(string? Fingerprint, bool Connected, string Message)> Probe(Host host, CancellationToken ct)
    {
        string? candidate = null;
        using var client = new SftpClient(Info(host));
        Configure(client, host, fp => candidate = fp);
        try
        {
            await client.ConnectAsync(ct);
            return (candidate, true, "SSH/SFTP 连接成功。无需安装远端组件，可继续配置日志源并扫描清单。");
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            return (candidate, false, candidate != null && candidate != host.Fingerprint
                ? host.Fingerprint == null ? "主机身份尚未确认，请核对指纹。" : "主机指纹已变化，连接已阻止。请联系服务器管理员核验。"
                : SafeError(e));
        }
    }
    public async Task<SftpClient> Sftp(Host host, CancellationToken ct)
    {
        if (host.Fingerprint == null) throw new ApiError(409, "请先测试连接并确认 SSH 主机指纹。");
        var client = new SftpClient(Info(host));
        Configure(client, host);
        client.OperationTimeout = TimeSpan.FromSeconds(30);
        try { await client.ConnectAsync(ct); return client; }
        catch { client.Dispose(); throw; }
    }
    public async IAsyncEnumerable<RemoteFile> List(Source source, [EnumeratorCancellation] CancellationToken ct)
    {
        using var client = await Sftp(source.Host, ct);
        using var cancel = ct.Register(() => { try { client.Disconnect(); } catch { } });
        await SftpLogFollower.CheckPath(client, source.Directory, true, ct);
        await foreach (var file in client.ListDirectoryAsync(source.Directory, ct))
        {
            if (file.IsRegularFile && !file.IsSymbolicLink && FileSystemName.MatchesSimpleExpression(source.Pattern, file.Name, false))
                yield return new(file.Name, Rules.RemotePath(source.Directory, file.Name), file.Length,
                    new DateTimeOffset(DateTime.SpecifyKind(file.LastWriteTimeUtc, DateTimeKind.Utc)).ToUnixTimeMilliseconds());
        }
    }
    public async Task Download(Source source, FileEntry file, Action<long> begin, Func<ReadOnlyMemory<byte>, CancellationToken, Task> write, CancellationToken ct)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
        lifetime.CancelAfter(TimeSpan.FromSeconds(30));
        using var client = await Sftp(source.Host, lifetime.Token);
        using var disconnect = lifetime.Token.Register(() => { try { client.Disconnect(); } catch { } });
        using var stream = await SftpLogFollower.OpenChecked(client, file.Path, lifetime.Token);
        var remaining = stream.Length; // Size belongs to the opened SFTP handle.
        begin(remaining);
        var buffer = new byte[64 * 1024];
        while (remaining > 0)
        {
            lifetime.CancelAfter(TimeSpan.FromSeconds(30));
            var count = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), lifetime.Token);
            if (count == 0) throw new ApiError(409, "远程文件在下载中被截断，请重新下载。");
            await write(buffer.AsMemory(0, count), lifetime.Token);
            remaining -= count;
        }
    }
    public async IAsyncEnumerable<RemoteLogChunk> Watch(Source source, FileEntry file, [EnumeratorCancellation] CancellationToken ct)
    {
        var encoding = Rules.StreamEncoding(source.Encoding);
        using var client = await Sftp(source.Host, ct);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
        // Let the producer cancel reads and close its handles before disconnecting.
        // Disconnecting from the cancellation callback races SFTP CLOSE replies;
        // an outstanding synchronous metadata request remains bounded by OperationTimeout.
        var channel = Channel.CreateBounded<RemoteLogChunk>(new BoundedChannelOptions(64) { SingleWriter = true, SingleReader = true });
        var producer = Task.Run(async () =>
        {
            try
            {
                await new SftpLogFollower(client, file.Path, encoding, channel.Writer).Run(lifetime.Token);
                channel.Writer.TryComplete();
            }
            catch (Exception error) { channel.Writer.TryComplete(error); }
            finally { try { client.Disconnect(); } catch { } }
        }, CancellationToken.None);
        try
        {
            await foreach (var chunk in channel.Reader.ReadAllAsync(ct)) yield return chunk;
        }
        finally
        {
            await lifetime.CancelAsync();
            await producer;
        }
    }
    public static string SafeError(Exception error) => error switch
    {
        ApiError api => api.Message,
        SshAuthenticationException => "SSH 认证失败，请检查用户名、密码和服务器认证策略。",
        SshConnectionException => "SSH 连接失败或主机指纹不匹配，请测试连接并核验指纹。",
        SftpPermissionDeniedException => "远端账户无权读取该目录或文件。",
        SftpPathNotFoundException => "远端目录或日志文件不存在，请重新扫描。",
        System.Net.Sockets.SocketException => "无法连接目标主机，请检查地址、端口和管理网络。",
        TimeoutException => "远程操作超时，请稍后重试。",
        OperationCanceledException => "操作已取消。",
        CryptographicException => "无法解密主机凭据，请检查服务端密钥或重新保存密码。",
        _ => "远程操作失败，请检查连接状态、文件权限及服务端诊断日志。"
    };
}
