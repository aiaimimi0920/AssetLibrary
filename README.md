# AssetLibrary

Neuro 的独立资源目录管理与授权分发服务，管理 Art、Capability 和应用包的元数据、版本、用户资源关系与分发资格。账号系统保持独立。

## 当前状态

最新 `.23` 可以直接体验全流程：在本目录运行 **`rtk proxy pnpm trial`**，打开输出的本地地址，用虚构编号 **10001（发布者）→ 10002（审核者）→ 10003（下载者）** 操作，无需账号服务或粘贴 JWT。页面提供示例 ZIP 和停止按钮；启动创建独占本地数据，停止不删除。已实际通过浏览器上传→审核→发布→保存文件→撤销/下架；详见 [本地全流程体验](docs/P5_LOCAL_TRIAL.md)。仅账号签发、AV 和部署准入为明确标识的本地模拟，生产门禁不变；原有真实账号接入按用户要求延期。

最新 `.22` 已按用户授权通过 [同包隔离 Cloudflare 验收](docs/P6_CLOUD_RECOVERY_VALIDATION.md)：十模块原字节部署/读回、九个静态入口、正式 cron 缺表故障及增量迁移恢复、真实 R2 对账、合成身份六状态轮换和成员撤销均有成功证据，持久 Logs 关联实际云版本。最终三个 Worker 的入口/cron 关闭、原公开身份配置恢复，数据和镜像保留；Container 只有一个 inactive 历史逻辑实例，没有活动实例。该切片不是实际账号登录或生产分发验收，完整计划仍未完成，拒绝门禁不变。

`.22` 的本地基线已完成同候选完整 Miniflare/workerd 关闭、复用原 D1/R2 持久目录重开及实际 cron 恢复证明。修正测试 fixture 的持久化字段遗漏；3 项重启和 45 项直接邻近回归通过，重开后状态/回执/审计及 R2 字节保持、旧实例不可用、取消和三次消费终态不复活。见 [P6 完整运行时重启](docs/P6_RUNTIME_RESTART.md)。这是受控本地关闭证明，不是突然崩溃或云灾备验收；生产代码与拒绝门禁未改，真实身份合同和生产退出仍开放。此前 `.21` [Web 上传终态恢复](docs/P5_UPLOAD_RECOVERY.md) 的真实浏览器证据按运行字节匹配复用，不重跑无关矩阵。

`.20` 已实现 P6 脱敏响应事件、只读 `/readyz` 和定时维护故障隔离；uploads/inspections/tickets 各有界执行一次，单阶段失败不饿死后续阶段，部分提交和重叠任务恢复保持审计唯一。operations 15 项及邻近回归 95 项通过，见 [P6 运行观测与恢复](docs/P6_OPERATIONS_RECOVERY.md)。就绪只表示私有依赖可读，不是扫描/生产分发准入；该本地批次当时未部署观测配置，后续 `.22` 已验证同包云配置/采集，不外推保留期、告警、全量采样或费用。真实身份仍缺；以下 `.18` 完整测试/浏览器证据是历史基线，不冒充 `.20` 全套验证。

`.19` 的 P6 固定 RSA 公钥轮换与本地配置恢复保持：静态 JWKS 最多 4 把公钥，精确 `kid` 选择，单钥→重叠→撤旧→可信配置回滚不重建 D1/R2、不改变主体和业务权限。身份合同和操作顺序见 [P6 公钥轮换](docs/P6_IDENTITY_ROTATION.md)。

按用户最新要求，原生组件安全风险与网络边界验收先延期，继续其余业务开发。`.16` 已增加私有 Web 工作区，`.17` 已实现 P3/P4 分发业务核心，`.18` 已补齐公开目录、下载资源库、owner 下载授权/撤销/下架和校验后保存的 Web 入口。完整本地测试 **202 pass / 0 fail / 0 skip**；浏览器在真实本地 D1/R2 上验证了合成身份/扫描、假设部署准入下的 798 字节 ZIP 保存/摘要、取消、损坏拒绝、授权撤销/恢复和下架。生产门禁未改变，真实外部身份、实际生产闭环与 P6 仍未完成。见 [分发 API](docs/P4_DISTRIBUTION_API.md)、[P5 私有 Web](docs/P5_PRIVATE_WEB.md) 和 [P5 分发 Web 验证](docs/P5_DISTRIBUTION_WEB.md)。

