# AssetLibrary 新项目开发规则

## 当前方向与仓库边界

新版 [GitHub CI](docs/CI.md) 已建立候选，仅验证活动 Worker 项目及当前提交的秘密变化；不执行 `old/` 工作流，不部署云资源。GitHub 实际运行和分支保护须独立核验，不能用本地通过冒充远端绿色。

最新 `.25` 补齐 [资源管理页面操作](docs/P5_RESOURCE_MANAGEMENT.md)：owner 可从当前资源改名、关闭、查询并授予/撤销指定主体的目录读权限；读取绑定当前资源 revision，变更仍走原有幂等/CAS/审计，成员不能取得管理或包体下载权限。身份切换清除资源管理状态和资源标题草稿。已在独占本地体验中验证，账号系统、云部署和生产准入保持原边界；新版 CI 和 Capability/应用包包体闭环仍是后续独立任务。

最新 `.24` 增加独立审核待办 `GET /v1/reviews` 和 Web“读取审核待办”，见 `docs/P5_REVIEW_QUEUE.md`。部署名单每页重查，仅显示他人活动待审核版本；UUID 有界分页、禁止自审、绑定校验、CAS/审计和生产门禁保持。`0007` 仅新增队列索引，未迁移云库。用户已明确授权提交推送，`.23` 重建基线已发布至独立 main（`f2597a5`），继续开发时不涉及账号系统或兄弟仓库。

最新 `.23` 按用户新要求暂不接真实账号，提供 `pnpm trial` 虚构编号本地全流程入口，见 `docs/P5_LOCAL_TRIAL.md`。编号 10001/10002/10003 分别演练发布、独立审核和下载，真实 Web/权限/D1/R2/格式检查/流式分发保留；账号签发、AV 和部署准入只在独占回环体验器中模拟，不进入生产 Worker。真实浏览器已完整保存 798 字节 ZIP 并验证撤销/下架，修复了缺少 Content-Length 的合法流被前端拒绝及 HTML pattern 语法错误。账号方案等待后续决定，不再阻塞本地业务体验；生产安全与完整 P3–P6 退出仍未通过。新入口不得部署公网或复用真实账号/生产数据。

最新 `.22` 已在用户明确授权后通过同包隔离 Cloudflare 观测、恢复与合成身份轮换切片，见 `docs/P6_CLOUD_RECOVERY_VALIDATION.md`。十模块原字节、九静态入口、正式 cron 缺表/增量迁移恢复、真实 R2 HEAD 对账及六状态公钥配置均有独立证据，持久日志关联到实际云版本。最终三个 Worker 的入口/cron 关闭，原公开身份配置恢复，D1/R2/镜像和测试数据保留；Container 保留一个 inactive 历史逻辑实例，没有活动实例。该切片不等于真实账号、完整 P6 或生产分发通过，生产准入仍拒绝，总目标保持全 P0–P6。

`.22` 的本地基线已补齐完整运行时关闭、原 D1/R2 目录重开与 cron 恢复，见 `docs/P6_RUNTIME_RESTART.md`。首轮真实发现 fixture 只设 isolated 路径未持久化 D1/R2，已据安装源码修正 resourcePersistencePath；3 项重启和 45 项邻近通过。重开不建 Schema/重置消费，取消和三次耗尽不复活，旧实例/workerd 确认关闭；不冒称突然崩溃或云灾备。生产代码/门禁未改，真实身份合同、延期安全项及生产退出仍开放。

此前 `.21` 已完成 Web 上传终态恢复，见 `docs/P5_UPLOAD_RECOVERY.md`；ID 绑定、历史同摘要隔离、取消和分页证据保持。

`.20` 增加 P6 脱敏响应事件、只读 `/readyz` 和三阶段有界维护故障隔离，见 `docs/P6_OPERATIONS_RECOVERY.md`。operations 15 项与邻近 95 项通过；阶段 completed 不等于扫描 passed 或积压清空，就绪不等于生产分发。该本地批次当时未部署观测配置；后续 `.22` 同包云配置/采集和恢复以顶部新回执为准，不外推保留期、告警、全量采样或费用。`.19` 固定公钥轮换合同保留，见 `docs/P6_IDENTITY_ROTATION.md`。真实外部身份仍缺，继续遵守下文延期安全项和外部操作授权边界。

