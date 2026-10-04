# 可选 Edge-policy-only indexer

## 实现与配置

`ASSETLIBRARY_INDEXER_MODE=edge-policy` 让现有生产 indexer 只维护 Edge 准入与
撤销；配合 API 的 `ASSETLIBRARY_SEARCH_PROVIDER=postgres`，不读取、初始化或
连接 OpenSearch/Valkey。没有新增 worker 服务或复制资格 SQL。未设置模式仍是
`search-edge`：OpenSearch → Edge → Valkey → processed → ACK。既有部署默认值、
NATS/Outbox/Scanner、队列重试和 search rebuild 均保留，不等于完整小规模 profile。

```text
ASSETLIBRARY_INDEXER_MODE=edge-policy
DATABASE_URL=<server-only PostgreSQL URL>
NATS_URL=<NATS URL, not ASSETLIBRARY_NATS_URL>
ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID=<32 hex>
ASSETLIBRARY_EDGE_POLICY_NAMESPACE_ID=<32 hex>
ASSETLIBRARY_EDGE_POLICY_API_TOKEN=<server-only token>
ASSETLIBRARY_EDGE_POLICY_API_BASE=https://api.cloudflare.com/client/v4
```

Edge 配置在此模式下即使 development 也必须完整。staging/production 仍要求
NATS TLS、Edge HTTPS；完整模式仍要求 Valkey TLS。Edge-only 不用假搜索 URL
占位。`rebuild` 在连接数据库/NATS 前拒绝：`rebuild requires search-edge mode`。

| 身份 | search-edge | edge-policy |
| --- | --- | --- |
| processed projection | `search-edge-v1` | `edge-policy-v1` |
| 默认 durable | `assetlibrary-indexer-v1` | `assetlibrary-indexer-v1-edge-policy-v1` |
| 自定义 consumer base | 原值 | 原值加 `-edge-policy-v1` |

保留 suffix 不能出现在任一模式的 base 末尾；base 和最终名称均校验字符与
100 字符上限。完整模式不会竞争 Edge-only durable。独立 marker 防止 Edge-only
ACK 后，回退漏写搜索/缓存；不要删除旧 durable 或 processed 数据。

两种模式都重新读取生产资格 SQL，并持有同一 PostgreSQL projection advisory
lock；短期重叠仍串行更新 Edge。失败不会记录 processed/ACK，沿用 2 秒 NAK、
60 秒 ACK wait、最多 20 次 delivery。外部 KV 与数据库不是分布式事务，部分
成功靠幂等 reconcile 收敛；guard 与 pool 操作也不能描述为同一原子事务。

## 签名键撤销补线

原 revoke API 只发 key 事件，不能驱动只消费 catalog invalidation 的 indexer。
本批在持有 publisher/key 锁的 revoke 事务内，为使用该 key 的每个 package
插入真实 catalog invalidation；同包多个 artifact 不重复、其他 key/tenant
不受影响。新理由 `signing_key_revoked` 同步 Rust/AsyncAPI 合同。幂等 replay
和 already-revoked 路径不重复发事件。publication 的 key `FOR SHARE` 与 revoke
锁冲突，避免在失效 snapshot 后提交新绑定。

fanout 为参数化服务端 `INSERT ... SELECT ... EXISTS`，不加载整个 package 表；
statement timeout 最多 5 秒，不放宽更短既有限制，随后恢复原值。失败将 revoke
事务一起回滚并返回数据库错误，不静默提交没有失效事件的撤销。大量 publisher
数据仍需容量验收，5 秒不代表已证明任何规模都能成功。

Edge 只读取本 package 历史 artifact 使用过的 revoked key，以 C 排序、每页
最多 200 条写入永久 `revoked:signing_key:<publisher>:<key>`。永久 deny 不塞入
原 1000 项 reversible blocklist snapshot，不截断，也不随 block lift 删除。
它拒绝旧 public URL 和仍未过期的 restricted ticket，而不只关闭新授权。
每次事件仍会重写历史永久集合：分页只限制单页内存，不限制总 HTTP 数、总页数
或锁持有时间。大量历史 key、慢 KV、重试耗尽与原 reversible 1000 项约束是
剩余容量/恢复边界，不声称已解决。

## 切换、回退与混合版本

以下是待部署操作合同，不是本批已执行的生产变更。

1. **消费者先于 API 升级**：所有完整模式 worker 先识别新 reason，再发布新增
   失效事件的 API。未升级旧 binary 会将新 reason TERM。
2. API 改用 PostgreSQL search，先保留升级后的完整 indexer。确认保留期覆盖
   必要历史，再启动独立 Edge-only durable，检查 backlog/ACK、准入/撤销与永久
   deny；通过后才停止完整模式，不删除 NATS/Outbox 或旧状态。
3. 回退搜索时保持 API 为 PG、Edge-only 持续消费，恢复**本批或更高版本 binary
   的 search-edge 模式**及真实搜索/缓存配置、原 durable；运行完整 rebuild，
   追平 backlog，验证旧 provider 查询、撤销和 generation，再切换 API provider。
4. mode 回退不是旧 binary 回退。必须回退旧版本时，需保留升级后的 Edge worker
   处理新撤销事件并另行设计兼容/恢复，不将本次证明外推为任意旧版本安全。
5. JetStream 仍最多保留 1,000,000 消息。历史被截断时不能假设新 durable 恢复
   全部 Edge 状态；search rebuild 不重建 Edge，完整云 KV 恢复/重放仍待交付。
   不清空 markers、KV、队列或数据库来完成切换。

