# AssetLibrary 开发计划

状态：P0-P5 核心链路与 P7 Loom/CLI 已通过本地门禁；P6 Web/Console 切片已实现，P5 云验收、跨产品接入及 P6/P8/P9 总门禁未完成

版本：0.1

最后更新：2026-09-04

## 1. 目标与边界

AssetLibrary 是一个独立 Git 仓库，用于向 Neuro 用户提供 Art 包、能力包，
并为未来的 Hook/Loom 应用更新提供可信制品分发基础设施。

首批客户端是：

- Web 浏览器；
- Loom 商店访问和安装流程；
- 后续 Hook 集成；
- Publisher CLI；
- 后续独立更新客户端。

本计划的目标不是先做一个临时原型再替换技术，而是从第一版就使用最终协议、
最终存储模型和可水平扩展的服务边界。开发环境可以使用本地兼容实现，但不得
把临时 SQLite、本地文件下载、API 代理大文件或 PostgreSQL 队列写成产品路径。

### 1.1 明确不属于 AssetLibrary 的职责

账号服务是独立系统。本仓库不实现：

- 注册、登录和密码；
- OAuth/OIDC 身份供应商本身；
- 密码找回和 MFA；
- 全局会话生命周期；
- 账号风险引擎；
- 账号数据库。

AssetLibrary 只验证外部账号服务提供的身份凭证，并在自己的领域内判断：

- 该主体是否属于某个 Publisher；
- 是否具有 Publisher Owner、Maintainer、Reviewer、Moderator 等商店角色；
- 是否可以上传、提交、审核、发布、撤销或下载某个制品。

开发阶段使用显式的 Development Identity Adapter 提供一个固定有效主体。
该适配器只能在开发环境启用，不能通过请求头或客户端字段任意伪造主体，
也不能在业务逻辑中为开发主体设置永久超级权限。

### 1.2 首批功能范围

首批必须覆盖：

1. Publisher 和成员授权；
2. Art Package 和 Capability Package 目录；
3. Package 和 Release 版本模型；
4. 私有隔离上传和 Multipart Upload；
5. 自动验证、恶意文件检查和清单验证；
6. 人工审核、拒绝、重新提交、下架和撤销；
7. 不可变制品和 SHA-256 摘要；
8. Ed25519 签名验证和发布元数据；
9. Web 公开商店、开发者后台和审核后台；
10. CDN 分发、Range 下载和断点续传；
11. Loom 下载校验、安装回执和评分资格；
12. 搜索、下载统计、安装统计和审计；
13. 依赖扫描、SBOM、provenance 和正式发布证明。

Hook 的实际代码修改不在首批范围内。首批只建立 Hook 所需的外部合同、
兼容性矩阵和 not-applicable inventory；待 AssetLibrary API、包清单和下载
验证稳定后，再在 Hook 仓库单独开发适配器。

应用自动更新预留于同一制品模型，但只有在 Capability/Art 分发链路通过
安全和回滚验收后，才允许启用 App Update 功能标志。

## 2. 终局技术栈决策

### 2.1 Web 与边缘

- Next.js App Router；
- React；
- TypeScript；
- Neuro 设计令牌和自有语义组件；
- Tailwind CSS 作为布局和尺寸工具；
- Headless 无障碍组件，不采用通用企业视觉组件库；
- Cloudflare DNS、CDN、WAF、Rate Limiting 和 Workers。

公开 Package、Publisher、分类和文档页面使用 SSR、静态生成或 ISR；登录后的
Publisher 和 Operator 页面默认动态渲染，禁止公共缓存。Next 多实例部署必须
使用共享缓存处理器和统一失效机制，不能假设单个 Pod 的本地缓存是权威数据。

### 2.2 控制面 API

- Rust；
- Axum；
- Tokio；
- Tower middleware；
- SQLx；
- REST + OpenAPI 3.1；
- JSON Schema 作为包清单和边界合同。

API 是无状态控制面，负责身份验证、商店授权、元数据、上传会话、发布状态、
签名票据和审计。API 不代理公开制品的大文件字节。

### 2.3 数据与消息

- PostgreSQL HA 作为事务事实源；
- PgBouncer 限制数据库连接；
- PostgreSQL primary 处理发布和其他权威写入；
- Read replicas 只服务允许短暂复制延迟的公开读取；
- Valkey 作为可重建缓存、限流、短期票据和幂等辅助存储；
- NATS JetStream 作为异步事件和任务系统；
- OpenSearch 作为搜索索引；
- ClickHouse 作为下载、搜索和安装分析系统。

禁止把搜索索引当作事实源，禁止把 Valkey 当作业务数据唯一副本，禁止用
PGMQ 作为扫描高峰的终局任务队列。业务事务与异步消息通过 PostgreSQL
Transactional Outbox 连接。

### 2.4 制品存储与分发

- 生产默认：Cloudflare R2 Standard；
- 应用层只依赖 S3-compatible ObjectStore 抽象；
- 开发环境可使用 MinIO 等 S3-compatible 服务，不使用本地文件存储冒充生产；
- 私有 Quarantine Bucket；
- 已验证制品使用 SHA-256 内容寻址键；
- Published Artifact 只读、不可覆盖；
- 公共下载使用自有下载域名和 CDN；
- 私有或限制下载使用 Edge 验证和短期下载票据；
- 大文件上传使用浏览器/CLI 到对象存储的 Multipart Upload；
- API 只创建上传会话、签发短期 Part URL 和完成上传。

AWS S3 + CloudFront 是企业、区域合规或复杂复制需求下的替代 Provider，
不是业务代码中的第二套协议。

### 2.5 运行与发布

- Kubernetes；
- HPA 处理 API/Web 资源扩容；
- KEDA 按 NATS lag 或任务深度扩容 Worker；
- OpenTofu 管理基础设施；
- Helm/Kustomize 管理部署清单；
- OpenTelemetry、Prometheus、Grafana、Alertmanager、Loki、Tempo；
- OCI 镜像、不可变 digest、SBOM、provenance 和签名发布。

## 3. 架构不变量

以下不变量是所有后续实现和审查的硬门禁：