用户最新要求暂缓原生组件安全风险与网络边界验收，先推进其余计划。按此调整开发顺序，不重复扩大这两项调查，也不将延期写成通过或关闭生产门禁。`.16` 已新增实际私有 Web 入口，`.17` 已实现 P3/P4 分发业务核心，`.18` 已补齐公开目录、下载资源库、owner 授权/下架和校验后保存的 Web 交互，见 `docs/P5_DISTRIBUTION_WEB.md`。完整本地测试 202 项通过，真实浏览器验证明确使用合成身份/扫描及假设准入的本地 D1/R2。生产发布与分发仍硬拒绝，真实外部身份、P5 生产闭环与 P6 未完成；总目标保持全计划。

AssetLibrary 是独立 Git 仓库。当前从零开发 TypeScript + Cloudflare Workers + D1 + R2 版本，唯一开发计划是根目录 `DEVELOPMENT_PLAN.md`。

只修改本仓库。未经明确跨项目授权，不修改 Neuro 根仓库、Hook、Loom 或其他兄弟仓库，不通过父仓库代替本仓库提交。

开始开发前阅读：

- `DEVELOPMENT_PLAN.md`
- `docs/DEVELOPMENT_STANDARD.md`
- `CONTRIBUTING.md` 和 `README.md`
- 当前修改子系统的新架构、API 或验收文档（存在时）

P0 历史归档、P1 私有资源目录/成员读权限及 P2 私有上传/取消/对账已实现并通过本地 Worker/D1/R2 验证。当前推进 P3；内容检查和审核已有本地及隔离云切片证据，生产发布、下载、真实身份接入仍未完成，不能把 quarantined 或局部结果外推为整套产品完成。

P3.1 可恢复内容检查任务和受限 `art-png-rgba8-v1` 格式策略已完成本地验收。P3.2 增加不可变版本、配置名单中的独立审核及 owner 撤回，发布门禁始终拒绝缺少必要内容检查的对象。PNG passed 和人工批准都不能自动取得发布资格。

P3.3a 实现多文件 `art-zip-manifest-v1` 受限 ZIP 检查及 `pack:art` 工具，包内仅支持 1–32 张静态 PNG 和一个明确清单。首期必须支持多文件归档，不以单张 PNG 替代。合同和证据见 `docs/P3_ART_PACKAGE_API.md`、`docs/P3_ART_PACKAGE_VALIDATION.md`。

P3.3b 已形成复合 `art-zip-clamav-v1`、内部原生 Container 接线及真实无网络 Docker AV/版本拒绝切片，合同和边界见 `docs/P3_CONTENT_SCAN_API.md`、`docs/P3_CONTENT_SCAN_VALIDATION.md`。仅支持预验证的受限 ZIP，不能将 ClamAV exit 0 当作任意归档完整扫描保证。旧格式事实不升级或重置。

Linux 本地原生 service binding → DO → Container 及主 Worker/D1/R2 业务链已验证，修正了 workerd 不支持 redirect:error 的实际缺陷。本地 scanner 的工具权限/动态宿主端口不作为生产沙箱证明。随后根据用户对 Cloudflare 凭据及隔离验收的明确授权，完成云端九项 native 场景和多文件 Art 上传/真实 cron/版本/独立批准/发布拒绝；远端确认 default policy、0.5 vCPU、4 GiB、8 GB、max_instances=1。修复镜像扫描发现的可修复 HIGH，保留筛选范围及未覆盖项。新建 Worker 的 workers.dev、preview、cron 均已关闭，D1/R2/镜像保留；证据见 `docs/P3_CLOUD_SCAN_VALIDATION.md`。

P3.3c 增加强制 freshclam 缓存失效、不可变候选/完整漏洞检查及防签名倒退的重新评估，命令与历史拒绝证据见 `docs/P3_SCANNER_RELEASE.md`。当时 Debian 候选完整扫描有 1 CRITICAL、55 HIGH、2 UNKNOWN，被安全拒绝；不沿用 `--ignore-unfixed` 作为生产准入。

