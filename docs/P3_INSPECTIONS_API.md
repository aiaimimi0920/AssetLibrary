# P3.1：可恢复的受限内容检查

## 状态与责任边界

P3.1 实现上传后的检查任务和 `art-png-rgba8-v1` 格式策略，支持受限的静态 PNG Art 对象。P3.3a 新增明确的 `art-zip-manifest-v1` 多文件策略，合同见 [P3_ART_PACKAGE_API.md](P3_ART_PACKAGE_API.md)。这两种策略均不是通用解码器、恶意内容扫描器或最终发布政策。

P3.3b 增加第三种 `art-zip-clamav-v1` 复合策略，完整合同、`result.scan` 身份/时效和云拒绝门禁见 [P3_CONTENT_SCAN_API.md](P3_CONTENT_SCAN_API.md)。复用同一任务而非给旧格式事实追加通过标记。

检查结果 `passed` 仅表示此策略通过。上传仍是 `quarantined`，本检查 API 始终返回 `publicationEligible: false`。后续 P3.2 已提供独立审核决定和版本快照绑定，但必要内容安全检查、成功发布和下架尚未完成；下载也没有开放。不得因格式通过或人工批准而跳过必要检查。

## 接口与授权

| 方法与路径 | 输入 | 行为 |
| --- | --- | --- |
| `POST /v1/uploads/{id}/inspection` | `application/json`；`{}` 或明确 `policy` | 仅上传 owner；新任务 201，同策略既有任务 200，不同策略 409 |
| `GET /v1/uploads/{id}/inspection` | 无 | 仅上传 owner；当前任务、历史结果及当前绑定有效性 |

身份遵循 [P1_API.md](P1_API.md)，每次请求重新验证 JWT。目录读成员和无关主体不能创建或查询任务，统一返回 404。只允许可选 `policy` 字段；省略时为 PNG，明确值只能是上述三种已实现策略，未知值返回 422。客户端不能指定状态、尝试次数、对象键或检查结果。

POST 要求活动草稿 Art 资源和已经完成的 `quarantined` 上传。PNG 上限 1 MiB，ZIP 上限 8 MiB；超过所选策略上限的首次申请返回 `422 INSPECTION_SIZE_UNSUPPORTED`。已有任务请求不同策略返回 `409 INSPECTION_POLICY_CONFLICT`，不重置事实。Capability、应用包返回 `422 INSPECTION_POLICY_UNAVAILABLE`，未完成或取消的上传返回 `409 INSPECTION_NOT_ELIGIBLE`。

每个上传最多一份任务，不要求额外幂等键；唯一约束及事务保证并发 POST 不重复排队或写审计。终态重复请求返回既有结果，不自动重启，也不重置已经消耗的次数。需要新上传身份时使用正常上传流程，当前没有无限内部重试或任意管理员重置 API。

结果的关键字段：

```json
{
  "id": "UUID v4",
  "uploadId": "UUID v4",
  "policy": "art-png-rgba8-v1",
  "state": "passed",
  "revision": 3,
  "attempts": 1,
  "nextAttemptAt": 0,
  "bindingCurrent": true,
  "error": null,
  "result": {
    "format": "png",
    "width": 1,
    "height": 1,
    "bitDepth": 8,
    "colorType": 6,
    "decodedBytes": 5,
    "bytesRead": 68,
    "sha256": "64位小写hex",
    "elapsedMs": 1
  },
  "checkedIdentity": {
    "uploadRevision": 2,
    "size": 68,
    "sha256": "64位小写hex",
    "etag": "R2对象etag"
  },
  "publicationEligible": false
}
```

字节数和耗时仅为示例。`elapsedMs` 是读取、摘要和检查的本地经过时间，不是 Worker CPU 消耗、计费指标或性能保证。

## 格式及资源限制

- 输入最多 1,048,576 字节；策略只接受 8-bit RGBA（color type 6）、非交错、标准压缩/过滤方法。
- 宽高为 1–2048，像素总数不超过 1,048,576；解码行数据含每行 filter，最大接受输出为 4,196,352 字节。
- 最多 64 chunks，只接受首个 IHDR、连续 IDAT 和最后一个零长度 IEND；每块检查长度及 CRC。拒绝 IEND 后附加字节。
- 不接受文本/私有元数据、APNG、其他颜色类型、其他位深或未知 chunk。部分普通合法 PNG 因本策略较严格也会被拒绝；不能描述为完整 PNG 标准支持。
- 原生 `DecompressionStream('deflate')` 验证 zlib，并逐段限制输出总量、逐行 filter 值和最终解码长度；截断、额外压缩流尾部、超长解码和不合法 filter 均拒绝。

R2 条件 GET 绑定 etag，并核对实际大小、原生摘要及实际读回字节的 SHA-256。PNG 输入缓冲上限为 1 MiB，ZIP 为 8 MiB，仅存在于检查任务，不改变流式上传、元数据查询或未来下载的职责。ZIP 只在内存按条目处理，不向文件系统展开归档、不执行上传内容，也没有新增生产依赖。

对象读取有 30 秒取消计时器，reader 和 timer 在退出路径清理。该计时器不保证 R2 GET、同步计算或整项任务在 30 秒内结束。输出限制在原生解压器返回块后检查，不能据此断言已测得原生内部内存峰值；云端 CPU/内存与高压缩比压力验收仍未完成。

## 任务、事务和恢复

`db/0003_inspections.sql` 增加 `inspections` 与 `inspection_events`。任务快照绑定 upload revision、大小、SHA-256 和 etag，不只绑定文件名或客户端声明。

状态为 `queued → running → passed/rejected/invalidated/failed`。临时基础设施故障可从 running 回 queued；格式错误进入 rejected。每项最多三次领取执行，每次两分钟租约，失败后一分钟退避；running 的过期租约可回收，中断不会无限重试。

每分钟现有 Cron 先进行 P2 对账，再顺序执行最多三份内容检查。使用到期索引查询，不全桶扫描。D1 本身不可用时整轮可失败，后续定时触发再恢复。

排队、领取、完成均将状态与审计放在同一 D1 batch。唯一 operation 标记保证 CAS 零行不增加幽灵审计。完成还要求当前 running、同一 lease token、未过期租约；旧执行者不能覆盖新执行者。

领取和结果提交在事务内检查当前资源与上传快照。上传取消、资源删除或绑定变化后，待执行/正在执行的任务只能收敛到 invalidated，不能留下成功结果；第三次执行中断后的回收也优先检查失效，而不是直接记重试耗尽。

已经完成的 passed 是历史事实，后续取消不会重写它。GET 从 D1 primary 同时计算 `bindingCurrent`；取消或资源删除后立即为 false。这个字段只说明 D1 绑定一致，不证明此刻的云端 R2 仍存在，更不能代替未来发布事务的最终准入。

## 外部资料与当前验收

2026-10-04 本轮联网核对 [W3C PNG 第三版](https://www.w3.org/TR/png-3/)、[WHATWG Compression Standard](https://compression.spec.whatwg.org/)、[Workers Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/) 和 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。实际实现是较窄的业务策略，不把标准全文当成已实现合同。

P3.1 本地验收与候选身份见 [P3_INSPECTIONS_VALIDATION.md](P3_INSPECTIONS_VALIDATION.md)，后续版本和审核见 [P3_VERSIONS_API.md](P3_VERSIONS_API.md)。成功发布和更广的包体策略必须继续开发并独立验收；本阶段不部署或开通云服务。