1. PostgreSQL 是发布、权限、审核和撤销的事务事实源。
2. 所有需要异步处理的事务同时写入 Outbox；事件至少一次投递，消费者必须幂等。
3. Release 和 Published Artifact 不可变；修改必须创建新版本。
4. Artifact 字节永远不通过 Next.js 或核心 API 的代理下载路径。
5. 公共下载 URL 使用内容摘要或等价不可变版本身份。
6. Multipart ETag 只能作为分片完成信息，不能被当作 SHA-256 或文件身份。
7. 任何写接口都支持并校验 `Idempotency-Key`。
8. 所有身份都表示为外部 `PrincipalRef`，不保存密码，不依赖跨服务数据库外键。
9. Publisher 授权由 AssetLibrary 决定，不把商店角色永久写死在账号 Token 中。
10. 只有通过验证的 Artifact 才能进入 Submission 或 Review。
11. Quarantine 对象不可公开访问、不可进入 CDN、不可用于预览。
12. 扫描 Worker 默认无网络、非 root、资源有界、不可执行上传内容。
13. Art、Capability、App Update 使用分级信任、签名和撤销策略。
14. 下载统计不能同步更新 Package 热行，下载路径不能依赖统计服务。
15. 删除使用 tombstone 或撤销状态，并保留可审计历史。
16. 权限、签名、哈希、撤销和状态失败时必须 fail closed。
17. 外部账号服务不可用时，公开已发布内容仍可按缓存策略浏览，但任何需要
    身份的写操作和私有下载必须拒绝或明确返回不可用。
18. 事件 Schema、OpenAPI 和清单 Schema 必须版本化并保持兼容策略。

## 4. 核心领域模型

### 4.1 身份和商店授权

`PrincipalRef` 至少包含：

- `issuer` 或 `authority`；
- `subject`；
- 可选 `tenant`；
- 凭证验证时的 `audience`；
- 认证时间和凭证到期信息；
- 不把邮箱或显示名作为身份主键。

AssetLibrary 领域实体：

- `Publisher`：发布主体，可由一个或多个账号主体维护；
- `PublisherMember`：外部 PrincipalRef 到 Publisher 角色的映射；
- `StoreRoleAssignment`：Reviewer、Moderator、Operator 等商店角色；
- `PrincipalProfileSnapshot`：可选的非权威显示信息缓存，不参与权限判断。

Publisher 状态：

```text
pending -> active -> suspended -> closed
```

`closed` 不删除历史发布、审核和审计事实。

### 4.2 目录和制品

- `Package`：面向用户的逻辑产品，类型为 `art`、`capability` 或 `app_update`；
- `Release`：Package 的不可变语义化版本和宿主兼容矩阵；
- `Artifact`：一个或多个实际对象及其摘要、大小、媒体类型和签名；
- `Manifest`：清单、依赖、权限、入口、平台和来源证明的可验证描述；
- `Compatibility`：Hook/Loom 版本、平台、架构和协议版本约束；
- `PermissionDeclaration`：权限名称、范围、理由和风险等级；
- `Revocation`：Package、Release、Artifact 或签名密钥的撤销状态。

Package 状态：

```text
draft -> submitted -> published -> deprecated -> archived
```

Release 状态：

```text
draft -> uploading -> submitted -> in_review -> approved -> published
                                                |             |
                                                v             v
                                             rejected       yanked
```

Artifact 状态：

```text
pending_upload -> uploaded -> scanning -> verified
                                      |          |
                                      v          v
                                  quarantined  deleted
```

发布后的 Release、Manifest、摘要、签名和实际 Published Artifact 不可就地修改。

### 4.3 供应链和运营

- `Submission`：一次提交及其声明、Artifact 引用和验证结果；
- `Review`：自动策略结果和人工意见的独立记录；
- `ModerationCase`：举报、下架、申诉、封禁和解决过程；
- `AuditEvent`：人工、API、Worker 和自动策略产生的不可抵赖操作记录；
- `BlocklistEntry`：Package、Release、Artifact、Publisher 或密钥的阻止规则。

Submission 状态：

```text
open -> validated -> in_review -> approved -> published
                         |            |
                         v            v
                  changes_requested rejected
```

Review 状态：

```text
pending -> in_progress -> approved
                       |-> rejected
                       `-> needs_changes
```

Moderation 状态：

```text
open -> actioned -> appealed -> resolved
```

高风险 Capability 和 App Update 的发布采用四眼或等价双人审批；普通 Art 可
根据风险降低人工要求，但不得跳过自动验证和审计。

### 4.4 分发、安装和评价

- `LibraryEntry`：某个 Principal/tenant 可见、收藏或已安装的目录投影；
- `DownloadSession`：下载授权、短期票据、开始、完成、失败、过期和撤销；
- `InstallReceipt`：客户端证明已下载、校验并安装某个摘要；
- `Rating`：具有安装资格的主体对 Package/Release 的评价；
- `DownloadEvent`：边缘或客户端产生的原始下载事件；
- `AnalyticsAggregate`：按时间、Package、Release、区域和客户端聚合的统计。

DownloadSession 状态：

```text
requested -> authorized -> issued -> started
                                      |-> completed
                                      |-> failed
                                      |-> expired
                                      `-> revoked
```

InstallReceipt 状态：

```text
pending -> accepted -> verified -> superseded
                              `-> revoked
