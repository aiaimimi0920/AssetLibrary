# P2：R2 私有隔离对象闭环

## 范围与非目标

P2 在 P1 的私有草稿资源上增加上传预留、流式上传、完成、取消和定时对账。使用同一个 Worker、D1 和原生 R2 binding，没有新增生产依赖、Queues、多段上传或第三方存储适配器。

`quarantined` 只表示对象大小、R2 原生 SHA-256 和不可变对象身份已核对，**不表示内容安全、归档结构、审核或发布资格已通过**。本阶段不提供发布、下载、安装或公开对象 URL。

身份仍遵循 [P1_API.md](P1_API.md)。上传的所有 API 只允许登记的 owner；目录读成员不能查看上传记录、上传、完成或取消。无权访问与不存在统一返回 404；重复请求也重新验证外部 JWT。

## API 与输入

| 方法与路径 | 输入 | 行为 |
| --- | --- | --- |
| `POST /v1/resources/{id}/uploads` | JSON `{"size":29,"sha256":"64位小写hex"}`；`Idempotency-Key` | 仅 owner 的活动草稿；201，登记唯一隔离对象身份 |
| `GET /v1/uploads/{id}` | 无 | 200，当前记录；只读，不主动执行对账 |
| `PUT /v1/uploads/{id}/content` | `application/octet-stream`；正确的 `Content-Length`；二进制流 | 200，`{"id":"…","state":"pending","objectStored":true}`；对象仍私有 |
| `POST /v1/uploads/{id}/complete` | JSON `{}` | 重新检查 R2 和 D1；成功返回 `quarantined` 记录 |
| `DELETE /v1/uploads/{id}` | 无 | 先提交终态，再清理唯一登记对象；重复请求保持已有终态 |

所有请求携带 `Authorization: Bearer <JWT>`。预留大小为 1–16 MiB（16,777,216 字节），摘要为 64 位小写十六进制；拒绝未知字段。完成接口要求 `application/json` 和空 JSON 对象。JSON 仍限制 8192 字节。

预留必须使用 P1 相同格式的主体级幂等键，摘要包括操作、资源、大小和 SHA-256。相同键及内容重放首次 201 结果，即使上传后来取消或过期；获取当前状态需 GET。不同内容或与该主体其他操作复用同键返回 `409 IDEMPOTENCY_CONFLICT`。

PUT、complete 和 DELETE 不要求额外幂等键，使用不可变对象身份、状态 CAS 和当前结果实现可重试语义。上传 revision 独立于资源 revision；预留不修改资源 revision。

预留和完成的记录形状：

```json
{
  "id": "UUID v4",
  "resourceId": "UUID v4",
  "state": "pending",
  "revision": 1,
  "size": 29,
  "sha256": "64位小写hex",
  "expiresAt": 1790000000000,
  "contentUrl": "/v1/uploads/UUID/content"
}
```

`expiresAt` 是 Unix 毫秒，预留有效期 15 分钟。尚未完成的记录过期后不得上传或完成。已完成的隔离对象不因原上传期限自动删除；重复 PUT 只返回已有对象的存储事实，不覆盖字节。

## 流、对象身份与失败关闭

对象键只由服务端 D1 事实生成：`quarantine/{resource_id}/{upload_id}`。客户端不能指定对象键，也不持有 R2 凭据或绕过业务入口的预签名 URL。

上传依次通过实际字节数校验、`FixedLengthStream` 和 R2 原生 `sha256` 校验。写入使用 `If-None-Match: *`；正常路径不能覆盖已登记对象。已有对象的重试会取消新请求体并核对存储对象，不执行第二次写入，因此它不是对重试 body 的再次验收。

实际长度校验只额外保留最后 1 字节，直到正常 EOF 才向 R2 交付；否则 R2 可能先提交合法固定长度前缀，再发现超长尾部。短流、超长流及 EOF 前错误不能凑齐可提交对象。生产路径没有整包 `arrayBuffer()`、无背压 `tee()` 或整包 JS 摘要计算。