已完成 P0 归档、P1 私有资源目录，以及 P2 的 R2 私有对象上传、完成、取消和有界对账。真实本地 Worker/D1/R2 binding 集成测试已通过，P3.3b 另已完成获准的隔离 Cloudflare 运行验收；不是生产部署。上传完成只代表字节完整性，不代表内容检查或审核通过，对象仍不可发布或下载。

P3.1 受限静态 PNG Art 内容检查及可恢复任务已通过本地验收，支持范围、租约和最多三次重试均有明确边界。格式策略 passed 不等于全面内容安全、审核或发布资格；P3 整体尚未完成。

P3.2 增加不可变版本快照、非 owner 的独立审核和 owner 撤回。版本批准是历史决定，当前绑定另行检查；取消或资源 revision 变化不会保留准入。必要内容安全策略缺失时，publish 始终拒绝，不能仅靠格式通过和人工批准开放对象。

P3.3a 增加首期要求的多文件 Art 归档包：一个 manifest 加 1–32 张静态 PNG，支持受限 Stored/Deflate ZIP、安全路径和逐文件摘要检查，接入原有任务、版本与独立审核。`pack:art` 生成带清单的候选 ZIP。结构/格式检查不是恶意内容扫描，发布仍保持拒绝。

P3.3b 增加 `art-zip-clamav-v1` 复合策略及独立 Cloudflare 原生 Container 接线。本地 Docker、Linux 原生链路及隔离云的 clean/EICAR、并发拒绝、绑定取消后恢复、闲置回收/重启均已验证。云主 Worker + D1/R2 完成双 PNG Art ZIP 上传、正式 cron 检查、版本与独立批准；publish 仍返回 `409 SCANNER_CLOUD_NOT_VALIDATED`，没有发布事件。修复镜像中扫描发现的可修复 HIGH；云 API 记录 default policy 和 standard-1 资源配置，但不代表资源/出网/逃逸安全测试均已完成。

此前 P3.3b 验收结束时，三个新 Worker 的 workers.dev/preview 均关闭，主 Worker 的 cron 移除；当时主/probe 外部请求返回 404，scanner 实例列表为空，D1/R2/镜像保留，详见 [历史隔离云验收](docs/P3_CLOUD_SCAN_VALIDATION.md)。最新 `.22` 收尾读回为一个 inactive 历史逻辑实例、零活动实例，以顶部新回执为准。真实身份、生产签名更新周期及沙箱安全边界仍缺，`cloudValidated:false` 和不可发布门禁不变。

P3.3c 增加强制 freshclam 重新执行、不可变候选、完整漏洞门禁和防签名倒退评估。新候选十项真实扫描及 11 项聚焦通过，但完整报告出现此前筛选未覆盖的 1 CRITICAL、55 HIGH、2 UNKNOWN，候选被安全拒绝；未切换云镜像或执行回滚。详见 [签名候选与安全阻断](docs/P3_SCANNER_RELEASE.md)，不把更新查询成功当作生产安全准入。

后续 P3.3d 已修复本地候选的发行版/实际加载库风险：采用固定官方 ClamAV 1.5.4 Alpine 变体和发行版 Node，固定 libxml2、PCRE2、nghttp2 修复包；十项真实 Docker 场景及 30 项聚焦通过。完整 Trivy 报告覆盖实际全部 49 个 APK 包，本次没有漏洞条目，候选可进入后续验收；不是生产安全准入。ClamAV 非 APK 二进制、新镜像云验证及实际切换仍待完成，见 [镜像修复与覆盖边界](docs/P3_SCANNER_IMAGE_REMEDIATION.md)。

P3.3e 新增 [上游来源与源码依赖核验](docs/P3_SCANNER_SOURCE_AUDIT.md)：OCI 构建来源关联固定源码提交，Cargo.lock 内容/Git blob 双重校验，全部 291 个源码包与完整扫描逐项匹配，保留 1 MEDIUM、1 LOW 及 Git 分支来源。官方 SBOM 缺原生组件且构建材料不完整；工具正确返回未取得供应链/云准入，不会将源码报告包装成运行二进制的完整证明。

P3.3f 已完成 [受控 ClamAV 构建与安装身份](docs/P3_SCANNER_NATIVE_BUILD.md)：固定源码及完整材料镜像、断网 CMake/Cargo 构建、实际编译输入/安装产物绑定，并在独占本地镜像中通过 clean/EICAR 与五项引擎二进制摘要核对。1 GiB 探针的真实 OOM 已修正为既有 4 GiB 验收预算，CRLF 导出和 PID 1 超时问题有回归证明。该镜像没有替换活动 scanner，且基础签名库过旧；供应链、云和生产准入仍为 false。