```

Rating 状态：

```text
pending -> published -> flagged -> removed
```

“下载过”不能直接等同于“安装成功”；“安装成功”也不能自动证明能力安全。

## 5. 数据面设计

### 5.1 公共下载

公开已发布制品使用不可变 URL，例如：

```text
/sha256/<digest>/<safe-filename>
```

下载流量直接走：

```text
Loom/Browser -> CDN -> R2 Published Bucket
```

不经过 Next.js、Rust API、PostgreSQL、OpenSearch 或统计写入服务。

响应必须支持：

- HTTP Range；
- `206 Partial Content`；
- `Content-Range`；
- `Accept-Ranges: bytes`；
- 合理的 `Content-Disposition`；
- `X-Content-Type-Options: nosniff`；
- 不携带账号 Cookie；
- 正确的 CORS 和缓存头。

Loom 下载器负责：

- 断点续传；
- 可选分段并发；
- 仅重试缺失分段；
- 临时文件写入；
- 完成后原子重命名；
- SHA-256 验证；
- 签名和 Manifest 验证；
- 取消、超时和失败清理。

### 5.2 限制下载

私有、未列出、租户限定或未来付费制品使用：

```text
Client -> AssetLibrary authorize -> Edge ticket validation -> private object
```

短期票据必须限定：

- Package/Release/Artifact；
- 操作类型；
- audience；
- 到期时间；
- 可选范围或租户；
- 必要时的客户端类型。

Presigned URL 是 Bearer Token，不得被写入日志或长期保存。限制下载的 URL、
Cookie 和用户标识不得进入共享 CDN Cache Key。撤销依赖 AssetLibrary denylist、
Edge 校验和必要的 CDN purge，而不是只等待 URL 自然过期。

### 5.3 上传和隔离晋级

上传链路：

```text
Account identity
  -> Publisher authorization
  -> Upload Session
  -> Multipart parts to private Quarantine
  -> Complete and checksum verification
  -> NATS scan job
  -> Sandboxed validation
  -> Verified digest object
  -> Review
  -> Signed publication
```

Quarantine 到 Published 的晋级必须使用新的内容寻址对象键。不能覆盖已有
Published 对象，不能在扫描期间为用户提供预览，不能把用户文件名直接作为
对象路径。

### 5.4 统计路径

下载统计采用：

```text
CDN/Edge logs -> object storage raw archive -> NATS/ingest -> ClickHouse
                                                   |
                                                   v
                                      hourly/daily PostgreSQL aggregates
