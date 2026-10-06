# P5：最小私有 Web 工作区

## 当前工作顺序与范围

根据用户最新要求，先延后原生组件安全风险复核和网络边界验收，推进其余业务开发。延期不是通过、风险豁免或生产发布授权；现有 `versionSafety` 与发布拒绝保持不变。本轮未执行实际原生风险扫描或网络边界验收，不切换云资源。旧构建工具的 Wrangler dry-run 曾自动执行缓存镜像构建，已修正为明确 `--containers-rollout none`，后续只打包 Worker，不隐式构建/更新 Container。

`.16` 提供实际私有资源入口；后续 `.17` 已实现 P3/P4 业务核心，`.18` 又增加公开目录、下载资源库、owner 下载授权/下架和校验后保存交互，详见 [P5 分发 Web](P5_DISTRIBUTION_WEB.md)。完整 P5 退出条件仍未达成：真实账号登录接入、生产成功发布/分发与 P6 云验收仍待完成，延期安全项不标为通过。

## 已实现的操作

- 连接外部签发的 Bearer JWT，读取服务验证后的 PrincipalRef；清除身份或刷新页面后不保留凭据。
- 分页读取 owner/目录读成员的真实资源列表，创建 Art 资源并选择工作区。上传及版本管理只对 owner 开放。
- 上传 1–32 张静态 PNG 的 Art ZIP，最多 8 MiB；浏览器计算 SHA-256，包体以 File 上传，不进入 JSON/base64。
- 显式选择 `art-zip-clamav-v1`（默认）或只做格式的 `art-zip-manifest-v1`。检查失败不自动降级，格式 passed 不取得发布资格。
- 查询后台检查事实；创建不可变待审版本，显示版本 ID、当前绑定与发布阻断原因。
- 配置名单中的独立 reviewer 根据已知 ID 批准/拒绝；owner 自审继续由 API 拒绝。没有伪造 reviewer 权限，也未提供内容预览。
- 请求发布时显示实际拒绝；撤回采用应用内确认对话框，Escape 不提交。上传可显式取消。

采用规范 Neuro 深色壳层、信号黄/绿、键盘焦点和窄屏布局。所有用户字段通过 `textContent` 展示，不作为 HTML 执行。

## 新增读取 API

| 路径 | 授权与响应 |
| --- | --- |
| `GET /v1/me` | 外部身份验证后返回 `{ principal }`，不返回 JWT 或账号资料 |
| `GET /v1/resources/{id}/uploads` | 活动资源 owner；返回 P2 上传视图的 `items` 和 `nextCursor` |
| `GET /v1/resources/{id}/versions` | 活动资源 owner；返回 P3 版本视图的 `items` 和 `nextCursor`，不是公开目录 |

两个工作列表支持 `limit=1..50`（默认 20）和 UUID `after`，拒绝未知、重复和非法查询参数。每次读取 D1 primary，查询本身重新过滤 owner/活动资源；预检不代替最终授权。使用资源前缀 UUID 索引，不扫 R2 或读取整包回答列表。`0005_workspace_indexes.sql` 只增加索引，不删除数据。

## 生命周期与失败行为

页面只访问同源 `/v1/`，拒绝重定向，不用 cookie、localStorage 或 sessionStorage。凭据输入在连接后立即清空，身份失败后清空内存凭据与视图。旧身份 generation 的响应不能进入新主体的视图。

请求期限为 30 秒，File 写入为 120 秒。停止或超时不意味着数据库回滚，也不等于服务器取消；显示未知写入提示，已保留的上传 ID 可查询/取消。没有隐藏自动重试。

创建/上传预留失败时，相同逻辑输入保留同一幂等键，完整成功才释放。最多 32 个未决键，满时拒绝新操作而不淘汰未知写入。`.21` 在预约响应成功后绑定服务器上传 ID：刷新上传列表（含下一页）或显式取消响应确认该 ID 为 cancelled/expired/rejected/missing，才释放该意图，使同一文件可开始新上传。历史同摘要但不同 ID、pending/quarantined/未知状态或预约响应丢失时均不猜测释放；旧身份/旧 operation 不能影响新键。未知预约可由用户显式重试取得 ID，再刷新真实终态；没有自动重试。刷新整页后先查询服务器状态，不宣称跨页面保存请求身份。详见 [P5 上传终态恢复](P5_UPLOAD_RECOVERY.md)。

公开的静态路径仅 `/`、`/style.css` 和七个 `*.client.js`（app、api、render、upload、distribution、distribution-render、download），支持 GET/HEAD；提供 no-store、nosniff、同源 CSP、禁止嵌入和 referrer。静态页面公开不取消业务身份验证。公开目录 GET 不携带 Bearer；个人下载资源库和下载仍使用可信外部身份及独立授权。

## 构建与本地运行

没有新增 Web 框架、浏览器测试依赖或第三方服务。`.18` 的 Wrangler 将九个 Web 文件作为 Text 模块放进主 Worker 运行图；构建核对九项并将全部 SHA-256 加入清单，不能只复制 `index.js`。Miniflare 加载同一组模块；Node 故障夹具只展开已核验静态文本导入，不改业务语句或增加生产测试入口。

```powershell
rtk proxy pnpm db:local
rtk proxy pnpm dev
```

访问 Wrangler 输出的地址。按 P1 身份合同配置外部 `AUTH_PUBLIC_JWK`、`AUTH_ISSUER`、`AUTH_AUDIENCE`；审核需要合法的 `REVIEWER_PRINCIPALS`。缺少配置时页面仍可打开，但 API 返回 503，不提供模拟登录或开发身份旁路。

本地后台任务使用 Wrangler 自己的本地定时测试入口，端口以实际输出为准：

```powershell
Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8787/cdn-cgi/local/scheduled -TimeoutSec 30
```

复合 ClamAV 策略仍需实际 scanner binding。缺失时按原合同重试并失败关闭，不为截图伪造 clean。未做真实账号集成、云部署、生产发布或下载验收。

## 验证

```powershell
rtk proxy pnpm check
rtk proxy pnpm typecheck
rtk proxy pnpm sizecheck
rtk proxy pnpm test web.test.mjs web-client.test.mjs version-consistency.test.mjs version-reviews.test.mjs upload-recovery.test.mjs
```

`.16` 的 23 项聚焦及完整 172 项本地测试通过（0 fail/skip）。当时浏览器完成 798 字节双 PNG ZIP 上传/摘要、真实后台格式检查、版本创建、owner 自审拒绝、独立批准、发布拒绝、Escape/确认撤回、身份切换/刷新清除、非法身份禁用，以及注入 PUT 失败→查询 pending→显式取消→同文件新上传恢复。1280×900 和 390×844 均无页面横向溢出。该历史回执、截图和清理记录保存在 `linshi/assetlibrary-web-20261005`；格式检查不冒充 ClamAV/云验收。

`.18` 的完整本地测试为 202 项通过，当前分发交互、焦点/滚动缺陷修复与新候选身份见 [P5 分发 Web 验证](P5_DISTRIBUTION_WEB.md)。临时身份文件与预览代理不加入仓库或候选，也不提供部署旁路。
