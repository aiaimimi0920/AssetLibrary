# 平台统一分发与更新验收

当前生产版本为 0.4.10，源码 b37ea47b5d4a2a8250bdbc50a7f7cfae1126b2fb。用户明确同意的 0011 保数据生产迁移及 SpringBok 更新已完成，独立可用性验证通过；四类真实账号更新使用验收仍未完成。下文早期批次的“未部署”仅描述当时状态。

## 生产更新与独立验证（2026-10-17）

- 精确提交 CI 39028333994 的 verify、secret_scan 均通过；已发布 v0.4.10 Release，未部署失败的 v0.4.9 候选。
- 原实例 dc-b20cc87beb7b44c0aa5c73eec88a7292 保数据更新任务 dc-19e119d9a04c411c9481ef3c05936972 返回 deployed-unverified。七项检查均通过，包括 backup-created、data-preserved、deployed-bindings；D1 备份校验、0011 迁移、原记录和 R2 保全检查后部署。
- 独立 verify 任务 dc-8f432ad91f5946f098878286c634b3c6 返回 succeeded，release-identity、private-dependencies、naccount-login-configured、scanner-admission-verified 四项通过。最后一项为历史检查名称，此处验证未扫描分发策略，不代表病毒扫描通过。
- 2026-10-17T11:35:25Z 线上 /healthz 返回 0.4.10 及上述完整 SHA；/readyz 的 identity、database、storage 均 available，distribution 为 available / unscanned-packages / malwareScanning=not_required。
- 回执与截图：C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-v0410-update-ui.txt、assetlibrary-v0410-verify-ui.txt、assetlibrary-v0410-verified.png；独立 HTTP 读回：同目录 assetlibrary-v0410-live-health.json。
- 这些证据确认应用上线与依赖可用性，不代替真实双账号的四类上传、下载、安装及新版实际运行验收。

0.4.9 的精确提交 CI 39027794638 为 366 项通过、1 项失败：SBA 合同夹具仍写死 0.4.8。修正为读取当前 manifest，并增加错误版本拒绝断言；保留原失败标签，不重写标签，不部署失败候选。

2026-10-17 用户新定义：AssetLibrary 是整个平台官方发布和第三方 UGC 的统一分发、版本与更新托管服务，不限于美术素材。
本文件细化根开发计划的验收条件，不新建另一套开发计划。

## 完成标准

Art、Capability、MCP、应用程序各至少一个真实可使用包，分别完成：

1. 发布者 A 上传旧版，经既有业务审核发布，消费者 B 获得下载权限。
2. B 下载并核对不可变包摘要，在实际消费者中安装或接入并产生可观察结果。
3. A 在同一资源下上传、发布新版；B 发现目标版本、下载、安装或切换，再实际使用。
4. 记录旧版/新版 ID、版本和摘要、运行结果；证明运行的是新版而不只是下载了新版 ZIP。
5. 下载失败或权限撤销不能误报更新成功，旧版票据不能用于新版。

应用程序必须是实际可运行程序，不用一个只有 version.txt 的归档冒充应用更新。
Loom 自身更新和较大程序托管属于平台目标；当前 8 MiB/32 载荷封装上限不能据此宣称支持 Loom 完整安装包。

暂停病毒/恶意代码扫描开发和研究；分发结果明确 not_scanned，不伪造 clean/cloudValidated。
摘要、类型、身份、权限、发布者信任和消费者安装/执行约束仍各自生效。

## 本次已实现的资源库增量（已随 0.4.10 上线）

- 新增独立 mcp 资源类型，走既有上传、检查、版本、审核、发布、授权、票据和流式下载。
- mcp-zip-format-v1 使用软件封装；loom-mcp-zip-format-v1 接受原字节 mcp.server.json 原生包。
- 原生 MCP 首期为 stdio，入口须在归档内；平台只验证有界归档与类型标记，不执行载荷、不代替宿主清单和签名验证。
- Web 新增 MCP 类型及两种明确策略；pack:software 支持 MCP，输出格式策略而非推荐已暂停的扫描策略。
- GET /v1/catalog 和 GET /v1/me/library 新增可选 resourceId UUID 筛选；保留 limit/after 分页及每次授权检查。
- 该筛选返回同一资源的发布版本，不将 UUID 顺序或发布时间冒充 SemVer 顺序；更新目标选择及实际激活由消费者负责。
- 授权仍绑定 publication。旧版授权不会自动授予新版；更新下载必须使用新版独立票据。

