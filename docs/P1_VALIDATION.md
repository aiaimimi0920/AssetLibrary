# P1 本地验收记录

日期：2026-10-04。范围：从零实现的 TypeScript Worker/D1 私有资源目录，不包含历史代码、R2 或云部署。

本文件保留 P1 当时的验收范围与证据；后续 P2 当前结果见 [P2_VALIDATION.md](P2_VALIDATION.md)，不以更新阶段状态改写旧测试结果。

## 通过的验证

- Node.js 22.22.2、pnpm 10.33.0，根锁文件固定当前活动依赖。
- Biome 格式与 lint、TypeScript `tsc --noEmit`、有效代码行和 UTF-8 无 BOM 检查通过。
- npm 官方 advisory 服务在线审计生产及开发依赖：`No known vulnerabilities found`；这不代表无零日漏洞，也不替代秘密扫描。
- Wrangler 4.147.0 `deploy --dry-run` 成功生成 Worker bundle，不执行真实部署。
- Wrangler 对独立 `linshi/assetlibrary-p1-schema-20261004-054642` 本地库成功应用建表脚本；第二次返回 `No migrations to apply!`，未触及云端或旧库。
- 同一 bundle 在 Miniflare/workerd 与真实本地 D1 binding 中运行 11 个集成测试，全部通过，无跳过项。

测试覆盖：

| 测试 | 实际断言 |
| --- | --- |
| 外部身份边界 | 缺失、伪造、过期、未来时间、错误 issuer/audience、无效主体、缺失必要 claim 拒绝 |
| 输入与注入 | 未知字段、越界大小、非法 revision、控制字符拒绝；SQL 片段只能作为绑定的标题文本 |
| 未配置身份 | 业务 API 返回 503，无可信主体头或开发旁路 |
| 数据库不可用 | 缺少 Schema 返回脱敏 503，不假装业务成功 |
| 完整 CRUD | 创建、读取、编辑、授予成员、解除成员、墓碑删除按序完成，审计 revision 一致 |
| 私有权限 | 读成员和无关主体不能编辑、删除或转授权；隐藏详情不泄露 |
| 有界分页 | 页大小受限，排序确定，去重且不混入其他主体资源 |
| 并发重放 | 8 个相同请求只创建一份资源和一条审计；不同内容 409；不同主体的键隔离 |
| revision 竞争 | 两次同 revision 修改只有一次 200，一次 409，失败不写审计 |
| 删除/授权竞争 | 恰有一个成功，不产生墓碑后的成员或幽灵审计 |
| 事务失败恢复 | 在末尾审计 INSERT 处触发 SQLite ABORT，资源、幂等结果和审计整体回滚，原键可重试 |

初轮测试发现 Miniflare 5 不再接受旧的顶层 `modules/scriptPath/d1Databases` 配置；已按安装版本的 `workers[].config.manifest/env` 原生 API 修正测试装配，并重新执行全部测试。没有降级数据库 mock 或跳过失败用例。

## 工程与资源检查

新源码从 0 开始，没有向历史超标文件追加职责。所有手写文件均低于 500 有效行；`pnpm sizecheck` 输出逐文件数值，当前没有 501–700 行例外。SQL 参数、主体、幂等键、标题、JSON 字节数及列表上限均有边界。

测试数据库和运行证据位于 `linshi`，不进入源码或可部署包。每个 Miniflare fixture 在成功、断言失败和初始化失败路径调用 `dispose()`。构建前后核对活动源码 SHA-256，检测并发修改；产物 manifest 绑定 bundle、source map、配置和 D1 Schema。

测试和本地建库结束后已按本仓库可执行路径复核，没有遗留的 `workerd.exe`。强制终止宿主、操作系统崩溃和长期运行资源压力不属于本轮验收。

独立只读子代理因上游 `503 Service Unavailable` 未能执行，不能记为独立评审通过。本批源码安全、事务、生命周期和有界性复核由主代理完成。

## 尚未通过或未执行

- P2–P6：R2、包体验证、发布、下载撤销、Web 入口和真实 Cloudflare 环境尚未实现或验收。
- 真实外部账号集成、公钥轮换、主体停用传播未验收；本地签名身份只用于协议验证。
- 依赖审计不等于完整 Git 历史秘密扫描，本批没有重新执行历史扫描或修改远端安全门禁。
- 幂等、墓碑、审计保留和上线限流尚无生产策略；本地测试不承诺容量、费用或持续运行性能。
- 没有提交、推送、远端 CI 或生产部署；现有 `old/` 归档工作区状态保留。

具体构建目录由 `pnpm test`/`pnpm build` 输出，采用唯一的 `linshi/assetlibrary-p1-*` 目录；以对应 `manifest.json`、`build.log`、`tests.log` 为原始证据，不将历史目录中的失败运行覆盖为通过。