P3.3g 已完成 [受控镜像漏洞与编译包关联](docs/P3_SCANNER_NATIVE_RISK.md)：同一受控镜像的 49 个 APK 包与实际清单完全一致，本次报告无漏洞；291 个 Cargo 包报告保留 1 MEDIUM、1 LOW，并关联到实际 244 个编译包。OneNote fork 确认实际编译，rand 0.9.2 未出现在本次编译清单中；均不自动取得可利用性结论或豁免，原生 C/C++、签名时效和产品/云门禁仍待完成。

P3.3h 已将受控安装结果接入真实 scanner 服务：独占镜像的 daily 从 28136 更新至 28143，十项 Art ZIP/Worker/D1/R2/审核及发布拒绝场景通过，五项引擎二进制与安装摘要一致，完整 APK 报告无告警。未切换活动镜像；原生组件、fork 风险和新镜像云门禁仍待完成，见 [受控引擎运行验收](docs/P3_CONTROLLED_RUNTIME.md)。当前总目标继续覆盖整个 P0–P6，而非只完成一个审计工具。

`.14` 继续补齐原生构建的严格安装身份核验，并完成内置 bzip2 已知整数溢出机制的官方补丁对应和 216 项 sanitizer 动态样本，见 [原生安全复核补充](docs/P3_NATIVE_SECURITY_CLOSURE.md)。这不是完整供应链或生产准入，业务发布/下载仍未开放。

`.15` 修复候选重新评估的十场景核验缺口，逐项复核 EICAR、预算、输入/签名身份、独立批准、发布拒绝和主动断开恢复；不再允许八项占位记录取得候选资格。证据字段与旧回执拒绝边界见 [运行事实核验](docs/P3_SCANNER_RUNTIME_EVIDENCE.md)，生产发布/下载仍未开放。

当前技术方向：

| 组件 | 职责 |
| --- | --- |
| TypeScript / Cloudflare Workers | 主业务 API、权限检查和必要的下载鉴权入口 |
| Cloudflare D1 | 元数据、版本、用户资源关系、状态、审计和幂等事实 |
| Cloudflare R2 | 包体和实际资源对象 |

其他 Cloudflare 服务按业务需要引入，不默认建设复杂服务拓扑。只实现 Cloudflare 接入；简单接口可保留，原生效率优先。不迁移历史数据库，不兼容旧开发版本。

## 开发入口

1. [开发计划](DEVELOPMENT_PLAN.md)：当前决策、业务边界、分阶段工作和退出条件。
2. [开发规则](AGENTS.md)：仓库边界、架构和授权约束。
3. [工程规范](docs/DEVELOPMENT_STANDARD.md)：模块大小、验证和归档隔离要求。
4. [协作流程](CONTRIBUTING.md)：从下一个有界切片开始的工作方式。

