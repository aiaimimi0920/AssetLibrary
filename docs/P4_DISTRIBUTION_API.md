# P3/P4 发布与授权分发业务合同

适用版本：`0.3.0-dev.17`。本轮按用户要求先完成业务代码，不展开延期的原生组件安全风险与网络边界验收。

## 实现与生产准入分开

发布、下架、公开目录、授权资源库、短期下载票据和流式下载的业务核心已实现。生产 HTTP 入口仍通过 `src/publications/admission.ts` 无条件拒绝尚未验收的部署准入，没有请求参数、环境布尔开关、测试登录或 R2 预签名下载旁路。数据库里存在历史或测试 publication 也不能放行生产分发。

当前 `POST /v1/versions/{id}/publish` 保留 owner、revision、approved 和当前绑定检查；format-only 仍为 `409 REQUIRED_CONTENT_CHECK_UNAVAILABLE`，有效复合 clean 仍为 `409 SCANNER_CLOUD_NOT_VALIDATED`。公开目录返回 `503 SCANNER_CLOUD_NOT_VALIDATED`，不把服务不可用伪装成空目录。其余分发入口在身份/权限检查后拒绝部署准入。

`tests/distribution-fixture.mjs` 在独占的真实本地 D1/R2 上，以合成扫描事实直接调用同一业务模块，明确表示“假设部署已经准入”的业务验证。TypeScript 测试输出只放 `linshi`，不增加生产 Worker 测试入口。这不证明实际 AV、云环境或生产安全已经通过。将来开放生产须另完成延期验收及受测部署准入实现，不能简单把函数改成返回 `true` 作为验收。

## 发布与下架

发布事务以版本 ID 自然幂等；第一次返回 201，同一批准版本的重复请求返回同一 publication、200。版本状态和审核历史不改变。新增 `publications`、`publication_events` 与后续分发表，不重建既有版本表。

同一 D1 batch 内重新验证 owner、版本 revision、独立批准后的状态、资源/上传/检查完整快照、扫描结果原文和时效。失败的条件写入不生成事件；事件 SQL 失败时整批回滚。没有 R2 COPY、公开键或缓存副作用，唯一隔离键继续私有保存。

`GET /v1/versions/{id}` 增加 `publication: null | {id, state, revision}`，方便 owner 从历史版本恢复管理入口；`publicationEligible:false` 和 `cloudValidated:false` 仍保留。

| 接口 | 权限与行为 |
| --- | --- |
| `GET /v1/publications/{id}` | 仅 owner 查询发布元数据/当前绑定；不返回对象键、票据、引擎细节 |
| `POST /v1/publications/{id}/unlist` | owner，JSON `{"revision":1}`，CAS 到 unlisted，revision + 1 |

下架是终态，原请求自然重放不会再写事件；同一 version 不重新上架。重新发布内容需要新的版本和审核。下架/授权撤销作为保护操作不依赖尚未通过的部署准入，便于关闭历史记录；这不是分发放行。版本撤回、资源修改/删除、上传取消/缺失或检查身份变化也会使当前分发失效，历史 publication 和审核事实不被抹除。

## 目录、资源库和授权

`GET /v1/catalog` 和 `GET /v1/catalog/{publicationId}` 为公开的最少发布元数据入口；不返回 owner、上传 ID/对象键、ETag、扫描原始事实或 reviewer。`GET /v1/me/library` 需要外部身份，只列 owner 或具备当前 active 下载授权的发布。P1 的目录读成员不是下载授权；不会自动转换或提升权限。

列表支持 `limit=1..50`（默认 20）及 UUID v4 `after` keyset 游标，拒绝未知/重复参数。每页最多读取 `limit + 1` 个候选，失效记录过滤后可能出现空页；仍须沿 `nextAfter` 前进，游标是最后扫描项，不能因过滤而漏掉后续有效项。每次查询 D1 primary，不用 Cache/KV 或副本决定准入。

| 接口 | JSON / 行为 |
| --- | --- |
| `GET /v1/publications/{id}/grants/{principal}` | owner 查询当前状态/revision，便于失败后恢复；未登记为 404 |
| `PUT /v1/publications/{id}/grants/{principal}` | owner 首次 `{"revision":0}`；后续使用当前授权 revision，从 revoked 恢复为 active |
| `DELETE /v1/publications/{id}/grants/{principal}` | owner 使用当前正整数 revision 撤销 |

owner 固有权限不能通过授权表修改。授权变更使用 CAS 和同批成功审计；撤销后保留墓碑，重新授权递增 revision，不能恢复旧票据。授权本身不修改资源 revision 或审核快照，也不提供下载资格的安全绕过。

## 下载票据与字节

`POST /v1/publications/{id}/tickets` 接受 JSON `{}`，需要当前 owner/active 下载授权和所有分发条件。业务核心返回 `publicationId`、`ticket`、`expiresAt`、`contentPath`。票据为 32 随机字节的不透明十六进制值，D1 只存 SHA-256 摘要；不在 URL、审计或日志中存明文。期限最多 5 分钟，且不超过扫描事实期限。

客户端向 `contentPath` 发送外部 `Authorization: Bearer ...` 和 `X-Download-Ticket: ...`。票据绑定主体、publication/version revision、授权 revision、SHA-256、ETag 和到期时间；另一主体、另一发布或重新授权后的旧票据都拒绝。最多每轮删除 100 张过期票据，保留发布/授权/审核/事件历史。

`GET /v1/publications/{id}/content` 流式返回 `application/zip`；`HEAD` 校验同一资格和原生对象身份但不读取包体。R2 原生 SHA-256、size、ETag 必须匹配，不信 custom metadata。包体不整包缓冲、没有 R2 预签名下载 URL；附 `private, no-store`、`nosniff`、固定安全下载文件名、Content-Length、ETag 和 Accept-Ranges。

- 单一 `Range: bytes=start-end`、开放尾端和 suffix 支持 206，拒绝多 Range、溢出整数和不可满足范围；416 附 `Content-Range: bytes */size`。
- `If-Range` 仅支持精确强 ETag 匹配；其他值退回完整 200。HEAD 忽略 Range，返回完整长度。
- 每次新 GET、HEAD 和续传都以一条 primary 查询同时复核票据、当前绑定、扫描时效和授权 revision。R2 获取之后再复核一次；若等待期间下架/撤销/取消或请求中止，关闭已经取得但尚未交付的对象流。
- 已开始交付的流不逐块查询 D1，允许结束；撤销不能收回已经传出的字节。后续新请求/续传仍拒绝。响应取消、客户端请求 abort、上游读取失败和 EOF 都释放 reader 与 signal listener。

## 本轮边界

API/业务核心与本地验证不等于 P3/P4 生产退出条件达成。本轮没有启用云端入口、cron、生产部署、真实账号接入或实际成功生产发布。Web 分发目录、资源库与授权管理交互属于后续 P5 工作，不将已有私有上传工作区标成完整用户闭环。
