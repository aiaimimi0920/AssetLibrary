# NAccount 认证与 SpringBok 部署

## 当前交付范围

`0.4.0` 接入已经部署的 `https://naccount-auth.aiaimimi.com`，新增应用自有 `.sba` v3 执行合同和 v2 资源声明。首次部署范围为真实身份、私有工作区、D1、私有 R2、Web/API 和定时维护。

**这不是扫描安全验收通过或生产分发开放。** `scannerService` 留空时不部署或绑定 scanner；对象仍隔离，内容检查不能获得通过。非空时仅引用同账户已有内部扫描服务，不创建 Container、不切换镜像。不得复用旧镜像历史云结果声称新镜像合格。`SCANNER_CLOUD_NOT_VALIDATED` 仍硬拒绝生产发布和下载。

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
线上保持 `0.4.0`。Actions 的 success 不替代业务回执，两次原回执均保留，不重放。

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
