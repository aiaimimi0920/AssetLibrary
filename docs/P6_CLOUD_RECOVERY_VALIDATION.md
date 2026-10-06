# P6：同包隔离 Cloudflare 观测、恢复与身份轮换验收

验收时间：2026-10-06 UTC；本地为 2026-10-05（America/Los_Angeles）。
最终只读收尾完成于 `2026-10-06T01:27:26.591Z`，候选 `0.3.0-dev.22`。

## 范围与结论

用户明确回复“我同意你继续操作，同意”后，复用此前创建的独占 Cloudflare
资源，完成主 Worker 的同包部署、九个静态入口、正式 cron 故障隔离和增量迁移
恢复、真实 R2 上传对账，以及合成身份的公钥轮换/撤销/可信回滚和配置恢复。
**本切片通过，不代表全 P0–P6、真实账号接入或生产分发验收完成。**

没有修改生产源码、身份校验规则或准入门禁，没有重打包候选、构建 Docker、
切换 scanner/probe、升级套餐、修改 DNS、清空 D1/R2 或提交推送。原生组件安全
风险和网络边界验收按用户要求延期，仍未通过。真实账号签发合同未获得；所有
本次认证请求均来自内存中的合成 RS256 signer，不保存私钥或 JWT。

## 同包部署与保留资源

本文的候选及证据目录路径均相对 `AssetLibrary` 仓库根目录。

| 项目 | 本次确认的身份 |
| --- | --- |
| main Worker | `al-main-val-tnjeik` |
| 原字节部署基线版本 | `81556991-a7aa-4168-b4b1-4bebbf749721` |
| 最终恢复原公开身份配置后的版本 | `b2a74011-53e2-4bb6-8062-2e0e1285b76e` |
| scanner 保留版本 | `c0dd9708-aa89-4631-b632-30cce010d88a` |
| probe 保留版本 | `dd763c55-85d1-433e-b44f-074c0f3f8d85` |
| D1 | `al-db-val-tnjeik` / `15eadf9a-932d-4854-ae67-9f45a94e8075` |
| R2 | `al-quarantine-val-tnjeik` |
| 候选目录 | `../../linshi/assetlibrary-p3-zVrcvG` |

通过官方 multipart API 直接上传候选 `index.js` 和九个 Text 模块，没有 rebundle。
部署后及最终收尾均从 `/content/v2` 逐模块重新计算 SHA-256，十模块全部与
不可变候选相同；九个 Web 静态入口实际返回 200，响应摘要与对应模块相同。
主模块 SHA-256 为：

```text
50ff2e79b0e733f586797bba322635d197cf5c5d1e6beab8426df7b2d9f6cc18
```

公钥配置切换产生不同云版本，但没有改变模块字节。候选 manifest 中的
`cloudDeployed:false` 是构建时事实，不回填或修改旧包；云结论以本次独立回执为准。
静态 HTTP 核验不是浏览器真实登录或正向生产分发证明。

## 正式 cron、缺表故障与增量恢复

只开启 main 的正式 `* * * * *` cron，没有调用本地 scheduled URL 或主动执行
scheduled handler。持久 Workers Logs 同时记录平台 scheduled/cron、云版本、
Worker request ID、应用 runId 和三阶段事件，能够关联到真实同一次云调用。

| 实测阶段 | 结果 |
| --- | --- |
| 仅有 `0001`–`0004` 时 | `/readyz` 503；identity/storage available，database unavailable；`/healthz` 200 |
| 正式 cron 缺分发表 | uploads/inspections completed，tickets incomplete；汇总 failedStages=1，记录固定 `TICKET_CLEANUP_INCOMPLETE` |
| 增量应用 `0005/0006` | 使用候选原 SQL 字节，新增索引和分发表；六份迁移各登记一次，不删除旧表或重复执行 DDL |
| 数据库恢复 | `/readyz` 200，distribution 仍 blocked；下一次正式 cron 三阶段完成，failedStages=0 |

对应 runId：缺表 `1aef5707-29b0-4d76-95b0-939da1a8f61e`；恢复
`4290f8da-018c-4ed7-b376-131537f47d8b`。阶段 completed 只表示本轮有界维护
完成，不代表扫描 passed、积压清空、完整灾备或生产准入。

保留原十张业务表的有界快照并逐行核验摘要。原资源、权限、幂等回执、审计、
上传、检查、版本和事件保持；仅允许旧 quarantined 上传在正式 HEAD 对账后
更新 `reconcile_at` 维护时间，差异单独记录，其余字段必须原样匹配。
这不是历史数据库迁移，也没有重置 attempts、任务终态或消费记录。

## 真实 R2 对账与合成身份恢复

新增一个独立测试资源和一个 42 字节私有对象，正常 PUT 后故意不调用 complete；
只将该测试上传的 `reconcile_at` 设为到期。正式 cron
`73850945-ad24-4c00-a8f8-018abe3b5283` 通过真实 R2 HEAD 核对大小、SHA-256 和
etag，将 pending 恢复为 quarantined，成功上传审计只有一条。
它不是 Art ZIP 扫描、内容安全通过或生产包下载。

