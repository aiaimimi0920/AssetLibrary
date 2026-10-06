# P2 本地验收记录

日期：2026-10-04。来源停点：会话 `01a106d6-c271-78d0-a231-519c0656f3cb` 最后未收尾的 R2 上传切片。范围仅为活动 TypeScript Worker、真实本地 D1/R2 binding 和本地定时触发；不包含历史项目或远程 Cloudflare 部署。

## 实际通过的检查

- Node.js `v22.22.2`、pnpm `10.33.0`；未新增生产依赖或改动活动锁文件。
- `pnpm check`：Biome 格式和 lint 通过；`pnpm typecheck`：`tsc --noEmit` 通过。
- `pnpm sizecheck`：活动代码行数及 UTF-8 无 BOM 检查通过，没有软上限例外。
- `pnpm audit`：本轮联网访问 npm advisory，返回 `No known vulnerabilities found`；不是全历史秘密扫描或零日安全保证。
- `pnpm test`：Wrangler `deploy --dry-run` 构建的同一 bundle，在本地 workerd、D1 SQLite、R2 binding 中运行 **26/26** 个测试，失败、取消和跳过均为 0。包含 P1 的 11 项回归及 P2 的 15 项验证。
- 对唯一隔离目录 `linshi/assetlibrary-p2-schema-20261004-063615` 执行 Wrangler `d1 migrations apply DB --local`：两份 SQL 首次成功；第二次返回 `No migrations to apply!`。没有重置旧本地库或触及云端。
- 独立 AssetLibrary `git diff --check` 通过。本轮保留已有 P0 归档和 P1/P2 未提交工作，不提交、推送或修改兄弟仓库。
- 测试及 Schema 验证结束后检查 `workerd.exe` 进程列表为空；没有擅自终止其他进程。

完整测试的原始证据目录：

```text
C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p2-4QAryL
  manifest.json
  build.log
  tests.log
```

最终候选使用文档收尾后的 fresh dry-run 构建；其目录以构建输出和交付报告为准。交付时对源码与产物 manifest 做 SHA-256 核验，且新候选的生产源码、Schema、工具配置和测试身份必须与上述测试产物对应。文档收尾不改变已测运行行为，不能把其他版本的绿色测试任意附给候选。

## 垂直闭环与故障证据

| 验证 | 实际断言 |
| --- | --- |
| 同一无害对象 | owner 预留 → 流式上传 → R2 读回 SHA-256 一致 → 完成 → 取消 → 原生 HEAD 不存在 |
| 1 字节与 16 MiB 边界 | 本地 Worker/R2 成功上传并读回一致；不是云端 CPU、内存或容量承诺 |
| 权限与过期 | 读成员和其他主体无法查看、上传、完成或取消；无效 JWT 与过期 pending 授权拒绝 |
| 输入和摘要 | 未知字段、越界大小、错误声明长度与内容类型拒绝；原生 checksum 失败不能产生可用对象 |
| 实际流长度与中断 | 声明正确长度但实际短流、超长流、提前错误及完整正确前缀后 EOF 前错误均失败；HEAD 为 null，不能完成，原授权可正常重试 |
| 幂等与并发 | 并发预留仅一份记录，键内容冲突 409；并发 PUT 不覆盖对象；完成仅增加一次 revision 和审计 |
| 预留事务失败 | 在 pending 审计 INSERT 注入真实 SQLite ABORT；授权和幂等记录回滚，恢复后原键只创建一次 |
| 完成事务失败 | R2 已存储但完成审计 ABORT；D1 保持 pending，定时对账恢复 quarantined，无重复成功审计 |
| 删除失败与重试 | 取消终态先提交；R2 删除故障返回 503 但不复活，后续原生 scheduled 清理 |
| 取消/完成竞争 | 持有旧 HEAD 的完成请求在取消后不能恢复状态或写出成功事件 |
| 晚到对象 | 在本地 bucket 模拟取消后晚到落盘；终态墓碑下一次对账再次删除 |
| 关闭条件 | 资源删除、pending 过期、已完成对象缺失或无原生摘要均收敛到终态并清理 |
| 有界与 owner | 26 条到期记录第一轮仅处理 25 条，下一轮继续；未登记的其他 R2 对象保留 |
| 隔离保持 | 发布和下载路径仍为 404；quarantined 不表示审核或内容安全通过 |

