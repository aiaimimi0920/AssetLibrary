# Trove 界面参考快照

保存日期：2026-10-26。用途：保存用户已认可的测试 HTML，供后续讨论、设计和正式开发对照。
**这是独立静态原型，不是正式业务实现，也不是部署入口。**

本快照来自 `assetlibrary-ui-preview-20261025-122720` 的最终可运行文件，保留原字节。
此前的 [Market V2 参考](../market-v2/README.md) 完整保留；本目录是品牌、游戏、素材与社区迭代后的较新参考。

## 打开原型

无需安装依赖，使用项目所需的 Node.js 22 或更新版本。在仓库根目录运行：

```powershell
rtk proxy node design/trove-preview/prototype/server.cjs 0
```

打开输出的 `PROTOTYPE_URL`；端口随机分配，不依赖临时预览的旧端口。按 `Ctrl+C` 停止。
服务器仅监听 `127.0.0.1`，只读指定静态资源。不应部署到正式环境；不要直接用 `file://` 打开，跨文件 SVG 可能受限。

| 页面 | 在输出地址后添加 |
| --- | --- |
| 首页 | `#home` |
| 游戏发现 | `#browse/game` |
| 游戏详情 | `#app/starfield`、`#game/mist-game` |
| 应用、Loom 扩展 | `#browse/application`、`#browse/loom` |
| Loom 内容空间 | `#app/loom` |
| 素材市场／求购广场 | `#browse/asset`，在页面内切换 |
| 社区广场 | `#community` |
| 频道发现 | `#community/channels` |
| 游戏／兴趣频道 | `#community/channel/star-game`、`#community/channel/pixel-art` |
| 我的资源库 | `#library` |

## 已确认的设计

- 品牌为 **Trove**，采用 Beaver 图标；短宣传语为“好东西，都在这！”，长文案为“好玩的，好用的，都在这！”。英文短句为 `All the good stuff. Right here!`。
- 一级导航固定为 **游戏、应用、loom、素材、社区**；保持封面优先、短文案和 Neuro 深色／信号色语义。
- 游戏发现采用上方编辑推荐与 AI 匹配入口、下方单一游戏片段位。手机上下换游戏、左右换同款片段；画面短按进入游戏，爱心表达游戏级偏好。保留已精简的画面，不恢复被移除的标题、玩家、商品栏或查看按钮。
- 素材提供市场与求购两个方向：七类目录、关键词与组合筛选、排序、分页和空态；素材详情展示许可、格式与适配，求购展示预算、周期、交付与授权要求。支持查看发布素材、发布求购和提交方案的登录提示。
- 社区以广场与频道组织内容。广场聚合跨频道帖子；频道可围绕游戏或兴趣建立，拥有独立帖子流、类型筛选和发帖入口。示例包括六个游戏频道与四个兴趣频道。
- 帖子可阅读、查看示例回复及关联作品；发帖可选择频道、预览草稿并选择是否同时分享到广场。未分享到广场不代表私密或权限隔离。
- 发布作品、发帖、回复、发布素材、求购及提交方案都停在登录提示，不能把访客当成已登录用户。

## 原型边界

作品、作者、帖子、价格、需求与配图均为虚构布局夹具；游戏画面明确是概念示意，不是真实游玩视频。
没有真实 AI 推荐、账号连接、行为采集、付款、发布、上传、下载或安装。
爱心、帖子收藏和草稿只在当前页面内存中，不持久化；刷新会清除。
静态服务器使用精确资源白名单与 `connect-src 'none'`，不开放检查脚本、截图、证据和其他本地文件。

`design/` 不在活动 Worker、TypeScript、Biome、运行测试和打包的源码白名单中。
本次不增加业务依赖、API、Schema、版本或部署配置；不要把演示数据直接接入正式业务。

## 文件与截图

- `prototype/index.html`：HTML 入口；同目录保存全部样式、脚本、SVG、回环服务器和四个现有检查脚本。
- `screenshots/`：七张此前实际浏览器截图，包括素材市场／求购桌面、素材手机、社区广场／目录／频道桌面和频道手机。它们是迭代时的截图，不是本次重新拍摄，也不表示全站所有断点都已覆盖。
- `evidence/`：保留此前素材与社区的响应式原始读数。素材覆盖 320／390／768／1024／1440 CSS px；社区在 320／390 px 覆盖三种视图，768 px 只验证广场，目录与频道该宽度仍未验证。
- `snapshot.json`：39 个复制文件的字节数与 SHA-256，归档时逐项和临时原型核对。

未归档临时日志、会话信息、旧 JS 备份、已过时的游戏截图或缩放异常的社区广场手机截图。

| 页面 | 桌面 | 手机 |
| --- | --- | --- |
| 素材市场 | [查看](screenshots/assets-market-desktop.jpg) | [查看](screenshots/assets-market-mobile.jpg) |
| 求购广场 | [查看](screenshots/assets-requests-desktop.jpg) | — |
| 社区广场 | [查看](screenshots/community-plaza-desktop.jpg) | — |
| 频道发现 | [查看](screenshots/community-directory-desktop.jpg) | — |
| 游戏频道 | [查看](screenshots/community-channel-desktop.jpg) | [查看](screenshots/community-channel-mobile.jpg) |

## 可重复检查

在仓库根目录执行三个不依赖浏览器的现有合同检查：

```powershell
rtk proxy node design/trove-preview/prototype/verify-community.cjs
rtk proxy node design/trove-preview/prototype/verify-asset-market.cjs
rtk proxy node design/trove-preview/prototype/verify-game-feed.cjs
```

启动本目录服务器后，将实际输出地址作为最后一个参数传给静态文件检查，不要省略该参数：

```powershell
rtk proxy node design/trove-preview/prototype/verify-asset-files.cjs http://127.0.0.1:<实际端口>/
```

该检查比对 25 个 HTTP 静态资源的实际字节、UTF-8 无 BOM、脚本语法、CSP 与写请求拒绝。
合同检查使用受控 DOM 替身，不等于本次重新进行完整浏览器或真实手机验收。

本次从仓库归档目录实际重跑：社区 39 项、素材 41 项、游戏片段 42 项均通过；25 个静态资源 HTTP 字节检查通过。
另核对 39 个复制文件与临时原型的 SHA-256、41 个归档文件的精确集合、17 个脚本语法、8 个说明链接，以及 25 个 HEAD 响应和 11 个拒绝请求；均通过。
这些结果只证明参考快照完整可运行，不表示正式业务、云验收或部署完成。

`market.css` 603 行、`responsive.css` 644 行、`asset-market.css` 624 行、`community-channels.css` 550 行。
它们分别聚焦基础市场、全站断点、素材页与社区频道样式，作为已认可快照保留，不为归档改变布局。
保护证据为现有聚焦检查、此前响应式记录和截图；正式实现时重新按组件职责组织，不直接继承这些文件为生产结构。

## 最近评审建议：尚未实施

用户要求先保存当前版本，因此下列建议只作后续讨论，不属于本快照已完成内容：

1. 游戏详情直接进入该游戏频道，而不是总广场；保持作品与讨论双向衔接。
2. 在广场和频道内部提供范围明确的帖子搜索，区别于全局作品搜索。
3. 收紧社区页头与重复说明，让帖子更早进入首屏。
4. 跨页返回时保留筛选、页码和浏览位置。
5. 频道发现更早并列呈现游戏与兴趣；关注频道与“我的频道”可后置。
