# DWorkBench

面向团队的 Linux 日志工作台 MVP。浏览器访问，服务端通过 SSH/SFTP 连接多台 Linux 主机；部署目标为管理网络内现有的 Windows Server 2022 VM。

Linux 目标机只需已有的 **SSH/SFTP 服务和可读取日志的账号**。清单、下载、实时增量读取统一通过 SFTP，解码与跟随逻辑运行在 DWorkBench 服务端；不要求 Python、tail、Shell 执行权限或安装远端组件，不上传脚本/程序。按可信内网主机设计：检查规范路径与普通文件、拒绝发现的符号链接；普通 SFTP 的路径检查不是对恶意并发替换的原子隔离。流式编码支持 UTF-8、GB18030、GB2312/GBK、ISO-8859-1、ASCII；UTF-16/UTF-32 原文件可下载查看。

## 已实现

- 本地账号初始化、成员启停、角色与资源权限；读取/下载要求日志组和主机两侧授权。
- 共享主机、日志源和跨主机日志组配置；SSH 主机指纹探测、人工核验与固定。
- 后台渐进扫描、来源进度和部分失败、文件名/主机/来源/时间筛选、200 项游标分页与虚拟化清单。
- 同一主机连接身份、路径与编码共享一条 SSH 读取；每位查看者独立授权、审计、配额和有界队列，慢客户端单独停止。
- 按需关注至多四个日志文件，展开一到两个主阅读窗格；后台卡片显示近期接收、独立规则命中、原文摘录和连接状态；支持固定、切换、收起、左右/上下分窗、停止/继续、冻结与专注模式。
- 每窗格支持文本、通配符、正则包含/排除、大小写和上下文筛选；Worker 处理、增量更新、虚拟列表。等级支持保守自动识别、纯文本、JSON 字段和自定义提取。
- 清单覆盖打开，保持日志窗格尺寸；切换管理页面保持活动流和有界显示缓冲。
- 按账号自动保存最近工作台：日志组、关注文件、双窗布局、固定状态、筛选/格式、换行及关注规则；刷新或重新登录后还原布局，点击“恢复接收”重新校验并连接。支持本机未同步草稿和多页面版本冲突提示。
- 主机测试后直达日志源；目录与文件模式可在保存前做有界 SFTP 预览；日志组直达清单；团队权限显示实际可访问来源。
- SFTP 原始字节下载，长度和内容来自同一个已打开句柄，浏览器接管下载进度；操作审计记录配置变更、权限、扫描、访问和下载结果。
- Windows 交互安装向导、数据库初始化和安装检查脚本、自包含发布及 Windows/Linux/PostgreSQL CI。

## 安装 v0.1.0

