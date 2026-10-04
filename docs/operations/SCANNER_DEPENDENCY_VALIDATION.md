# Scanner 本地真实依赖验收

## 已验证范围

2026-10-04 UTC，Windows x64 的 release Scanner 和 Outbox，通过本机 Docker
Desktop Linux 的独立 PostgreSQL、NATS JetStream、MinIO 以及真实 ClamAV，完成
Artifact 扫描与对象晋升闭环。没有运行 Web/API 上传、账号交换、提交审核或发布流程。
数据库记录和 quarantine 对象由测试脚本直接创建，不代表上传 API 验收。

| 场景 | 实际结果 |
| --- | --- |
| ClamAV 连接不可用 | `malware_scanner_unavailable`，1 次 retry；状态仍为 `uploaded`，无 published key、无 verified event |
| 重启本轮 Scanner 并恢复 ClamAV 地址 | 同一 durable consumer 自动重投；第 2 次扫描 verified，签名/Manifest/SBOM/provenance 证据齐全，MinIO 已存在摘要寻址对象 |
| 对同一 Artifact 再发一个新 event ID | consumer ACK 序号从 2 到 3、stream ACK 从 1 到 3；pending/ack pending 均为 0；扫描次数仍为 2，verified event 仍为 1 |
| 原始摘要正确但不是 ZIP 的无害文件 | `manifest_invalid`，quarantined，无 published key、无 verified event，1 个 quarantined event |
| 随后的正常签名 ZIP | 首次扫描 verified，使用相同 canonical published key，证明拒绝异常包后可继续处理 |
| 清理 | 本轮 native workers 已退出、scanner 临时目录为空、3 个自有容器已停止；共享 4 个依赖仍 running/healthy |

恢复使用的是重启测试 worker 来替换故障注入地址，不是停止/重启共享 ClamAV，
也不是进程热重载配置测试。只使用无害合成夹具，不执行 ZIP 中的内容。

成功 run：`al-scan-20261004035706-4e4ef0`。本地完整证据：

```text
C:\Users\Public\nas_home\AI\GameEditor\linshi\assetlibrary-scanner-dependency-20261004\run-20261004-035706
```

关键文件为 `runtime-result.json`、`cleanup.json`、`post-run-state.json`、
`resources.json` 和脱敏 `logs/`。版本包只复制明确允许的证据，不包含
`local-only.env`、数据库/MinIO 数据或其他凭据。

Scanner SHA-256：
`7ad447558af9939cb7436cdc9f7e2418fa905171e88a4035988d3fbe633c680a`。
Outbox SHA-256：
`4446bb63a8f65e37f9df08e844791cb498932c171617f6c93b53b9a6ef02310a`。
ClamAV 实际响应：`ClamAV 1.5.4/28142/Sat Oct  3 06:24:16 2026`。
这不是今后运行时病毒库新鲜度的保证。

## 可复现入口与安全边界

先 locked release 构建 Scanner、Outbox 和无害 fixture example。脚本只使用显式指定的
已安装 image ID，`--pull=never`；重新运行时应核验本机镜像身份，而不是猜测远端标签。

```powershell
rtk proxy cargo build --locked --release -p assetlibrary-scanner-worker -p assetlibrary-outbox-worker
rtk proxy cargo build --locked --release -p assetlibrary-scanner-worker --example build_signed_fixture

.\scripts\Test-ScannerIsolatedRuntime.ps1 `
  -EvidenceDirectory 'C:\Users\Public\nas_home\AI\GameEditor\linshi\scanner-new-run' `
  -PostgresImage sha256:f372eda99ac2ea249c3dce566dcdf468397035371284d2cf2103b4bc52b3b39e `
  -NatsImage sha256:a10e008495467f740bfaa354ef3e6cee8decfe44b9546638f7511e20066d46de `
  -MinioImage sha256:9d668e47f1fc60ea49af4203deee87a657eb1aa0e2761fee2c7c2d1df282c880 `
  -ClamAvPort 3310
```

- `EvidenceDirectory` 必须不存在且位于指定 `linshi` 下。每次生成唯一容器/网络名和
  随机本地凭据，不读项目 `.env`，不覆盖共享 signing key 或已有数据库。
- 数据 bind 到本轮目录；migrations 和 fixtures 只读挂载。所有 16 个 migrations
  只应用到新测试数据库，不是正式数据库迁移。
- 独立 bridge 网络，宿主端口只绑定 `127.0.0.1`；**不是出站网络隔离**。
  Docker 29.5.3 的 `--internal` 网络没有实际发布这些宿主端口，不能据此声称有隔离沙箱。
- readiness 使用 PostgreSQL TCP，避免将 initdb 的临时 Unix-socket 服务误判为最终服务。
- native worker 清空继承环境后只注入本轮所需配置；ClamAV 仅借用其扫描/版本端口，
  不修改配置、病毒库或服务状态。Docker 命令有 45 秒截止时间，条件轮询有界。
- `Environment.ps1` 只负责本轮资源生命周期；`Fixture.ps1` 只负责测试数据库、对象、
  事件及断言查询；入口脚本编排场景。没有增加生产行为或依赖例外。
- finally 按 owner label 停止容器、按已持有进程对象停止 worker，保留容器、网络和
  数据，不执行 prune、rm 或删除卷。成功必须同时满足 runtime 与 cleanup passed。
- 本次前两轮分别因内部网络端口和 PostgreSQL 初始化 readiness 失败，失败证据保留；
  修复后完整重跑成功，没有将失败标记为通过。三轮共 9 个测试容器全部停止并保留。

PG/MinIO 的 `1g`、NATS 的 `256m` 和每容器 1 CPU 只是 Docker 配置限制，
不是实测峰值 RSS、CPU 或性能数据。测试目录中的随机凭据仍需当作本地敏感文件保管。

## 尚未验收

Linux Scanner worker、OS job/cgroup/硬资源限制、父进程突然崩溃回收、ZIP/JSON 峰值
内存、PG/NATS/存储中断、真实恶意样本、整栈容量、托管数据库、TLS/服务身份、真实
账号、Web/API 全链路、审核发布、Edge/Cloudflare 和生产恢复均不在本次证明范围。
App Update 与 production eligibility 保持关闭。后续部署地点与托管商仍需确定，
不能因本地链路通过就创建付费资源、迁移真实数据或推进云端发布。