```

统计服务故障不能阻止下载。必须区分：

- CDN 请求量；
- 传输字节量；
- 完整下载；
- 成功安装；
- 评分资格。

## 6. 分阶段开发计划

阶段按依赖顺序执行。阶段完成必须满足退出门禁，不能只提交代码而跳过契约、
测试、运行手册或部署证据。

### P0：基础决策、契约和威胁模型

交付物：

- ADR-001 独立账号服务和 PrincipalRef；
- ADR-002 控制面/数据面分离；
- ADR-003 Rust/Axum 控制面；
- ADR-004 Next/React Web；
- ADR-005 R2/S3 ObjectStore；
- ADR-006 PostgreSQL、Valkey、NATS JetStream、OpenSearch、ClickHouse；
- ADR-007 Art/Capability/App Update 信任等级；
- Threat Model；
- OpenAPI 3.1 初版；
- AsyncAPI/NATS Subject 初版；
- Art、Capability、App Update Manifest Schema 初版；
- 兼容性、版本、撤销、幂等和事件演进策略；
- 初始容量和 SLO 假设；
- 仓库 AGENTS、CONTRIBUTING、README 和本地开发说明。

退出门禁：

- 所有领域实体、状态转换和权限边界有书面定义；
- Account Service 不出现在 AssetLibrary 数据库设计中；
- OpenAPI、AsyncAPI 和清单 Schema 有 schema version；
- Threat Model 覆盖不可信上传、票据泄漏、缓存泄权、Worker 逃逸和撤销；
- 至少一个跨语言合同测试夹具可以被 Rust API 和 TypeScript Web 使用；
- 计划中禁止的临时实现有机器可检查的规则。

### P1：终局基础设施和环境

交付物：

- OpenTofu 环境模块；
- staging 和 production 独立 state、bucket、前缀和密钥；
- Cloudflare DNS、WAF、CDN、Workers 和下载域名；
- R2 bucket、生命周期和 Quarantine/Published 分离；
- PostgreSQL HA、备份、PgBouncer 和只读连接；
- Valkey HA；
- NATS JetStream 集群、Stream、Durable Consumer 和 DLQ；
- OpenSearch 集群和快照；
- ClickHouse 数据库和对象存储备份；
- Kubernetes namespace、NetworkPolicy、PodSecurity、PDB 和 topology spread；
- Secret Manager/SOPS 运行时注入；
- 基础 OTel、健康检查和 correlation ID。

退出门禁：

- OpenTofu fmt、init、validate 和策略检查通过；
- CI 不执行未授权的真实云端 plan/apply；
- 没有公开数据库、对象存储、管理端口或默认秘密；
- Pod 有资源 requests/limits，Worker 有任务并发上限；
- staging 可以从干净环境启动所有终局组件；
- 所有外部 Provider 配置都有可替换接口，不把供应商 URL 写进领域层。

### P2：身份、Publisher 和 Catalog

交付物：

- External Account Service JWT/JWKS 或等价验证适配器；
- Development Identity Adapter，仅开发环境可用；
- Publisher、PublisherMember 和 StoreRole 数据模型；
- Package、Release、Compatibility、PermissionDeclaration 模型；
- 状态机、数据库约束和并发唯一性；
- `/v1/public`、`/v1/me`、`/v1/internal` 路由分层；
- 审计事件和 Outbox；
- Publisher CLI 的身份和 API 合同预留。

退出门禁：

- 无效 issuer、audience、签名、过期 Token 和重放凭证拒绝；
- 开发身份在生产配置中启动失败；
- 跨 Publisher、跨 tenant 和越权操作拒绝；
- Publisher slug、Package ID、Release version 和 Artifact digest 唯一；
- 并发提交不会产生双重发布；
- 所有管理动作包含 actor、request ID、目标和结果审计；
- 数据库迁移使用 expand/contract 思路并有回滚说明。

### P3：Artifact Ingest 和 Supply Chain

交付物：

- Multipart Upload Session；
- 每 Part 的大小、数量、Content-Type 和 checksum 约束；
- Quarantine Bucket；
- ZIP/归档文件安全解析；
- Manifest Schema、权限和兼容性验证；
- SHA-256 和 Ed25519 验证；
- SBOM 和 provenance 关联；
- NATS scan job、重试、退避和 DLQ；
- Rust sandbox scanner worker；
- Verified digest object 晋级；
- 孤儿 Multipart 和 Quarantine 生命周期清理。

退出门禁：

- 重复 Part、断点恢复、重复 Complete 和重复 Scan 都是幂等的；
- 超大文件、超多 Part、压缩炸弹、路径穿越、绝对路径、`..`、反斜杠、
  大小写碰撞、符号链接和过深归档被拒绝；
- Worker 非 root、默认无网络、只读输入并有 CPU、内存、PID、时间和磁盘限制；
- 扫描失败能重试、隔离并保留证据；
- 未验证 Artifact 不能提交审核；
- Published 对象不能被覆盖；
- 真实 SHA-256 不依赖 Multipart ETag；
- API 服务器没有接收整个包文件的代理路径。

### P4：Submission、Review 和 Moderation

交付物：

- 自动策略 Review；
- 人工 Review Queue；
- Changes Requested 和拒绝重提；
- 四眼审批配置；
- Publisher、Package、Release、Artifact 和签名撤销；
- Blocklist；
- 举报、下架、申诉和解决；
- Review Evidence、扫描器版本和规则版本留存；
- 发布事务和搜索/缓存失效事件。

退出门禁：

- 发布只能引用 verified Artifact；
- 高风险 Capability/App Update 没有双人审批不能发布；
- 拒绝、撤回、yank、suspend 和 block 操作可审计、可重入；
- 发布后对象、摘要和签名不变；
- 撤销能传播到目录、搜索、下载授权和客户端元数据；
- Operator 界面不泄露账号 Token、对象存储密钥或内部扫描详情；
- 公开页面只展示已发布状态，不展示内部假成功状态。

### P5：Search、Library 和 Download

本地实现检查点（2026-09-03）：公开/限制下载契约、Edge Range 与缓存策略、
Library、OpenSearch 版本化索引、Valkey generation 失效、NATS 增量投影、
PostgreSQL 重建和异步下载事件投递已实现并有本地运行门禁。2026-09-04 的首次
免费 staging 部署已真实创建 R2/Worker/KV/Queue，并通过公开对象完整 GET、Range
206、HEAD、内容摘要和缓存头验证；全局撤销传播、Cache purge、CDN 命中/回源指标、
Queue 消费及 ClickHouse 物化仍属于 staging/P8 验收项，因此不能把本检查点表述为
P5 或生产验收完成。脱敏证据见
`docs/operations/FIRST_STAGING_DEPLOYMENT_EVIDENCE.md`。

交付物：

- OpenSearch Package/Publisher/Tag 索引；
- 索引版本和可重建脚本；
- 公开目录和详情 API；
- Library、收藏和已安装投影；
- 公共不可变 CDN 下载；
- 限制下载 Edge Ticket；
- Range、断点和下载失败协议；
- DownloadSession 和授权审计；
- Valkey Cache Aside、TTL jitter 和事件失效；
- 下载事件和 ClickHouse ingest。

退出门禁：

- 公开下载不触碰核心 API 和数据库；
- 缓存键不含用户 Cookie、高基数授权参数或私有身份；
- URL 到期、签名错误、摘要错误、撤销和越权下载均失败；
- 206、Content-Range、并发分段和断点恢复测试通过；
- CDN 命中、回源和 Cache purge 有指标；
- OpenSearch 删除后可以从 PostgreSQL 重建；
- 下载统计写入变慢不会影响文件下载；
- 公开包、私有包和 Capability 包使用正确的域名和缓存策略。

### P6：Web、Publisher Console 和 Operator Console

本地实现检查点（2026-09-04）：公开目录、搜索、Package、Publisher 和 Release
读取已由 Next Server Components 接入真实 `/v1/public` API。版本投影只返回
通过 Package/Publisher/Release/Artifact/签名密钥/Blocklist 门禁的数据，并公开
有界的兼容性、权限、摘要、大小、安全文件名和签名 key id；对象存储键、扫描
证据、账号主体和原始 Manifest 不进入公开 DTO。迁移 0011 增加了独立、可扩展
到多平台制品的发布绑定事实；公开详情、下载、Library 安装和搜索索引不再把
同一 Release 下其他 `verified` 制品误判为已审核。SSR 主内容、分页、合同校验、
SEO 基础信息、真实空结果、依赖不可用及纵向运行链路已有本地门禁，并增加了
Publisher/Release 公开读取索引。当前外部 `PrincipalRef` 的 Publisher Membership、
自有 Package/Release 分页读取以及 Package/Release 草稿创建 API 已完成；角色、
状态、SemVer、App Update 功能门、幂等重放/冲突、并发唯一性、创建者不可变、
private `no-store`、审计和事务 Outbox 已由迁移 0012 与真实 PostgreSQL/HTTP 门禁
覆盖。Publisher Console 首个真实切片也已完成：Next 服务端仅向独立 Account
Service 交换指定会话 cookie，bearer 与 `PrincipalRef` 不进入 HTML，工作区、
Package 列表及 Package/Release 草稿表单使用真实私有 API，并在无会话或账号服务
故障时 fail closed。Operator Review 首个真实切片也已完成：PostgreSQL 事实源提供
固定快照游标队列、净化后的 Submission 证据和当前 revision 审核历史；reviewer/
operator Store Role 在事务中授权，`can_review` 只作 UI 提示，写操作仍重新检查自审、
Publisher 成员和 revision 隔离。Next 动态页面只在服务端交换 Account Service bearer，
不会输出 PrincipalRef、对象键或原始扫描证据；真实 API/Next/PostgreSQL 运行门禁已覆盖
角色撤销与依赖故障。Operator Moderation 切片现提供未解决案件的固定快照队列、
净化后的举报/处罚/申诉详情、唯一处罚提案、不同主体的第二次批准以及申诉解决页面；
迁移 0014 在数据库同时约束一案一提案和批准者隔离，真实 PostgreSQL/Axum/Next
门禁覆盖下架、角色拒绝和敏感字段隔离。Publisher Moderation 切片也已完成：迁移
0015 支持按成员关系读取已执行案件，固定快照分页不显示开放调查，详情只公开处罚理由、
申诉和结论；Publisher Console 可提交一次受同源、外部会话、成员锁和幂等约束的正式
申诉。真实 PostgreSQL/Axum/Next 门禁覆盖跨成员拒绝、成员撤销、敏感举报材料隔离和
依赖故障。Publisher Package 工作区现可读取 Release 历史，Release 详情与 draft
兼容性/权限编辑使用行锁、旧 `updated_at` 并发令牌、幂等键、审计和 Outbox；生产
Next 门禁同时证明创建者主体不会进入 HTML 或 React Flight。Publisher Release
工作区现进一步提供有界 Artifact 状态、当前 Submission 与去身份化审核反馈，只把安全
文件名、摘要及扫描器/规则版本投影给成员；对象键、上传内部标识、原始扫描证据、策略
证据和 Reviewer 主体均被合同拒绝。`uploaded`/`scanning` 在 UI 中明确保持不可信，只有
`verified` Artifact 能经同源 Server Action 提交或重提，写事务仍重验规范化制品、签名
密钥、Blocklist、状态和当前成员关系；撤销成员不能重放旧提交。真实 Workflow 与生产
Next 门禁已覆盖反馈、隐私和依赖故障。浏览器上传现以 8 MiB 有界增量摘要、最多 3 分片
并发和每片最多 3 次重签重试直接写入隔离桶，Next/Axum 不代理大文件字节；控制面
Server Action 只返回去除对象键的会话，实际短时 PUT URL 受独立上传 Origin allowlist、
同源调用和外部账号会话约束。MinIO 真实运行门禁覆盖 CORS preflight、ETag 暴露、
Checksum、完成清单、验证事件、被撤销成员的会话重放/继续上传拒绝以及 rejected Release 修订上传。
Publisher 签名密钥 API 与私有工作区现支持 Ed25519 公钥列表、注册和不可逆吊销；仅 Owner/
Maintainer 可写，Release Manager 只读，私钥不进入浏览器合同或服务端存储。注册/吊销受当前
成员和 Publisher 状态锁、幂等、审计和事务 Outbox 约束；发布读取活动密钥共享锁，与吊销
串行化，真实 PostgreSQL/Axum 与生产 Next SSR 门禁覆盖权限、规范 Base64、指纹、缓存和身份
隔离。Package 工作区现进一步允许 active Owner/Maintainer 编辑 draft 的可见性、名称、摘要、
说明和标签；Slug/类型保持不可变，事务内重验角色、Publisher/Package 状态与旧 `updated_at`，
并以幂等审计和 Outbox 拒绝覆盖并发修改。OpenAPI 现按 public、consumer、Publisher 与 Operator 资源域生成 TypeScript 客户端，
每个生成文件都低于 700 行并由 CI 做逐字节漂移检查；生成类型只提供编译期约束，HTTP 信任边界
仍保留严格运行时解析。Playwright 已在本地通过与 CI 同版本的 Linux 容器及 Windows 浏览器基线，
并在桌面/移动视口覆盖公开目录与签名密钥工作区的键盘首焦点，以及 Package 编辑 Server
Action 的 Axe、页面溢出、身份隔离和平台独立视觉回归。浏览器刷新后续传恢复现使用仅限
当前标签页的无秘密描述符，要求重新选择并完整复算同一 ZIP，服务端重新授权当前成员并从
对象存储列出权威分片，只跳过大小和 SHA-256 均匹配的部分；Windows 和 CI 同版本 Linux
浏览器门禁均覆盖刷新、焦点恢复、缺片补传、清理、Axe 与溢出。其余复杂交互的焦点恢复和
完整 P6 浏览器流程仍未完成，因此 P6 仍处于开发中。

公开目录发现性切片增加包级安全 JSON-LD，以及固定 UUID 区间的有界 sitemap index/leaf。
它复用现有公开发布资格门禁，避免可变 updated_at 游标漏项；每片最多 5000 包，超量或
依赖故障返回 503，不截断成功。robots 私有路径规则不再误挡公开 Publisher 页面。
具体范围、配置和合成 PostgreSQL/浏览器门禁见 `docs/PUBLIC_DISCOVERY.md`；不代表
生产部署、任意规模 sitemap 或 P6 总验收已经完成。

交付物：

- Next 公开商店页面；
- Package/Publisher/Version 详情；
- sitemap、robots、canonical、OG metadata 和结构化信息；
- Publisher 草稿、上传、提交和版本管理；
- Operator 审核、证据、下架和申诉页面；
- 空态、加载、错误、禁用、权限拒绝和不可用状态；
- API Client 和 OpenAPI 生成类型；
- Owner、Visitor、Operator 视图分离。

退出门禁：

- 公开页面 SSR/预渲染 HTML 包含主要 Package 内容；
- 私有页面不会被 CDN 或 Next 公共缓存；
- 依赖 API、搜索或对象存储不可用时显示明确 unavailable/error，而不是假空；
- Neuro UI 颜色和语义遵循统一文档：信号黄 `#d9ff38`、信号绿 `#22c55e`、
  信息蓝 `#06b6d4`、危险红 `#f43f5e`；
