using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading.RateLimiting;
using LogDesk;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddJsonFile("appsettings.local.json", optional: true).AddEnvironmentVariables();
if (OperatingSystem.IsWindows())
{
    builder.Services.AddWindowsService(options => options.ServiceName = "LogDesk");
    builder.Services.Configure<Microsoft.Extensions.Logging.EventLog.EventLogSettings>(options => { if (OperatingSystem.IsWindows()) options.SourceName = "LogDesk"; });
}
var httpsThumbprint = builder.Configuration["Hosting:HttpsCertificateThumbprint"];
if (!string.IsNullOrEmpty(httpsThumbprint))
{
    if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Configure a file-based Kestrel certificate on this platform.");
    using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
    store.Open(OpenFlags.ReadOnly);
    var certificates = store.Certificates.Find(X509FindType.FindByThumbprint, httpsThumbprint, true);
    if (certificates.Count == 0 || !certificates[0].HasPrivateKey) throw new InvalidOperationException("A valid HTTPS certificate and private key are required.");
    var certificate = certificates[0];
    builder.WebHost.ConfigureKestrel(options => options.ListenAnyIP(builder.Configuration.GetValue("Hosting:Port", 443), listener => listener.UseHttps(certificate)));
}
var root = builder.Configuration["Storage:Root"];
if (string.IsNullOrWhiteSpace(root))
{
    if (!builder.Environment.IsDevelopment()) throw new InvalidOperationException("Configure Storage:Root before deploying.");
    root = Path.Combine(builder.Environment.ContentRootPath, ".local");
}
root = Path.GetFullPath(root);
Directory.CreateDirectory(root);
var keyPath = Path.Combine(root, "secrets", "keys");
Directory.CreateDirectory(keyPath);
var protection = builder.Services.AddDataProtection().SetApplicationName("LogDesk.v1").PersistKeysToFileSystem(new DirectoryInfo(keyPath));
var certPath = builder.Configuration["Protection:CertificatePath"];
var thumbprint = builder.Configuration["Protection:CertificateThumbprint"];
if (!string.IsNullOrEmpty(certPath))
    protection.ProtectKeysWithCertificate(X509CertificateLoader.LoadPkcs12FromFile(certPath, builder.Configuration["Protection:CertificatePassword"]));
else if (!string.IsNullOrEmpty(thumbprint))
{
    using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
    store.Open(OpenFlags.ReadOnly);
    var certificates = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, false);
    if (certificates.Count == 0 || !certificates[0].HasPrivateKey) throw new InvalidOperationException("Credential protection certificate not found or private key unavailable.");
    protection.ProtectKeysWithCertificate(certificates[0]);
}
else if (!builder.Environment.IsDevelopment()) throw new InvalidOperationException("A credential protection certificate is required in production.");

