# CI 执行策略

CI 根据变更范围选择检查，把耗时较长的 Windows 浏览器回归与完整负载留给手动扩展运行。普通代码 PR 的 2–4 分钟是优化目标，实际耗时以 Actions 运行记录为准；缓存状态、GitHub Runner 排队及变更范围都会影响结果。

## 入口与场景

| 入口 / 变更 | 执行内容 |
| --- | --- |
| PR：普通文档 | 检查仓库内相对文件链接及合并冲突标记，不还原依赖或构建应用 |
| PR：前端 | Ubuntu 前后端构建、核心检查、日志筛选与后台摘要逻辑、Chromium 浏览器回归 |
| PR：后端 | Linux 和 Windows 构建、核心与 SQLite/API/SSH/SFTP 回归，以及 PostgreSQL 17 接口回归 |
| PR：认证、API、工作台或 `Program.cs` | 在后端检查之外增加 Ubuntu 浏览器回归，覆盖登录、权限及工作台交互的影响 |
| PR：流式读取、订阅与配额 | 在受影响检查之外增加 Linux 短时负载：8 / 32 订阅，每档 5 秒，检查共享、队列上限与释放 |
| PR：安装、打包脚本或随包文档/许可证 | Windows 打包、安装脚本的 PowerShell 5.1 语法解析、发布包启动与静态资源检查 |
| PR：依赖锁文件、公共工具、测试、CI，或未分类路径 | 完整基线，避免漏掉间接影响 |
| 推送 `main`：普通文档 | 文档检查，不产生发布候选包 |
| 推送 `main`：其他变更 | 完整基线与 Windows 候选包；全部检查成功后产生 `Release qualification` 标记 |
| 手动 `CI`，`profile: full`（默认） | 完整基线 |
| 手动 `CI`，`profile: extended` | 完整基线的负载扩展为完整档，再加 Windows Chromium 回归 |
| 推送 `v*` 标签 | 独立 Release 流程；先查找同提交合格产物，没有则执行完整基线 |

同一次修改跨多个范围时取所需检查的并集。无法可靠识别变更时执行完整基线。随发布包交付的部署/验证/性能文档、基准数据、发行说明与许可证属于打包范围，不作为普通文档跳过。

文档检查读取仓库内文件，不联网检查外部 URL，也不校验标题锚点或 HTML/MDX 中的链接。

完整基线包括 Ubuntu 构建、核心与前端逻辑、API/SFTP、浏览器和短时负载，Windows 构建、核心、API/SFTP 与打包检查，以及 PostgreSQL 回归。Windows 浏览器与完整负载只有 `extended` 才执行；当前不配置定时任务。

## 工作流与合并检查

- [ci.yml](../.github/workflows/ci.yml) 接受 PR、`main` 推送及手动触发，先计算所需检查，再调用 [verify.yml](../.github/workflows/verify.yml)。标签只走 [release.yml](../.github/workflows/release.yml)，避免同时启动另一套 CI。
- 可复用验证流程按输入选择任务，并由内部汇总检查逐项确认应该运行的任务确实成功；意外跳过、取消或失败都不能作为通过。
- 每个 PR 都运行固定的 **`CI result`** 汇总任务，即使仅修改普通文档也会有明确结果。建议分支保护只要求 `CI result`，不要把按条件执行的子任务设为必需项。本次调整不修改仓库分支保护设置。
- 同一 PR 的旧运行自动取消，任务各有超时。手动运行在 GitHub 的 **Actions → CI → Run workflow** 选择分支和 `profile`；默认 `full`，需要 Windows 页面或容量回归时选 `extended`。

API 与浏览器检查目前共用集成夹具：浏览器回归仍会先完成相应接口准备和检查。未选择浏览器的任务通过 `SKIP_BROWSER=1` 跳过浏览器安装与页面步骤，避免 Windows 普通提交重复安装 Chromium。

## 构建复用与产物保留

Windows 任务先安装 npm 依赖并构建前端，再以 `Publish-Windows.ps1 -SkipClientBuild` 打包，消除同一个任务中的第二次 `npm ci` / `npm run build`。本地直接运行发布脚本的默认行为保持不变。跳过参数要求已生成的 `wwwroot/index.html` 及包含 npm 安装记录的 `node_modules`；调用者必须确保这些文件由当前 checkout 的本次任务生成。

| 产物 | 保留策略 |
| --- | --- |
| `DWorkBench-win-x64` Windows ZIP 与 SHA-256 | 30 天；正式发布前需仍可下载 |
| 失败诊断：白名单内的日志、截图与报告 | 仅失败时上传，保留 7 天 |
| 手动 `extended` 的完整负载报告 | 无论成功或失败均尝试上传报告，保留 14 天 |
| 正式 GitHub Release 资产 | 与所发布版本一起保留，不受 CI Artifact 的 30 天期限影响 |

不上传数据库、保护密钥、Cookie、本机配置或整个 `.local` 目录。Windows 打包会继续收集 npm / NuGet / .NET 许可证，并拒绝混入数据库、私钥与本机配置。

## 标签发布与同提交复用

发布流程接受稳定版 `vMAJOR.MINOR.PATCH` 标签，要求标签提交已在 `main` 的提交历史中。先解析标签实际指向的提交（包括附注标签），校验标签与前后端版本、发行说明一致，再按以下规则查找候选包：

1. 仅查找**该提交 SHA** 对应的 `main` **push** CI；不使用 PR、手动运行或“最新”的其他提交产物。
2. 要求该运行成功、完整基线资格检查 `Release qualification` 成功，并存在未过期的 Windows Artifact。普通文档检查和局部 PR 检查不具备发布复用资格。
3. 如果相同提交的主干 CI 仍在运行，等待有时间上限；查找不到、等待超时、失败、缺少资格或产物过期时，执行完整基线生成新包。
4. 下载后校验 ZIP 的 SHA-256 及包内 `release-info.json`：产品、版本、提交、Windows 自包含目标、干净工作区和 `ciQualification` 均须符合预期。资格字段 `dworkbench-release-v1` 表示构建请求的范围，必须结合实际运行与资格检查成功判断。
5. 使用通过检查的原始 ZIP，生成带版本号的文件名与配套哈希，发布发行说明、独立校验脚本和快速安装文档；不在此时重新编译。

GitHub API 查询异常、标签不合法或下载包校验失败会停止发布，需要先解决错误；这些错误不会被当作“没有候选包”而绕过校验。

普通本地发布脚本默认不写入 CI 资格字段。只通过打包检查的 PR 产物也不能被标签复用。以上流程适用于后续发布，不重建或替换已发布的 v0.1.0。

## 验证边界

短时负载用于发现共享、队列和资源释放回归，不等同于生产容量承诺。完整负载也运行在 CI 的受控夹具上，不连接管理网络中的实际 Linux 主机。

Windows 发布包检查在 Development / SQLite 下启动程序并检查哈希、页面、JS、Worker 和许可证。PowerShell 5.1 检查只解析安装脚本语法；两者都不代表 Windows 服务管理器、组织 HTTPS 证书、PostgreSQL 安装或离线部署已经实测。目标 Windows Server 2022 的部署验收继续按 [部署说明](DEPLOYMENT.md) 执行。