- 每个上下文只有一个黄色主 CTA；
- 使用深色 slab、白色焦点面、高密度列表和克制结构装饰；
- 不引入紫粉玻璃、光球、全局白底后台或等权卡片墙；
- 键盘、可见焦点、Escape、焦点恢复、内部滚动和 reduced-motion 通过测试。

### P7：Loom、CLI 和 InstallReceipt

交付物：

- Loom Web/API 客户端适配层；
- Art/Capability Manifest 协商；
- Package 兼容性筛选；
- 下载器 Range/断点/摘要/签名验证；
- 临时文件和原子安装目录；
- InstallReceipt 上报、验签、幂等和防重放；
- Publisher CLI：打包、Manifest、摘要、签名、dry-run、提交和状态查询；
- 离线安装和失败回滚合同；
- Hook 外部合同和未接入清单。

退出门禁：

- Loom 不直连 AssetLibrary 数据库或对象存储管理接口；
- 客户端只通过服务层和版本化 API；
- 旧 Loom 客户端无法理解新字段时仍能安全拒绝或降级；
- 摘要、签名、兼容性、撤销和权限验证失败时不安装；
- InstallReceipt 不能伪造、重放或绑定到另一个 Release；
- 中断下载可以恢复，错误下载不会覆盖已有安装；
- 离线状态和 Account Service 暂时不可用状态有明确行为；
- Hook 本轮保持未修改，并有后续适配边界和不适用项记录。

