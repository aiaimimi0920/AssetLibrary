# PG + Edge-only 候选组合的分组件资源基线

## 本批结论和范围

2026-10-04 UTC，本地 Windows x64 实际完成一次无害签名 Art ZIP 的上传、
Scanner 验证、独立审核发布、PG 搜索、同包下载和自动撤销，并观测空闲、
上传扫描和两个客户端查询三个阶段。原有失败关闭、503 自然重投及未过期旧票据
拒绝门禁没有被资源观测绕过。此轮没有运行 OpenSearch、Valkey 或 ClickHouse。

这是一份**候选分组件基线**，不是完整小规模部署 profile、全栈峰值、生产预算或
100 用户容量证明。没有选定托管商或部署地点，没有修改默认 Compose/Helm，
没有创建云资源、配置真实账号或迁移数据。App Update 和生产准入继续关闭。

成功 run：`al-art-20261004091809-7690ff`，artifact：
`e145fdac-4cde-48bf-85b4-16209398e2da`。本地原始证据：

```text
C:\Users\Public\nas_home\AI\GameEditor\linshi\assetlibrary-small-candidate-20261004\run-02
```

`runtime-result.json`、`candidate-resources.json` 和 `cleanup.json` 均通过。
源码提交、tree、EXE 来源和文件摘要由本批不可变版本包的 manifest 绑定；
本轮没有修改 Rust 生产代码，复用上一 `edge-policy-0.1.0-local-20261004-081042`
版本的相同 EXE 字节，不把它称为 fresh Rust build。

## 环境、负载和计量口径

- Windows 11 build 26200，Intel i5-12400F，12 个逻辑处理器。
- native：API、Scanner parent、Outbox、Edge-only indexer、本地 Node Edge adapter。
- Docker Desktop：本轮独立 PG、NATS JetStream、MinIO，固定本机 image ID；每个容器
  配置 `--cpus=1`。这是测试调度配置，不是实测需求或生产 CPU 预算。
- 共享 ClamAV：`ClamAV 1.5.4/28142/Sat Oct  3 06:24:16 2026`，只借用 loopback
  3310，不停止该服务。此处版本响应不保证后续运行时病毒库仍新鲜。
- 单个 ZIP 为 1675 字节，raw SHA-256 为
  `cc3ff5d14647c2a774e912e3054ad1a97e5cdb30555c5948629587274242bbbb`，
  canonical SHA-256 为
  `4e9e1fd1dc7fe5b9c8b83922469a25a3b03bd096b5f8a68ec7fd56c4b294b425`。
- 发布后两个 gated 客户端各读取 10 次，间隔 100 ms；所有 20 个 HTTP 200 响应
  仅含本轮 package，客户端请求窗口实际重叠。不是 SQL 执行重叠或真实用户压力证明。
- 资源观测窗口约 27 秒。idle 含 3 秒等待和前后 Docker collection；上传扫描和
  查询阶段也包含 collection 开销，不把整个阶段时长称为纯扫描/纯查询时长。

native sampler 持有并核对本轮 PID/executable，约每 100 ms 读取 Windows
`WorkingSet64`、`PrivateMemorySize64`、`PeakWorkingSet64` 和累计 CPU time。
`sampled_max_*` 是采样最大值，可能漏过短峰；`os_lifetime_peak_*` 是截至该样本的
进程生命周期峰值，不是该阶段的独立 OS 峰值。CPU delta 是阶段首末样本累计 CPU
之差，不是 CPU 使用率；计时粒度可能让短阶段显示 0。

Docker 每阶段只取前后两次 `docker stats --no-stream`。保留 raw memory/CPU
display，并按显示精度解析 `parsed_display_memory_bytes`；这不是精确 kernel
bytes、Windows working set 或 RSS。`collection_start_utc`/`collection_end_utc`
是 collector 调用窗口，`collector_received_utc` 是接收时刻，不冒充 daemon 的
准确采样时刻。显示的 memory limit 也不是资源需求或完整 VM 容量。

## 实测结果

以下 MiB 为 bytes / 1048576，四舍五入至两位。**不将各组件最大值相加**；
它们不是同一时刻、同一种口径，也不包含完整系统。

### Windows native：采样最大工作集 / private bytes

| 组件 | idle MiB | upload-and-scan MiB | two-client-query MiB |
| --- | ---: | ---: | ---: |
| API | 15.19 / 3.15 | 18.93 / 3.59 | 19.51 / 3.84 |
| Scanner parent | 14.63 / 3.02 | 18.68 / 3.82 | 18.73 / 3.73 |
| Outbox | 12.08 / 2.56 | 12.32 / 2.59 | 12.34 / 2.61 |
| Edge-only indexer | 12.39 / 2.61 | 12.42 / 2.61 | 14.38 / 3.03 |
| 本地 Node Edge adapter | 60.64 / 56.75 | 59.63 / 54.45 | 62.86 / 57.80 |

