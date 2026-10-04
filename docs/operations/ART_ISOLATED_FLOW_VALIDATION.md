# Art 本地同包 API-to-Edge 验收

## 首轮实际通过的闭环（显式 reconcile 历史基线）

2026-10-04 UTC，Windows x64 release API、Scanner、Outbox，配合本轮独立
PostgreSQL、NATS JetStream、MinIO 和共享 loopback ClamAV，完成同一个签名 Art
ZIP 的上传、验证、审核、发布、搜索、下载与撤销闭环。没有直接 seed verified
artifact、approved review 或 publication binding。仅 publisher、membership 和
store-role 是测试 bootstrap SQL；身份是 `assetlibrary-development` 的开发
`PrincipalRef`，不是账号服务、真实登录或 OIDC 验收。

成功 run：`al-art-20261004054626-534ba5`。完整本地证据：

```text
C:\Users\Public\nas_home\AI\GameEditor\linshi\assetlibrary-art-flow-20261004\run-04
```

同一 artifact：`3b4db3a1-34e1-4408-8d21-71f7e54b5dd7`，ZIP 为 1675 字节。

| 阶段 | 本次真实结果 |
| --- | --- |
| 草稿和 key | API 注册 Ed25519 public key、创建 package/release |
| 上传 | API 签发 upload session/part；直接向本轮私有 MinIO multipart PUT；complete 后 uploaded；重复 reservation 保持同一 artifact |
| 未验证准入 | 提交审核返回 409 |
| 验证 | Outbox → NATS → Scanner；真实 ClamAV、Manifest、签名、SBOM/provenance 完整；1 次 verified、1 个 verified event |
| verified 但未发布 | PG 搜索为空；真实 reconcile 不生成 public policy；Edge 返回 404 |
| 审核发布 | publisher 自审 403；未 approved 发布 409；独立 reviewer 1 次批准满足 Art 门禁；operator 发布并幂等重放 |
| 发布绑定 | 查询 `published_release_artifacts` 确认绑定的是同一上传 artifact |
| 搜索 | `ASSETLIBRARY_SEARCH_PROVIDER=postgres`，真实 HTTP 搜索返回该 package |
| 下载 | API 返回 canonical digest URL；真实 Edge HEAD 200、完整 GET raw SHA-256 一致、Range 206 字节一致、条件 GET 304 |
| 撤销 | API revoke key；PG 搜索为空、API 下载授权 404；显式真实 reconcile 后旧 Edge URL 404 |
| 清理 | native owned processes 退出、scanner 临时目录为空、3 个本轮容器停止；保留数据、容器、网络 |

Raw ZIP SHA-256：
`cc3ff5d14647c2a774e912e3054ad1a97e5cdb30555c5948629587274242bbbb`。
Canonical digest：
`4e9e1fd1dc7fe5b9c8b83922469a25a3b03bd096b5f8a68ec7fd56c4b294b425`。
URL 使用 canonical digest，下载字节另外核对 raw digest，两者不混用。
ClamAV 响应为 `ClamAV 1.5.4/28142/Sat Oct  3 06:24:16 2026`，不是未来
运行时病毒库新鲜度的保证。

## 接线与复现

`scripts/Test-ArtIsolatedRuntime.ps1` 复用 Scanner 的 run-owned 生命周期、迁移
和 `Stack.ps1`。`Workflow.ps1` 仅编排真实 API；`Edge.ps1` 使用已安装 TypeScript
7 的 native compiler 编译原始 `services/edge/src/index.ts`、`range.ts`、`ticket.ts`，
然后 Node adapter 直接调用原始 `worker.fetch`。未复制 handler 的下载/准入逻辑。

测试 S3 port 只允许本轮 `assetlibrary-published` canonical key，以本轮随机凭据
签名 HEAD/GET，支持 bounded range；没有匿名开放 MinIO 或把管理凭据发给客户端。
测试 policy port 初始为空，只接本轮随机 bearer 保护、有大小/数量边界的
Cloudflare-compatible PUT/DELETE。`reconcile_local_policy` example 直接引用生产
`Repository`、资格 SQL、projection guard 和 `EdgePolicy::reconcile`，没有手造
allowlist。它不加载 OpenSearch/Valkey，也不是一个新生产 indexer 服务。

先在独立仓库安装 Edge 已锁定依赖并构建：