数据库故障注入仅使用测试隔离库，存储故障/竞争由 Node 宿主装配原始 bundle 与真实 binding。流故障测试仅在本地 workerd fixture 中插入测试入口，仍调用原始生产 Worker 和原生长度流；生产包不包含这些故障开关。晚到对象是明确的故障注入，不冒充真实网络竞速。

## 恢复时发现并修复的问题

原会话已将 Miniflare 定时触发测试路径改为 `/cdn-cgi/local/scheduled`；本轮确认该入口实际运行生产 `scheduled`，没有使用公开生产管理路由代替。

新增实际流校验暴露了合法前缀提前提交问题：仅靠 `FixedLengthStream` 时，R2 可能先收到并保存正确固定长度字节，随后超长尾部才让接口失败。遗留对象的 HEAD 大小和 SHA-256 都合法，旧完成路径会据此准入。修复在同一上传 owner 中保留最后 1 字节到正常 EOF，无整包缓存；短流、超长流和中断不能交齐 R2 提交所需字节。测试同时断言失败响应、无存储对象、不能完成和原授权重试，未通过删除断言或放宽校验掩盖问题。

## 工程、逐文件审查与资源

恢复前测量已有 P2 活动代码。上传、对象状态、预留和对账继续按现有职责拆分，没有向旧归档文件增加业务。

| 文件 | 有效代码行 |
| --- | ---: |
| `src/uploads/content.ts` | 91（恢复时 68；新增 23 行为同一流式完整性职责） |
| `src/uploads/records.ts` | 107 |
| `src/uploads/reserve.ts` | 90 |
| `src/uploads/reconcile.ts` | 71 |
| `src/uploads/routes.ts` | 43 |
| `src/index.ts` | 27 |
| `db/0002_uploads.sql` | 26 |
| `tests/fixture.mjs` | 128 |
| `tests/upload-fixture.mjs` | 71 |
| `tests/uploads.test.mjs` | 146 |
| `tests/upload-recovery.test.mjs` | 218 |
| `tests/upload-stream-worker.mjs` | 35 |
| `tests/upload-streams.test.mjs` | 62 |
| `scripts/run-tests.mjs` | 27 |
| `scripts/build.mjs` | 86 |
| `wrangler.jsonc` | 17 |

全部低于 250，有唯一职责；活动工具链其他文件均低于 500，无 501–700 行例外。所有活动文本继续由 checker 验证 UTF-8 无 BOM。历史大文件保持静态归档，不属于本轮迁移结果或新增代码。

主线程复核输入边界、owner、参数化 SQL、CAS/审计、对象键、补偿、流背压、timer、Miniflare 生命周期和对账有界性。独立只读子代理完成上传模块、Schema、故障测试和末字节修复的交叉审查，没有把代理未运行的测试当成通过证据。补充测试已实际覆盖单字节和完整前缀后错误。

测试数据与产物仅保存在 `linshi`，不打包数据库、私钥或真实凭据。fixture 的成功、失败和初始化异常路径调用 `dispose()`；故障入口不进入生产 Worker。构建检查活动源码前后 hash，manifest 绑定 bundle、source map、配置和两份 Schema。

## 未执行及残留边界

- P3–P6 未完成：归档/恶意内容检查、审核、发布、下载撤销、Web 用户入口和云环境均不属于本阶段通过结论。
- 没有开通 Cloudflare、使用真实凭据、操作云对象或部署；真实账号接入、公钥轮换、主体停用传播未验收。
- 流故障是本地 Worker 内受控注入，不等于真实客户端断网、云端中断或强制终止进程。60 秒计时器约束输入搬运，不保证整个 R2 PUT 总耗时。
- 终态墓碑、审计和幂等记录尚无生产保留/配额策略；每分钟最多 25 条及每小时终态再查不构成长负载吞吐承诺。D1 本身故障时整轮可失败。
- R2 无云端实际隐私配置证明；当前没有公开 URL 或应用下载旁路，云上线前仍须核查 bucket/路由设置。
- 依赖审计不替代完整 Git 历史秘密扫描、远端 CI、分支保护或云恢复演练；这些未修改、未验收。

P2 已完成本地可运行闭环；下一阶段是 P3，而不是提前允许未经必要检查和审核的对象分发。