## 迁移与兼容性

0011_mcp_packages.sql 扩展 resources、inspections、versions 的 CHECK 合同，在单一事务中复制、替换并重建索引。
旧列、旧策略和业务记录保留；不修改已上线迁移。独占 linshi 测试后，经用户明确授权执行生产迁移，保全结果见上文。
上线顺序为备份并核对原库、应用新增迁移、验证保全和外键、部署支持新类型的 Worker，最后开放 MCP 上传。
旧代码不识别 MCP，不允许混用旧实例处理新类型写入。回退应用时保留新增记录和包体，不逆向缩表或删除新数据。
迁移失败回滚和重复执行保全沿用 populated 数据库测试；旧版本/票据/审核/审计逐行核对。

## 验收状态

资源库本地测试采用真实 Worker/D1/R2 和明确的合成账号，不冒充线上双账号或宿主执行。
已补四类同资源双版本分发测试，覆盖两版原字节下载、更新独立授权、有界分页、票据跨版本拒绝和撤销后不可发现。
这些测试包仅用于分发验证，不是四类业务使用验收样例。

既有真实 Art 首次下载/安装/执行证据见 UNSCANNED_DISTRIBUTION_STAGE.md。
新增代码生产部署与独立验证已完成；四类线上真实消费者旧版到新版运行仍未完成。MCP 和便携应用的本地消费者进展见下文。
总验收保持未完成，不以局部测试通过替代用户提出的四类全流程标准。

2026-10-17 本地验证记录（目录均位于 C:/Users/Public/nas_home/AI/GameEditor/linshi）：

- assetlibrary-p3-T68oj0/tests.log：13 项通过，覆盖六种未扫描策略、三项 populated 迁移及四类双版本分发。
- assetlibrary-p3-BMnuVn/tests.log：1 项通过，包含原生 MCP 清单/入口/混装六种拒绝场景。
- assetlibrary-p3-MeVDKI/tests.log：24 项邻近回归通过，包含原生归档、下载授权、Web 和打包器。
- assetlibrary-p3-2oTvd7/tests.log：新增 MCP Web/打包器断言后 15 项通过，和上一批有重叠，不累加为独立测试总数。
- TypeScript 类型检查、17 个变更代码/测试文件的 Biome 检查、源码行数检查及 git diff --check 通过。

未运行真实病毒扫描、容器研究、完整依赖漏洞重扫或桌面 UI 验收；未改依赖和锁文件；未提交、推送、生产迁移或部署。

## MCP 消费端续进

2026-10-17 已接通 Loom 的 MCP 云包安装选择与宿主安装器，并修复 MCP 更新后配置保存失败时 active.json 未回滚的问题。
冲突不再删除候选包家族的历史版本。新调用基于新版配置建立 stdio 会话，不承诺升级瞬间终止正在执行的旧调用。

新增可复验命令（在 AssetLibrary 仓库运行，临时目录及 CARGO_TARGET_DIR 放 linshi）：

```powershell
rtk proxy node scripts/verify-loom-mcp-update.mjs C:/Users/Public/nas_home/AI/GameEditor/Neuro/Loom
```

已实际通过两版同资源上传、格式检查、独立 trial 审核、另一主体授权、Loom HTTP 下载、宿主安装和真实 stdio 工具调用，结果分别为 1.0.0、1.1.0。
证据位于 `C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-ZjqZfM/mcp-update-evidence.json`。
真实部分为服务、传输、包体和宿主进程；身份为合成 trial 主体，扫描未执行，生产未部署。
MCP 本地联合闭环通过不替代四类生产目标；真实双账号最终验收仍开放。

## 便携应用消费端续进

2026-10-17 新增 Windows x86_64 小型便携应用安装。沿用 application-zip-format-v1 软件封装，载荷包含 application.json（schemaVersion、version、platform、entry）及真实 EXE。宿主核对文件清单、大小、摘要、平台和发布版本；按资源 UUID 隔离目录，使用独占版本目录和原子 active.json 切换，保留旧版本，不自动执行程序。

