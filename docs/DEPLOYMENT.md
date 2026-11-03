# LogDesk MVP 运行与部署

## 当前交付范围

已实现本地账号、角色和主机/日志组交集授权、共享主机与来源配置、SSH 指纹探测和确认、后台 SFTP 渐进扫描、游标分页清单、最多四个实时关注文件及一到两个阅读窗格、原始文件下载和操作审计。正式部署目标是现有的 Windows Server 2022 VM；服务端核心目标框架为 net10.0。

MVP 使用一个 Web 服务进程和 PostgreSQL。Linux 目标只需已有的 SSH 密码认证、SFTP 服务和日志读取权限；目录枚举、下载和增量读取均走 SFTP。无需 Python、tail、Shell 执行权限、Agent 或上传临时脚本/程序。可使用仅允许 `internal-sftp` 的已有账号，但不要求为应用调整远端配置。

用户已确认按可信内网主机设计。应用在打开前后校验规范路径和普通文件属性，拒绝发现的路径符号链接；SFTP v3 不提供原子的逐级 no-follow 打开，无法保证抵御有能力恶意并发修改远端目录的账号。最终文件权限边界仍由远端操作系统及 SSH 账号权限决定，不将配置的日志目录宣称为对恶意远端用户的沙箱。

流式编码支持 UTF-8、GB18030、GB2312/GBK、ISO-8859-1 和 ASCII。UTF-16/UTF-32 目前不支持流式读取，已有这类配置的原文件仍可下载查看。SSO、Ansible、跳板机和任意命令终端属于后续扩展。

## 本地开发与预览

开发/构建脚本需要 PowerShell 7、Node.js 22.12+ 或 24、.NET 10 SDK。仓库若已有 .tools/dotnet，开发脚本优先使用该 SDK。运行服务器只需发布包及 PostgreSQL，无需这些构建工具。

从仓库根目录运行：

```powershell
./scripts/Start-Dev.ps1
```

打开 http://127.0.0.1:5080。第一次启动进入管理员初始化页面：从 .local/dev-settings.json 的 BootstrapToken 取出初始化令牌，自行设置用户名和至少 12 位、包含大小写字母及数字的密码。没有默认账号或默认密码。初始化完成后令牌不能再创建额外管理员；后续通过团队成员管理新增账号。

开发模式使用 .local/dev-data 下的 SQLite，便于独立运行；本地密钥环仅用于开发，不能复制为正式环境。Production 环境拒绝 SQLite，并强制配置凭据保护证书及 HTTPS 访问。不要将开发模式开放给团队网络。

可选的前端热更新：先保持后端运行，再在 src/LogDesk.Client 执行 npm run dev，通过 Vite 地址访问。API 与 SignalR 已配置代理。

## 首次使用流程

1. 添加 Linux 主机，保存 SSH 用户名/密码。
2. 点击“测试连接”。首次探测只读取主机指纹，未知指纹不会进入密码认证。通过服务器控制台或可信管理员核对 SHA-256 指纹，明确确认后再测试认证。
3. 为主机配置日志源：绝对目录、文件名 glob 和编码；同一个目录不递归子目录。
4. 创建日志组，可勾选不同主机上的多个日志源。
5. 从日志工作台打开“日志清单”，点击“刷新清单”。默认刷新全部来源，可通过右侧箭头展开范围后选择部分来源。清单以每批 200 项渐进写入，页面按游标读取。
6. 勾选至多四个文件，选择“仅加入关注”或“加入并阅读”；停止单个窗格不影响其他窗格或用户。同文件共享读取，继续查看读取最近快照，不保证补齐停止期间内容。
7. 创建团队成员并分配角色，分别授权日志组和对应主机。读取和下载均要求两侧授权；维护权限仅对维护者生效，连接/凭据及用户管理仅限管理员。

日志正文不存入业务数据库。显示缓冲按 10,000 行和约 2,000,000 字符双重限制；服务端流队列有界，接收不及会停止对应流并提示。下载由浏览器接管进度，以开始时的远端文件长度为范围，不进行转码。

### 快速日志与不同格式

