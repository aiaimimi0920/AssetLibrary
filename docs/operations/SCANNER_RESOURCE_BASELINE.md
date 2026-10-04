# Scanner 检查子进程资源基线与 SBOM 生命周期优化

## 结论与严格范围

2026-10-04 UTC，在 Windows 11 build 26200、i5-12400F（12 逻辑处理器）、
Rust 1.95.0 / x86_64-pc-windows-msvc 上，单并发、每种夹具各运行 3 次。
测量对象仅为 `--inspect-local` 子进程，不包含生成夹具的进程、父 Scanner、
Outbox、ClamAV、API、数据库或整栈开销。不是 Linux RSS 或部署规格建议。

生产修改只有一处：在确认 SBOM 的 `bomFormat` 后立即 `drop(sbom)`，只保留摘要，
避免继续解析 provenance 时同时保留两棵完整 JSON 树。没有跳过字段校验、
摘要计算或后续签名/杀毒，也没有改变大小限制、返回合同或错误码。

| 无害夹具 | 优化前峰值工作集 | 优化后峰值工作集 | 优化后耗时范围 | 检查结果 |
| --- | ---: | ---: | ---: | --- |
| 普通签名包，6 条目，1,675 bytes | 9.21 MiB | 9.23 MiB | 71.6–95.1 ms | 成功 |
| 10,000 条目，1,461,398 bytes | 14.40 MiB | 14.43 MiB | 2,399.5–2,450.3 ms | 成功 |
| SBOM 与 provenance 各 8 MiB − 1 byte，每份 50,000 个 component 对象 | 101.66 MiB | 59.32 MiB | 318.7–400.8 ms | 成功 |
| SBOM 8 MiB + 1 byte | 9.12 MiB | 9.15 MiB | 99.7–139.8 ms | `attestation_missing`，保持既有映射 |
| 非 ZIP 的 17-byte 文本 | 8.75 MiB | 8.76 MiB | 98.0–145.2 ms | `manifest_invalid` |

表中内存取每组 3 次的最大 OS 峰值。大 JSON 场景从 106,594,304 bytes
降至 62,201,856 bytes，减少 **41.65%**。其他场景的细小差异不解释成性能收益。
不能将该降幅推广为 Scanner、服务组合或任意 JSON 形状的内存降幅/上限。
耗时受机器负载和文件缓存影响，不作为 SLO 或 CPU 加速结论。

前后所有夹具 SHA-256 一致，**15 对完整 `inspection-result.json` 逐字节一致**，
包括正常包的 Manifest/签名/双摘要/SBOM/provenance 摘要与异常包的错误结果。
JSON 和多条目变体使用 Stored ZIP，避免用高压缩比掩盖工作负载；夹具内容从不执行。

## 测量方式与复现

`scripts/scanner-runtime/ResourceMetrics.ps1` 在创建进程后保留其 OS handle，
退出后调用 Windows `GetProcessMemoryInfo.PeakWorkingSetSize`，获取该进程生存期
峰值，而不是用低频采样峰值冒充真实峰值。缺失/零值直接失败，不写估算值。
CPU 来自进程 user+kernel 时间，Windows 计时粒度可能产生 0 或 15.625 ms 步进。
耗时包含进程启动和等待退出。报告的 `workspace_final_file_bytes` 是检查完成时
工作区逻辑文件大小，**不是临时磁盘峰值或磁盘实际分配量**。

```powershell
rtk proxy cargo build --locked --release -p assetlibrary-scanner-worker
rtk proxy cargo build --locked --release -p assetlibrary-scanner-worker --example build_resource_fixtures
.\scripts\Measure-ScannerInspection.ps1 `
  -EvidenceDirectory 'C:\Users\Public\nas_home\AI\GameEditor\linshi\scanner-resource-new-run' `
  -Repetitions 3
rtk proxy cargo build --locked --release -p assetlibrary-scanner-worker --example build_signed_fixture
.\scripts\scanner-runtime\Test-ResourceCleanup.ps1 `
  -EvidenceDirectory 'C:\Users\Public\nas_home\AI\GameEditor\linshi\scanner-cleanup-new-run'
```

目录必须全新且位于指定 `linshi` 内；运行次数限制为 1–5，检查进程最多 30 秒，
超时后终止并等待退出。环境清空后只传递 Windows `SystemRoot`；不连接真实依赖。
终止后的等待未确认退出时测量失败；即使状态查询或终止失败也释放进程 handle。
报告写入失败仍恢复调用会话的 `TEMP`/`TMP`。这不保证 OS 拒绝终止时进程已退出。
聚焦清理脚本实际注入 31 秒睡眠子进程和只读报告文件，验证 30 秒超时后的退出、
12 次缺失 EXE 的失败路径、写入失败后的环境恢复，以及随后正常签名 ZIP 的检查。
进程 handle 释放由嵌套 `finally` 保证并经过源码交叉核验；不把整个 PowerShell 的
handle 总数变化当作单个检查进程的泄漏证明。
`-ScannerBinary` 和 `-FixtureBinary` 可显式选择另一版本用于同机对比；报告记录两者
SHA-256。测试数据和结果保留，不删除已有目录。该脚本不是 OS 配额或父进程崩溃保护。

本次证据根目录：

```text
C:\Users\Public\nas_home\AI\GameEditor\linshi\assetlibrary-scanner-resource-20261004
```

- `run-20261004-041449/resource-result.json`：优化前 15 次测量。
- `optimized-20261004-041659/resource-result.json`：优化后 15 次测量。
- `comparison.json`：逐字节一致性、测量差异、OS/CPU/编译器。
- `verification.json`：相关回归与重新运行真实依赖链路的证据路径。

基线源码提交为 `05e94ffa9c70d1bd57c2902c478a675103244613`。
优化前 Scanner SHA-256 为
`7ad447558af9939cb7436cdc9f7e2418fa905171e88a4035988d3fbe633c680a`；
优化后为
`5df4a7a97d84b0566fc61383a2d50b2f16d978453c3b864bb0a81f584f22598d`。
优化源码、测量脚本与工具链通过版本包及 Git 提交绑定。

## 仍未证明

这不是完整资源预算：任意 ZIP 中央目录/JSON 形状的最坏峰值、Linux worker、
ClamAV/整栈资源、并发负载、临时磁盘峰值、硬 CPU/RSS/磁盘限制，以及父进程崩溃
回收仍需独立验收。保持签名、杀毒、审核和 App Update 的原有准入边界。