当前封装没有应用签名合同，明确标记 unsigned 并执行宿主已有信任策略；RequireTrusted 等拒绝策略不会被绕过。归档损坏、版本不匹配和信任拒绝测试均验证原活动记录不变。该实现不是 Loom 自身升级器，不支持当前单文件 1 MiB、整包 8 MiB 上限以外的完整桌面安装包。

```powershell
rtk proxy node scripts/verify-loom-mcp-update.mjs C:/Users/Public/nas_home/AI/GameEditor/Neuro/Loom application
```

实际通过隔离 Worker/D1/R2 的同资源双版本上传、格式检查、独立审核、另一主体授权及 Loom HTTP 下载、安装、EXE 运行。TextNormalize 1.0.0 将输入 `  alpha  beta  ` 变为 `alpha  beta`，1.1.0 变为 `alpha beta`，并验证旧程序仍存在。
证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-IFfvbt/application-update-evidence.json`。身份仍为 trial 合成主体，未执行病毒扫描，未生产部署。

本轮聚焦回归：Loom cloud_install 8 项通过、1 项要求真实签名 Art 环境的测试跳过；桌面安装服务 4 项通过，TypeScript 和前端构建通过。前端构建不等于生成或替换正在运行的 Loom.exe，也不等于桌面 UI 人工验收。

## Capability 双版本实际执行

2026-10-17 已实际通过真实本地 Worker/D1/R2、独立 trial 发布/审核/下载主体、libaria2 下载、签名检查、安装与权限批准，再启动两版 Capability 进程。进程输出分别为 1.0.0、1.1.0，包摘要不同；新摘要未经批准时拒绝启用或升级。第二版走宿主 upgrade 路径，不以清单版本替代进程运行证据。

证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-hktmyS/capability-update-evidence.json`，含两版发布 ID、包摘要、下载回执及实际执行结果。`cloudVerified=false`、`syntheticIdentity=true`、`malwareScanning=not_performed`；不等于真实账号生产验收或桌面交互通过。

可复验入口为 `scripts/verify-loom-mcp-update.mjs <Loom绝对路径> capability`；先显式运行 Loom 的 ignored 测试 `cloud_generate_capability_update_fixture`，将新建隔离目录传入 `LOOM_CLOUD_SIGNED_FIXTURE_ROOT`。规范打包器重新封装生成目录中的签名原字节，不放宽 ZIP 属性校验。

本轮上线前聚焦回归 29 项通过，包含 populated 迁移失败回滚及重复执行保全、四类双版本分发、MCP 原生包、未扫描策略和 Web/打包器；日志 `C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p3-uOePmJ/tests.log`。

## libaria2 下载引擎联合验证

2026-10-17 按用户要求将 Loom 下载执行改为进程内 libaria2 DLL，不再启动 aria2c.exe。固定 DLL 的应用和 MCP 两版实际下载、安装及执行重新通过，证据明确记录 downloadEngine=libaria2：

- 应用：C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-OiQLLJ/application-update-evidence.json。
- MCP：C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-YZs9rJ/mcp-update-evidence.json。

两份证据均保留 cloudVerified=false、syntheticIdentity=true、malwareScanning=not_performed。没有恢复病毒扫描，也未执行生产迁移或部署。原生引擎另有真实分段、进度、暂停/继续、取消及卸载测试；暂停/继续尚未接入客户端 UI。DLL 约 2.09 MB，仅引擎文件比此前 EXE 约小 63%，不代表整个安装包或实际下载速度的改进幅度。

实现、构建与未完成发行项见 Loom/docs/ARIA2_DOWNLOAD_ENGINE.md；未交付新桌面程序，四类线上完整更新验收仍未完成。

2026-10-17 后续批次已生成非正式 Loom debug 验收包并接通下载控制，详情见 Loom/docs/LIBARIA2_DELIVERY_VALIDATION.md。依赖迁移后的最新实际 libaria2 联合验证仍通过：应用证据为 C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-00u87n/application-update-evidence.json，MCP 证据为 C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-S2UGH1/mcp-update-evidence.json。两者仍为 syntheticIdentity=true、cloudVerified=false、malwareScanning=not_performed，不替代线上四类最终验收。
