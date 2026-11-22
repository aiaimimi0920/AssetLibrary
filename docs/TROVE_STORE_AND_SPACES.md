# Trove 商店壳层、内容空间、素材市场与求购广场（0.4.16）

更新日期：2026-11-23。本文件记录 `0.4.16` 候选版本包含的三批连续业务切片与活动依赖安全修复。

## 1. 第一切片收口：Trove 商店壳层与真实三分区过滤

在保留既有身份、下载续传、请求效率与未扫描分发合同的前提下，将公开商店 `/` 切换为已确认的 **Trove** 品牌壳层与五类一级导航：

- **品牌与一级导航**：采用 `/beaver.svg` 图标、宣传语“好东西，都在这！”／“好玩的，好用的，都在这！”（`All the good stuff. Right here!`），一级导航固定顺序为 **游戏、应用、loom、素材、社区**，右侧保留 **发现 / 我的资源库** 与 **发布作品 ↗**。
- **按真实包合同分区（`GET /v1/catalog` 与 `GET /v1/me/library` 可选 `section`）**：
  - `section=applications`：`versions.kind = 'application'`。
  - `section=loom`：归属 Loom 空间的扩展包（`art` / `capability` / `mcp`，包含全部 `loom-*` 原生检查策略及显式指定 `space='loom'` 的扩展版本）。
  - `section=assets`：非 Loom 专属的 `art` 素材包。
  - 未知、空值或重复 `section` 均返回 `400 INVALID_CATALOG_FILTER`；不按标题关键字猜测游戏、素材或宿主兼容性。
- **诚实空态与发布入口**：尚未实现真实后端的 `#games`（游戏）与 `#community`（社区）不发起伪目录请求、不注入示例商品，明确展示“尚未开放”提示并支持搜索或一键回到市场；访客点击“发布作品 ↗”弹出同源原生 POST `/auth/login?returnTo=workspace` 登录提示，已登录用户直接进入 `/workspace`。

## 2. 第二切片：作品展示元数据、静态 PNG 封面与应用内容空间

在不引入外部图片外链、不放宽 CSP（保持 `img-src 'self'`）且不破坏不可变版本审核绑定的前提下，补齐作品展示资料、静态 PNG 封面与应用内容空间聚合：

### 2.1 保数据增量表（`db/0013_showcase_spaces.sql`）

- 新增 `STRICT` 表 `resource_profiles` 与 `version_profiles`（含 `version_profiles_space(space, version_id)` 索引），不重建或删除既有表、外键、业务行与 R2 包体。
- 空间枚举固定为 `general`（跨应用通用）、`loom`、`otter`、`framelab`；未建立展示记录的历史版本按检查策略确定性解析（`loom-*` 原生策略解析为 `loom`，其余为 `general`）。

### 2.2 展示资料与静态 PNG 封面 API

- `PUT /v1/resources/:id/profile`：owner 草稿 + `revision` CAS + `Idempotency-Key`，更新 `space`、`summary`（0–160 字符）、`detail`（0–2000 字符），原子递增 `resources.revision` 并写入 `audit_events(action='profile')`。
- `PUT /v1/resources/:id/cover?revision=<n>` 与 `DELETE /v1/resources/:id/cover`：接受 `<= 1 MiB` 严格静态 RGBA8 PNG（复用 `inspectPng`），存入私有 R2 `covers/<resourceId>/<sha256>.png`，原子递增 `resources.revision` 并记录审计。
- 受控流式封面读取：`GET | HEAD /v1/resources/:id/cover`（owner 或目录读成员）、`GET | HEAD /v1/versions/:id/cover`（owner 或独立 reviewer）、`GET | HEAD /v1/catalog/:id/cover`（匿名公开，实时核验 `isDistributable`，失绑／下架／关闭后立即返回 `404`）。
- 内容空间过滤与页面：`GET /v1/catalog?space=<space>`、`/v1/me/library?space=<space>` 及商店 `#app/loom`、`#app/otter`、`#app/framelab` 专区横幅与双向跳转。

## 3. 第三切片：素材细分属性筛选与真实求购广场（`#assets`）

按已获确认的不含在线支付／资金托管边界，落地素材市场细分检索与真实求购需求发布、方案响应和关闭闭环：

### 3.1 保数据增量表（`db/0014_asset_market_requests.sql`）

- 新增五张 `STRICT` 增量表：`resource_asset_attributes`、`version_asset_attributes`（含 `version_asset_attributes_category` 索引）、`asset_requests`（含 `asset_requests_public`、`asset_requests_requester` 索引）、`asset_request_responses`（`UNIQUE(request_id, responder)`，含 `asset_request_responses_request` 索引）与 `asset_request_events`。
- 通过 `hasAssetMarketSchema(db)` 保持 `0001`–`0013` 历史增量迁移测试完全兼容。

### 3.2 素材细分属性与防绕过审核绑定

