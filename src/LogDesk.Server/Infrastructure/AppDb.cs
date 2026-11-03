using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace LogDesk;

public class AppDb(DbContextOptions<AppDb> options) : IdentityDbContext<AppUser>(options)
{
    public DbSet<Host> Hosts => Set<Host>();
    public DbSet<Source> Sources => Set<Source>();
    public DbSet<LogGroup> Groups => Set<LogGroup>();
    public DbSet<GroupSource> GroupSources => Set<GroupSource>();
    public DbSet<FileEntry> Files => Set<FileEntry>();
    public DbSet<Grant> Grants => Set<Grant>();
    public DbSet<AuditEvent> Audit => Set<AuditEvent>();
    public DbSet<AppMetadata> Metadata => Set<AppMetadata>();
    public DbSet<UserWorkspace> Workspaces => Set<UserWorkspace>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        base.OnModelCreating(b);
        b.Entity<AppMetadata>().HasKey(x => x.Key);
        b.Entity<UserWorkspace>().HasKey(x => x.UserId);
        b.Entity<UserWorkspace>().HasOne(x => x.User).WithOne().HasForeignKey<UserWorkspace>(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<GroupSource>().HasKey(x => new { x.GroupId, x.SourceId });
        b.Entity<Source>().HasOne(x => x.Host).WithMany().HasForeignKey(x => x.HostId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<GroupSource>().HasOne(x => x.Group).WithMany().HasForeignKey(x => x.GroupId);
        b.Entity<GroupSource>().HasOne(x => x.Source).WithMany().HasForeignKey(x => x.SourceId);
        b.Entity<FileEntry>().HasOne(x => x.Source).WithMany().HasForeignKey(x => x.SourceId);
        b.Entity<Grant>().HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId);
        b.Entity<Grant>().HasIndex(x => new { x.UserId, x.Scope, x.ResourceId }).IsUnique();
        b.Entity<FileEntry>().HasIndex(x => new { x.SourceId, x.Path }).IsUnique();
        b.Entity<FileEntry>().HasIndex(x => new { x.SourceId, x.ModifiedAt, x.Id });
        b.Entity<FileEntry>().HasIndex(x => new { x.SourceId, x.Name });
        b.Entity<AuditEvent>().HasIndex(x => new { x.At, x.Id });
        b.Entity<Host>().Property(x => x.Name).HasMaxLength(100);
        b.Entity<Host>().Property(x => x.Address).HasMaxLength(253);
        b.Entity<FileEntry>().Property(x => x.Path).HasMaxLength(2048);
    }
}