5. [P1 API 与数据模型](docs/P1_API.md)：当前已实现的接口、身份和权限边界。
6. [本地工具链](docs/P1_TOOLCHAIN.md)：安装、运行、测试与 Worker 产物。
7. [P1 验收记录](docs/P1_VALIDATION.md)：通过的检查与仍未验收的事项。
8. [P2 API 与对象状态](docs/P2_API.md)：受限上传、流式完整性、取消和补偿边界。
9. [P2 验收记录](docs/P2_VALIDATION.md)：本地 R2、故障恢复与候选产物证据。
10. [P3.1 检查 API](docs/P3_INSPECTIONS_API.md)：受限内容策略、持久任务与准入边界。
11. [P3.1 验收记录](docs/P3_INSPECTIONS_VALIDATION.md)：检查、解压边界、重试及租约竞争证据。
12. [P3.2 版本与审核 API](docs/P3_VERSIONS_API.md)：不可变快照、独立审核、自然幂等和发布拒绝门禁。
13. [P3.2 验收记录](docs/P3_VERSIONS_VALIDATION.md)：完整回归、确定性竞争和最新候选的证据边界。
14. [P3.3a Art 包合同与打包](docs/P3_ART_PACKAGE_API.md)：多文件归档、解压预算、清单、路径和本地工具。
15. [P3.3a 验收记录](docs/P3_ART_PACKAGE_VALIDATION.md)：真实 ZIP 闭环、负向安全和候选身份。
16. [P3.3b 内容扫描合同](docs/P3_CONTENT_SCAN_API.md)：复合策略、实际扫描身份/时效、资源预算和原生接线。
17. [P3.3b 验收记录](docs/P3_CONTENT_SCAN_VALIDATION.md)：真实 Docker、Linux 原生业务链、检测能力与本地工具隔离边界。
18. [P3.3b 隔离云验收](docs/P3_CLOUD_SCAN_VALIDATION.md)：云运行版本/镜像、资源配置、真实 cron 业务闭环、漏洞修复及测试入口关闭证据。
19. [P3.3c 签名更新候选](docs/P3_SCANNER_RELEASE.md)：强制刷新、完整漏洞检查、时效/防倒退、不可变证据及真实安全拒绝。
20. [P3.3d 镜像修复](docs/P3_SCANNER_IMAGE_REMEDIATION.md)：官方 Alpine 变体、实际解析库、完整 APK 覆盖与未完成的生产边界。
21. [P3.3e 源码依赖核验](docs/P3_SCANNER_SOURCE_AUDIT.md)：固定构建来源、Git blob、Cargo 完整清单、Git 分支告警和真实覆盖缺口。
22. [P3.3f 受控原生构建](docs/P3_SCANNER_NATIVE_BUILD.md)：编译材料、实际安装结果、独占运行镜像、故障修复与不可变回执。
23. [P3.3g 原生风险关联](docs/P3_SCANNER_NATIVE_RISK.md)：完整镜像扫描、Cargo 实际编译归属和未完成的风险边界。
24. [P3.3h 受控引擎运行](docs/P3_CONTROLLED_RUNTIME.md)：实际签名更新、服务协议/业务链和原生安装绑定。
25. [原生组件与 fork 调查](docs/P3_NATIVE_COMPONENT_REVIEW.md)：真实内置来源、混合版本、材料字节和未决复核。
26. [P6 完整运行时重启](docs/P6_RUNTIME_RESTART.md)：持久化字段修正、完整关闭/重开、租约/消费/审计和全计划剩余边界。
27. [P6 同包隔离云验收](docs/P6_CLOUD_RECOVERY_VALIDATION.md)：正式 cron/迁移/R2 恢复、合成身份轮换、持久日志、失败保留及最终关闭证据。

```powershell
rtk pnpm install --frozen-lockfile --store-dir C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-pnpm-store
rtk pnpm test
```

测试自行生成临时签名身份，在本地 workerd/D1/R2 完成真实 API 闭环，结束时关闭自己创建的运行时。没有部署可用的认证或故障旁路。`rtk pnpm build` 当前生成包含主/扫描 Worker、九个 Web Text 模块和 scanner runtime 的唯一候选到 `linshi/assetlibrary-p3-*`，标记 `P5-local-trial-and-streaming-web-candidate`；主/扫描 Worker 仅做 dry-run 打包，显式禁止隐式 Container 构建，不需要运行 Docker，不是旧 Rust EXE。`rtk pnpm test:scanner` 独立构建并验证无网络本地扫描容器，结束清理所属容器且保留镜像与证据。`rtk pnpm pack:art <input-directory>` 生成唯一 Art ZIP 候选，不自动上传或取得安全通过资格。

按最新工作顺序，`.19` 公钥轮换、`.20` 运行观测/故障隔离及 `.21` 上传终态恢复已完成本地切片；`.22` 已补完整运行时重启和获准的同包隔离 Cloudflare 恢复/合成身份切片，真实外部账号和完整 P5/P6 退出条件仍开放。以下 **P3.3 生产安全准入** 项保留为生产前待办：原生组件漏洞归属、新镜像完整扫描、新引擎回归与签名时效、新镜像隔离云验收、签名实际切换回滚及资源/网络隔离验证。不手写一份未验证 SBOM 或隐去源码告警补足证明。`.22` 未切换 scanner 镜像，不能替代新镜像的云验证，也不解除生产门禁；当前没有实际成功生产发布或下载，不把合成测试、扫描 clean、格式通过和人工批准等同于生产可分发。不要执行旧 Cargo/Web 命令来代表新项目。

## 历史参考

旧项目保存在 [`old/`](old/ARCHIVE.md)，包括旧源码、旧协议、旧构建/部署/CI、旧开发文档及保留的本地状态。原有 Git 历史仍在本仓库。

`old/` 不参与新项目构建、测试、依赖发现、文档索引或发布。根 `.ignore` 将它排除在默认项目检索之外，但不会将归档源码排除在 Git 之外。旧验收记录不是新实现的验证证据。需要参考时只读取相关文件，不恢复其技术路线或执行流程。

旧环境文件、缓存、运行产物和证据仍由忽略规则保护，不是待提交源码；不得输出其中的秘密信息。
