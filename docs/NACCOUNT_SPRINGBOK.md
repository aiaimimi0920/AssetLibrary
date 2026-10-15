# NAccount 认证与 SpringBok 部署

## 当前交付范围

`0.4.0` 接入已经部署的 `https://naccount-auth.aiaimimi.com`，新增应用自有 `.sba` v3 执行合同和 v2 资源声明。首次部署范围为真实身份、私有工作区、D1、私有 R2、Web/API 和定时维护。

**这不是扫描安全验收通过或生产分发开放。** `scannerService` 留空时不部署或绑定 scanner；对象仍隔离，内容检查不能获得通过。非空时仅引用同账户已有内部扫描服务，不创建 Container、不切换镜像。不得复用旧镜像历史云结果声称新镜像合格。`SCANNER_CLOUD_NOT_VALIDATED` 仍硬拒绝生产发布和下载。

## 2026-10-15 实际部署回执

- 地址：`https://assetlibrary.aiaimimi.com`；线上 `0.4.3`，固定 SHA `eb3c362ea7f8dcc7b18c38920de7bdeda068948b`。
- 独立仓库 [v0.4.3 Release](https://github.com/aiaimimi0920/AssetLibrary/releases/tag/v0.4.3)；精确提交 [CI 38750774015](https://github.com/aiaimimi0920/AssetLibrary/actions/runs/38750774015) 的 verify/secret_scan 均成功。
- SpringBok 原实例 `dc-b20cc87beb7b44c0aa5c73eec88a7292` 保留。repair 任务 `dc-e2e0c559e28242dbbe1ce9977b11a8fb`，
  [运行 38751546139](https://github.com/aiaimimi0920/SpringBok/actions/runs/38751546139) 业务结果 `succeeded`，10 项检查全部通过。
  包括 backup-created、data-preserved、deployed-bindings、release-identity、private-dependencies、
  naccount-login-configured、production-gate-preserved、repair-completed、unchanged-resources-verified、service-ready。
- 回执 archive SHA-256：`c50879602043be335dbcde3a5d192b3ed29658dd17b89a7f9fe0796f1dba00b7`；
  run/task/source 身份及 GitHub artifact digest 均独立核对。首次部署、失败升级的历史回执不改写为成功。
- 真实资源：Worker `assetlibrary`；D1 `assetlibrary-db` / `dd6dc465-2d9a-4ee6-800f-3033ffea0dc1`；私有 R2 `assetlibrary-objects`。
  R2 托管公共入口关闭、无自定义公开域名；Worker workers.dev/preview 均关闭，仅批准的自定义域名启用；cron 为 `* * * * *`。
  `NACCOUNT_SESSION_KEY` secret binding 存在且修复不生成新 key；这不是读出或比较 secret 明文字节的证明。SCANNER binding 不存在。
- `/healthz` 返回以上固定版本/SHA；`/readyz` 的 identity/database/storage 均 available，distribution 保持 blocked / SCANNER_CLOUD_NOT_VALIDATED。
- 独立验证：在精确发布提交的 clean 工作区，清空进程云 token 和 SBA_EXECUTE 后调用 `.sba/springbok.py` 的 verify，
  返回 succeeded / 四项公开只读检查通过，结果保留在 `linshi/assetlibrary-independent-verify-v043/result.json`。
  SpringBok 当前不向成功 repair 提供独立 verify 动作，因此这不是额外的平台 verify 任务，也不改写 repair 回执。
- 本轮本地：SBA Python 合同检查、SpringBok v3/v2 声明检查、formatter、typecheck、sizecheck、构建及 8 项认证/SBA 聚焦测试通过；
  活动依赖 fresh `pnpm audit --audit-level=low` 无已知漏洞。GitHub 推送仍提示仓库级 Dependabot 告警，未将活动依赖结果外推为全历史仓库安全通过。

真实浏览器已打开线上 Web。早期自动化点击在 Edge 出现 `ERR_BLOCKED_BY_CLIENT`；随后用户手动登录明确收到
`AUTH_ORIGIN_REJECTED`，已确认存在下述应用侧策略冲突，不能再将用户错误归因于扩展。
真实 NAccount 登录、创建/读取私有资源和退出仍待验收。
本次数据保全证明覆盖当时库/对象状态，不冒称已有完整业务数据升级、恢复演练或完整 P0–P6 退出。

## 0.4.4 登录表单策略修复

2026-10-15：Web 的 `Referrer-Policy: no-referrer` 与原生 `POST /auth/login` 表单冲突。
按 [MDN 的 Origin 规则](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy#effect_on_the_origin_header)，
该策略使非 CORS 的表单 POST 携带 `Origin: null`，随后被应用严格同源校验拒绝。
线上受控 HTTP 探针确认首页返回 no-referrer、null Origin 得到 403 / AUTH_ORIGIN_REJECTED、
正确 Origin 得到 303 到 NAccount authorize。未取得用户原始请求头，不将 HTTP 探针说成浏览器抓包。

仅将固定 Web 入口策略改为 `same-origin`：同源表单保留 Origin，跨站不发送 Referer。
认证重定向继续使用 `no-referrer`，不泄露 callback code/state；不接受 null、缺失或外站 Origin。
无 Schema、会话密钥、账号权限或 scanner 门禁变更。

回归先在旧代码确认策略断言失败，再修复通过；认证/Web/SBA 聚焦 10 项通过。
新增 null/缺失/外站来源拒绝、无 Cookie/事务/远端副作用和认证跳转策略断言。
formatter、typecheck、sizecheck、SBA Python 合同、构建和活动依赖审计通过。
浏览器工具自身加载 request-header policy 时遇到上游 403，不能接管 SpringBok 或完成真实登录验收。
本节记录待部署修复，不改变上节的已上线 0.4.3 回执；须经原实例正常 update 后独立 verify。

## 认证合同

- 正式 issuer 是域名 origin，不是 `/account` 页面地址。
- 使用独立 SPA client、固定小写 `/auth/callback`、Authorization Code + S256 PKCE，以及随机 state 和浏览器绑定；仅申请 `openid profile`，不申请 `offline_access`。
- 当前 NAccount Access Token 没有 `aud`，校验固定 issuer、RS256/JWKS、`azp`、`tokenType=user`、profile scope 和时效；拒绝 impersonation。不将 ID Token 当作业务 API 凭据。
- NAccount 实际 `/userinfo` 返回 `authId`，必须与已验证 token 的 `sub` 一致。每次私有业务请求在线核查用户/securityVersion，服务不可用时失败关闭。外部服务不可用不会假冒撤销，也不会放行离线缓存。
- 浏览器持有随机 `__Host-assetlibrary-session` Cookie（Secure、HttpOnly、SameSite=Lax）；D1 只保存 Cookie SHA-256。访问令牌和 PKCE verifier 使用 AES-GCM 加密，并绑定用途与行身份。`NACCOUNT_SESSION_KEY` 是 Worker secret。
- 会话最长 15 分钟，且不超过 access token 的有效期；到期重新登录。不把令牌写入 URL、浏览器存储或客户端 JavaScript。
- 所有私有请求（包括 GET/Range）校验页面会话绑定；写请求另校验 Origin。防止另一标签页更换 Cookie 后旧页接纳新主体的数据。
- 回调先原子认领事务，网络交换后有条件创建会话；退出删除当前会话并取消同浏览器在途登录，迟到回调不能复活会话。
- 配置 NAccount 后拒绝旧 Bearer 身份；未配置时保留原固定签发者本地测试入口。真实用户主体不使用邮箱，不自动获得审核或资源权限。

公开端点：`POST /auth/login`、`GET /auth/callback`、`GET /auth/session`、`POST /auth/logout`。只有 `/auth/session` 返回同源页面所需 CSRF 值，不返回访问令牌。退出先废止 AssetLibrary 会话，再跳 NAccount 的客户端退出入口；不宣称这撤销其他应用的令牌。

## 部署配置

SpringBok 自动分配 D1/R2，将实际 ID 写入 configuration。应用不创建同名替代资源。配置含 accountId、worker、origin、database、bucket、identity、reviewers、scannerService；不接受公开配置中的秘密。首次部署仅由云账户凭据生成新的会话加密 secret；更新使用 `keep_bindings: ["secret_text"]` 保留它，不隐式轮换。

真实接入登记于 2026-10-15：NAccount 应用 `AssetLibrary`，仅 `openid/profile`，回调 `https://assetlibrary.aiaimimi.com/auth/callback`，退出回跳 `https://assetlibrary.aiaimimi.com`。该登记不是浏览器登录已验收。实际 Cloudflare 资源核查发现 SpringBok 当前域名为 `https://springbok.yamiyu.com`，旧 `springbok-test.aiaimimi.com` 不是本轮控制台入口。

## 生命周期及限制

`0.4.3` 新增声明式 `r2-pagination-v041` 修复，只接受固定 `0.4.1` 提交的 update
父回执：状态必须是 `failed`、检查为空、错误为上述 Cloudflare 请求失败，且规范 JSON
摘要与 SpringBok 已核验的父结果一致。线上必须仍是固定 `0.4.0` 提交和版本，原 D1/R2、
身份与会话 secret 均匹配；否则写前拒绝。修复复用备份、旧行/对象保全、发布及就绪核对，
成功返回 `succeeded` 和 repair-completed/data-preserved/unchanged-resources-verified/service-ready。
写后异常仍为 unknown，不支持未知状态、任意旧版本或任意失败的通用重放。

`0.4.2` 修复真实 R2 List Objects 的分页差异：首请求省略空 cursor；响应未提供可选
`result_info` 时，按官方 `start_after` 严格递增读取至空页，不把短页猜为终页。
重复/逆序键、无效或重复 cursor、超过 100 页仍拒绝；备份键不纳入业务对象见证，
但参与分页进度。2026-10-15 已只读复现空 cursor 返回 400 / code 10023，
修正后的空桶及含私有备份的桶均完成读取；额外 D1 导出、R2 写入/读回摘要和旧行见证通过。
备份保留于 `_sba_backups/preupgrade-proof-20261015/`，不删除。

`0.4.1` 修正独立 verify 的凭据边界：SpringBok 不向 verify 交付云部署令牌，
所以只读取 `/healthz`、`/readyz`、匿名 `/auth/session`，核对固定版本、依赖可用性和关闭的门禁。
真实绑定核对仍在 deploy/update 的内部验证阶段执行；独立 verify 不冒称重新读取 Cloudflare 配置。

首次 `0.4.0` 部署任务 `dc-b20cc87beb7b44c0aa5c73eec88a7292` 经 SpringBok 恢复原 reserved
任务后，在 [运行 38745974590](https://github.com/aiaimimi0920/SpringBok/actions/runs/38745974590)
返回 `deployed-unverified`。`0.4.1` 升级任务 `dc-3cc50662aa804fc9891fcff1a7c6baf3`
在 [运行 38746770491](https://github.com/aiaimimi0920/SpringBok/actions/runs/38746770491)
因上述空 cursor 在备份/迁移前返回 `failed / ASSETLIBRARY_CLOUDFLARE_REQUEST_FAILED`；
该失败后线上保持 `0.4.0`，后来仅通过上文的独立 repair 晋级。Actions 的 success 不替代业务回执，两次原回执均保留，不重放。

- deploy：固定 GitHub SHA、干净检出；拒绝已存在 Worker、非空 D1、公开 R2 和其他服务占用的域名；执行增量 Schema、上传主 Worker 全模块、配置内部绑定、访问入口和 cron。写入开始后不确定结果为 unknown，不自动重放。
- update：核对原 SHA、同实例 D1/R2 和身份合同；导出 D1 到私有 R2 独立备份键并读回摘要，迁移后验证旧列/旧行及 R2 对象元数据见证；保留会话 secret。不把对象元数据见证说成逐字节全库恢复测试。
- verify：无部署凭据，只读核对固定版本、私有依赖可用性、匿名会话状态和仍关闭的分发门禁，不顺便发布或初始化。
- preview / destroy-preview：当前明确返回 `ASSETLIBRARY_PREVIEW_NOT_IMPLEMENTED`，应用入口在云调用前拒绝；**尚未完成全生命周期支持**。SpringBok 可能已在执行应用前分配预览资源，不能据应用拒绝声称平台未创建资源；不得发起这两个动作，也不自动删除平台已创建资源。
- 成功首次部署返回 deployed-unverified；独立 verify 的 succeeded 只表示上述服务可用性范围，不代表用户登录、扫描安全或完整生产分发通过。

备份保留在 `_sba_backups/<taskId>/<sha256>.sql`，不得自动清空；SQL 包含业务元数据及加密会话，不应公开下载。真实有数据升级/恢复与预升级能力必须另行验收。

## 本地验证入口

```powershell
rtk proxy pnpm test naccount.test.mjs sba-contract.test.mjs
rtk proxy python -B tests/sba_contract_checks.py
rtk proxy pnpm check
rtk proxy pnpm typecheck
rtk proxy pnpm sizecheck
rtk proxy pnpm audit --audit-level=low
```

SpringBok 根目录可只读检查：

```powershell
rtk proxy node pages/check-example.mjs C:/Users/Public/nas_home/AI/GameEditor/Neuro/AssetLibrary
```

认证测试使用真实业务代码、独占 D1/R2 和符合 NAccount 实际字段的合成远端，不冒称真实账号验收。SBA 测试使用假云后端，覆盖安全预检、错误回执、只读 verify、密钥初始化/保留、artifact hash 以及数据保全。云端结果应另行记录。