- **受控枚举**：
  - `category`：`general`（未细分默认）、`models`（3D 与场景）、`images`（2D 与 UI）、`materials`（材质与贴图）、`audio`（声音与音乐）、`effects`（特效与动画）、`templates`（代码与模板）。
  - `style`：`general`、`pixel`、`lowpoly`、`realistic`、`stylized`、`handdrawn`。
  - `formats`：最多 4 项去重升序标准格式标签（`PNG / SVG / ASEPRITE / GLB / FBX / BLEND / SHADER / WAV / OGG / LUT / GDSCRIPT / ZIP`）。
  - `license`：`unspecified`（默认）、`commercial`、`personal`、`open_source`。
- **防篡改快照**：`PUT /v1/resources/:id/attributes` 递增 `resources.revision` 并记录 `audit_events(action='attributes')`；创建版本时冻结写入 `version_asset_attributes`，`currentSnapshot` 同步校核属性一致性，发布后任何属性改动均使旧发布立即失绑下线。
- **目录与私库细分过滤**：`GET /v1/catalog` 与 `GET /v1/me/library` 支持可选 `category`、`style`、`format`（`json_each` 参数化匹配）、`license` 组合过滤；非法或重复参数返回 `400 INVALID_CATALOG_FILTER`。

### 3.3 求购广场（Asset Requests）API 与隐私隔离

| 端点 | 权限与幂等 | 行为与安全边界 |
| --- | --- | --- |
| `GET /v1/asset-requests` / `GET /v1/asset-requests/:id` | 匿名公开（仅 `state='open'`） | 支持 `category`、`style`、`format`、`license`、`space`、`q`、`after`、`limit` 过滤；**公开响应不暴露发起人原始 `PrincipalRef`（`requester`）或内部 `revision`** |
| `GET /v1/me/asset-requests` | 已认证用户 | 分页读取本人发布的全部求购（含 `open` 与 `closed`） |
| `POST /v1/asset-requests` | 已认证用户 + `Idempotency-Key` | 在单一 D1 `batch()` 内原子写入 `mutation_requests`、`asset_requests` 与 `asset_request_events(action='created')`；`budgetNote` 仅为最多 80 字的协作意向说明，无金额撮合或计费 |
| `POST /v1/asset-requests/:id/responses` | 已认证非发起人 + `Idempotency-Key` | 对 `open` 求购提交方案说明（1–1000 字）并可选绑定本人名下 `published` 状态的 `publicationId`；原子拦截自响应（`409 SELF_RESPONSE_FORBIDDEN`）、重复提交（`409 RESPONSE_ALREADY_SUBMITTED`）、冒用他人作品（`409 INVALID_RESPONSE_PUBLICATION`）与已关闭求购（`409 REQUEST_CLOSED`） |
| `GET /v1/asset-requests/:id/responses` | 已认证用户 | 严格权限隔离：发起人（`viewerRole='requester'`）可分页读取全部方案响应；非发起人（`viewerRole='responder'`）仅能读取本人已提交的方案，不泄露其他响应者内容 |
| `POST /v1/asset-requests/:id/close` | 发起人 + `revision` CAS + `Idempotency-Key` | 原子置为 `closed` 并递增 `revision`，立即从公开求购列表移除并拒绝后续新方案 |

### 3.4 商店 `#assets` 与工作台接线

- 新增 `src/web/asset-market.css` 与 `src/web/asset-market.client.js`（Web 静态 Text 模块增至 20 个）：在 `#assets` 内提供“素材市场 / 求购广场”双模式切换、七类细分按钮、可折叠组合筛选面板、可一键移除的筛选标签及发布求购／查看需求／提交方案／关闭求购原生模态框；`/workspace` 新增 `#resource-attributes-form`。
- **浏览器实测问题与修复**：
  1. 求购卡片按钮最初复用了 `.asset-open`，其全卡 `::after` 伪元素在无定位祖先时向上覆盖了顶部 `#store-request-open` 按钮；已改用独立 `.am-request-open` 并为 `.am-request-card` 补齐 `position: relative`，复验零遮挡。
  2. Chromium 在页面已滚动状态下对 `<dialog>::backdrop` 滚轮仍会触发根视口滚动链；已同步配置 `dialog { overflow: auto; overscroll-behavior: contain; }`、`html:has(dialog[open]) { overflow: clip; overscroll-behavior: none; }` 与 `bindModalScrollLock` 遮罩区滚轮拦截，复验双向滚轮 `deltaDown = 0`、`deltaUp = 0`。

## 4. 工具链 `undici` 安全修复与本地验证

- **活动依赖修复**：在 `pnpm-workspace.yaml` 新增 `"miniflare>undici": 7.30.2` override 并刷新 `pnpm-lock.yaml`，`pnpm audit --audit-level=low` 返回 `No known vulnerabilities found`，独占 `linshi` 目录 `pnpm install --frozen-lockfile` 验证通过。
- **静态、合同与浏览器验证**：270 个活动文件的 `pnpm check`、`pnpm typecheck`、`pnpm sizecheck`（全部 `<= 500` 有效行）、三组 SBA Python 合同检查（`sba_contract_checks.py`、`sba_native_client_checks.py`、`sba_scanner_release_checks.py`）、`git diff --check` 与 `1440 / 960 / 760 / 390 / 320px` 双模式响应式浏览器核验均通过；全量 `pnpm test` 共 **433 项测试：432 通过、0 失败、1 项大包专用联合场景默认跳过**。