之后复用该资源、对象、成员与创建回执，没有因验收脚本失败另建资源、重传对象
或重跑迁移。六个公开身份配置状态及其请求均与预期云版本逐项关联：
单钥、双钥重叠、撤旧、仍可信的重叠配置回滚、非法配置、配置恢复。
18 条业务/就绪结果记录证明：

- 两把钥对应同一稳定主体；轮换本身保持资源、成员权限、幂等回执和审计。
- 撤旧生效后的旧钥读写均为 401，新钥能重放原创建回执，没有增加成功事实。
- 显式成员撤销后，新旧 signer 的成员请求都返回 404。
- 非法身份配置下 `/readyz` 和创建请求返回脱敏 503；恢复后原幂等键仍有效。
- 上传元数据、etag/摘要及唯一成功上传审计在轮换前后保持。

只读生效探测有 120 秒上限；记录传播窗口中的实际状态，不把 API 上传成功或
`/readyz` 200 当作公钥配置已经对所有请求生效。可信回滚不是泄露密钥回收，
也不承诺零停机或终止已经认证/传出的响应。

## 持久日志与真实失败记录

原实时 tail WebSocket 在等待首次 cron 时断连，回执保留为失败，未据此把 cron
配置存在说成执行通过。改为查询已持久化 Workers Logs 后完成正式云调用关联，
最终检索到 225 条白名单应用事件。HTTP ID 由服务端生成，不接受客户端指定 ID。
应用事件没有查询标记；本次观察到的平台事件也没有该查询标记。只保存脱敏
应用字段、必要的版本/触发关联和验证摘要，不保存原始 headers 或 JWT。

最终 API 读回 observability enabled、head sampling 1、redact_query_string true、
logs enabled/persist true、invocation_logs false、traces enabled false。这是本次
配置与采集事实，不证明长期保留期、告警、所有平台字段脱敏、实际全量采样或费用。
实际查询请求的 `view:"events"` 位于顶层；放在 parameters 内只得到 calculations，
没有将那次响应误记为持久事件查询通过。

首轮合成 JWT 的 iat 比云端响应时间快约 3 秒，返回 401；同一 JWT 等待 5 秒后
返回 200，回退 10 秒签发时间的令牌也返回 200。仅修临时 signer，仍保持
`exp-iat=900` 和生产 clockTolerance=0，没有扩大产品容差或调整系统时钟。
另一次撤旧探测仍由旧重叠版本处理，真实日志确认该版本身份；后续有界探测及
云版本关联补齐传播证明，没有修改身份实现掩盖问题。

还保留了连接超时、`fetch failed` 和入口启停传播中的 404。只对只读操作做
有界重试，并在恢复连通后补失败切片；未盲重放云写入、迁移或已完成 R2 业务。
最终业务回执通过后，一次收尾读取连接失败；另行只读收尾通过，早期失败回执
不覆盖、不改写为通过。因此汇总是多个明确成功切片的合成，不是一次全流程零失败。

## 收尾与生产门禁

最终只读核验确认三个 Worker 的 workers.dev/preview 均关闭、cron 均为空，
main `/healthz` 实际返回 404；原公开身份 bindings 已恢复，十模块仍逐字节匹配。
scanner/probe 的部署版本未变，probe secret 未读取或覆盖。

Container instances-v2 仍有一个历史逻辑实例 `art-singleton`，状态 inactive；
没有运行实例，**不是逻辑实例列表为空**。D1/R2/镜像和新增测试数据保留。
当前两个上传均 quarantined，唯一旧 inspection 仍 passed，无 pending 上传或
queued/running 检查。cron 关闭读回只是控制面事实，不声称全球同时停止投递。

公开 catalog 仍为 `503 SCANNER_CLOUD_NOT_VALIDATED`，生产 library 仍为 409，
publications=0。安全延期项没有记为通过，生产准入仍拒绝。

## 证据与下一项

证据根：`../../linshi/assetlibrary-p6-cloud-20261005-165337`。

- `acceptance-complete.json`：组合成功切片、原失败回执及未完成边界的唯一汇总。
- `deployed-dev22-byte-identity.json`、`cloud-web-assets.json`：初始十模块/九入口原字节。
- `cloud-acceptance-resumed-result.json`、`migrations-applied.json`：缺表 cron、迁移和恢复。
- `business-identity-recovery-resumed.json`：真实 R2 对账通过；其后撤旧探测失败保留。
- `identity-diagnostic.json`、`identity-rotation-final.json`：时钟证据及最终六配置/版本关联。
- `telemetry-events-resumed.json`：脱敏持久日志、正式 cron 和配置版本关联。
- `final-cloud-acceptance-result.json`：业务 passed，仍保留最后一次读取连接错误。
- `final-readback-verified.json`、`verified-final-dev22-byte-identity.json`：独立只读收尾通过。
- `preservation-*.json`：迁移和配置切换前后的原业务事实与明确维护时间差异。

真实账号仍需要正式 issuer/audience、公开 RSA/JWKS、JWT 获取入口、稳定 sub 映射
和实际登录验收。真实 P5 生产闭环、完整 P6 退出及延期的安全/网络验收仍开放。
本次不重跑已经有相同字节证据的本地重启或浏览器矩阵，不伪造 fresh build。