每组件各阶段有 48、41、34 条样本。Scanner 数字**仅为 parent**；短命 inspector
child 未被本轮 sampler 纳入，不能将 18.68 MiB 称为整个扫描峰值。
Node adapter 不是生产 Cloudflare Worker 的资源估算。

### Docker：两次 CLI 显示 memory 的最大值

| 组件 | idle MiB | upload-and-scan MiB | two-client-query MiB |
| --- | ---: | ---: | ---: |
| PostgreSQL | 36.93 | 43.61 | 55.37 |
| NATS | 5.62 | 5.18 | 5.27 |
| MinIO | 223.00 | 224.00 | 224.10 |

每组件只有每阶段两条观察值，这不是连续监控峰值。CPU 的原始 CLI 百分比、native
CPU delta、生命周期 peak、容器身份/image ID、phase UTC 范围和全部样本保存在
`candidate-resources.json`，不把百分比与累计 CPU 毫秒混合计算。

20 次本地查询耗时平均 8.25 ms，最小 5.85 ms，最大 14.95 ms；包括客户端响应
buffer/read，不包含请求间隔，不代表 100 用户容量、托管数据库时延或生产 SLO。
最后 Scanner 临时目录逻辑文件大小为 0 字节；这是清理结果，不是磁盘峰值。

## 复现、边界与失败记录

在 [Art 验收入口](ART_ISOLATED_FLOW_VALIDATION.md) 的前提与固定本机 image IDs
下，对新目录运行：

```powershell
.\scripts\Test-ArtIsolatedRuntime.ps1 `
  -MeasureResources `
  -EvidenceDirectory 'C:\Users\Public\nas_home\AI\GameEditor\linshi\candidate-new-run' `
  -PostgresImage sha256:f372eda99ac2ea249c3dce566dcdf468397035371284d2cf2103b4bc52b3b39e `
  -NatsImage sha256:a10e008495467f740bfaa354ef3e6cee8decfe44b9546638f7511e20066d46de `
  -MinioImage sha256:9d668e47f1fc60ea49af4203deee87a657eb1aa0e2761fee2c7c2d1df282c880

.\scripts\art-runtime\Test-Resources.ps1 `
  -EvidenceDirectory 'C:\Users\Public\nas_home\AI\GameEditor\linshi\candidate-contract-new'
```

`-MeasureResources` 不能与 OpenSearch/Valkey rollback 参数同轮使用，以免将旧依赖
混入候选报告；旧模式回退证据仍见 [Edge-only 手册](INDEXER_EDGE_POLICY_MODE.md)。
sampler 上限 30000 条样本；查询每请求 2 秒、响应 buffer 64 KiB、总 deadline
15 秒。禁用自动 redirect/proxy/cookies；失败或 deadline 取消两客户端并检查任务
结束。极端底层调用不响应取消时明确失败，不声称该异常分支已动态证明成功回收。

`contracts-05` 实际验证 memory display 单位/溢出、foreign identity 拒绝、native
计数、gated 查询、指定 deadline、302 不跟随、503 失败、任务 drain 与无后续请求。
contract 只使用本轮 loopback fixtures，不调用真实 Docker 或 AssetLibrary。
初版 `run-01` 通过后，复审修复了持续取消、重定向与子报告先写 passed 的问题；
它不是最终源码证明。`contracts-01` 的 node 路径选择失败、`contracts-04` 的异常
链识别失败均保留；后者改为读取 aggregate/inner exception 消息后通过，不掩盖失败。

最终运行须联合读取 runtime、resource 和 cleanup receipts。资源报告仅在 sampler
Dispose 成功后写入，资源观测错误不会跳过 owned 环境清理。只停止本轮 worker 和
owner-label 核对的容器，保留数据/容器/网络，不 prune/delete，不动共享 ClamAV。
bridge 复用延续现有入口边界：并非原子独占网络或阻止 outbound 的 sandbox。

**未测**：inspector child、共享 ClamAV、Docker Desktop VM/collector、Next.js Web、
账号服务、磁盘峰值、下载带宽、完整队列恢复负载、较大目录/包、多客户端更新、
Linux/托管/云运行和组合同时峰值。不能比较本轮与旧 full 模式得出资源降幅，
不能批准最低机器规格、生产预算或可删组件。小规模 profile、托管 TLS/权限/备份
恢复、故障验收与容量证明仍是后续独立任务。
