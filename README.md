# DWorkBench / LogDesk

面向团队的 Linux 日志工作台 MVP。浏览器访问，服务端通过 SSH/SFTP 连接多台 Linux 主机；部署目标为管理网络内现有的 Windows Server 2022 VM。

Linux 目标机只需已有的 **SSH/SFTP 服务和可读取日志的账号**。清单、下载、实时增量读取统一通过 SFTP，解码与跟随逻辑运行在 LogDesk 服务端；不要求 Python、tail、Shell 执行权限或安装远端组件，不上传脚本/程序。按可信内网主机设计：检查规范路径与普通文件、拒绝发现的符号链接；普通 SFTP 的路径检查不是对恶意并发替换的原子隔离。流式编码支持 UTF-8、GB18030、GB2312/GBK、ISO-8859-1、ASCII；UTF-16/UTF-32 原文件可下载查看。

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
- Windows 服务安装脚本、自包含发布脚本、Windows/Linux 基础 CI 定义及 PostgreSQL 集成验证。

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

生成 artifacts/windows/LogDesk.zip。解压后用包内 Install-Windows.ps1 配置 PostgreSQL、HTTPS 与凭据保护证书。应用和数据库原生运行在 Windows，MVP 不依赖 WSL；具体步骤见 [部署与使用说明](docs/DEPLOYMENT.md)。

管理网络无法访问互联网时，按 [离线安装说明](docs/DEPLOYMENT.md#离线安装windows-server-2022) 提前准备发布包、SHA-256、PostgreSQL 完整安装包及证书。目标 VM 不需要安装 SDK、Node.js 或在线还原依赖；DEPLOYMENT.md 随发布包提供，可在内网直接阅读。

## 验证

第一阶段回归与稳定性收尾、第二阶段工作台保存与恢复已实现。CI 在每个 PR、推送到 `main` 以及手动触发时运行；具体结果以该提交的 GitHub Actions 状态为准，历史本地结果见 [验证记录](docs/VALIDATION.md)。

| CI 检查 | 覆盖范围 |
| --- | --- |
| Windows / Ubuntu | 前后端构建、共享读取器及资源释放、日志筛选、后台摘要、SQLite/SSH/SFTP 接口和 Chromium 页面回归 |
| 工作台回归 | 配置保存、账号隔离、并发版本冲突、撤权及失效引用；浏览器刷新/重新登录、手动恢复接收、本机冲突草稿 |
| PostgreSQL 17 | 独立测试数据库上的完整接口回归，含工作台版本比较更新 |
| 短时负载 | 8 / 32 订阅共享同一读取器，检查缺口、队列上限和退出释放；每档 5 秒，不用于承诺生产容量 |
| Windows 发布包 | 自包含发布、SHA-256、程序启动、首页/JS/Worker 和许可证；通过后上传 `LogDesk-win-x64` Artifact，保留 14 天 |

失败日志、截图及负载报告作为诊断 Artifact 保留 7 天；数据库、保护密钥、Cookie 和本机开发配置不上传。过时的同一 PR 流水线自动取消，各任务有超时限制。流水线只构建和验证，目标 Windows Server 的部署仍按部署文档执行。

```powershell
cd src/LogDesk.Client
npm ci
npm run build
npx playwright install chromium
cd ../..
dotnet build src/LogDesk.Server
dotnet run --project tests/LogDesk.CoreChecks
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

- src/LogDesk.Server：ASP.NET Core、Identity、SignalR、EF Core、SSH.NET；业务与基础设施按目录组织。
- src/LogDesk.Client：React + TypeScript、虚拟列表、多窗格工作台。
- tests：受控 SSH/SFTP、真实 WSL 与浏览器集成测试。
- deploy / scripts：Windows 安装、开发启动、自包含发布。
- [产品规格](docs/PRODUCT_SPEC.md)、[技术方案](docs/TECHNICAL_DESIGN.md)、[部署说明](docs/DEPLOYMENT.md)。
- [本地验证结果与目标环境待验收项](docs/VALIDATION.md)。

正式支持以 Windows Server 2022 为目标；核心代码使用跨平台 net10.0，Linux 正式部署需补齐目标环境验收。首版不接 SSO 或 Ansible；数据库和应用授权模型为后续集成保留稳定的内部用户/资源 ID。

CI 覆盖构建、受控 SFTP、SQLite、PostgreSQL 和 Chromium，最新结果以对应提交的 Checks 为准。SFTP 轮询活跃时约 250ms，空闲时退避至 2s；身份检查约 1–2s。普通 SFTP 不提供统一 inode，内容相同的替换、轮询间多次轮转及快速截断重写不能保证无遗漏。目标 Windows VM 的服务安装、组织证书、管理网络内各主机的 SSH 策略、权限与容量仍需验收。