- 窗格筛选栏可选“文本 / 通配符 / 正则”，例如文本 `trace_id=abc`、通配符 `*timeout*`、正则 `timeout|失败`。通配符匹配整行；默认忽略大小写。
- 点击筛选设置按钮，配置排除模式（例如心跳）、等级范围和前后文。排除优先于包含与上下文。正则不支持环视或反向引用，写错规则时仍显示上一有效结果。
- 自动着色只识别明确等级；无法识别时保持中性。对特殊格式选择“纯文本”、指定 JSON 字段（如 `log.level`），或填写等级提取正则 `severity=(INFO|WARN|ERROR)`，第 1 个捕获组作为等级。
- 雪花按钮冻结当前显示并继续接收，可在冻结快照上筛选；恢复后回到当前实时缓冲。窗格“更多”菜单的“停止接收”取消自己的订阅；换行、复制和清空也在此菜单。长时间冻结不会无限积累历史，原始文件可另行下载。
- 筛选仅针对本窗格当前保留内容，不检索整个远端文件，也不减少服务器到浏览器的流量。格式和筛选随当前账号的最近工作台保存在服务端；团队共享主机和日志组，每个人保留自己的阅读配置。

## 构建 Windows 发布包

在有 SDK 和 Node 的构建机运行：

```powershell
./scripts/Publish-Windows.ps1
```

生成 artifacts/windows/LogDesk.zip，包含 win-x64 自包含应用、前端静态文件和 Windows 安装脚本。运行节点不需要 Node 或 .NET SDK。自包含运行时的更新通过重新发布完成。

## Windows Server 2022 安装

1. 原生安装受支持版本的 PostgreSQL，配置仅监听 127.0.0.1，并创建独立业务数据库和账号。
2. 将发布包解压至 D:\LogDesk\app。准备一个团队浏览器信任的 HTTPS RSA 证书，及一个独立的凭据保护 RSA 证书；都导入本地计算机的 My 证书存储，须包含私钥。保留凭据保护证书的受保护导出备份。
3. 用管理员 PowerShell 执行包内的 Install-Windows.ps1，提供数据库连接字符串、两个证书的指纹，以及允许访问的团队网络地址。

数据库可通过 PostgreSQL 管理员的 psql 创建（密码交互设置）：

```sql
CREATE ROLE logdesk_app LOGIN;
\password logdesk_app
CREATE DATABASE logdesk OWNER logdesk_app;
```

初始数据库应为空、专用于 LogDesk。0.9 首次启动创建 schema 2；从 schema 1 启动时，在事务内新增 Workspaces 表并更新版本标识，现有账号、主机、来源、日志组及审计表保持原结构。应用只接受已支持的 schema 标识，不通过删库升级。

独立凭据保护证书可由管理员创建（它用于本机数据保护，不承担浏览器 HTTPS 信任）：

```powershell
$protectionCert = New-SelfSignedCertificate -Subject 'CN=LogDesk-CredentialProtection' -CertStoreLocation 'Cert:\LocalMachine\My' -KeyAlgorithm RSA -KeyLength 3072 -KeyExportPolicy Exportable -KeyUsage KeyEncipherment,DataEncipherment -NotAfter (Get-Date).AddYears(3)
```

安装示例。数据库连接字符串通过交互输入，避免将真实密码写入脚本或命令历史：

```powershell
$secret = Read-Host 'PostgreSQL connection string' -AsSecureString
$connection = [System.Management.Automation.PSCredential]::new('unused', $secret).GetNetworkCredential().Password
./Install-Windows.ps1 -DataRoot 'D:\LogDesk' -DatabaseConnectionString $connection -HttpsCertificateThumbprint '<HTTPS_CERT_THUMBPRINT>' -ProtectionCertificateThumbprint $protectionCert.Thumbprint -AllowedRemoteAddress @('10.0.0.0/24')
$connection = $null
```

连接字符串格式：Host=127.0.0.1;Port=5432;Database=logdesk;Username=logdesk_app;Password=实际密码。

安装脚本创建/更新 LogDesk 服务，以 LocalService 运行，设置自动启动和失败恢复；为专用数据目录和两个 RSA 私钥授予所需访问权，并按给定网段创建 HTTPS 防火墙规则。它不会安装 PostgreSQL、申请 HTTPS 证书或修改 SSH 服务器。若使用自定义 AppPath/DataRoot，必须为此应用的专用目录；不要传入盘符根目录或共用业务目录。

