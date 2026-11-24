# Trove / AssetLibrary 降本、提速与防刷保护合同（0.4.17–0.4.18）

本文档记录 `0.4.17`–`0.4.18` 针对公开可浏览资产商店（`https://assetlibrary.aiaimimi.com`）引入的 Cloudflare Workers 配额降本、首屏瀑布流消除、D1 热路径优化、边缘 SWR 缓存与防刷限流合同，严格对齐 `DEVELOPMENT_PLAN.md` 第 5、6 节的权限权威与缓存寿命边界。

## 1. 静态资源零 Worker 调用、`<link rel="modulepreload">` 与 1 年不可变指纹

- **构建与上传合同**：
  - `src/web/store.html` 与 `src/web/index.html` 显式声明全部子模块的 `<link rel="modulepreload">`，消除深层 ESM 串行网络瀑布流，使浏览器在首轮 HTML 解析时即并行拉取完整脚本图。
  - `scripts/build.mjs` 将 `src/web/` 下全部 20 个静态前端文件生成至构建产物 `public/` 目录（`store.html` 映射为 `/index.html`，`index.html` 映射为 `/workspace.html`），对样式、图标及 ESM 模块图收敛注入一致的 `?v=<12位SHA-256内容指纹>`，并计算 Cloudflare Static Assets 规范的 32 位 `blake3(base64 + ext)` 清单哈希及 64 位 `SHA-256` 完整性摘要写入 `manifest.json`。
  - `.sba/static_assets.py` 与 `.sba/cloudflare.py` 在本地校验全部静态文件 `SHA-256` 与字节长度通过、且确认 scanner 窗口有效后，通过 `/workers/scripts/{worker}/assets-upload-session` 与 `/workers/assets/upload` 上传增量静态资源，并在 Worker `metadata.assets` 中绑定 `html_handling: "auto-trailing-slash"`、`not_found_handling: "none"` 及严格安全响应头 `_headers`。
- **计费与静态缓存策略**：
  - 未设置 `run_worker_first` 时，全部 20 个静态前端文件由 Cloudflare 边缘 Static Assets 直接返回，**0 次 Worker 请求计费、0 CPU 时间**。
  - `/` 与 `/workspace`：`Cache-Control: public, max-age=60, stale-while-revalidate=300`（保证新版本发布后快速切换新的 `?v=` 指纹入口）。
  - `/*.css`、`/*.js`、`/beaver.svg`：`Cache-Control: public, max-age=31536000, immutable`（浏览器与全球边缘节点长期缓存 1 年，复访 0 网络往返；内容变更由入口 HTML 内的新 `?v=` 指纹立即切换）。
  - 全部静态响应保持严格 `Content-Security-Policy`、`Referrer-Policy: same-origin`、`X-Content-Type-Options: nosniff` 与 `Permissions-Policy`。

## 2. D1 热路径单次查询、复合索引与边缘 SWR 缓存边界

- **D1 热路径优化与 `0015` 索引**：
  - `src/spaces/optional-schemas.ts`（`withOptionalSchemas`）默认按完整 Schema 直接执行单次业务 SQL，彻底消除每次冷启动或请求时的 `sqlite_master` 前置探测往返（仅在历史增量迁移测试缺表时自动回退）；所有列表查询先完成参数边界校验，非法请求不消耗任何 D1 读取。
  - `db/0015_query_indexes.sql` 为 `versions(resource_id, state, id)`、`versions(kind, state, id)`、`version_asset_attributes(category, style, license, version_id)` 及 `asset_requests(state, space|style|license, id)` 补齐保数据复合索引。
- **公开缓存寿命、SWR 后台刷新与写操作本机房即时失效**（严格遵循 `DEVELOPMENT_PLAN.md` 第 6 节第 6 条声明跨机房最大残留窗口）：