P3.3d 已将本地候选改为固定 digest 的官方同版本 ClamAV 1.5.4 Alpine 镜像，使用发行版 Node/libxml2/PCRE2/nghttp2 修复包。十项真实无网络 Docker 场景和 30 项聚焦通过，Trivy 的全部 49 个 APK 包与实际容器清单逐项匹配、报告无漏洞；仅允许进入后续验收。详见 `docs/P3_SCANNER_IMAGE_REMEDIATION.md`。ClamAV 非 APK 二进制供应链尚未完整覆盖；云中保留的旧镜像没有因此切换或取得新准入。签名仍为 daily 28143，没有实际新签名切换/回滚或自动定时更新。

P3.3e 新增 `scanner:source-audit`，从不可变镜像的 OCI provenance 追溯 compiler image 和固定源码提交，双重校验 Cargo.lock 并对实际全部 291 个源码包扫描。源报告有 1 MEDIUM、1 LOW；Git 分支来源单独保留，不把名称/版本匹配当作运行可利用性。官方 SBOM 缺原生组件、构建材料标记不完整，源码扫描不能证明运行依赖完整，所以供应链和云准入仍拒绝。见 `docs/P3_SCANNER_SOURCE_AUDIT.md`。

云运行、APK 镜像修复和源码补充核验均不等于生产安全准入。剩余安全与云验收按顶部最新顺序延期，不能靠手写 SBOM 或忽略告警补绿。clean 当前有效也硬拒绝 `SCANNER_CLOUD_NOT_VALIDATED`，`cloudValidated:false`，无发布开关；`.17` 的业务表和代码不改变这一门禁，P3 尚未完成生产验收。手动开发库仍为 `../../linshi/assetlibrary-p33b-local`；本地和云验收各用独占状态，旧库完整保留。普通 Worker 打包显式使用 `--containers-rollout none`，不需要 Docker；真实 AV 检查独立用 `pnpm test:scanner`，仅清理所属随机标签容器，保留镜像和数据。

P3.3f 已完成本地受控 ClamAV 1.5.4 构建身份切片，见 `docs/P3_SCANNER_NATIVE_BUILD.md`。固定 tree 的 1,438 文件、291 个 Cargo 解析包、244 个实际编译 Rust 包、908 个原生输入及 36 个安装项已绑定至材料/运行镜像；4 GiB 独占无网络容器通过 clean/EICAR 和安装摘要核对，随后回收。保留 Windows CRLF 转换事实、首次 1 GiB OOM 和旧 daily 28136 警告。构建身份通过不等于漏洞或签名时效通过，不替换活动 scanner、不改变云/发布门禁。下一项为原生漏洞归属、完整新镜像扫描、签名时效、新引擎业务回归及后续隔离云验收。

P3.3g 增加 `scanner:native-risk`，验证同一受控镜像全量 49 个 APK 包及 291 个 Cargo 包报告，并与 244 个实际编译包关联。OneNote fork 的 MEDIUM 告警确认实际编译，rand 0.9.2 的 LOW 未在本次编译记录中；两项仍保留且不自动豁免。原生 C/C++ 覆盖、签名时效、业务回归与云准入仍缺，详见 `docs/P3_SCANNER_NATIVE_RISK.md`。活动扫描镜像、业务运行代码和拒绝门禁未变。

当前用户目标是完成整个 P0–P6 计划，不能把单轮 P3 工具切片重定义为总目标完成。P3.3h 已通过受控安装引擎的十项本地服务/业务场景，独占候选签名从 daily 28136 更新至 28143；活动镜像和云资源未切换，发布仍拒绝。原生组件/OneNote fork 复核继续推进，记录见 `docs/P3_CONTROLLED_RUNTIME.md` 和 `docs/P3_NATIVE_COMPONENT_REVIEW.md`；P3 发布/下架、P4–P6 仍是实际未完成项。全计划目标不自动授权提交推送、云变更或删除数据。

`.14` 修复原生构建核验未复用严格安装身份规则的遗漏，所有引擎身份入口共用 `scripts/scanner-native-installation.mjs`。内置 bzip2 CVE-2010-0405 已完成官方 1.0.5/1.0.6 修复对应和 216 项原始解码器 sanitizer 样本，详见 `docs/P3_NATIVE_SECURITY_CLOSURE.md`。未改变业务运行字节或活动镜像，其他原生组件和生产准入仍待完成。