配置保存在应用目录下的 appsettings.local.json，包含数据库连接信息和首次初始化令牌，文件访问由专用目录 ACL 保护。证书保护的 key ring 默认在 D:\LogDesk\secrets\keys；数据库密文依赖此 key ring 和保护证书私钥，三者缺一不可。配置中 Protection:CertificatePath/CertificatePassword 也可加载受限 PFX 文件，供后续 Linux 部署适配使用。

安装完成后访问 https://内部域名/api/health，再访问网页完成管理员初始化。首次令牌位于该受保护配置的 Bootstrap.Token。RDP 注销不影响 Windows 服务。

## 运行、备份与限制

- 数据库持续保存配置、权限、文件清单元数据与审计；审计没有删除 UI。诊断错误可从 Windows Application 事件日志的 LogDesk 源查看；诊断不记录凭据。
- 定期备份 PostgreSQL、Data Protection key ring 和保护证书私钥，分别受保护并复制到 VM 之外。同一 D 盘上的另一目录不能承担异机恢复。
- 全局扫描并发 3，每主机扫描并发 1；日志订阅默认每用户 4、每主机 128、全局 512，独立远端读取器每主机 8、全局 32；同连接身份/路径/编码共享读取。全局下载并发 2、每用户下载并发 2。配额不是吞吐量承诺，压测结果见 [性能报告](PERFORMANCE.md)。
- 流式会话每 5 秒复核账号、资源权限及主机连接身份；退出登录、改密或管理员停用账号会使已有会话失效。退出登录会使该账号此前的会话 Cookie 全部失效。
- 单 VM/服务重启会中断查看和下载；恢复后重新打开。SFTP 读取器在服务端保留偏移和增量解码器，活跃时约 250ms 轮询，空闲时退避至 2s。初始快照有界（最近 128 KiB 内最多 200 行，丢弃窗口首段残行）。借助前缀/已读末尾内容检查识别常规轮转、截断和删除重建；SFTP 无统一 inode，内容相同的替换、快速截断重写和轮询间多次轮转不能保证无遗漏，断线也不补齐历史。
- 标准 SFTP 仍需枚举大目录的全部元数据；分页仅约束清单查询和渲染成本。当前未实现元数据与审计保留期的自动清理，应按实际规模监控数据库增长。
- 当前下载成功审计表示服务端已完成输出；浏览器本地最终落盘由浏览器管理。
- 管理员可调整来源路径；应用用户不能把任意路径或 Shell 命令直接作为流/下载参数提交。发现符号链接或非普通文件即拒绝，下载长度取自已打开的 SFTP 句柄。按可信远端管理者模型运行，不承诺远端内容完整性或原子抗路径替换。

### 流服务配置与升级

共享流优化版本使用 schema 1；0.9 工作台保存功能升级为 schema 2，见下方升级说明。升级前备份并重启服务，随后刷新浏览器以加载新的前端；旧 `Watch` 协议仍兼容。配置示例：

```json
{
  "Limits": {
    "SubscribersPerUser": 4, "SubscribersPerHost": 128, "SubscribersGlobal": 512,
    "ReadersPerHost": 8, "ReadersGlobal": 32, "ReaderIdleSeconds": 3,
    "SubscriberBufferFrames": 64, "SubscriberBufferCharacters": 262144,
    "ReplayLines": 200, "ReplayCharacters": 131072, "BatchMilliseconds": 40
  }
}
```

字符数按 UTF-16 计算，不等于字节数。最后一个订阅退出后 3 秒释放远端读取器；慢订阅独立隔离，待传输清理前仍占配额。管理员可请求 `/api/streams/status` 观察当前读取器、活动/清理中订阅、缓冲量及隔离次数。多个应用进程不会跨进程共享读取。

旧 `StreamsPerUser/StreamsPerHost/StreamsGlobal` 仅在对应新键缺失时作为回退；应用默认配置已提供新键，升级时请将自定义旧配额迁移到新键。不要直接把 512 全局订阅上限当成已测的生产容量。

## 验证

```powershell
cd src/LogDesk.Client
npm ci
npm run build
npx playwright install chromium
cd ../..
dotnet build src/LogDesk.Server
node tests/integration.mjs
```

