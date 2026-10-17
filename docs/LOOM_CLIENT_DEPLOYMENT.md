# Loom 原生客户端正式部署方案

## 0.4.7 实际上线与独立验证

用户已明确要求实际部署与线上测试成功，并单独同意 `0009` 的备份后保数据迁移。
本版本包含 Loom 原生包策略、迁移、下载票据时效修复和 scanner 部署准入保护；
scanner 验收记录仍为空，不能将本版本上线等同于正式分发已开放。

用户另指定当前登录的真实账号承担独立审核。`.sba/reviewers.py` 以已读取的
NAccount 主体登记该授权，只在原正式 target 和网页 identity 全部匹配、平台
`reviewers` 仍为空时生效；显式非空名单保持优先。不修改 SpringBok 原 configuration，
不使用邮箱充当主体，不自动让包 owner 通过自审。发布者须为另一个真实账号。
发布后核验 `REVIEWER_PRINCIPALS` 必须与版本管理的有效名单一致；原生客户端、
网页客户端、会话密钥和私有 D1/R2 的保留约束不变。

2026-10-16 已在原实例完成正常升级：

- `v0.4.7` / `1d8a19fb9af220081d4fc8bcc9bc1b5511f5a5f6`；本地完整 349 项通过，
  精确提交 [CI 38955024244](https://github.com/aiaimimi0920/AssetLibrary/actions/runs/38955024244) 两个 job 通过。
- update task `dc-22405e075dfd4bb58c32fbb02fde6100`，
  [run 38955900682](https://github.com/aiaimimi0920/SpringBok/actions/runs/38955900682)；
  回执 `deployed-unverified`，备份、保数据、绑定及其余四项共七项通过。
  artifact `12070397960`，已下载 ZIP 并核对 SHA256
  `ae5695829c0250309ff1485e220af54cbf398a98260913e933bd623aabfe274e`。
- 独立 Cloudflare 读回原 D1/R2、native client 和 session secret binding 保持；
  审核主体名单已生效。0001–0009 迁移存在，0009 摘要与本地一致，foreign_key_check 为空。
  当时 resources/uploads/inspections 各 1，versions 为 0，不将其外推为大量生产版本迁移证明。
- 无云凭据的独立应用 verify 四项通过；随后真实平台 verify task
  `dc-dd7006263e074c3ebdf8af4457b9fbf2`，
  [run 38958057697](https://github.com/aiaimimi0920/SpringBok/actions/runs/38958057697)，
  已读取业务回执 `succeeded`、精确版本/SHA 和四项 passed；平台显示“可用性已验证”。
- 证据：`linshi/assetlibrary-run-38955900682/`、
  `linshi/assetlibrary-independent-verify-v047/`、`linshi/assetlibrary-v047-online-progress.json`。

服务部署与可用性验证已通过，但 scanner 仍未绑定，生产分发保持
`SCANNER_CLOUD_NOT_VALIDATED`。真实双账号发布、审核及 Loom 下载、安装、运行仍未通过。
后续扫描器修补属于未上线增量，不能用本次 349 项或线上版本证明新引擎通过。

## 2026-10-16 历史 0.4.6 部署结果

- 发布 `v0.4.6` / `84d29682e03c27e81a50a414019e97094e89f353`，精确提交 CI
  [38850067853](https://github.com/aiaimimi0920/AssetLibrary/actions/runs/38850067853) 两项 job 通过；本地完整测试 329 项通过。
- 用户在原实例提交 task `dc-bf45117308d444189d09edb0e1007b19`，SpringBok 执行
  [38850385813](https://github.com/aiaimimi0920/SpringBok/actions/runs/38850385813) 成功。
- 回执 `deployed-unverified`，备份、数据保全、部署绑定、发布身份、私有依赖、网页认证配置和生产门禁七项均通过。
  artifact `12024174430`，归档 SHA-256 `8c7e56584b99ee84034702256e995b7683adb1446e2e08c51c9b420f9f78dee2`，
  摘要与 run/task/source 身份已核验；证据在 `linshi/assetlibrary-run-38850385813/`。
- 独立 Cloudflare 读回：native clientId 与下文 Loom 值一致，网页 clientId、D1/R2 不变，
  session secret binding 存在，reviewers 仍为空，SCANNER 未绑定；不声称读出了 secret 明文。
- 在 clean 发布提交运行无云 token 的应用 verify，四项通过；healthz 精确版本/SHA 匹配，readyz
  为 ready，分发仍 blocked / `SCANNER_CLOUD_NOT_VALIDATED`。
  证据在 `linshi/assetlibrary-independent-verify-v046/`，不是 SpringBok 平台独立 verify 任务，未改写平台状态。
- 本批完成服务端客户端配置部署；Loom 桌面真实登录与私有资源访问、包上传/安装/更新仍须分别验收。

## 当前问题与责任边界

`0.4.5` 已部署，但正式 Worker 没有 `NACCOUNT_NATIVE_CLIENT_ID`。SpringBok 的
`cloud/service-instance.mjs::updateOperation` 要求新旧 `configuration` 完全一致，
因此仅新增一个可选配置字段并不能为已部署实例启用客户端。

`0.4.6` 将已授权的正式站点集成声明放入应用自有 `.sba/native_client.py`，由固定版本源码
决定有效 native binding。平台保存的 configuration、请求摘要与历史回执不修改。
不直接修改 Cloudflare binding，不修改 SpringBok，不新建实例，也不重放历史 update。

## 确定性配置规则

1. 配置已显式提供 `identity.nativeClientId` 时使用该值，保留 `0.4.5` 的合同。
2. 未提供时，只有下面五项全部匹配才使用已登记的 `Loom Desktop` 公开客户端：

| 字段 | 固定值 |
| --- | --- |
| accountId | `bea2e3be0577ee4f7b3ffae4df6f53bb` |
| worker | `assetlibrary` |
| origin | `https://assetlibrary.aiaimimi.com` |
| identity.issuer | `https://naccount-auth.aiaimimi.com` |
| identity.clientId | `1F55EDc6b445F3E8d0787B227171dea1917bE2E2bb72bf768c16f17655c8cc9f` |

有效 Loom clientId：`E2C4ea99CC5Fee924b9023D76986397f7593282D25AF979d727D26eaB09A0c10`。
这些都是公开部署标识，不包含 OAuth secret 或 Cloudflare token。其他站点不自动启用。

预检、发布、发布后 binding 验证共用一个解析函数。预检仅允许从未配置转为期望值，
或保留已匹配的值；已有其他 native binding 时写前拒绝。发布后缺少或错误绑定不能通过
`deployed-bindings`。未修改网页 clientId、session key、D1/R2、reviewers 或 scanner。

## 发布与实际操作

1. 本地检查和精确提交 CI 通过后，发布 `v0.4.6` 固定版本。
2. SpringBok 原 AssetLibrary 实例从 `0.4.5` 正常升级到 `0.4.6`，继续原 configuration。
   不需要在页面输入或修改 `nativeClientId`，不选择“部署服务”创建新实例。
3. 记录新 task/run，核验 artifact digest、回执 task/source/version；写后 unknown 不重放。
4. 独立读回 healthz、readyz 与 Worker binding，确认 nativeClientId 与 Loom 完全一致。
   确认原网页身份、资源和扫描门禁保持。
5. 桌面真实 NAccount 登录及私有目录访问另行验收。部署绑定成功不是登录成功，也不是包上传、安装或更新完成。

## 后续升级、失败与撤回

后续版本保留此集成声明及回归测试；即使平台 configuration 仍没有该字段，也会解析为同一客户端，
不会因为下一次正常升级而丢失。更换上述站点身份或客户端不是普通升级，须显式迁移并重新授权。

此变更不更改业务 Schema 或对象字节。构建或预检失败保持旧版本；写后失败按既有 unknown 规则保留
现场与备份，先核验回执和实际 binding。不能以重复点击升级处理未知状态。
SpringBok 不接受降版本 update，因此不把重新部署 `0.4.5` 当作受支持回滚。
若需要撤回集成，应发布更高版本的应用修订，明确允许仅移除本次固定 Loom binding 并验证网页链路；
不得直接删除 Worker、重建数据库、改写旧回执或移除 session secret。该撤回动作不是本次自动执行步骤。

## 回归证据

`tests/sba_native_client_checks.py` 验证：五项匹配隔离、显式配置优先、原配置不变、旧无 binding
升级后添加、后续版本继续保留、缺失绑定验证失败、已有错误 binding 写前拒绝、网页 client 与
资源绑定不变、session secret 保留及不添加 scanner。这里使用假云与受控工件，不冒称实际云部署。