var provider = builder.Configuration["Database:Provider"] ?? "Postgres";
if (provider == "Sqlite" && !builder.Environment.IsDevelopment()) throw new InvalidOperationException("SQLite is only enabled for local development and tests.");
builder.Services.AddDbContextFactory<AppDb>(options =>
{
    if (provider == "Sqlite") options.UseSqlite("Data Source=" + Path.Combine(root, "logdesk.db") + ";Default Timeout=30");
    else options.UseNpgsql(builder.Configuration.GetConnectionString("LogDesk") ?? throw new InvalidOperationException("Configure ConnectionStrings:LogDesk."));
});
builder.Services.AddIdentityCore<AppUser>(options =>
{
    options.Password.RequiredLength = 12;
    options.Password.RequireNonAlphanumeric = false;
    options.Lockout.MaxFailedAccessAttempts = 5;
    options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
}).AddRoles<IdentityRole>().AddEntityFrameworkStores<AppDb>().AddSignInManager().AddDefaultTokenProviders();
builder.Services.AddAuthentication(IdentityConstants.ApplicationScheme).AddIdentityCookies();
builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.Name = "LogDesk.Session";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = builder.Environment.IsDevelopment() ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;
    options.ExpireTimeSpan = TimeSpan.FromHours(8);
    options.SlidingExpiration = false;
    options.Events.OnRedirectToLogin = c => { c.Response.StatusCode = 401; return Task.CompletedTask; };
    options.Events.OnRedirectToAccessDenied = c => { c.Response.StatusCode = 403; return Task.CompletedTask; };
});
builder.Services.AddAuthorization();
builder.Services.AddAntiforgery(options => { options.HeaderName = "X-CSRF-Token"; options.Cookie.SameSite = SameSiteMode.Strict; });
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429;
    options.AddPolicy("source-preview", ctx => RateLimitPartition.GetFixedWindowLimiter(ctx.User.Identity?.Name ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "local",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 12, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    options.AddPolicy("auth", ctx => RateLimitPartition.GetFixedWindowLimiter(ctx.Connection.RemoteIpAddress?.ToString() ?? "local",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 12, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<AuditWriter>();
builder.Services.AddSingleton<AccessService>();
builder.Services.AddSingleton<RemoteLogs>();
builder.Services.AddSingleton<IRemoteLogReader>(services => services.GetRequiredService<RemoteLogs>());
builder.Services.AddSingleton<SharedLogBroker>();
builder.Services.AddHostedService(services => services.GetRequiredService<SharedLogBroker>());
builder.Services.AddSingleton<ScanCoordinator>();
builder.Services.AddHostedService(services => services.GetRequiredService<ScanCoordinator>());
builder.Services.AddSingleton<DownloadQuota>();
builder.Services.AddSignalR(options => { options.MaximumReceiveMessageSize = 16 * 1024; options.StreamBufferCapacity = 8; });
var app = builder.Build();
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDb>();
    var created = await db.Database.EnsureCreatedAsync();
    if (created) { db.Metadata.Add(new AppMetadata { Key = "schema", Value = "2" }); await db.SaveChangesAsync(); }
    var schema = await db.Metadata.SingleOrDefaultAsync(x => x.Key == "schema");
    if (schema?.Value == "1")
    {
        // Additive v1 -> v2 upgrade, compatible with SQLite and PostgreSQL.
        await using var upgrade = await db.Database.BeginTransactionAsync();
        await db.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS "Workspaces" (
                "UserId" TEXT NOT NULL PRIMARY KEY REFERENCES "AspNetUsers" ("Id") ON DELETE CASCADE,
                "Revision" TEXT NOT NULL,
                "UpdatedAt" BIGINT NOT NULL,
                "Document" TEXT NOT NULL
            );
            """);
        schema.Value = "2";
        await db.SaveChangesAsync();
        await upgrade.CommitAsync();
    }
    if (schema?.Value != "2")
        throw new InvalidOperationException("Unsupported database schema. Back up the database and follow the release migration instructions.");
    if (provider == "Sqlite") await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;");
}
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "same-origin";
    ctx.Response.Headers["X-Frame-Options"] = "DENY";
    ctx.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    if (ctx.Request.Path.StartsWithSegments("/api")) ctx.Response.Headers.CacheControl = "no-store";
    try
    {
        if (ctx.Request.Path.StartsWithSegments("/api/workspace"))
        {
            var size = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
            if (size is { IsReadOnly: false }) size.MaxRequestBodySize = 65_536;
            if (ctx.Request.ContentLength > 65_536) throw new ApiError(413, "工作台配置过大。");
        }
        if (!app.Environment.IsDevelopment() && !ctx.Request.IsHttps) throw new ApiError(400, "请通过 HTTPS 访问工作台。");
        if (ctx.Request.Headers.TryGetValue("Origin", out var origin) &&
            (!Uri.TryCreate(origin.ToString(), UriKind.Absolute, out var uri) || !string.Equals(uri.Authority, ctx.Request.Host.Value, StringComparison.OrdinalIgnoreCase) || uri.Scheme != ctx.Request.Scheme))
            throw new ApiError(403, "不允许跨来源访问。");
        await next();
    }
    catch (Exception error) when (!ctx.Response.HasStarted)
    {
        var status = error is ApiError api ? api.Status : error is BadHttpRequestException or System.Text.Json.JsonException ? 400 : 500;
        if (status == 500) app.Logger.LogError("Request {RequestId} failed: {ErrorType}", ctx.TraceIdentifier, error.GetType().Name);
        ctx.Response.StatusCode = status;
        await ctx.Response.WriteAsJsonAsync(new { error = error is ApiError ? error.Message : status == 400 ? "请求数据格式不正确。" : "服务暂时无法完成操作，请联系管理员。", traceId = ctx.TraceIdentifier });
    }
});
app.UseAuthentication();
app.Use(async (ctx, next) =>
{
    if (ctx.User.Identity?.IsAuthenticated == true && (ctx.Request.Path.StartsWithSegments("/api") || ctx.Request.Path.StartsWithSegments("/hubs")))
    {
        var access = ctx.RequestServices.GetRequiredService<AccessService>();
        try
        {
            var user = await access.User(ctx.User.UserId());
            if (ctx.User.FindFirst("AspNet.Identity.SecurityStamp")?.Value != user.SecurityStamp) throw new ApiError(401, "登录已失效，请重新登录。");
            ctx.Items["appUser"] = user;
        }
        catch (ApiError) { await ctx.SignOutAsync(IdentityConstants.ApplicationScheme); throw; }
    }
    if (ctx.Request.Path.StartsWithSegments("/api") && !HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
    {
        try { await ctx.RequestServices.GetRequiredService<Microsoft.AspNetCore.Antiforgery.IAntiforgery>().ValidateRequestAsync(ctx); }
        catch (Microsoft.AspNetCore.Antiforgery.AntiforgeryValidationException) { throw new ApiError(400, "页面验证已失效，请刷新后重试。"); }
    }
    await next();
});
app.UseAuthorization();
app.UseRateLimiter();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapLogDesk();
app.MapWorkspaces();
app.MapHub<LogsHub>("/hubs/logs", options =>
{
    options.TransportMaxBufferSize = 64 * 1024;
    options.TransportSendTimeout = TimeSpan.FromSeconds(10);
});
app.Map("/api/{**path}", () => Results.NotFound(new { error = "接口不存在。" }));
app.MapFallbackToFile("index.html");
await app.RunAsync();

public partial class Program { }
