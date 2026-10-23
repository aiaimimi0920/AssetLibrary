# 访客商店、统一主题与请求预算

日期：2026-10-23。上一批 0.4.14 已通过 SpringBok 原实例升级及独立平台验证；下述发现布局改版仅在本地实现，未提交或部署。

## 本地商店发现布局改版（未部署）

参考已联网查看的 [Godot Asset Store](https://store.godotengine.org/)、[Fab](https://www.fab.com/) 和
[Unity Asset Store](https://assetstore.unity.com/)。采用 Godot 的资产发现层次及 Fab 的分类／资源库分离，不复制第三方品牌或页面代码。

- 顶部为品牌、名称搜索和账号入口，第二层区分发现资产、我的下载资源库和发布工作台，不再使用后台式筛选侧栏。
- Art、Capability、MCP、应用程序四类直接进入目录；名称与类型组合过滤、全部类型、刷新和下一页均复用原 API。
- 资产卡片提供固定比例类型占位、真实名称、版本、大小、未扫描状态和整卡详情入口；长标题不撑开网格。
  桌面四列、中屏三列／两列、手机单列，不拉取外部字体或图片。
- 原生 `dialog` 展示完整名称、类型、版本、字节数、SHA-256 和发布 ID；支持焦点进入、Escape、焦点恢复、内部滚动与背景锁。
- 下载任务允许在传输时关闭详情并重新打开。保留的任务始终展示原下载资产，不把旧进度混入新资产详情；
  重开使用当前页内存中的任务元数据，不增加目录请求，实际继续仍重新申领票据并检查当前授权。
- 传输错误只保留完整段，停止、身份失效和页面离开仍清空任务。最多三次手动尝试，不自动重试或持久化票据／包体。
- 现有 API 没有公开封面、简介、作者、许可证、评分、销量或发布时间；本轮不伪造这些字段。
  `ORDER BY p.id` 不是按时间排序，因此不标注“最新上架”或“热门”。类型占位明确写明不代表包内预览。

本轮只修改 `store.html`、`store.css`、`store.client.js`、商店生命周期测试及说明文档。
NAccount、SpringBok、Loom、身份／授权合同、Schema、部署模块和扫描策略未改；发布候选版本改为 0.4.15，不表示本地字节已经上线。

### 0.4.15 发布收尾

用户随后授权继续完善并通过 SpringBok 部署。详情内新增同源原生 POST 登录表单，直接返回商店，
不再引导正式用户使用本地体验身份；未配置账号或已登录时隐藏该入口。下载操作采用当前上下文的主操作样式。
关闭进行中下载的详情时，焦点落到可用的下载任务按钮；任务清空后回到搜索框，不尝试聚焦已隐藏或禁用的入口。
新资产详情从顶部展示，避免沿用上一个长详情的滚动位置。保护测试夹具现包含动态卡片按钮，真实模拟请求中的禁用状态。
本轮不修改 NAccount 会话合同，不新建维护授权，不重放任何历史任务。完成本地及 exact-head CI 后发布固定 SHA，
再通过 SpringBok 正常 update，保留原 configuration、D1/R2、Loom binding 和历史回执，最后执行独立平台 verify。

### 发布收尾验证（0.4.15）

- 最终完整回归 404 项：403 通过、0 失败、1 个完整 Loom 包专用测试按原规则跳过；商店生命周期聚焦测试 10 项通过。
  最终构建目录 `linshi/assetlibrary-p3-jKgcCf/`，完整日志 `linshi/store-discovery-release-20261023/final-full-tests.log`。
- 使用上述新构建的实际 Edge + 隔离 Worker/D1/R2，核实详情登录入口为同源原生 POST `/auth/login`，
  合成已登录身份隐藏该入口；进行中关闭详情的焦点落到下载任务，重开绑定原资产，停止后关闭回到搜索框。
  390px CSS 视口实际滚动长详情后切换资产，详情回到顶部且没有横向溢出；临时视口仿真已清除，用户缩放未改。
  未配置账号隐藏入口由聚焦测试覆盖，没有把本地合成身份当作正式 NAccount 登录验收。

### 布局改版初轮本地验证

- 商店生命周期聚焦测试 9 项通过：包含文本注入安全、分类／名称／分页、空候选页、访客禁下、详情焦点、身份失效和任务绑定。
- Biome、TypeScript、源码行数与 Worker dry-run 构建通过；未放宽行数门禁、引入新依赖或运行真实 scanner。
- Edge + 实际隔离 Worker/D1/R2：四类发布包经过真实格式检查和独立审核；只有身份为本地合成，未使用生产账号。
  四类型与组合搜索、空态、503 手动恢复、401 清空、长标题、Escape／焦点恢复、背景锁和详情内部滚动已验证。
- 实际 CSS 视口 1440／960／760／390／320px 均无横向溢出；保留用户原浏览器缩放，只对测试视口进行临时仿真，结束后恢复。
- 600416 字节应用包第一段 262144 字节后注入 503，界面保留完整段；切换到其他详情不显示旧任务，重开回到原资产，
  手动继续后通过长度与 SHA-256 校验并触发浏览器保存。另测运行中关闭／重开／停止，任务和字节清空。
  浏览器工具的下载事件未返回文件路径，本轮没有追加落盘 ZIP 的独立原字节比对，不以页面成功提示代替该项证据。
- 最终完整回归 403 项：402 通过、0 失败、1 个需指定完整 Loom 包的专用测试按原规则跳过；
  构建目录 `linshi/assetlibrary-p3-IA0ojO/`，原日志另存 `linshi/store-discovery-20261023/final-full-tests.log`。
- 65 秒真实空闲窗口中，回环代理请求总数保持 80→80，没有新增目录、session 或其他请求；该窗口不代表整体费用或负载基准。
- 固定 Gitleaks 8.30.1（压缩包摘要与既有校验清单一致）扫描本轮全部七个变更文件，无秘密发现；
  UTF-8 无 BOM 与 `git diff --check` 通过。本地截图及原始证据位于 `linshi/store-discovery-20261023/`，不作为生产升级或真实账号业务验收。

## 页面与权限

- `/` 为公开资产商店，`/workspace` 保留上传、格式检查、独立审核、发布、授权和管理工作台。
- 访客可浏览公开目录和当前详情；我的下载资源库、票据与包体仍要求当前身份及独立下载授权。
- 搜索提交、刷新及下一页均由用户显式触发。目录不自动轮询，不自动扫完空页，不添加静态示例资产。
- 卡片和详情保留真实类型、版本、大小、SHA-256 和 `not_scanned` 提示；不伪造官方认证、缩略图或扫描通过。
- 下载复用原分段、票据、长度/SHA-256 和最多三次手动尝试合同。停止、身份失效和页面离开清理请求与保留字节。
- 原本地 `pnpm trial` 根入口继续是虚构编号工作台，不将合成登录注入正式商店或持久化 Bearer。

## API 增量

`GET /v1/catalog` 与 `GET /v1/me/library` 在既有 `resourceId/after/limit` 之外接受：

| 参数 | 合同 |
| --- | --- |
| `kind` | `art/capability/mcp/application` 之一；可省略，不可重复 |
| `q` | 1–100 字符；trim 后非空，不可重复；名称子串匹配 |

搜索采用参数化 `instr(lower(title), lower(?))`，`%`、`_` 不是通配符，SQL 片段不执行。
SQLite `lower()` 的大小写折叠范围不扩展为 Unicode 搜索引擎。每页最多扫描原预算，当前失效候选仍占预算，
空 `items` 不表示没有下一页；`nextAfter` 仍指向最后扫描项。私库过滤不扩大授权。

## 请求优化及保留边界

- session 与 logout 纳入 AbortController、10 秒超时、响应清理和身份 generation 保护；并发退出共享一次请求，失败后仅手动重试。
- 商店离开/停止会使尚未应用的初始化 session 失效，迟到结果不得恢复身份。
- JWKS 冷启动和强刷并发合并，成功缓存 5 分钟，未知 kid 的刷新间隔至少 30 秒；失败刷新也消耗冷却预算。
- 新 kid 在冷却窗口内可能暂被拒绝，窗口结束后可重新读取。有效旧 key 不等待其他未知 kid 的刷新，缓存过期仍失败关闭。
- 每次私有令牌验证仍在线调用 userinfo，保留停用/securityVersion/即时撤销语义，不增加跨请求身份缓存。
- `/auth/login?returnTo=workspace` 只接受固定标记；其他、重复和未知参数拒绝，不创建事务。旧加密纯 verifier 事务在原五分钟窗口内仍能完成。
- 不删除维护 cron、晚到上传 PUT 补偿或部署锁释放，不恢复扫描器研究。

## SpringBok 打包与主题

Worker Text 模块从 11 个增至 14 个，增加商店 HTML/CSS/JS；构建与 Worker fixture 均强制覆盖。
`.sba/cloudflare.py` 继续从实际 manifest 的 `modules` 发布全部模块，无平行部署器或 Schema 迁移。
原 `.sba/native_client.py`、默认 Loom 客户端 binding、数据保全和部署回执合同未改。
SpringBok 服务页仅周期查询活动实例，完整列表在初始化、用户操作后和恢复可见时读取；终态后停止。
三个独立项目使用同一 Neuro 黄/绿/中性色语义，不引入跨站运行时样式依赖。NAccount 组织显式 branding 仍保留。

## 本地验证

- `pnpm check`、`pnpm typecheck`、`pnpm sizecheck`、`git diff --check`；依赖联网 `pnpm audit --audit-level=low` 无已知漏洞。
- 完整 suite：395 项中 394 通过、0 失败、1 个需指定完整 Loom 包的专用测试跳过。构建证据 `linshi/assetlibrary-p3-OS0BXI/`。
- 此后补充并发冷启动 JWKS 和升级前事务兼容两项，最终相关五个测试文件的 12 项聚焦回归全通过；最终构建 `linshi/assetlibrary-p3-CcSMdw/` 并重跑真实商店浏览器通过，不把分批结果冒称又跑了一次完整 suite。
- 新增真实 Worker/D1 筛选、分页、字面搜索/注入、私库权限；真实 NAccount provider 夹具验证固定回跳、冷却/失败恢复、并发 JWKS 和旧事务兼容。
- 客户端真实模块验证并发退出、取消、身份代际、商店初始化和无隐式私库/轮询。
- Chrome + 实际 Worker/D1/R2：匿名、搜索/类型、空态/503、详情、1440/960/760/390/320 宽度、合成 session 下授权 ZIP 原字节比对、401 清理和停止初始化通过。
- 浏览器脚本与截图在 `linshi/asset-store-ui-20261023/`；使用隔离合成身份，不是生产登录、真实业务或线上费用验收。

用户已明确授权保存三个独立仓库成果、生成 NAccount 定制补丁并通过发布门禁，再通过 SpringBok 原实例保数据升级及独立 verify。
升级前线上基线经只读探针核对为 0.4.13 / `1661458c7ab38304aa2bd203641faff9609292eb`。

## 0.4.14 发布与生产证据

- PR #108 正常合并，main CI `39946693651` 的 verify/secret_scan 成功；正式 `v0.4.14` 固定
  `7803519cb8558687b25db5558f24ac3fe8df9902`。最终完整 suite 为 397 项、396 通过、0 失败、1 跳过，
  formatter、类型、行数和最终 Worker 构建通过，构建目录 `linshi/assetlibrary-p3-USflV8/`。
- 原实例 `dc-b20cc87beb7b44c0aa5c73eec88a7292` 正常 update：任务
  `dc-769a7d5629804578b20d2720abef531d` / [run 39948275033](https://github.com/aiaimimi0920/SpringBok/actions/runs/39948275033)，
  原回执 `deployed-unverified`，七项检查通过，包括备份、逐行数据保全、bindings、发布身份、依赖、账号配置与现行分发策略。
  artifact ZIP SHA-256 为 `d720014b8ae2fce094077757a6bc998fc540450abf6bbca9f86a1111836b8af1`，唯一 artifact 的 digest 与 task/run/source 逐项匹配。
- 独立平台 verify：任务 `dc-0778e0bc04704a16a30f3849a4b870b8` /
  [run 39948761193](https://github.com/aiaimimi0920/SpringBok/actions/runs/39948761193)，`succeeded`、四项检查通过；
  artifact ZIP SHA-256 为 `2d9a09760757671a7722698759e92e65d4839385fdba3ffac24d54653a1e5f82`。
  不将独立验证改写成原 update 回执成功。
- 独立 Cloudflare before/after 读回：仅 `RELEASE_SHA/RELEASE_VERSION` 变更，其余 bindings、runtime settings 和 domains 全部一致；
  原 D1、私有 R2、会话 secret binding 和 Loom native client binding 保留。secret binding 相同不等于读出或比较 secret 明文。
- 正式 `/healthz` 返回固定版本/SHA，`/readyz` 的 identity/database/storage 均 available，分发仍为 `unscanned-packages`，没有新增 scanner 或伪造扫描结果。
- 实际 Edge 正式匿名商店读取 10 条既有发布，搜索“颜色迁移”返回两条真实 Art，详情含当前摘要且访客下载禁用；
  `/workspace` 正常初始化 NAccount 登录入口。空闲观察窗口无目录自动请求；不以此代替总体成本/负载测量。
- 本轮没有重新执行生产上传、审核、授权下载、Loom 安装/运行或账号撤销的全业务验收。临时证据在
  `linshi/asset-store-ui-20261023/`。GitHub 仓库级 Dependabot 告警仍全部位于 `old/**`，未清除或豁免。