当前证据（2026-09-04）：P7 本地退出门禁已通过
`scripts/Test-P7Runtime.ps1`。该复合门禁覆盖版本化 Publisher API、确定性签名
打包、可恢复直传、签名扫描晋升、公开/受限下载合同、Loom 摘要/签名/兼容性
校验、事务安装回滚、预授权离线继续、InstallReceipt 防伪/防重放和 Library
投影。Loom/Hook 的仓库内产品接线、正式 CLI 制品、云 R2/CDN 验收和发布签名
仍分别属于后续跨产品及 P5/P9 门禁；不得用本地 P7 结果代替这些证据。详细合同
和 Hook not-applicable inventory 见
`docs/LOOM_CLIENT_AND_PUBLISHER_CLI.md`。

### P8：可观测性、性能、可靠性和成本

交付物：

- API、Web、Worker、NATS、数据库和 Edge 的 trace 关联；
- RPS、p95/p99、错误率、数据库池、复制延迟、缓存命中、R2 4xx/5xx、
  JetStream lag、搜索延迟、索引新鲜度、下载字节和扫描耗时指标；
- Grafana Dashboard、Alertmanager 告警和 Runbook；
- k6/vegeta 负载场景；
- PostgreSQL PITR 和加密备份；
- R2 版本、生命周期、Object Lock 或等价保留策略；
- NATS、OpenSearch、ClickHouse 快照与恢复；
- 单可用区、区域和组件故障演练；
- 成本驱动和预算告警；
- 云账号、免费试验环境、凭证、预算、到期清理和付费迁移 Runbook。

初始容量假设只作为压测基线，不是生产承诺：

- 公开浏览持续 1,000 RPS，短时突发 5,000 RPS；
- 搜索 200 RPS；
- 10,000 个并发下载由 CDN/R2 承担；
- 上传测试单独模拟 100 个新上传会话/秒和短时完成高峰；
- 年度已发布对象增长假设约 10 TB；
- 典型包大小、超大包、Range 和慢客户端分别测试；
- 负载测试和长期存储增长是两个不同维度，不能把短时上传峰值误报为年度容量。

目标 SLO 初稿：

- 公开目录 p95 小于 300 ms；
- 搜索 p95 小于 500 ms；
- 元数据写 p95 小于 400 ms；
- Upload Complete 控制请求 p95 小于 1 s，不包含文件传输时间；
- 控制面 5xx 小于 0.1%；
- 事件端到端延迟小于 30 s；
- 搜索索引新鲜度小于 60 s；
- CDN 缓存命中路径不依赖 API 可用性；
- 扩容响应小于 2 分钟，保留至少 40% 资源余量。

退出门禁：

- 2 倍基线负载和 24 小时 soak 通过；
- 5 倍基线突发 10 分钟不发生级联崩溃；
- API、Worker、数据库、Valkey、NATS、OpenSearch、R2/CDN 故障有明确降级；
- 元数据 RPO 小于等于 5 分钟，分析数据 RPO 小于等于 15 分钟；
- 单可用区 RTO 小于等于 15 分钟，区域级 RTO 小于等于 60 分钟；
- 成本按存储、请求、出口、数据库、集群、搜索、分析和可观测性拆分；
- 预算告警为 50%、80% 和 100% 阈值；
- 恢复后的行数、摘要、Manifest、审计和事件偏移可以核对。

当前证据（2026-09-04）：P8 实现地基已经包含 Rust Prometheus/OpenTelemetry
公共层、HTTP/JetStream W3C 上下文、Next.js 服务端 tracing、API/S3 外部依赖
和缓存指标、Edge request/correlation ID、Cloudflare sampled logs/traces 配置、
Helm ServiceMonitor/PrometheusRule/AlertmanagerConfig/Grafana Dashboard，以及带
远端 HTTPS/显式确认/证据目录边界的参数化 k6 控制面和下载场景。OpenTofu 已
声明 Quarantine 一天终止不完整分片、环境化对象生命周期，以及 Published
`sha256/` 前缀锁；Cloudflare provider 5.24.0 schema 和两个环境的 validate 均
已通过。五项本地恢复演练现已真实执行并核对清理：PostgreSQL custom-format
逻辑备份及全表/约束/迁移/audit/outbox 指纹，JetStream stream/consumer 状态，
OpenSearch fixture snapshot/重命名恢复/alias 切换，MinIO Published/Quarantine
对象摘要，以及 ClickHouse MergeTree/物化视图原生备份恢复；证据 Manifest 均
明确限制为本地、同节点或 fixture 范围。这些仍不能替代云验收：2 倍 24 小时
soak、5 倍突发、10,000 并发云下载、托管 PostgreSQL PITR、独立加密备份、
跨集群 NATS/OpenSearch/ClickHouse 与真实 R2 恢复、AZ/区域故障、实际 RPO/RTO、
真实成本拆分和 50/80/100% 告警投递尚无云证据，因此 P8 退出门禁保持未完成。
本地组件故障演练另已验证 Valkey 故障搜索回退、OpenSearch 故障 503、PostgreSQL
liveness/readiness 分离和原进程恢复；演练同时推动 readiness 快速失败与缓存操作
超时修复。版本化成本策略也已固定八类成本、低基数标签、50/80/100% 独立告警
路由和 provider 实测导出要求，但它不包含虚构预算金额，也不证明实际告警送达。
严格的云容量证据合同与对抗性校验器另已绑定 baseline、24 小时 soak、5 倍突发、
10,000 VU 下载、双故障域生成器、全部外部信号、成本/告警导出和文件摘要；它会拒绝
本地来源、loopback、缺失信号、路径逃逸、重复证据、窗口/摘要不匹配和伪造的 k6
准入位。校验报告仍固定为 provider 身份真实性未验证且 P8 不可关闭，避免把仓库内
结构/完整性检查误报为真实云性能、成本、故障或恢复结论。
`docs/operations/CLOUD_ACCOUNT_AND_FREE_TRIAL_RUNBOOK.md` 另固定了 GitHub、
Cloudflare、Neon、Aiven、Synadia、Grafana、OCI 和 ClickHouse 的试验账号顺序、当前
免费限制及协议级迁移规则；这些免费单节点/限额环境只用于开发和集成，不构成任何
HA、SLA、容量、恢复、成本或 provider 身份真实性证据。

### P9：正式安全、发布和 App Update 准入