测试使用两个仅监听本机的受控 SSH/SFTP 服务器，不读取实际管理主机。涵盖初始令牌、CSRF、指纹固定、跨主机扫描、200 项游标分页、特殊字符路径、UTF-8 原始字节下载、权限交集、四流配额、取消释放、账号停用、审计，以及浏览器分窗操作。SKIP_BROWSER=1 可仅执行 API/SSH 测试。

开发机安装 WSL 时，可另运行 node tests/wsl-integration.mjs，验证真实 OpenSSH/SFTP。脚本创建独立应用数据库、临时账号和回环 SSH 端口，并通过 ForceCommand internal-sftp 禁用应用账号的命令执行。WSL 管理端用 Python 准备/修改测试文件，应用连接不使用该解释器；正式运行不需要 WSL 或 Python。结束后清理 Linux 测试资源。历史验证版本与清理范围见 [验证记录](VALIDATION.md#本机-wsl-实测)。

PostgreSQL 验证需要一个全新的测试数据库，设置 TEST_DATABASE_PROVIDER=Postgres 和 ConnectionStrings__LogDesk 后运行同一脚本。不要指向业务数据库。CI 定义包含 Windows/Linux 基础验证和单独 PostgreSQL 验证；新增 workflow 只有推送到 GitHub 后才会执行，不能将定义存在视为 CI 已通过。


## 关注列表与目录预览（0.7）

关注列表可折叠，点击文件切换当前活动窗格，后台卡片的“并排”打开第二个；固定窗格会保留。收起阅读窗格后日志仍接收，“更多”菜单的“停止接收”才取消订阅。后台和前台共同计入默认每用户四订阅额度，当前不会自动跟踪整个日志组。

卡片更多菜单中的“关注规则”与阅读筛选相互独立；“接收详情”可查看近 60 秒统计。点击命中摘要或待看徽标可定位，菜单中的“标为已查看”才清除待看计数。近 60 秒按接收时间统计，包含首次 tail 的尾部数据，显式共享回放快照除外；只表示此会话观察到的数据，停止期间不统计。原文及计数不构成故障判定。重新跟踪重置旧窗口，防止快照重复累加。

日志源表单可在保存前检查目录与模式。预览最多返回 20 个普通文件，最多检查 5,000 个目录项，15 秒取消，服务端最多四个同时预览，每用户每分钟 12 次；达到上限时仅为部分结果。预览复用 SSH 指纹固定与现有授权，不保存配置或修改远端文件。

## 工作台保存与恢复（0.9）

每个账号保存一份最近工作台，包含当前日志组、最多四个关注文件、两个阅读槽位、固定窗格、左右/上下布局、分隔比例、侧栏开关、每文件的阅读筛选/格式/换行和独立关注规则。修改后约 500ms 合并保存；退出登录前等待一次保存。保存失败会提示并提供重试，浏览器存储可用时保留该账号的未同步配置草稿。

刷新或重新登录后只恢复配置，所有条目先进入“待恢复”。“恢复接收”重新校验当前日志组和主机授权，按来源、主机、路径和编码定位当前清单文件；实际连接时继续执行 SSH 指纹、读取权限及远端文件检查。单项失效保留原因，可重新检查或移除，不阻断其他条目。文件重新出现但清单仍标记缺失时，先刷新清单。

配置不包含日志正文、命中摘录、凭据、接收计数和浏览器滚动位置；冻结和连接状态也不会跨页面恢复。重新连接读取最近快照，不补齐离线期间的全部日志。0.8 的匿名浏览器筛选偏好不会自动导入其他账号；0.9 起使用账号隔离的服务端配置。

多个页面修改同一账号时，服务器使用版本号拒绝过期写入。发生冲突后可“加载已保存版本”或“保留当前工作台”，后者基于最新版本重新提交，仍受并发检查。正常保存不增加常驻状态栏。

升级步骤：

1. 停止应用，备份数据库、Data Protection key ring 及保护证书；升级期间只启动一个应用实例。
2. 部署 0.9 程序并启动。schema 1 → 2 为增量建表；首次升级的数据库账号须有 CREATE TABLE 权限。
3. 刷新浏览器。首次使用 0.9 需选择一次日志，此后的配置变更自动保存。
4. 回滚旧版时同时恢复升级前数据库与对应程序。旧程序只接受 schema 1，不要手工修改 schema 标识强行降级。