| 路径范围 | 浏览器 `max-age` | 边缘新鲜期 `s-maxage` | 边缘后台异步 `SWR` 窗口 | 跨机房最大公开可见残留窗口 | 备忘与保护边界 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GET \| HEAD /v1/catalog`、`/v1/catalog/:id` | `5s` | `60s`（生产 `PUBLIC_EDGE_CACHE_SECONDS=60`） | `300s`（单飞 `waitUntil` 后台回源） | 浏览器 `5s`；同机房写操作即时清理，跨机房最长约 `60–360s` | SWR 期内访客 0 毫秒获返 `X-Traffic-Cache: STALE` 并后台异步刷新；剥离客户端 `Cookie`/`Authorization` |
| `GET \| HEAD /v1/asset-requests`、`/v1/asset-requests/:id` | `5s` | `60s`（生产 `PUBLIC_EDGE_CACHE_SECONDS=60`） | `300s`（单飞 `waitUntil` 后台回源） | 浏览器 `5s`；同机房写操作即时清理，跨机房最长约 `60–360s` | 发布／响应／关闭求购成功后立即清理当前边缘机房对应缓存键 |
| `GET \| HEAD /v1/catalog/:id/cover`（含可选 `?v=<hex>`） | `60s` | `300s`（生产 `COVER_EDGE_CACHE_SECONDS=300`） | `60s`（响应头） / 边缘最长 `600s` | 同机房下架即时清理，跨机房最长约 `300–900s` | 命中 `If-None-Match` 在调用 R2 `get`/`head` **之前**直接返回 `304`；前端附带 `?v=<sha256前16位>`、`loading="lazy"` 与 `decoding="async"` |
| **私有接口与包体下载**：`/auth/*`、`/v1/me*`、`/v1/resources/*`、`/v1/uploads/*`、`/v1/versions/*`、`/v1/reviews/*`、`/v1/publications/*` | **`no-store`（0 秒）** | **禁止缓存（0 秒）** | **无** | **0 秒（实时读取 D1 Primary）** | 私有封面、我的资源库、我的求购、方案响应、下载票据（`/tickets`）及每个包体流分段（`/content`）均保持 `no-store`，下架或撤销授权后立即拒绝 |

- **商店前端无锁抢占与零布局跳动（Zero-CLS）**：
  - 目录／求购读取期间保持顶部导航栏、细分分类按钮、筛选下拉与搜索框可交互；用户点击新栏目或筛选时自动中止在途旧读取并立即切换目标路由，不再因首屏慢请求锁死页面或闪现取消报错。
  - 切换筛选期间保留既有卡片半透明过渡，空列表初始加载采用固定最小高度骨架占位，并为卡片启用 `content-visibility: auto`，消除页脚跳动（CLS）。

## 3. 双层防刷与突发限流（Rate Limiting）

在进入路由、D1 查询、R2 读取或 NAccount 交互前，`src/traffic/rate-limit.ts` 执行两级无状态／有界防护：

1. **请求输入前置拦截**：
   - URL 总长度超过 `2048` 字符立即返回 `414 URI_TOO_LONG`，不进入解析或数据库查询。
   - `/v1/catalog/:id/cover` 仅允许空查询串或唯一合法参数 `?v=<1..64位十六进制>`，其余查询参数立即返回 `400 INVALID_QUERY`。
2. **客户端地址归并（防 IPv6 `/64` 轮换）**：
   - 基于 Cloudflare 边缘注入的 `CF-Connecting-IP` 提取客户端键；IPv6 地址统一归并至前 4 组 `/64` 子网前缀（如 `2001:0db8:abcd:0012::/64`），防止攻击者在同一 `/64` 地址段内随机轮换后缀绕过单 IP 配额。
3. **有界内存窗口 + Cloudflare 原生 `ratelimit` 绑定**：
   - **单实例有界内存限流器**：固定 60 秒窗口，最大跟踪键数硬上限为 **`2,048`**（满额时优先清理过期项，仍满则 `O(1)` 淘汰最早键），杜绝随机源地址洪泛耗尽 Worker 128 MB 内存。
   - **Cloudflare 原生机房级 `ratelimit` 绑定**（Free 与 Paid 计划均免费内置，跨同机房实例共享计数）：
     - `RATE_LIMIT_PUBLIC`（`namespace_id: "1001"`）：每分钟 `300` 次（覆盖 `/v1/catalog*`、`/v1/asset-requests*`、`/readyz`、`/auth/session` 等读取请求）。
     - `RATE_LIMIT_AUTH`（`namespace_id: "1002"`）：每分钟 `15` 次（保护 `POST /auth/login` 与 `GET /auth/callback`，防止刷满 `auth_transactions` 容量上限）。
     - `RATE_LIMIT_WRITE`（`namespace_id: "1003"`）：每分钟 `120` 次（保护 `POST` / `PUT` / `DELETE` / `PATCH` 写接口，兼顾多步上传发布流程）。
   - 超限统一返回 `429` JSON `{"error":"RATE_LIMITED"}`，携带 `Retry-After` 秒数与 `Cache-Control: no-store`。
4. **已知边界声明**：
   - 应用层与 Worker 原生 `ratelimit` 绑定可阻断恶意爬虫对 D1、R2 与 NAccount 的放大消耗，但任何实际到达 Worker 的动态 API 请求（含返回 `429` 的请求）仍计入 Cloudflare Worker 请求数；若遭遇大规模分布式洪水攻击，仍可结合域名级 Cloudflare WAF / Bot Fight Mode 在进入 Worker 前拦截。

## 4. `0.4.17` 发布与生产保数据升级回执（2026-11-23）

- **发布身份**：GitHub Release [v0.4.17](https://github.com/aiaimimi0920/AssetLibrary/releases/tag/v0.4.17)，精确提交 `943bb384ef59a78e9941cd95e50756366fd98dbe`；GitHub Actions CI 运行 [45056341038](https://github.com/aiaimimi0920/AssetLibrary/actions/runs/45056341038) 的 `verify`（437 项测试：436 通过、0 失败、1 默认跳过）与 `secret_scan` 全部通过。
- **SpringBok 原实例保数据升级（`update`）**：
  - 实例 ID：`dc-b20cc87beb7b44c0aa5c73eec88a7292`（`https://assetlibrary.aiaimimi.com`，Worker `assetlibrary`，D1 `assetlibrary-db` / `dd6dc465-2d9a-4ee6-800f-3033ffea0dc1`，私有 R2 `assetlibrary-objects`）。
  - 任务 ID：`dc-71325e47a06e49ba821b2f45734b381c`（首次提交因同云账户另一服务占用通道停在写前 `preparation-unconfirmed`，通道释放后原任务恢复执行，未新建任务或改动配置）。
  - SpringBok 运行：[45083021109](https://github.com/aiaimimi0920/SpringBok/actions/runs/45083021109)，业务结果 `deployed-unverified`，**7/7 检查通过**（`backup-created`、`data-preserved`、`deployed-bindings`、`release-identity`、`private-dependencies`、`naccount-login-configured`、`scanner-admission-verified`）；回执制品 `14777393300` SHA-256 `113f50a1ee4f7546758c20bc2720515f657d39aa045e5341063cd4e7e27c3df8` 与 GitHub API digest 核对一致。
- **SpringBok 独立平台验证（`verify`）与本地无凭据验证**：
  - 平台验证任务：`dc-748f0aad754d48e0852eed506185fce5`，SpringBok 运行 [45083217409](https://github.com/aiaimimi0920/SpringBok/actions/runs/45083217409)，业务结果 `succeeded`（控制台状态 `可用性已验证`），**4/4 检查通过**；回执制品 `14778420968` SHA-256 `5f7be4a6079969675f3edf57c8c47de0fa54a794fd3b518974751670dc0fb084` 核对一致。
  - 本地清空 `CLOUDFLARE_API_TOKEN` 与 `SBA_EXECUTE` 后执行 `.sba/springbok.py` `verify`，返回 `succeeded` / 4 项检查通过。
- **线上边缘实测证据**（保存在 `linshi/trove-release-0417-20261123/verification-summary-0417.json`）：
  - `/`、`/workspace`、`/store.css`、`/store.client.js`、`/beaver.svg` 均返回 `200`、携带严格 `Content-Security-Policy` 与 `_headers` 声明的 `Cache-Control`，且**不含 Worker `X-Request-ID` 响应头**，证实由 Cloudflare Workers Static Assets 在边缘直接返回、未触发 Worker 调用；子资源 `If-None-Match` 实测返回 `304`（0 字节响应体）。
  - `GET /v1/catalog?limit=20` 原有 **10 条发布完整保留**，首请求 `X-Traffic-Cache: MISS`、紧接次请求命中边缘 `X-Traffic-Cache: HIT`，`If-None-Match` 返回 `304`；`GET /v1/asset-requests?limit=20` 同样命中 `ETag -> 304`。
  - `GET /auth/session` 保持 `Cache-Control: no-store`；超长查询串请求实测返回 `414 URI_TOO_LONG`（`Cache-Control: no-store`）。
