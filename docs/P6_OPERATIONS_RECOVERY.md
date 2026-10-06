# P6：运行观测与本地故障恢复

## 范围与完成边界

`0.3.0-dev.20` 增加脱敏响应事件、只读依赖就绪探测和三阶段定时维护的故障隔离。
这是 `.20` 当时的 P6 本地切片，不是 Cloudflare 退出验收。该批次没有新增迁移、
账号服务、后台队列、自动重试层或部署旁路；真实外部身份仍待验证。原生组件安全
风险和网络边界按用户要求延期，不记为通过。生产分发仍拒绝
`SCANNER_CLOUD_NOT_VALIDATED`；正向票据准备使用合成扫描和假设准入。

`.22` 另补齐完整关闭旧 Miniflare/workerd 后从原 D1/R2 持久目录重开与实际 cron
恢复证明，见 [完整本地运行时重启](P6_RUNTIME_RESTART.md)。同时修正测试 fixture
的持久化字段遗漏；不把本文件的 host 故障/下一轮 cron 证据外推为该重启证明。

后续 `.22` 已按明确授权通过 [同包隔离 Cloudflare 切片](P6_CLOUD_RECOVERY_VALIDATION.md)：
正式 cron 缺表时保持三阶段隔离，增量应用现有 `0005/0006` 后恢复；真实 R2 HEAD
对账及持久日志采集/云版本关联通过。没有修改本文生产合同，旧本地结果仍是
历史证据；云切片不等于真实账号、完整 P6、长期运行保障或生产分发退出。

## HTTP 观测合同

每次主 Worker HTTP 响应由服务端生成 UUID，设置 `X-Request-ID`，不接受客户端
请求 ID。只输出固定 JSON `http.response_ready` 事件：

```json
{
  "service": "assetlibrary",
  "format": 1,
  "event": "http.response_ready",
  "requestId": "服务端 UUID",
  "route": "resources",
  "method": "GET",
  "status": 200,
  "durationMs": 12
}
```

route 是固定类别：liveness/readiness/catalog/library/resources/uploads/versions/
publications/web/unknown，不是具体路径。方法限定 GET/HEAD/POST/PUT/PATCH/DELETE/
OPTIONS，其余记为 OTHER。不输出主体、资源 ID、URL/query、Authorization、Cookie、
body、票据、公钥配置或异常。日志 sink 抛错不会改变已提交业务或触发重放。

事件表示**响应已构造**，不是客户端接收完成或文件传输成功。durationMs 止于
响应构造，不计后续流传输时间。包装直接保留原 response.body，不 clone、tee、
预读或整包缓冲；保留状态和原 headers。不承诺下载吞吐或端到端成功指标。

## 存活与只读就绪

`GET /healthz` 仍只表示 Worker 存活。新增无需身份的 `GET /readyz`，设置 no-store，
只公开固定依赖状态：

```json
{
  "service": "assetlibrary",
  "scope": "private_dependencies",
  "status": "ready",
  "checks": {
    "identity": "available",
    "database": "available",
    "storage": "available"
  },
  "distribution": {
    "status": "blocked",
    "reason": "SCANNER_CLOUD_NOT_VALIDATED"
  }
}
```

全部可用为 200 ready；任一不可用为 503 degraded，对应项为 unavailable。不写
D1/R2、不列对象、不返回异常、账号、公钥或业务计数：

- identity：检查 issuer/audience 并实际校验/导入固定 RSA 公钥，不请求外部签发者。
- database：参数化查询 sqlite_schema，确认六份当前迁移的全部 15 个表名存在。
  只是**表存在性**，不检查列、索引、约束或 Schema 内容，也不证明业务写入。
- storage：只对保留键 `__assetlibrary_readiness_probe__` 执行 R2 HEAD；缺对象也
  表示调用成功。该键不属于业务 quarantine/{resource}/{upload}，不创建对象。

三个探测并行等待，没有单独 probe deadline，不保证固定超时。入口会消耗公钥
导入和平台只读调用，不承诺零开销或免费。不探测 scanner，不证明真实账号登录
或生产分发准入；200 时 distribution 仍 blocked。只有 GET 走探测，其他方法
继续原路由/身份规则，没有新增匿名写入口。

## 定时维护、计数与恢复

每轮生成独立 runId，顺序各执行一次：

| 阶段 | 原有有界工作 | 未完成时的固定错误 |
| --- | --- | --- |
| uploads | 最多 25 条到期上传对账 | `UPLOAD_RECONCILE_INCOMPLETE` |
| inspections | 最多 3 条到期检查，沿用租约/最多三次尝试 | `INSPECTION_SCHEDULER_INCOMPLETE` |
| tickets | 单条 SQL 最多回收 100 条过期票据 | `TICKET_CLEANUP_INCOMPLETE` |

单阶段失败不饿死后续阶段。全部阶段尝试后输出汇总，如有失败则抛首个固定错误，
不泄露驱动异常。没有新增内部重试、重置 attempts、跨阶段事务或脱离 owner 的
任务。下一轮仅处理原状态机允许的到期记录。