从 [v0.1.0 发布页](https://github.com/DGS-ai-team/DWorkBench/releases/tag/v0.1.0) 下载 `DWorkBench-v0.1.0-win-x64.zip` 及配套 `.sha256`。这是首个公开版本；文档中的 0.7、0.8、0.9 是发布前内部迭代编号。

1. 在 Windows Server 2022 上准备 PostgreSQL 17、组织信任的 HTTPS RSA 证书及内部域名；离线环境提前带入完整安装程序和证书链。
2. 按 [快速安装说明](deploy/QUICKSTART.zh-CN.md) 校验包，完整解压至新的专用目录，例如 `D:\DWorkBench\app`。
3. 双击包内 **`Install.cmd`**，按向导填写数据库、证书和允许访问的网段。向导可创建业务数据库、导入 HTTPS PFX、生成并备份独立凭据保护证书，随后安装和检查 Windows 服务。
4. 打开向导给出的 HTTPS 地址，用初始化令牌创建首个管理员，再配置 Linux 主机和日志组。

无需在目标 VM 安装 SDK、Node.js、WSL 或远端组件。完整前提、升级/回滚和手动参数见 [部署说明](docs/DEPLOYMENT.md)，本版范围见 [发布说明](docs/releases/v0.1.0.md)。

## 本地运行

开发/构建需要 PowerShell 7、.NET 10 SDK、Node.js 22.12+ 或 24。开发脚本也会识别项目内 .tools/dotnet。

```powershell
./scripts/Start-Dev.ps1
```

打开 http://127.0.0.1:5080。初始令牌位于 .local/dev-settings.json 的 BootstrapToken；首次页面使用该令牌创建管理员，自行设置账号密码。没有默认账号密码。

开发模式使用 SQLite，数据位于 .local/dev-data；正式部署使用 PostgreSQL，并要求 HTTPS 和凭据保护证书。生产配置不能使用开发模式或开发密钥。

## Windows Server 2022 发布

```powershell
./scripts/Publish-Windows.ps1
```

生成 `artifacts/windows/DWorkBench.zip` 及 `.sha256`，包含应用、交互安装向导、检查脚本、版本信息、部署文档和许可证。输出目录必须为空；再次构建时指定新的专用目录，例如 `./scripts/Publish-Windows.ps1 -Output 'D:\builds\DWorkBench-0.1.0'`。不要将构建输出指向已安装的应用目录。

管理网络无法访问互联网时，按 [离线安装说明](docs/DEPLOYMENT.md#离线安装windows-server-2022) 提前准备发布包、SHA-256、PostgreSQL 完整安装包及证书。目标 VM 不需要安装 SDK、Node.js 或在线还原依赖；DEPLOYMENT.md 随发布包提供，可在内网直接阅读。

## 验证

第一阶段回归与稳定性收尾、第二阶段工作台保存与恢复已实现。PR 按变更范围选择检查；`main` 的非普通文档变更执行完整基线并生成 Windows 候选包。标签由独立发布流程处理。具体结果以该提交的 GitHub Actions 状态为准，历史本地结果见 [验证记录](docs/VALIDATION.md)。

| 场景 | CI 执行范围 |
| --- | --- |
| 普通文档 | 本地相对链接与冲突标记检查，不构建应用 |
| 前端 | Ubuntu 构建、日志处理逻辑、核心和 Chromium 页面回归 |
| 后端 | Linux / Windows 构建、核心与 API/SFTP 回归，PostgreSQL 17 回归；认证、API、工作台与启动配置变更追加 Ubuntu 浏览器回归 |
| 流式读取与并发 | 在受影响检查之外追加 Linux 短时负载，检查共享读取、队列和释放 |
| 安装、打包及随包文档 | Windows 打包、PowerShell 5.1 语法检查、发布包启动检查 |
| 依赖、公共工具、测试、CI 或未分类路径 | 完整基线：以上全部，浏览器仅 Ubuntu |
| 手动 `extended` | 完整基线，再加 Windows 浏览器回归与完整负载；手动默认 `full` |

每个 PR 都产生固定的 **`CI result`** 汇总检查；建议分支保护仅将其设为必需项，按路径跳过的子任务不作为独立必需项。Windows 候选包 `DWorkBench-win-x64` 保留 30 天；诊断文件仅在失败时上传并保留 7 天，手动扩展运行另保留完整负载报告 14 天。数据库、保护密钥、Cookie 和本机开发配置不上传。同一 PR 的旧运行自动取消。

版本标签优先复用**同一提交、完整验证成功的 `main` 推送**产物，校验资格、版本信息和哈希；等待仍在运行的主干检查有时间上限。没有合格产物或产物过期时才重新执行完整基线，不使用 PR 或其他提交的包。发布不会自动部署目标 Windows Server。任务矩阵、复用条件和手动入口见 [CI 执行策略](docs/CI.md)。

```powershell
cd src/DWorkBench.Client
npm ci
npm run build
npx playwright install chromium
cd ../..
dotnet build src/DWorkBench.Server
dotnet run --project tests/DWorkBench.CoreChecks
node tests/log-processing.mjs
node tests/log-activity.mjs
node tests/integration.mjs
```

集成测试启动两个仅监听本机的 SSH/SFTP 测试服务器，验证指纹、跨主机扫描、分页、特殊字符路径、原始字节下载、权限、日志流配额与取消释放，并通过 Chromium 验证页面操作。测试不连接真实管理主机。PostgreSQL 测试配置及执行限制见部署说明。

Windows 开发机还可运行真实 WSL 验证：

```powershell
node tests/wsl-integration.mjs
```

WSL 脚本使用独立数据库、临时 Linux 账号及回环 SSH 端口，并将应用账号限制为 `internal-sftp`，结束时清理 Linux 测试资源。开发机的 Python 仅用于造数和操作测试夹具，不是应用目标机的运行依赖。设置 WSL_LOAD=1 可追加 8 账号 / 32 订阅验证。历史 tail/Python 读取器的结果不能替代当前 SFTP 实现的验收，具体版本与结果见 [验证记录](docs/VALIDATION.md)。

压测运行 `node tests/load.mjs`；可用 `LOAD_SECONDS` 设置每档时长，`LOAD_SHORT=1` 仅运行短档。当前实测覆盖 64 订阅 × 1,000 行/秒、32 订阅 × 5,000 行/秒及真实慢客户端隔离，详见 [性能报告与复现方法](docs/PERFORMANCE.md)。配置上限不等于已测生产容量。

## 项目结构

- src/DWorkBench.Server：ASP.NET Core、Identity、SignalR、EF Core、SSH.NET；业务与基础设施按目录组织。
- src/DWorkBench.Client：React + TypeScript、虚拟列表、多窗格工作台。
- tests：受控 SSH/SFTP、真实 WSL 与浏览器集成测试。
- deploy / scripts：Windows 安装、开发启动、自包含发布。
- [产品规格](docs/PRODUCT_SPEC.md)、[技术方案](docs/TECHNICAL_DESIGN.md)、[部署说明](docs/DEPLOYMENT.md)。
- [本地验证结果与目标环境待验收项](docs/VALIDATION.md)。

正式支持以 Windows Server 2022 为目标；核心代码使用跨平台 net10.0，Linux 正式部署需补齐目标环境验收。首版不接 SSO 或 Ansible；数据库和应用授权模型为后续集成保留稳定的内部用户/资源 ID。

CI 覆盖构建、受控 SFTP、SQLite、PostgreSQL 和 Chromium，最新结果以对应提交的 Checks 为准。SFTP 轮询活跃时约 250ms，空闲时退避至 2s；身份检查约 1–2s。普通 SFTP 不提供统一 inode，内容相同的替换、轮询间多次轮转及快速截断重写不能保证无遗漏。目标 Windows VM 的服务安装、组织证书、管理网络内各主机的 SSH 策略、权限与容量仍需验收。
