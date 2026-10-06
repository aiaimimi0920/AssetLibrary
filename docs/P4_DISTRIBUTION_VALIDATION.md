# P3/P4 本地业务验证：`.17`

2026-10-05，版本 `0.3.0-dev.17`。用户指定的原生组件安全风险与网络边界验收继续延期，本轮没有重新开展这些验收、Docker 构建或云端部署。

## 已运行结果

- 新增 20 项聚焦测试全部通过。修复一次测试夹具试图违反已有 inspection CHECK 约束的问题后重新执行；没有放宽数据库约束或生产门禁。
- 完整 `rtk proxy pnpm test`：**192 pass / 0 fail / 0 skip**，受测候选 `../../linshi/assetlibrary-p3-jvKhbJ`，原始日志 `tests.log`，约 91.7 秒。
- Biome、TypeScript 和有效行数检查通过；新生产模块最大 96 有效行附近，新增测试最大 226 行，无软上限例外。
- `pnpm audit --audit-level=low` 联网查询结果为 `No known vulnerabilities found`；该结果只针对当前 pnpm 依赖，不覆盖延期的原生组件风险。
- AssetLibrary 与 Neuro 两个独立仓库的 `git diff --check` 通过；没有 staging、commit、push 或云变更。

最终候选、源码/产物身份与运行时清理以 `../../linshi/assetlibrary-distribution-20261005/final-delivery.json` 为准。完整测试候选与最终候选的运行字节必须逐项比较后才复用证据；不以源码近似或构建成功替代身份核对。

## 验证范围与含义

`tests/publications.test.mjs` 覆盖并发自然发布幂等、owner/revision/状态/扫描拒绝、取消竞争、发布审计回滚、终态下架重放和下架审计回滚。真实生产 Worker 保留 clean 后发布拒绝，合成 publication、请求/环境布尔值都不能开放目录、票据或下载。版本查询可恢复 publication ID/state/revision，原审核事实不被发布改变。

`tests/distribution-grants.test.mjs` 覆盖独立授权 CAS/并发重放、owner 专属查询恢复、输入边界、授权/撤销审计回滚、最少公开字段、资源库权限和失效候选分页前进。

`tests/distribution.test.mjs` 在真实本地 D1/R2 上证明同一个双 PNG Art ZIP 上传、检查、版本和独立审核后，业务核心返回完全一致的包体及 SHA-256。目录读成员不能直接下载；主体/票据绑定、票据摘要保存、撤销后新请求和 Range 拒绝、重新授权不复活旧票据、过期清理、单 Range/suffix/If-Range/HEAD/416 均有断言。

`tests/distribution-recovery.test.mjs` 暂停真实 R2 GET 的返回窗口，在其中提交下架、上传取消或下载授权撤销，证明第二次 primary 查询拒绝且取消已取得流。还覆盖资源修改/删除、版本撤回、扫描原文变化/畸形事实、R2 消失/覆盖/伪造 custom metadata、请求中止、消费取消、读取失败及 reader 释放。

已开始交付的流允许结束，之后的新请求和 HEAD 拒绝；测试与合同一致，不声称撤销能收回已传字节或立即截断既有响应。只读交叉核验未发现明确生产门禁绕过，指出的 R2 等待竞争/stream 生命周期测试缺口已补齐并实际通过。

## 明确不是本轮结论的事项

正向测试通过合成 clean 事实和独立测试编译直接调用业务核心，**明确假设部署已经安全准入**。这不是实际 ClamAV 运行证明、真实 Cloudflare 正向发布/分发验收或生产资格。测试模块不进入主 Worker，不提供部署认证旁路。

新 Schema 只应用于独占测试数据库；旧手动开发库、历史镜像/云资源与 `.16` 包保持原样。P5 分发 Web 交互、真实外部账号、P6、延期安全验收以及实际生产发布/下载仍未完成。全计划目标保持 active，不能将本轮局部业务交付写成总目标完成。