每阶段输出 scheduled.stage，汇总为 scheduled.complete，固定字段包括 runId、
stage、`scope: "bounded_batch"`、completed/incomplete、耗时及有界计数；汇总
另有 failedStages。计数只接受 0–100 安全整数：

- uploads：processed 是选中数，completed 是正常返回的对账数。
- inspections：processed 是选中/调度数，**不是扫描 passed 数**；业务 rejected、
  queued 或三次耗尽 failed 可与阶段 completed 并存，结果查持久任务/事件。
- 内部 failed 对外命名 dispatchErrors，避免误读为内容拒绝数。
- tickets：processed/completed 使用实际 SQLite meta.changes，不按预计数填报。
- 阶段抛异常可能已有部分提交，计数未知，输出 `{}`，不伪造 processed=0。

completed 仅表示**本轮有界调度完成**，不证明扫描通过或积压清空。105 条过期
票据分两轮 100、5；第一轮 completed 仍有剩余。清理只删过期票据，保留有效票据、
发布、授权、审计和 R2 字节。

## 本地证明与逐文件审查

证据目录：`../../linshi/assetlibrary-operations-20261005`。operations 三个文件在
assetlibrary-p3-4xy27J 上 **15 pass / 0 fail / 0 skip**；邻近 22 个文件在
assetlibrary-p3-exFm90 上 **95 pass / 0 fail / 0 skip**，含身份、目录事务、上传/流、
检查恢复、版本审核、发布/分发撤销和 Web 合同。没有重跑原生审计、浏览器全矩阵
或完整 suite；`.18` 的 202 项是历史基线。

实际 workerd console 证明响应 ID、事件白名单和 cron 三阶段关联；Miniflare 5
使用 handleStructuredLogs 捕获，不假设经过宿主 Log.log。故障注入明确在 Node
host 层，使用生产 bundle 和真实本地 D1/R2，证明：

- 缺身份/缺表、D1/R2 读故障脱敏降级，恢复保持原业务事实。
- logger 故障仍提交，幂等回执和成功审计唯一。
- 三阶段同时失败仍各尝试；单阶段故障后其他阶段继续，下一轮恢复。
- 部分上传先提交再中断时保留事实/未知计数，恢复后各一条成功审计。
- 两个重叠定时执行保持单检查 attempts=1、passed 审计唯一。
- 真实 SQLite DELETE ABORT 不虚报清理，恢复仅删票据、发布/R2 保持。
- Node 编译的生产包装未预读、按需读取，Range/缓存头保持、取消传到底层；
  这是聚焦流证明，不是浏览器或云端传输证明。

Biome、TypeScript、有效行数/UTF-8 和联网 pnpm audit 通过，audit 为
`No known vulnerabilities found`，不覆盖延期原生风险。最终包直接测试、六迁移/
重复应用、九静态入口、降级就绪及字节核验以 final-delivery.json 为准；测试库不
打包，不以旧包代替新构建。

events/readiness/scheduled 分别 78/61/42 有效行；index 从 49 到 54、tickets 从
82 到 83；fixture 178、distribution-fixture 115；operations 夹具 64、HTTP 159、
scheduled 285、stream 57。全部小于 500，无例外。逐文件审查固定输入/日志白名单、
SQL 参数、只读探测、原流所有权、异常隔离、有界批次及 finally 运行时清理；没有
新增依赖、账号缓存或秘密落盘。

## Cloudflare 配置与未验证事项

主配置启用 observability/head sampling 1、redact_query_string:true，关闭自动
invocation logs 和 traces，只依赖上述自定义事件。本轮联网核实官方
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、
[Logging](https://developers.cloudflare.com/workers/observability/logs/) 和
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)，
同时核对已安装 Wrangler 4.147.0 配置 schema；页面副本保存在证据目录。

上述 `.20` 本地批次当时只有源码配置，没有部署或证明云端采集。后续 `.22`
同包隔离云验收已读回 observability/logs enabled、persist true、head sampling 1、
redact_query_string true、invocation_logs false 和 traces disabled，并检索到
225 条白名单应用事件，正式 cron/配置版本与业务恢复有独立关联证据。实际查询
请求的 `view:"events"` 必须位于顶层，放入 parameters 的失败尝试没有算通过。

自定义白名单及本次观察到的查询标记缺失，不等于全部平台脱敏、长期保留期、
告警、实际全量采样或费用保证。真实签发合同、完整 P6 和真实 P5 生产闭环仍开放。
本次获准云操作已关闭三个 Worker 的入口/cron、恢复原公开身份配置，数据和镜像
保留；scanner/probe 版本未变。详细失败记录、配置及最终只读收尾见
[P6 云验收](P6_CLOUD_RECOVERY_VALIDATION.md)，无生产源码修改、提交、推送、
Docker 构建或数据清空。
