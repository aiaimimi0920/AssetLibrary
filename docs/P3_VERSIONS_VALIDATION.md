# P3.2 本地验收记录

日期：2026-10-04。范围：不可变版本、独立审核决定、owner 撤回及失败关闭的发布请求。不是完整 P3 或正向发布验收。

## 实际通过的检查

- 聚焦版本/审核/一致性测试 **17/17** 通过，失败、取消、跳过均为 0。
- 完整本地 workerd/D1/R2 suite **55/55** 通过：既有 38 项回归和新增 17 项，失败、取消、跳过均为 0。
- Biome 格式/lint、TypeScript、有效行数和活动文本 UTF-8 无 BOM 检查通过。
- 本轮联网 `pnpm audit` 返回 `No known vulnerabilities found`。未添加依赖、未修改根锁文件。
- 四份 SQL 在新的隔离库首次应用成功，第二次返回 `No migrations to apply!`；没有清空旧状态或触及远端。
- 生产 Worker 的 fresh Wrangler dry-run 构建和最终候选身份核对使用最终交付目录中的 manifest、build.log、delivery-provenance.json；没有真正部署。

聚焦测试证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p3-zF6qLd`。

完整 suite 原始证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p3-2mXZWz`，含 manifest、bundle、build.log、tests.log。本地完整 suite 用时约 70.6 秒，仅是该次经过时间，不构成性能或云计费保证。

迁移证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p32-schema-20261004-082834`，含 migration-validation.log/json。两次命令退出码均为 0。

文档收尾后重新生成唯一候选，并逐项核对源码和产物 SHA-256；只有执行源码、配置、Schema 和 bundle 与已测身份完全一致才复用测试日志。source map 的构建目录差异单独记录，不冒称原始 map hash 相等。

## 真实闭环与安全证明

同一个无害 PNG 经真实 owner 创建资源、预留、上传、完成和检查，再创建 `pending_review` 版本；名单中的非 owner reviewer 提交 approved，版本 revision 增加而快照不变。owner 的 publish 请求返回 `409 REQUIRED_CONTENT_CHECK_UNAVAILABLE`，对象仍隔离，公开目录及下载仍为 404。随后 owner withdraw，保留之前审核者、决定、理由和时间。

| 场景 | 实际结果 |
| --- | --- |
| 创建前无检查、排队、拒绝或上传取消 | 409，不创建版本事实 |
| 非 Art、其他资源的上传、目录成员创建 | 不允许，不升级已有权限 |
| 同标签并发创建及重放 | 仅一份版本和一次创建审计，不重置状态 |
| 同标签更换 uploadId/resourceRevision | 409，不覆盖不可变快照 |
| 名单缺失、错误、重复、过大、大小写不匹配 | 失败关闭，不从请求或 JWT 角色授予权限 |
| owner 在审核名单中 | 仍拒绝自审 |
| 非授权主体、无效 JWT、伪造角色 | 无法查询私有版本或写审核/撤回事实 |
| 相同决定重放、相反决定或不同 reviewer/reason | 同一重放不重复审计，其余冲突 |
| 两名 reviewer 相反决定竞争、approve 与 withdraw 竞争 | 一个成功、一个 409，只有一份实际决定审计 |
| 创建、批准、撤回审计 ABORT | 状态和 revision 整批回滚，恢复后原请求可重试 |
| 创建预检后资源 title 改变 | 事务内复核拒绝，不遗留空壳版本 |
| 批准预检后取消、删除或 grant | 事务内拒绝，不写 approved 事件 |
| 批准后改 title、grant/revoke、删除或取消 | 历史批准保留，bindingCurrent 即时为 false |
| inspection revision、上传摘要或 etag 漂移 | 不能批准旧快照 |
| 失效后 reject/withdraw | 可以关闭版本，不抹掉已有审核历史 |
| PNG passed、当前快照和独立批准全部满足 | publish 仍拒绝，不产生 published 状态或公开对象副作用 |

基础接口闭环和常规竞争在本地 workerd 中执行；配置故障和确定性批次竞争在 Node 宿主装配相同生产 bundle、真实本地 D1/R2 binding，仅在测试中暂停 batch 或修改隔离状态。没有把故障开关编入生产 Worker。

## 工程审查

| 新增/修改文件 | 有效代码行 |
| --- | ---: |
| `db/0004_versions.sql` | 41 |
| `src/versions/create.ts` | 64 |
| `src/versions/decisions.ts` | 52 |
| `src/versions/policy.ts` | 26 |
| `src/versions/records.ts` | 106 |
| `src/versions/routes.ts` | 76 |
| `tests/version-fixture.mjs` | 105 |
| `tests/versions.test.mjs` | 174 |
| `tests/version-reviews.test.mjs` | 164 |
| `tests/version-consistency.test.mjs` | 190 |
| `src/index.ts` | 33 → 37，只有路由和类型接线 |
| `tests/fixture.mjs` | 128 → 137，增加隔离测试审核名单配置 |
| `scripts/build.mjs` | 91 → 91，更新候选阶段身份 |
| `package.json` | 31 → 31，版本改为 0.3.0-dev.2 |

没有新增大文件或软上限例外。逐文件复核有界输入、名单权限、参数化 SQL、自然幂等、CAS、审计原子性、快照所有权、错误脱敏及运行时清理。业务路径没有读取整包、启动进程、公开对象复制、无界集合或新外部调用；查询按主键/唯一标签定位。

独立只读审查没有发现可确定的高、中严重度缺陷或发布成功旁路；审查者没有运行测试，不将其源码核验冒充独立运行验收。审查指出完整资源 revision 会把成员变更也视为快照失效，该保守合同已在 API 文档和测试中明确。

## 未验收与下一停点

本轮记录审核决定，不证明审核者实际在系统中预览了内容；审核工作台和文件预览未实现。D1 bindingCurrent 不证明此刻 R2 存在，人工批准不替代必要内容安全策略。当前没有 published 状态、成功发布或下架接口、公开目录及下载。

下一项 P3.3 是先确定首期包体及必要安全检查组合，再完成对应运行限制验证与实际发布/下架闭环。不得因本轮拒绝门禁通过而开放 format-only 对象。真实 Cloudflare CPU/内存、账号接入、云网络故障、费用和生产部署仍未验收。

没有提交、推送、真实凭据使用、付费资源开通或云部署。已有归档、674 个历史 tracked 删除标记和其他未提交工作保留，未修改兄弟项目。
