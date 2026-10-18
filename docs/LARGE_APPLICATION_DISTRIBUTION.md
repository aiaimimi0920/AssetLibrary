# 大型应用包分发实施与保数据迁移

本文件细化 DEVELOPMENT_PLAN.md 的统一分发目标，不建立独立开发计划。

## 授权与当前状态

2026-10-18 生产升级已完成：用户恢复 SpringBok 会话后，以 `vmjcv666@gmail.com` 对应账户在原实例升级到固定 `v0.4.12 / 9a66309fc4dc776480d7bdbad95f4baa620cf491`。更新任务 `dc-e329020c0aef499bb8b67cb2101c58f1` 的七项检查通过，包含 `backup-created`、`data-preserved`、`deployed-bindings`，0012 随固定版本迁移链应用。部署执行 [39099963419](https://github.com/aiaimimi0920/SpringBok/actions/runs/39099963419) 成功，原实例、D1 和 R2 保留。随后独立验证任务 `dc-83903254b69740be9b1e50b62dd54164` 返回 `succeeded`、四项通过，见 [39100106020](https://github.com/aiaimimi0920/SpringBok/actions/runs/39100106020)。下段登录阻塞已经解除，保留为先前停点。

本机独立无凭据读取 healthz、readyz、auth/session：线上版本及 SHA 精确匹配，identity/database/storage 均 available，distribution 为 `available / unscanned-packages / malwareScanning:not_required`，匿名 principal 为 null。历史检查 ID `scanner-admission-verified` 在当前路径只验证分发状态，不代表执行病毒扫描。浏览器已读到新版四类包文案及 96 MB 大包说明；双账号完整大包业务、新版原生 UI、运行中 Loom 自更新和正式组合源码仍未完成，不能据此结束全部验收。

账号操作约束：SpringBok 发布账户只有 `vmjcv666@gmail.com`；NAccount 双账号业务测试可使用 `vmjcv666@gmail.com` 与 `vmjcv111@gmail.com`。不得将两者登录权限混同。

2026-10-18 续进：测试运行器日志缓冲故障已修复，固定提交 `9a66309fc4dc776480d7bdbad95f4baa620cf491` 的完整 GitHub CI 382 通过、0 失败、1 跳过，verify/secret_scan 成功；Windows 业务回归 286 通过、0 失败、1 跳过。已发布 [v0.4.12](https://github.com/aiaimimi0920/AssetLibrary/releases/tag/v0.4.12)，标签及发布页绑定该提交。发布不等于上线：SpringBok 原标签页刷新后进入 Cloudflare Access 验证码登录，尚未恢复会话，未发起生产升级、未执行 0012 生产迁移。运行中自更新、原生 UI 与正式组合源码边界仍按下文保留。

用户已对本次新的生产保数据迁移及配套上线明确回复“同意”。允许调整 uploads、inspections、versions 的大小及策略约束；执行前必须备份、验证保全与失败回滚，保留业务记录和 R2 文件。此前 0011 授权不作为本次授权来源。扫描器开发、研究和病毒扫描继续暂停。

已新增本地候选 `db/0012_large_application_packages.sql`，未应用生产。新策略命名为 `application-large-zip-format-v1`，仅 application 可用；包体预算 96,000,000 字节，覆盖当前约 80 MB 的 Loom 包。不是无限尺寸，也不宣称已支持超过此预算的文件或 multipart。

后续本地实现已接通：application 超过原 16 MiB 上传预算时仍检查 owner/draft/type；新策略采用顺序 ZIP 解析和原生 DigestStream，校验 local/central/EOCD、CRC、清单逐文件摘要与整包摘要。最多 64 个载荷，单文件 128 MiB、总解压 256 MiB、清单 32 KiB、路径 180 字节、压缩比 100；既有小包解析器和预算不变。Web 新增大型应用策略并按策略校验上传/下载预算，Range 单段仍最多 256 KiB。浏览器端摘要仍在有界预算内汇集文件，不能称浏览器零缓冲。

## 兼容与发布顺序

- 不改写已应用迁移；0012 在一个 D1 batch 内复制并替换三张表，恢复全部索引。资源、审核、授权和审计记录不重置，R2 文件不搬移或删除。
- 旧检查策略仍保持 8 MiB，PNG 保持 1 MiB；只新增应用策略获得扩大预算。新策略 passed 仍要求软件包 schema、application kind、原摘要和 not_scanned，禁止出现 scan 字段。
- 当前生产运行代码仍拒绝新策略和超旧预算上传；本地候选已接通服务端及 Web 策略。必须完成 Loom 下载及文件式安装后，才发布应用代码并执行生产升级；不能仅放大常量，仍整包分配内存。
- 部署按现有 SpringBok 流程：R2 见证、D1 私有备份及回读摘要、迁移、原记录/外键/R2 保全检查、发布、独立 verify、双账号真实大包业务验收。
- 迁移事务内失败须完整回滚。迁移成功后升级失败不能称自动回滚；保留扩展 schema 和备份，按真实部署回执处理 unknown，不盲目重放。
- 新大包记录产生后，不把旧预算 schema 直接覆盖回来。旧应用对新策略拒绝属于保守兼容行为，不是新包可用性保证；生产恢复须先只读核对快照、版本与数据，再选择前滚或经确认的备份恢复。

## 已有验证

本地真实 D1 测试确认 0009–0012 四个迁移分别保留既有发布、检查、版本、票据和审计；批次尾部注入错误后原子回滚；成功及重复迁移不改变原事实，外键检查为空。

新 schema 聚焦测试确认：80,423,635 字节新应用策略可入库；96,000,001 字节被拒；旧应用格式/扫描策略不能承接大包；错误 kind、schema、摘要、clean 状态或 scan 字段不能写成 passed。这里只证明数据库约束，不是实际上传或检查通过。

测试日志在 linshi/assetlibrary-p3-XeVtT3/tests.log 与 linshi/assetlibrary-p3-2ZVuOR/tests.log。

后续真实本地 Worker/D1/R2 测试已完成 80,000,000 字节随机载荷的 ZIP 上传、检查、独立审核及未扫描发布，另验证 47 文件 Deflate；这是有真实字节的测试包，不是真实 Loom 可执行包，也不是公网身份验收。单次本地检查约 1.7–2.1 秒，不作为生产吞吐量或峰值内存证明。

故障注入发现并修正：原生解压器会重包装上游读取错误，单靠 instanceof 不能保留临时故障。现在通过归档流本地失败记录区分 R2 读失败与损坏 Deflate；stored/deflate 读取中断均 queued，恢复读取后 passed；真实非法 Deflate 保持 rejected。ZIP 中央目录差异、CRC 损坏、尾随数据和错误文件摘要均拒绝。故障注入仅装配在测试 Worker，不进入生产产物。首轮失败日志保留于 linshi/assetlibrary-p3-d68PNZ/tests.log；修复后的 16 项测试日志位于 linshi/assetlibrary-p3-1bjgSw/tests.log。

后续客户端进展见下节；实际 Loom 大包包装及两版联合验收、生产备份/迁移/上线仍未完成，当前没有包含本次改动的新交付客户端 EXE。

最终聚焦复测：6 文件 33 项通过（大型流式检查、Web 大包预算、上传策略、下载、Range、续传）；日志 linshi/assetlibrary-p3-2m1LJR/tests.log。类型、Biome、Worker 构建、行数及 diff 检查通过。旧 Range 上限测试和策略选项断言已按独立大包合同更新；旧小包超限拒绝仍保留，不通过删除保护测试获得通过。

## 2026-10-18 Loom 文件式安装增量

Loom 下载元数据仅对 application 与新策略的精确组合放宽到 96,000,000 字节。安装准备持有下载文件句柄，分块复验 SHA-256；Windows 拒绝并发写入/删除，不把大包载入 bytes。文件式 ZIP 安装复用既有路径、链接、碰撞和解压保护，逐文件摘要改为流式读取。桌面安装入口接受新应用策略，其他资源不能借此扩大预算。

本地安装测试 10 项通过、2 项专用场景默认忽略：包括两版含 80,000,000 字节载荷的应用 ZIP、真实 EXE 运行差异与旧版本入口保留，以及大文件锁定、篡改拒绝和旧策略拒绝。下载/控制测试 5 项通过、1 项独立 Worker 场景默认忽略；共享 ZIP 保护 6 项通过；桌面服务 4 项与 TypeScript 类型检查通过。这不是完整 Loom 程序的自更新验收。

真实固定 libaria2 DLL 专用测试已增加 80,000,000 字节分段下载与逐字节验证，连同暂停、继续、取消、正常卸载一并通过。初次大流量测试发现 Windows 接受的 socket 继承非阻塞模式，write_all 返回 os error 10035；测试服务与生产 relay 均改为显式阻塞模式，并保留原有读写超时。未增加 DLL 权限或改变固定摘要，未扩大 75 秒下载截止时间。

## 完整 Loom 包联合验收与新开发交付

`pack:software <input-directory> --large-application` 已接通大型应用封装。显式模式仅接受 application、最多 64 个载荷，包体不超过 96,000,000 字节；旧调用预算保持不变。按条目选择 Deflate 或 Stored，压缩比超过 100 的文件退回 Stored，避免自己产生格式检查必拒的归档。打包器是有界本地 Node 工具，不宣称它与 Worker 一样不整包缓冲。

完整旧开发载荷的首次联合验收通过，包体 80,150,741 字节、41 个载荷，证据位于 `linshi/assetlibrary-local-trial-iqqN58`。随后从当前工作区重新构建 desktop 与 daemon，构建前导出 1,548 文件源码快照，构建后逐文件对照成功；完整模块沿用已验证的前次开发包，DLL 固定摘要未变。

新开发目录：`linshi/Loom-large-dev-20261018-v1`。新资源库封装：`linshi/assetlibrary-software-package-h0R5YF/package.zip`，80,166,238 字节，SHA-256 `922b112abae075dc433d7737f905b17f2b5526143e70e3c27c796079e3475efb`，版本标签 `0.2.2-dev.20261018-large`。源码快照位于 `linshi/loom-large-source-20261018-v1`，build-receipt.json 绑定源码清单与载荷摘要。它是 debug 开发交付，不是正式对应源码发行。

新包已通过真实本地 HTTP→Worker/D1/R2 上传→流式格式检查→独立审核→发布→消费者授权→固定 libaria2 下载→当前文件式安装→包内 daemon --version。测试断言 downloadEngine=libaria2、下载摘要等于输入封装、archive 有句柄且 bytes 为空；安装中保留未扫描事实。证据：`linshi/assetlibrary-local-trial-zC8P9q/large-application-evidence.json`、同目录 consumer 日志及 `linshi/loom-daemon-contract-cloud-complete-loom-63092-1/installation-evidence.json`。身份是隔离合成主体，不是生产双账号验收；未启动桌面窗口或替换当前用户实例。

初次网络联合测试发现 trial 的 16 MiB HTTP 前置预算拒绝大包；新增只在专用验证入口显式启用的大包选项，仅 PUT 上传 content 路由放宽，正式 Worker 仍独立核验类型/owner/预算。默认 trial 行为不变。打包与大包检查 6 项通过，旧软件/Art 打包与默认 trial 15 项通过；类型、Biome、构建、有效行数和 diff 检查通过。

完整 Loom 包同资源双版本升级现已本地通过，见下节。仍未完成：生产 0012 备份/迁移/部署及双账号大包验收、运行中 Loom 自更新的退出/替换/重启/失败恢复、原生 UI 全路径和正式完整对应源码交付。不得把本地新开发包标记为正式发行。

## 开发版全量回归与同资源更新

AssetLibrary 非 scanner-* 业务测试 284 项：283 通过，1 个指定完整包测试默认跳过；完整包专用联合测试已另行显式运行通过。全量日志为 `linshi/assetlibrary-p3-kHikzc/tests.log`。Loom daemon 完整库测试 573 通过、9 个专用测试默认忽略；桌面前端 248 项通过，TypeScript 类型通过。未恢复扫描器开发或运行原生病毒扫描。

在同一个资源下发布旧完整包 `0.2.2-dev.20261018` 与新完整包 `0.2.2-dev.20261018-large`，两版均经过独立审核、授权和 libaria2 下载；同一安装数据根先后安装、运行各自 daemon，确认资源 ID 一致、包摘要不同、新旧 daemon 字节不同、旧入口仍保留。回执位于 `linshi/assetlibrary-local-trial-5RGoA7/large-application-evidence.json`；实际安装记录位于 `linshi/loom-daemon-contract-cloud-complete-loom-11792-1/installation-evidence.json`。首轮与完整回归并发时链接器因测试 EXE 被占用返回 LNK1104，等待旧测试退出后串行重跑通过，原失败记录保留。

已准备应用版本 0.4.12 候选元数据；这不是已上线。新版原生桌面独立启动命令被工具策略拒绝，未执行、不绕过；旧 Loom 窗口能通过原生工具读取，不将旧窗口当作新版 UI 通过。

## 已核实的平台约束

Cloudflare Workers 单 isolate 内存为 128 MB，必须避免整包缓冲；原生 crypto.DigestStream 支持不保留载荷的流式摘要。请求体上限取决于账户计划，不能由 Workers 代码任意提高。本切片采用低于 100 MB 的单请求预算；更大包需要后续明确 multipart 合同。

官方依据：https://developers.cloudflare.com/workers/platform/limits/ 与 https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ 。