## 本地验收

`scripts/Test-ArtIsolatedRuntime.ps1` 运行生产 NATS indexer，不再显式 reconcile：
真实 API 草稿/key/上传 → Scanner → 独立审核/发布 → PG search；policy 503 时
未 mark/ACK，恢复后同事件自然重投 → 原包下载 → key revoke 自动消费 → 旧 URL
404、未过期旧 ticket 的精确 `revoked bearer ticket` 403。

可选 `-OpenSearchImage <sha256> -ValkeyImage <sha256>` 在上述发布 proof 后才
启动两份 run-owned 旧依赖：同事件双 marker、真实增量文档、rebuild alias swap、
旧 provider HTTP 查询/generation，以及撤销双消费、空搜索和文档 404。
没有接入共享搜索服务。OpenSearch 1 CPU/256 MiB heap 的独立 readiness probe
实测约 172 秒（不是 RSS），因此冷启动测试预算为 240 秒；首轮 90 秒超时保留。
测试 ticket TTL 为允许范围内的 900 秒，并另检查拒绝时未过期以排除 expiry。

两份 real-SQL gates 使用显式 loopback `assetlibrary_sitemap_test` 的 temporary
tables，覆盖事件合同、租户/key 范围、同包去重、事务回滚、timeout 恢复、1001
个相关/1001 个无关 revoked keys 分页和 mode marker 隔离：

```powershell
rtk proxy cargo test -p assetlibrary-api --locked signing_key_catalog_gate -- --ignored --nocapture
rtk proxy cargo test -p assetlibrary-indexer-worker --locked edge_policy_repository_gate -- --ignored --nocapture
```

必须设置 `ASSETLIBRARY_KEY_TEST_DATABASE_URL`，CI 单独运行；普通 test 的 ignored
不算通过。owned 容器停止但不删除，数据/失败证据保留在 linshi。真实账号/OIDC、
Cloudflare 全球 KV 撤销/CDN purge、托管数据库、Linux worker、长期容量和生产
部署仍未验收；App Update/production eligibility 保持关闭。

并发初始化两份独立 PG 时，本机绑定目录 initdb/同步/临时 server 阶段超过旧的
60 秒预算，未进入最终 TCP server；失败与 cleanup receipt 保留。测试 PG readiness
预算改为 180 秒，仍使用最终 TCP pg_isready，不使用临时 Unix socket 代替 readiness。
最终 Art/SQL gates 串行运行；这不是数据库持久化或容量验收。

旧模式首次回退另发现测试 Scanner/full-indexer 的自定义 consumer base 相同，
NATS get_or_create 返回既有 Scanner durable，因而没有 catalog 消费。现按 worker
分开命名；生产 indexer 启动时校验既有 durable 的 subject、pull/body、显式 ACK、
60 秒 ACK wait、20 次 delivery 和单个 ack-pending，冲突直接退出，不自动重配
别人的队列。回退 harness 另真实连接 Scanner durable 验证精确拒绝错误。

Docker 默认 address pool 实际耗尽后，测试仅在该精确错误下复用带自身 owner
label、命名合规且 inspect 当前成员均为同 owner/stopped 的历史测试 bridge。
不删网络/数据，不停止旧容器；只读非秘密元数据，新容器仍以新 run label 清理。
network_reused 单独记录。复用不是独占网络或原子租约，成员视图可能不包含全部
停止的配置关联容器，亦不能防止外部随后启动旧容器；本地证明不是 OS 网络隔离。

## 当前通过记录（2026-10-04）

`linshi/assetlibrary-edge-policy-20261004/run-08` 的
`al-art-20261004074041-26eed2` 完整通过自动发布、policy 503 未 mark/ACK、恢复
自然重投、原 ZIP 下载、自动 key revoke、public URL 404，以及未过期旧 ticket
精确 `403 revoked bearer ticket`。没有调用显式 reconcile。独立完整模式通过
同事件双 marker、artifact 一致、rebuild alias swap、旧 provider 查询和撤销；
cache generation 从 2 前进到 3。冲突启动前后真实 Scanner durable config
快照相等，且启动以精确冲突错误拒绝。五个 owned 容器均停止，历史数据保留。
receipt 绑定实际 Rust binary、Edge source/compiled JS 和本地 adapter hashes；
源码提交与版本包另由发布清单绑定，不把本记录当作云或生产部署证据。
最终 `sql-gates-final-03` 已实际运行并通过两份 ignored PostgreSQL gates；
普通单元测试中仍标为 ignored 的结果不被用来替代该证明。

`run-06`、`run-07` 的 Docker output 关闭失败同样保留。后者定位为 exec 包装
进程 exit=0，但双路 reader task 未完成。Windows PowerShell 同步匿名 pipe 的
`ReadToEndAsync` 会占用 ThreadPool worker；受控限制为 12 workers、六个长驻
双路 reader 时 available worker=0，只读 Docker inspect 复现同一失败形态。
改为每个 pipe 专属 LongRunning 背景 reader 后，相同限制下短进程双路输出、
正常 owned 清理和完整 run-08 通过；没有延长 Docker/pipe timeout。这是本地
调度问题的复现和修复证据，不是对任意继承 pipe、异 binary 子进程或异常 reader
取消的证明；每个重定向进程仍使用两个 reader threads。