交付物：

- 依赖清单、lockfile 和基础镜像清单；
- OSV/恶意依赖扫描；
- Secret Scan、SAST、容器扫描和 IaC 策略；
- SBOM SPDX 或 CycloneDX；
- SLSA provenance 或等价构建证明；
- Ed25519 Publisher 签名验证；
- TUF Root/Targets/Snapshot/Timestamp 元数据；
- 密钥轮换、撤销和应急 kill switch；
- 发布镜像签名和不可变 digest；
- 5% -> 25% -> 100% canary；
- 自动回滚和 SLO burn 保护；
- App Update 的独立根密钥、渠道和回滚策略。

退出门禁：

- PR、默认分支、定时任务和正式发布使用同一安全策略；
- 扫描的 commit/ref 与最终构建 commit/ref 完全一致；
- 工具、Action、下载器和基础镜像有固定版本或 digest；
- 漏洞扫描、Secret Scan、SBOM、provenance 或签名失败时禁止发布；
- 例外必须按公告 ID、具体理由、owner、reviewer 和到期日记录，最长 90 天；
- 不允许 broad package ignore、公开 Quarantine、无限期 presign、无签名发布、
  Worker 联网执行上传代码或把 Art 信任外推到 Capability/App Update；
- App Update 未通过完整 TUF/回滚/撤销验证前，功能标志保持关闭；
- release 目录包含镜像 digest、迁移、部署清单、SBOM、provenance、测试和审计证据。

当前实现状态：PR、默认分支、定时扫描和 release 已复用相同的 fail-closed 安全
工作流，release 还复用同一 commit 的完整质量工作流。OSV、pnpm audit、Secret
Scan、CodeQL、Trivy IaC/镜像扫描、Syft SPDX、Cosign keyless 签名以及 SLSA/SBOM
attestation 已接线；六个第一方镜像、构建/运行基础镜像和 ClamAV 运行镜像均由
固定清单及 digest 约束。release 最后聚合不合并的同轮 workflow artifacts，校验
文件集合、版本、commit、镜像 registry/digest、扫描结果和多层 SHA-256，并封装
全部 SQL migration、同 commit CI 结果以及禁止 App Update 的 digest-bound Helm
默认/渐进式双 render。渐进式 render 固定 Argo Rollouts v1.9.1 controller 镜像
digest、NGINX TLS traffic routing、API/web stable/canary Service、精确 5/25/100
权重，并在每一级执行 request-rate、5xx、p95 与全局 SLO 告警的 fail-closed
Prometheus 分析；HPA 同步切换到 Rollout，而 worker 仍保持 Deployment。API/web
的最终 digest 还会以其非 root 运行用户启动并完成容器间 health 和
SSR smoke，结果同时绑定 commit 与两个 digest。`release-candidate-evidence.schema.json` 把该产物限定为 signed candidate，
`production_release_eligible` 和 `app_updates_enabled` 固定为 false；本地对抗测试已
覆盖篡改、漏洞结果、错误 checksum、缺镜像 digest、缺 100% 权重和伪造生产资格。

这仍未达到 P9 退出门禁：GitHub protected environment/CODEOWNERS 的真实设置、
registry/provider 侧真实性需要外部核验；当前仓库只实现默认关闭的 workload-side
canary 合同与候选渲染物，并未安装/验证集群 controller、NGINX 联动、生产指标和
真实 5% -> 25% -> 100% 流量窗口。独立 promotion evidence schema/verifier 已要求
candidate/P8/provider commit、account、deployment digest、六镜像、controller identity、
数据库 checkpoint、顺序且不重叠的 5/25/100 观测窗、rollback decision 和五类 smoke
证据一致，并拒绝路径逃逸、链接、复用、篡改、错序、重叠和伪造回滚；但生成报告
固定 `provider_authenticity_verified=false` 与 `production_release_eligible=false`，仍需
外部 attestor。基于 SLO burn 的真实自动回滚尚未实现。App Update 已新增独立 ADR、
策略 Schema 和原生 Rust `tough` 0.24.0 客户端；因该实现不支持 delegated roles，
终局架构固定为 Loom/Hook 与 stable/beta/nightly 的六个独立 Root/仓库，Root/Targets
使用相互独立的离线 2-of-3 Ed25519 密钥，Snapshot/Timestamp 使用分离的在线
1-of-1 ECDSA P-256 HSM 身份。客户端已实现安全过期、持久 rollback datastore、consistent snapshot、元数据
大小/Root 更新上限、产品/渠道/平台绑定、单调 release sequence/policy epoch、签名
control kill switch、撤销列表、远端降级拒绝和原子验证下载；动态生成的真实签名仓库
测试覆盖角色算法漂移、过期 Timestamp、元数据/目标字节篡改、版本回退、混搭攻击、
TUF datastore 删除后的 policy epoch 回退拒绝和 Root old/new threshold 连续轮换。但
六套生产 Root ceremony、真实 HSM 轮换、正式冻结/状态丢失恢复演练、updater 制品，
以及 Hook/Loom 单实例激活、健康检查、失败回滚和 recovery mode 仍无证据。因此 App
Update 继续默认关闭且现有服务端/Loom 客户端仍拒绝该包类型。操作边界和当前证据
格式见 `docs/ADR/ADR-008-app-update-tuf.md` 与
`docs/operations/RELEASE_SECURITY_RUNBOOK.md`。

## 7. API 和事件边界

### 7.1 API 分层

```text
/v1/public/*    公开目录、搜索、详情、公开 Manifest
/v1/me/*        Publisher、Library、Upload、Download、InstallReceipt
/v1/internal/*  Review、Moderation、索引、分析和运维接口
/healthz        活跃性
/readyz         依赖就绪性
```

公开 API 不返回内部扫描细节、对象存储凭证、账号 Token 或未发布包内容。

### 7.2 关键事件主题

主题必须带版本，事件主体必须包含事件 ID、发生时间、actor 或 system actor、
Package/Release/Artifact 引用和 schema version。初始主题包括：

