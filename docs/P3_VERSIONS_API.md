# P3.2：不可变版本、独立审核与发布拒绝门禁

## 本轮范围和停止条件

P3.2 实现 owner 将已通过受限检查的上传绑定到不可变版本，独立 reviewer 批准或拒绝，owner 撤回，以及失败关闭的发布请求。P3.3a 允许明确的 `art-png-rgba8-v1` 或 `art-zip-manifest-v1` passed 事实绑定，PNG 最多 1 MiB，ZIP 最多 8 MiB；ZIP 合同见 [P3_ART_PACKAGE_API.md](P3_ART_PACKAGE_API.md)。本地真实 Worker/D1/R2 闭环证明权限、并发、重复请求、审计回滚和绑定失效不会产生错误批准或发布。

P3.3b 也允许 `art-zip-clamav-v1` passed 绑定，版本增加 `contentSafety.scan/scanCurrent/cloudValidated`。有效 clean 仍被 `SCANNER_CLOUD_NOT_VALIDATED` 硬拒绝；过期和历史批准分开计算。详见 [P3_CONTENT_SCAN_API.md](P3_CONTENT_SCAN_API.md)。Linux 本地和获准的隔离云完整业务链已通过；生产资源/网络隔离、完整供应链及签名更新准入仍缺，见 [云验收](P3_CLOUD_SCAN_VALIDATION.md)。

本文件保留 P3.2 原始切片边界。后续 `.16` 已提供私有 Web，`.17` 已新增独立 publication 和授权分发业务核心；版本读取增加 publication 管理摘要，见 [P4_DISTRIBUTION_API.md](P4_DISTRIBUTION_API.md)。实际生产发布、下载、真实身份接入和部署仍未完成。ZIP/PNG 格式检查和人工批准不能替代缺少的安全策略，format-only 无放行开关。

## 版本与权限

版本冻结资源 revision/title/kind、上传 revision/size/SHA-256/etag、inspection id/revision/policy。标签为 1–64 字符，首字符为字母或数字，其余仅字母、数字、`.`、`_`、`-`；它是资源内唯一标签，不宣称实现完整 SemVer。标签及绑定不能修改，也不能撤回后重用。

创建要求当前 owner、活动 Art 草稿、已完成隔离上传及当前绑定的 passed inspection。创建直接进入 `pending_review`；版本自身 revision 从 1 开始。

审核者来自部署者设置的 `REVIEWER_PRINCIPALS` JSON 字符串数组，最多 32 个不同的合法 PrincipalRef，编码最多 8192 字符。配置缺失或非法时审核写接口返回 503；不采信请求头、JSON 或 JWT 自报角色。每次审核重新验证身份和配置。owner 即使在名单中也不能自审；目录读成员没有版本查看或审核权限。owner 和有效名单中的 reviewer 可以按已知 id 读取版本事实，但本轮没有审核目录或隔离文件下载。

名单是当前部署级审核权限，不是资源成员角色。API 记录审核者提交的决定，不证明其在本系统中实际查看了文件；本轮没有审核工作台或内容预览。审核不重新读取 R2，不将决定记录当成新的文件安全证明。

## 接口

| 方法和路径 | JSON 输入 | 行为 |
| --- | --- | --- |
| `POST /v1/resources/{id}/versions` | `label`, `uploadId`, `resourceRevision` | owner 创建；首次 201，完全相同绑定重放 200 |
| `GET /v1/versions/{id}` | 无 | owner 或配置的 reviewer 查看快照、历史审核及当前绑定 |
| `POST /v1/versions/{id}/review` | `revision`, `decision`, `reason` | 独立 reviewer；decision 为 `approved` 或 `rejected`，reason 为 1–500 字符非空说明 |
| `POST /v1/versions/{id}/withdraw` | `revision` | owner 撤回 pending/approved/rejected 版本 |
| `POST /v1/versions/{id}/publish` | `revision` | owner 请求；本轮始终拒绝，不写 published 事实 |

输入遵守 P1 的有界 JSON、严格字段和 UUID/revision 规则。版本接口不用额外幂等键：创建用资源内唯一 label 固定请求身份，标签相同但任何绑定输入不同返回 409。创建重放仍先验证活动资源 owner；上传取消或版本撤回不会重置已有版本，资源删除后创建请求则返回 404。审核和撤回用 revision CAS；失去响应后的完全相同决定可重放一次成功结果，不增加 revision 或审计，不重新审批终态。reason 去除首尾空白后比较；不同审核者、不同理由、相反决定或后续撤回不算同一重放。重放也不跳过当前 reviewer 配置及自审检查。

审核批准在同一 D1 原子批次内重新检查资源和上传快照、passed inspection 的身份，以及当前 pending 状态/revision。拒绝仅关闭 pending 版本，不要求失效对象重新恢复；撤回可以保留已经失效版本的历史。状态及成功审计同批提交，CAS 零行不写幽灵审计，审计失败整批回滚。

## 历史事实与当前准入

GET 的 `bindingCurrent` 是 D1 primary 中的快照一致性，不证明此刻 R2 存在。资源元数据、成员权限变更都会递增资源 revision，因此本轮采取保守合同：任何资源 revision 变化使版本绑定失效，需要新标签及新审核。取消上传或删除资源立即使该字段为 false，不重写历史批准。

`review` 保留审核者、决定、理由和时间；withdrawn 不抹掉此前审核记录。`publicationEligible` 固定 false，`publicationBlockers` 总包含 `REQUIRED_CONTENT_CHECK_UNAVAILABLE`，并按当前状态/绑定增加 `VERSION_NOT_APPROVED`、`VERSION_BINDING_CHANGED`。

publish 按当前 owner、revision、approved 和当前绑定检查，最终仍返回 `409 REQUIRED_CONTENT_CHECK_UNAVAILABLE`。没有 published 状态、成功发布审计、公开对象复制或下载路径。后续实现必要内容安全策略和实际发布/下架时，必须独立验证原子准入与 R2 身份；不能以本轮拒绝门禁的测试替代正向发布验收。
