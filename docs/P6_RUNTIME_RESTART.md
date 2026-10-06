# P6：完整本地运行时重启与持久状态恢复

## 范围和结论

`0.3.0-dev.22` 补齐同一候选的完整 Miniflare/workerd 关闭、重开和实际 cron
恢复证明。新增三个聚焦场景 **3 pass / 0 fail / 0 skip**；九个直接邻近文件
**45 pass / 0 fail / 0 skip**，涵盖上传/流、检查恢复、Art ZIP、身份配置/轮换和
定时维护。受测运行基线为 `.21` 的 `assetlibrary-p3-8T4RLm`；fresh `.22` 包、
直接包测试和字节核验以证据目录 `final-delivery.json` 为准，不以旧包代替新构建。

原生组件风险和网络边界继续延期，不记为通过；没有改变生产业务代码、迁移或
`SCANNER_CLOUD_NOT_VALIDATED` 门禁。成功格式检查仅为 `art-zip-manifest-v1`，
不是 ClamAV 或生产发布资格。没有新增依赖、自动重试、账号或云变更。

## 首轮真实失败及责任层

原 fixture 仅设置 `isolatedResourcePersistencePath`。完整 dispose/reopen 后三个
场景实际均报 `D1_ERROR: no such table: resources: SQLITE_ERROR`，并非恢复成功。

已核对当前安装的 `miniflare 5.20261001.0-alpha` 声明和实现：D1/R2 插件读取
`resourcePersistencePath`；未配置它时使用实例临时目录。关闭 shared storage 时
isolated 字段由 resource 字段推导，不能单独指定 isolated 来代替 D1/R2 持久根。
因此只修正 `tests/fixture.mjs` 的测试装配为 `resourcePersistencePath: persist`。
Wrangler 手动入口使用的 `--persist-to` 未改，不把本地 fixture 遗漏说成生产库丢失。

首轮失败、安装源码行证据及后续运行日志均保留；不重建 Schema 把失败补成通过。
`.19 setOptions()` 和 `.20` 下一轮 cron 的历史证据仍只证明各自的原有范围，
不升格为完整关闭后的持久恢复。

## 关闭与重开合同

fixture 的 `restart()` 顺序为：

1. `await oldMiniflare.dispose()`，确认旧实例、HTTP 入口和 D1 stub 不再可用。
2. 在开新实例之前执行测试核验回调；不存在旧、新运行时重叠窗口。
3. `new Miniflare(runtimeOptions)`，保持同一模块内容、worker 名称、DB ID、R2 名称、
   persistence 和身份配置；重新取得新 D1/R2 stub 并更新宿主 env。
4. 不再执行六份 Schema，不清空数据、不重置 attempts/token/幂等回执/审计。

Windows 回执按当前测试 Node 的 ParentProcessId 枚举所属 workerd。每次重启保存
before-dispose、after-dispose-before-open、after-open 三个点，并实际断言旧 PID
不存在、中间所属 workerd 为零、新 PID 不同。无停止其他会话的操作；每个场景
finally 关闭自己的运行时，测试数据库和字节保留在 linshi，不进入可部署包。

安装的 Miniflare dispose 内部会终止 workerd 并等待退出。这是**受控 API 完整关闭**
证明，不是 workerd 请求优雅排空、突然 Node/系统断电、云容灾、D1 备份恢复或
零停机证明。Node 测试宿主未重启；合成签名密钥仅在该宿主内存中延续。

## 三个场景及证明层次

| 场景 | 中断状态如何形成 | 重开后的实际证明 |
| --- | --- | --- |
| R2 已写、D1 pending；另有取消后删除故障 | 实际 PUT；真实 SQLite 审计 ABORT 使完成返回 503；生产取消在宿主 R2 delete 故障后返回 503 | 15 张业务表、schema/trigger、回执和审计逐项保持；798 字节 ZIP/etag 保持。移除本测试 trigger、推进到期时间后真实 cron 提交唯一 quarantined 并清理取消对象；取消仍 410，不复活 |
| 实际 running/attempts=1 | 同一生产 bundle 的宿主 scheduled 实际 claim，真实 D1 增次数/写 token 后在宿主 R2 GET 暂停 | 旧运行时关闭后释放宿主执行，旧 stub 不能写回；初始持久快照完全保持。租约未到期时真实 cron 不重执行；仅推进时间字段后 attempts=2 格式 passed，事件精确为 queued/running/running/passed |
| 第三次实际执行中断 | 两次宿主 R2 故障实际执行/重排队，再由生产 claim 领取第三次并暂停 | 重开保留 running/attempts=3 和原 token；未过期不重复。仅推进租约时间后真实 cron 记 failed/INSPECTION_RETRY_EXHAUSTED，不产生第四次 running；再次重开/重放不能重置消费或审计 |

running 不是手写数据库行，领取与次数/审计来自生产调度和真实本地 D1。暂停和
故障注入明确属于 Node 宿主层，不冒称 workerd 内部 AV 正在被杀死。重开后的 cron
通过 Miniflare 的本地 scheduled 入口运行原生 Worker；时间推进只修改 lease_until/
next_attempt_at 或 reconcile_at，不修改状态、消费、token、结果或事件。

恢复后每个场景再次完整重开并重放，初始完整快照保持、成功/终态事件唯一。
显式 upload complete 会正常推迟下一次 reconcile_at，重放断言只容许该调度时间
变化；其余上传绑定、业务表、回执和审计均保持，不靠忽略整个上传表补绿。

## 验证与逐文件审查

证据目录：`../../linshi/assetlibrary-runtime-restart-20261005`。`restart-passing.log`
为三项初步通过，`neighbors.log` 为 45 项邻近通过；最终包重启、门禁、源码身份、
checksums 和运行时关闭回执以 `final-delivery.json` 及所列原始文件为准。

改动仅为 fixture、重启测试/专属测试夹具、构建阶段与版本标记及文档。fixture
重开后换新 stub；并发重启拒绝；失败仍由调用者 finally dispose 当前实例。检查
固定 SQL 表白名单/参数绑定、有限测试数据、5 秒暂停看门狗、10 秒进程查询和
2 秒旧入口探测。签名密钥/JWT 不写证据，无外部身份获取或生产测试路由。
全部手写文件低于 250 有效行，无行数例外。格式/类型/行数/UTF-8、联网 pnpm
依赖 audit 和两仓 diff check 的最终状态单独核验，不以这次恢复代替完整 suite。

## 全计划剩余边界

按当前 DEVELOPMENT_PLAN 的 P0–P6 退出条件复核：P0/P1/P2 的本地验收已完成；
P3/P4/P5 业务实现和假设准入下的本地交互已有证据，但生产发布/分发和真实身份
闭环仍未达成。P6 已有本地公钥轮换、观测/维护隔离及本次完整重开证明；仍缺：

- 真实外部签发合同与实际账号验证：issuer、audience、可信公钥/JWKS、sub 映射及
  有效期/轮换规则。沿用 `P6_IDENTITY_ROTATION.md`，不自造账号服务或真实凭据。
- 对**同一候选**另行获准的 Cloudflare 身份、观测、故障恢复、授权和撤销验收；
  当前观测源码没有部署，旧隔离云样本不能替代这项新验收。
- 与延期准入相关的真实生产发布/目录/下载闭环。保留现有拒绝，不加绕过开关。

原生安全/网络边界按用户要求延期；签名实际更新/切换回滚等原生发布验收仍是
生产前未验证事实，本轮不重复扩大调查。局部本地证明不等于全计划完成，目标
继续 active。无提交、推送、云变更、Docker 构建、真实凭据配置或数据清空。