# Loom 下载联合验收与正式交付缺口

2026-10-16，恢复 Session `01a13f19-31ed-7121-86e0-3cb7a7cdbd0d` 的最后目标：
已部署可运行的 AssetLibrary，以及能连接平台下载内容的 Loom。
**本轮完成跨仓库功能联调；该整体目标尚未完成，不能将本地通过写成线上成功下载。**

## 本轮实际执行

AssetLibrary 新增 `scripts/verify-loom-download.mjs`；Loom 增加显式运行的
`asset_library_worker_download_contract` 测试。二者直接联调真实 Worker、D1/R2
业务与 Loom `asset_library/download.rs`，不再仅以手写 HTTP 响应代替服务。

```powershell
rtk proxy node scripts/verify-loom-download.mjs C:/Users/Public/nas_home/AI/GameEditor/Neuro/Loom
```

命令从 AssetLibrary 仓库执行，Loom 参数必须指向包含该联合测试的独立源码仓库。
不进入默认测试；普通 `cargo test` 会明确忽略需要外部夹具的测试，联合脚本通过
`--ignored` 显式执行并检查确实有一项通过，而不是把零项测试当成功。

三类包 Art、Capability、Application 各完成以下场景，共九项通过：

1. 实际 HTTP 上传 → 格式检查 → 独立身份审核 → 发布 → 授权；Loom 通过正式
   下载函数申请票据、接收流、核验长度/SHA-256 并生成唯一 ZIP 文件。
2. 撤销授权后，Loom 实际请求得到 404，不生成下载目录或文件。
3. 恢复授权并下架后，Loom 实际请求得到 404，不生成下载目录或文件。

明确的本地假设：使用现有 trial 的虚构身份、合成 AV、假设部署准入；仅回环监听，
独占 D1/R2 状态，结束关闭所属运行时并保留证据/数据。未改正式 origin、凭据存储、
scanner 门禁或线上资源。新 Rust 入口仅在 `cfg(test)` 下编译。

最终回执：`../../linshi/assetlibrary-local-trial-LURd8b/loom-integration.json`。
其中记录九项结果、Worker 原始产物摘要与 Loom 下载模块源码摘要；各阶段保留 cargo
输出。先前运行的 `assetlibrary-local-trial-gX0rri` 也保留，最终以带源码摘要者为准。
普通 Loom 聚焦测试为 4 passed、1 ignored；该 ignored 项由上述联合运行实际执行九次。
编译保留已有 `OtterCanvasDocument::read` dead_code 警告，不称零警告。

## 线上独立读回

只读回执：`../../linshi/assetlibrary-live-resume-20261016-052741/readback.json`。

| 路径 | 实际结果 |
| --- | --- |
| `/healthz` | 200，`0.4.6` / `84d29682e03c27e81a50a414019e97094e89f353` |
| `/readyz` | 200，identity/database/storage available；distribution blocked |
| `/v1/catalog` | 503，`SCANNER_CLOUD_NOT_VALIDATED` |

**不是仅配置 scannerService 即可完成。** `src/publications/admission.ts` 当前
无条件拒绝生产准入，`src/versions/safety.ts` 固定 `cloudValidated:false`；`.sba`
只绑定已有 scanner，不部署/验收 Container，也不实现证据满足后的生产激活。

正式交付仍需三个明确阶段：同一 scanner 候选的有效生产验收；实际部署及绑定该
候选；实现并验证基于已完成验收的生产激活合同，然后通过 SpringBok 升级并验收
真实上传、独立审核、授权及 Loom 下载。现有延期安全/网络项没有被本轮测试关闭，
不得以环境布尔值、预置 publication 或删除拒绝函数替代这些阶段。

## 桌面包边界

原会话留下的 `../release/Loom/manual-20261016-cloud-download-r2` 本轮重新核验
`checksums.sha256`，50 项匹配。这是既有包完整性复核，不是本轮重新编译。
其 manifest 的源 SHA `18b66358af68bcf951c45906033adf44e9e574d0` 在当前 Loom
仓库不可解析，因此不能把它宣称为当前 HEAD 的构建证明；后续最终交付仍需固定
已核对源码并生成对应包。用户现有 Loom/daemon 未被关闭、替换或另起正式实例。

本轮没有提交、推送或部署；保留 AssetLibrary 已有 Dockerfile 改动及 Loom 其他
投屏/连接相关未提交修改，不将它们混入本轮验收结论。