输入搬运设置 60 秒取消计时器，所有退出路径清理 timer、abort 并等待搬运结束。这个计时器不是整个 R2 PUT 的总时长保证，也不能替代云端断连与请求生命周期验收。

完成使用 R2 HEAD 返回的实际大小和原生 checksum；自定义元数据不能冒充摘要。第一次完成保存 etag，后续对账还核对该身份。PUT 返回成功不等于 complete 成功；定时对账也可以把已落盘且符合条件的 pending 记录收敛到 quarantined。

## 状态、事务与对账

| 状态 | 含义与后续 |
| --- | --- |
| `pending` | 尚未完成，可在有效期内重试写入 |
| `quarantined` | 字节完整性通过，仍未内容检查、未审核、不可分发 |
| `cancelled` | 主动取消或资源删除后对账关闭 |
| `expired` | pending 授权过期 |
| `rejected` | 存储对象大小、原生摘要或已记录身份不符 |
| `missing` | 已完成对象在对账时缺失 |

四个关闭状态都是终态，不能恢复。终态保留 D1 墓碑并重复清理其登记键，捕获请求中断后的晚到 R2 写入。不会列举或删除整个 bucket，也不会处理未登记的其他 owner 对象。

`db/0002_uploads.sql` 新增 `uploads` 和 `upload_events`，包含 STRICT、外键、状态/大小约束、revision 事件唯一键和到期索引。预留把授权记录、幂等结果与审计放入同一个 D1 batch。状态转换以 `id/revision/state` 做 CAS；完成还在同一事务内重新检查草稿和有效期，审计只选择本次成功 operation，零行 CAS 不产生幽灵事件。

D1 与 R2 不存在跨服务事务。R2 已写入但 D1 完成失败时保留 pending 及对象供重试；取消先写 D1 终态，删除失败不回退终态。PUT 后重新查 D1，取消/删除/过期发生后的晚到写入只允许清理，不能复活。

Cron 配置每分钟触发，每轮按 `(reconcile_at, id)` 索引最多顺序处理 25 条。pending 通常一分钟内再查（不晚于到期时间），quarantined 和清理过的终态每小时再查。R2 单条处理失败尝试退避一分钟；D1 本身不可用时整轮可以失败，不能承诺任意单条故障总不影响后续条目。

资源墓碑删除提交后，上传和完成立即重新检查资源状态；旧隔离对象由后续对账清理。已有 quarantined 记录可能等到下一小时检查，不承诺资源 DELETE 响应前已经完成 R2 删除。本阶段没有可分发旁路。

## 错误与重试

- 401：外部 JWT 缺失或无效；404：不存在、非 owner、非草稿上传或未实现路径。
- 400：大小、SHA-256、幂等键、未知字段或声明长度不合法；411：缺少 Content-Length；415：内容类型错误。
- 409：幂等键冲突、未存储对象、对象无效或状态竞争；410：上传终态或 pending 过期。
- 503：D1/R2/输入流等内部失败，统一 `SERVICE_UNAVAILABLE`，不泄露 SQL、JWT 或驱动错误。客户端查询当前状态后安全重试；取消返回 503 也可能已经提交终态。

GET 可以暂时反映尚未对账的状态，不能据它承诺对象安全或立即存在。只有真实 P3 内容校验和审核完成后才能讨论发布；下载和当前撤销授权属于 P4。

## 外部核实与验收边界

2026-10-04 已重新联网核对官方 [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) 的 checksum、条件 PUT 与 null 返回语义，[FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/) 的长度约束，以及 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) 的流式与运行限制。

实际证据来自本地 workerd/D1/R2，不代表远程 Cloudflare、真实网络中断或任何套餐 CPU/内存/计费承诺。测试入口仅存在于本地 fixture，生产 Worker 不包含故障路由或认证旁路。当前结果见 [P2_VALIDATION.md](P2_VALIDATION.md)。