```powershell
rtk proxy pnpm --dir services/edge install --frozen-lockfile
rtk proxy cargo build --locked --release -p assetlibrary-api -p assetlibrary-scanner-worker -p assetlibrary-outbox-worker
rtk proxy cargo build --locked --release -p assetlibrary-scanner-worker --example build_signed_fixture
rtk proxy cargo build --locked --release -p assetlibrary-indexer-worker --example reconcile_local_policy

.\scripts\Test-ArtIsolatedRuntime.ps1 `
  -EvidenceDirectory 'C:\Users\Public\nas_home\AI\GameEditor\linshi\art-new-run' `
  -PostgresImage sha256:f372eda99ac2ea249c3dce566dcdf468397035371284d2cf2103b4bc52b3b39e `
  -NatsImage sha256:a10e008495467f740bfaa354ef3e6cee8decfe44b9546638f7511e20066d46de `
  -MinioImage sha256:9d668e47f1fc60ea49af4203deee87a657eb1aa0e2761fee2c7c2d1df282c880 `
  -ClamAvPort 3310
```

镜像参数是本机已存在 image ID，运行前必须 fresh inspect，不推断远端标签；
脚本 `--pull=never`。EvidenceDirectory 必须是不存在的 `linshi` 子目录。
本机需要 Windows PowerShell、Node 22、Docker 和可用的真实 ClamAV；本次 Node
为 22.22.2、Rust/cargo 为 1.95.0。没有引入新依赖或修改生产行为。

fixture 生成、native TS 编译、reconcile、HTTP、SQL 和 readiness 各阶段均有界。
cleanup 可能追加进程等待和日志关闭时间，不把单阶段 timeout 当整轮精确上限。
清理按持有 process/容器 owner label 操作，不 prune、不删卷、不停止共享 ClamAV。
本轮修复日志采集失败跳过 owned container stop 的控制流，并用无真实 Docker
的故障注入验证；另验证 owned tool 超时后已退出。旧 Scanner 入口的同夹具故障
恢复、重复事件、异常包隔离另做邻近回归，不将本次 Art 成功替代它。
故障注入停止动作提前到 retry 观察之后；若强制停止打断下一次 delivery 的 NAK，
恢复等待覆盖生产 consumer 的 180 秒 ACK 周期（测试上限 240 秒），不 reset
consumer 或更改生产重试规则。首轮邻近回归的 60 秒超时证据同样保留。
修复后的邻近回归 `al-scan-20261004055239-d2d76e` 已完整通过：ClamAV 不可用
时失败关闭，恢复后自然重投 verified，重复事件不重复扫描，非法 ZIP quarantine，
随后正常包继续 verified，最终 cleanup passed。证据位于同一父目录的
`scanner-neighbor-final`；没有靠增加等待掩盖无结果的失败。

前三次失败证据保留：Windows PowerShell 限制直接设置 Range header；随后
PowerShell 的 bodyless 304 包装和 .NET buffered response 读取失败。改为
`HttpWebRequest.AddRange`、`HttpClient.ResponseHeadersRead` 后完成。第二、三轮
真实 Edge 日志已经记录 304，失败不被标为成功，也未改动生产 Edge 来迁就客户端。

## 证据和未验收边界

`upload.json`、`verification.json`、`publication.json`、`search.json`、四个
`reconcile-*.json`、`download.json`、`runtime-result.json`、`cleanup.json` 与
脱敏日志保存分阶段事实。runtime receipt 记录 Rust EXE、真实 Edge source、
实际 compiled JS 和 adapter SHA-256；唯一版本包的 manifest 另绑定源码提交
和所有打包文件。包只复制明确允许的证据，不带 `.env`、本地随机凭据、数据库
或 MinIO 数据。测试原目录仍含本地敏感配置，需要按敏感文件保管。

以下仍未验证：真实 Account Service/OIDC/JWKS、Web UI/浏览器上传、Hook/Loom
EXE 安装激活、Capability 四眼审核、NATS 自动 indexer 消费/撤销传播时延、
Cloudflare R2/KV/Queue/WAF 和 CDN cache、托管 PostgreSQL/TLS/故障恢复、生产
部署和整栈容量。Node 没有 `caches.default`，日志的 `miss` 不代表 Cloudflare
缓存验收。显式 reconcile 之后的 404 不代表全球即时撤销。

这是本地集成验收，不是删掉 NATS/indexer/Valkey 的依据，也不选定托管商/部署
地点或授权创建付费资源。App Update 和 production eligibility 继续关闭。

## 后续自动传播批次

当前入口已改为生产 indexer 自动消费，不再运行测试 reconcile example。
新增 Edge-only 模式、真实 policy 故障重投、API key-revoke catalog 事件、
永久 signing-key deny 和未过期旧 ticket 拒绝，详见
[INDEXER_EDGE_POLICY_MODE](INDEXER_EDGE_POLICY_MODE.md)。可选旧模式回退另启动
独立 OpenSearch/Valkey 并检查同事件双 marker、rebuild、旧 provider API 和撤销。
以上历史 run、旧版本包及未验边界不被覆盖；新批次的 receipt 单独绑定实际源码。
新批次 `al-art-20261004074041-26eed2`（`run-08`）已通过自动发布、故障自然重投、
自动撤销与完整模式回退；详细事实和 pipe 调度故障保留记录见上述新文档。