```text
assetlibrary.publisher.v1
assetlibrary.package.v1
assetlibrary.release.v1
assetlibrary.artifact.uploaded.v1
assetlibrary.artifact.scan-requested.v1
assetlibrary.artifact.verified.v1
assetlibrary.submission.v1
assetlibrary.review.v1
assetlibrary.moderation.v1
assetlibrary.catalog-published.v1
assetlibrary.catalog-revoked.v1
assetlibrary.download.v1
assetlibrary.install-receipt.v1
assetlibrary.analytics.v1
```

消费者必须：

- 显式 ACK；
- 结果持久化后再 ACK；
- 使用幂等键；
- 支持重试退避；
- 超过重试上限进入 DLQ；
- 支持从指定序列重放；
- 不把重复事件当作数据损坏。

## 8. 测试和验证策略

测试层级：

1. Schema 和序列化合同测试；
2. Rust domain/application 单元测试；
3. PostgreSQL migration 和 repository 集成测试；
4. R2/S3 Multipart、Range、checksum 和生命周期测试；
5. NATS Outbox、重复投递、重试和 DLQ 测试；
6. OpenSearch 索引、删除和重建测试；
7. Worker 沙箱和恶意归档夹具；
8. API 权限、幂等、并发和审计测试；
9. React 组件和状态测试；
10. 浏览器公开页面 SEO/SSR 测试；
11. Publisher/Operator 流程 Playwright E2E；
12. Loom 下载、校验、安装回执和回滚 E2E；
13. k6/vegeta 性能和容量测试；
14. 备份恢复、故障注入和灾备演练；
15. Release smoke 和正式制品验证。

核心端到端验收链：

```text
Publisher
  -> Art Release 上传
  -> Quarantine
  -> 自动扫描
  -> Review
  -> Publish
  -> Library 可见
  -> 授权下载
  -> Loom 摘要/签名验证
  -> InstallReceipt
  -> 合格用户评分
```

每个步骤都必须证明：

- 成功可审计；
- 失败可重试；
- 重试不重复发布；
- 状态不会跳过必要阶段；
- 错误不会伪装为空态或成功 Toast；
- 撤销和回滚行为可验证。

## 9. 仓库组织原则

计划中的逻辑结构如下，实际创建目录前仍需逐项确认：

```text
AssetLibrary/
├── apps/web/                  # Next.js 公开站点和管理界面
├── services/api/              # Rust Axum 无状态控制面
├── workers/                   # ingest/scan/index/analytics/signing
├── crates/domain/             # 领域类型和状态规则
├── crates/application/        # 用例编排和事务边界
├── crates/adapters/           # DB/ObjectStore/Identity/Queue 适配器
├── crates/contracts/          # API、事件和清单合同
├── packages/api-client/       # 生成的 TypeScript API Client
├── packages/ui/               # AssetLibrary Neuro UI primitives
├── packages/design-tokens/    # 独立仓库中的 Neuro token 映射
├── schemas/                   # Art/Capability/App Update schemas
├── migrations/                # PostgreSQL migrations
├── contracts/openapi/         # OpenAPI 文档
├── contracts/asyncapi/        # 事件文档
├── deploy/                    # OpenTofu、Helm/Kustomize、策略
└── docs/                      # ADR、威胁模型、运行手册、容量报告
```

新代码按领域和资源生命周期拆分，目标约 150 行，正常不超过 500 行；不把
新职责堆入巨型 `common`、`utils`、`helpers` 或单一全能 Worker 文件。

## 10. 依赖安全和发布纪律

AssetLibrary 必须建立自己的依赖安全策略，不复制 Loom 的 lockfile、例外、哈希
或发布目标。策略至少覆盖：

- Cargo、npm/pnpm、Docker、GitHub Actions、OpenTofu 和全部 Worker；
- PR、默认分支、定时、手工和正式发布触发；
- 固定扫描器版本、Action commit SHA 和工具 SHA-256；
- 锁文件路径和基础镜像 digest；
- OSV、Secret、SAST、容器和 IaC 扫描；
- 公告级、自动到期的例外；
- 同一个 clean commit 的扫描、构建、SBOM、provenance 和 release；
- 恶意依赖或污染预编译物时的停发和密钥轮换流程。

安全扫描、配置校验、迁移检查或发布证明失败时，不得把失败改成 warning 后
继续发布。

## 11. 生产上线前总门禁

只有全部条件满足后，AssetLibrary 才能标记为生产就绪：

- P0-P9 退出门禁全部有新鲜证据；
- 公开、Publisher、Operator 和 Loom 核心流程 E2E 通过；
- 负载、soak、故障注入和恢复演练通过；
- CDN、R2、PostgreSQL、NATS、Valkey、OpenSearch 和 ClickHouse 有运行手册；
- 数据库恢复后摘要、Manifest、权限和审计一致；
- 正式 release 使用不可变镜像 digest；
- SBOM、provenance、签名、checksums 和迁移清单齐全；
- 安全、隐私、许可证和数据保留审查通过；
- on-call、告警、SLO burn 和自动回滚经过演练；
- staging/prod 使用不同资源前缀、密钥和状态；
- 账号服务不可用时的降级行为已验证；
- Hook 未接入部分有明确的 not-applicable inventory，不把未完成适配伪报为完成；
- App Update 功能保持关闭或已有独立的 TUF/回滚准入证据。

## 12. 本计划的停止条件

出现以下情况时，必须停在当前阶段解决，而不是继续堆功能：

- 账号服务边界变成共享数据库或 AssetLibrary 开始保存密码；
- 公共下载重新经过 API 代理；
- Quarantine 被公开或未扫描 Artifact 可以发布；
- 发布对象可以覆盖或摘要与实际字节不一致；
- Worker 为了方便获得 root、网络或无界资源；
- 事件没有 Outbox、幂等或重放策略；
- OpenSearch、Valkey 或统计系统被错误当成事实源；
- CDN 缓存可能返回其他用户的私有内容；
- 安全扫描失败仍然允许发布；
- 任何容量、SLO、RPO 或 RTO 目标没有真实测试证据；
- 为了短期开发方便引入需要后续替换的 SQLite、本地文件或 PG 队列产品路径。

这份计划是 AssetLibrary 的实施基线。后续业务需求变化应通过新增或修订 ADR、
Schema、威胁模型和阶段门禁表达，而不是绕过这些边界直接加入实现。
