# DWorkBench v0.1.0 快速安装

适用于 Windows Server 2022 x64。本文件随发布包提供，完整说明在包内 `DEPLOYMENT.md`，版本范围在 `RELEASE-NOTES.md`。

## 1. 准备材料

从 [v0.1.0 发布页](https://github.com/DGS-ai-team/DWorkBench/releases/tag/v0.1.0) 下载：

- `DWorkBench-v0.1.0-win-x64.zip`
- `DWorkBench-v0.1.0-win-x64.zip.sha256`
- `Verify-Package.ps1`（解压前校验用）

目标 VM 还需要以下材料。可在联网电脑准备后一起带入内网：

| 材料 | 要求 |
| --- | --- |
| PostgreSQL 17 | Windows x64 完整安装程序；已有可用实例可复用，无需再安装 |
| HTTPS 证书 | 组织信任的 RSA 证书 PFX，包含私钥；访问域名须在 SAN 中，准备好 PFX 密码 |
| 证书链和 DNS | VM 与团队电脑信任所需根/中间 CA，并能解析该内部域名 |
| 安装信息 | PostgreSQL 管理员或现有业务账号、团队允许访问的网段、保护证书备份位置及密码 |

目标 VM 不需要 .NET SDK、Node.js、Git、WSL 或 IIS。Linux 目标仅需已有 SSH/SFTP 和可读取日志的账号，不安装 Python、Agent 或其他组件。

## 2. 安装 PostgreSQL 并校验应用包

1. 运行 PostgreSQL 完整安装程序，选择 **PostgreSQL Server** 和 **Command Line Tools**，不启动需要联网的 Stack Builder。
2. 数据库数据目录建议使用 `D:\PostgreSQL\17\data`；应用目录单独使用 `D:\DWorkBench`。本机数据库只监听 `127.0.0.1`，配置本机密码认证；不要向团队网段开放 5432。具体配置见 `DEPLOYMENT.md`。
3. 将 ZIP、哈希和校验脚本放在同一目录，在该目录打开 Windows PowerShell，运行：

```powershell
.\Verify-Package.ps1 -PackagePath '.\DWorkBench-v0.1.0-win-x64.zip'
```

校验只比较 SHA-256，不能证明发布者身份；文件和哈希须来自可信渠道。组织要求脚本签名时遵循组织流程。

## 3. 双击安装

使用资源管理器将 ZIP **完整解压到新的专用目录**，例如 `D:\DWorkBench\app`。不要在 ZIP 预览中运行，不要只取出 EXE。

双击 **`Install.cmd`**，同意 UAC 提权，然后依次填写：

1. **数据目录**：默认 `D:\DWorkBench`，必须是应用专用目录。
2. **数据库**：逐项填写主机、端口、库名、业务账号和密码，无需拼接连接字符串。新环境可选“创建”，输入数据库管理员密码后由脚本建库；新业务密码至少 16 位可打印 ASCII 字符，可含空格和符号。已有业务账号/数据库选择复用。
3. **凭据保护证书**：新环境生成独立证书，按提示填写新的 PFX 备份文件路径和至少 12 位备份密码。文件必须在应用和数据目录之外，并把备份另存 VM 之外。旧环境必须复用原保护证书和 key ring。
4. **HTTPS**：选择已安装的证书或提供 PFX 文件路径和密码，再填写端口、域名和允许访问的团队网段。提前完成 VM/客户端的组织 CA 信任；向导不会用自签 HTTPS 证书替代组织证书。
5. **确认安装**：核对摘要后确认。脚本安装 Windows 服务，设置目录与私钥权限、防火墙和失败恢复，再检查 HTTPS 健康接口。
6. **管理员初始化**：首次安装且健康检查成功后，选择在当前终端显示初始化令牌。打开向导给出的 HTTPS 地址，输入令牌，设置自己的管理员账号和密码。

数据库密码、PFX 密码通过隐藏输入填写。安装器不安装 PostgreSQL 服务，不改 DNS、CA 信任或远端 Linux 配置。

如果中途失败，已创建的数据库或已导入的证书会保留。先根据提示排查；数据库已创建则选择复用，配置已写入则沿用原配置和保护证书，不要删除数据库或密钥来重试。

## 4. 首次使用

1. 添加 Linux 主机，核对并固定 SSH 指纹，再测试账号认证。
2. 配置日志源的目录、文件模式与编码；将不同主机的来源加入日志组。
3. 刷新清单，选取关注的日志，查看流式内容、筛选和下载；在审计页面确认操作记录。
4. 创建团队成员，分别授权日志组及相关主机。

之后需要检查服务时，以管理员打开 Windows PowerShell 5.1，在包目录运行（替换为实际域名）：

```powershell
.\Check-Installation.ps1 -Url 'https://dworkbench.example.internal'
```

该检查不修改服务，保留 TLS 验证，也不代表远端主机、日志和生产容量均已验收。

## 已有环境升级

先读 `DEPLOYMENT.md` 的升级与回滚章节：停止服务，备份数据库、配置、`secrets\keys` 以及保护证书私钥；新包解压到新的专用目录，复制原受保护的 `appsettings.local.json` 后运行向导。不要重建数据库或保护证书，不要让两个应用实例同时运行。

旧服务名为 LogDesk 时，先停止并禁用旧服务，再按文档迁移。v0.1.0 是首个公开发布版本；历史文档中的 0.7、0.8、0.9 为内部迭代编号，v0.1.0 使用数据库 schema 2。

配置文件含数据库连接信息与初始化令牌，不对外分享。恢复数据库密文需要配套的数据库、key ring 和保护证书私钥，三者缺一不可。