`.15` 修复候选重新评估只检查两项 clean/案例数量的遗漏；十项场景须逐项复核原始事实，审核后/发布拒绝后版本、审计、实际 client abort 和 clamscan 清理均持久记录。旧缺字段回执不得回填或视为新合同通过，详见 `docs/P3_SCANNER_RUNTIME_EVIDENCE.md`。不关闭 ClamAV 解析器，不改变生产发布门禁；全计划仍未完成。

## 架构约束

- 主业务使用 TypeScript Workers；D1 保存结构化业务和授权事实；R2 保存文件字节。
- 当前只实现 Cloudflare 接入。配套服务按实际需要引入，不延续历史组件拓扑。
- 领域模型和纯业务尽量不依赖平台类型；简单接口可保留，但不建设多云框架、第三方适配器、空 provider 或通用 ORM。
- 抽象影响效率、限制原生能力或增加无必要复杂度时，直接使用 Cloudflare 原生接口。
- 不迁移历史数据库，不继承旧表和旧迁移脚本；开发期不兼容旧开发版本。
- 当前版本仍需保持权限、状态、幂等、审计和并发一致性；D1/R2 跨服务副作用按阶段、重试和补偿设计。
- 账号服务独立，只接受外部可信身份和不透明 `PrincipalRef`；不建立注册、密码或 MFA 数据。
- 隔离对象私有，未经必要校验和审核不得发布。下载检查当前准入和撤销状态，文件流不得整包缓冲。
- 重检查任务须验证普通 Worker 限制；确有需要时再设计 Cloudflare 内的隔离执行，不因从零开发省略安全验证。
- 自动更新、宿主安装、收费和多云支持不是首个切片的目标。

## 历史目录

`old/` 是静态历史参考，不是新项目的源码根、工作目录、运行依赖或当前开发规范。

- 默认不读取旧项目；需要理解特定业务时，只读取相关历史文件。
- 不在 `old/` 增加新业务，不运行其构建、部署、CI 或历史开发流程。
- 旧开发指令原文为 `old/AGENTS.legacy.md`，不得作为当前规则。
- 新构建、格式化、lint、typecheck、测试、行数检查、活动依赖发现、文档索引和打包使用新源码白名单，并排除 `old/**`。
- 缓存键只使用活动锁文件；秘密扫描不因旧源码排除而关闭。
- 实际复用旧代码时按新代码重新审查和验证，不继承旧绿色结果。

## 工程要求

- 所有新增和修改文本使用 UTF-8 无 BOM；解释和文档使用简体中文，标识符、命令和日志原文不改。
- Windows 默认 PowerShell；外部可执行程序按当前 RTK 规则运行。临时脚本、测试和证据优先放 `C:/Users/Public/nas_home/AI/GameEditor/linshi`。
- 文件目标约 150 有效代码行；100–250 推荐，251–500 保持单一职责，501–700 必须记录理由和保护测试。新增超过 700 行不可作为完成状态，超过 1500 行无条件拆分。
- 不用 `common/utils/helpers` 巨型文件、压缩代码或字符串封装规避行数规则。
- 为新增行为及权限、并发、失败、重试、取消、资源清理补充聚焦测试。
- 检查输入边界、参数化 SQL、秘密信息、无界查询/集合、阻塞路径和对象生命周期。
- 代码实现后运行实际配置的 formatter、聚焦测试、直接类型/编译检查、行数和适用安全检查，以及 `git diff --check`。
- 尚未配置的运行命令不得假装可执行；纯文档整理不需要构建旧 Rust EXE 或容器。
- 分别报告计划、实现、本地验证、Cloudflare 验收和部署状态，未运行不算通过。

## 授权边界

不擅自提交、推送、部署、配置真实凭据、开通付费服务、修改外部账号或清空本地/云端数据。历史数据库无需迁移不等于获得删除权限。

`linshi` 外涉及删除、清空或格式化的高风险操作，先解释并等待用户明确回复“同意”。移动必须核验源和目标的绝对路径，不覆盖目标，不处理链接指向的目录外内容。

子代理仅用于有价值的只读检索或交叉核验；使用 `agent_type = "default"`、`fork_turns = "none"`，任务自包含，最多同时 6 个，不撤销他人工作。
