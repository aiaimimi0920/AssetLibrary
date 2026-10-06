# P5：分发 Web 本地切片与验证

2026-10-05 UTC，版本 `0.3.0-dev.18`。本轮遵守用户指定顺序：不重新开展延期的原生组件安全风险或网络边界验收，不构建 Docker 镜像，不改云环境和生产准入。

## 1. 已实现的用户操作

- 无身份读取公开目录及公开详情；请求不发送 Bearer。生产未准入时明确显示 `SCANNER_CLOUD_NOT_VALIDATED`，不是空目录成功。
- 连接外部身份后读取独立下载授权资源库；目录读成员与下载授权不互相提升。
- owner 输入发布 ID，或从版本中的 publication 摘要进入管理；读取当前发布事实后下架或管理下载授权。
- 查询主体的当前授权状态/revision，首次不存在使用 0；授予、撤销和恢复均使用读取所得事实。编辑主体或发布 ID 会清空旧状态并禁用变更，须重新查询；未知提交不猜 revision，也不自动重放。
- 下载先申请短期票据，再以同源 header 取得包体；本页只接收最多 8 MiB Art ZIP。实际响应类型、长度和 SHA-256 全部核对后才创建 Blob 并交给浏览器保存。
- 撤销和下架使用应用内确认框；Escape 不提交，关闭后恢复触发控件焦点，宽窄屏背景滚动均锁定。

Web 不新增登录/注册服务、第三方 SDK、框架或浏览器测试依赖。凭据仅在当前页面内存中，连接后清空输入，刷新/清除身份后失效。上传和原有版本/审核入口继续保留。

## 2. 生命周期与运行边界

`api.client.js` 的 `withResponse` 在控制器生命周期内消费响应：身份切换、停止和超时保护覆盖字节读取及摘要完成，旧响应不得污染新会话。下载期限 120 秒，普通 JSON 请求仍为 30 秒。没有隐藏自动重试或跨页面票据缓存。

浏览器在合同上限内汇集字节以调用 WebCrypto；这是客户端的有界校验，不改变 [P4 合同](P4_DISTRIBUTION_API.md) 中 Worker/R2 的流式交付。页面不执行 ZIP 内容、不安装资源，也不承诺撤销能收回已传字节。

只有校验通过后才调用 `URL.createObjectURL`，临时下载链接随即移除，Object URL 一秒后释放。成功文案为“已交给浏览器保存”，不将浏览器接受下载等同于用户磁盘最终保存成功。

`distribution.client.js` 负责分发状态和操作，`distribution-render.client.js` 负责安全 DOM 展示，`download.client.js` 负责有界字节/摘要及浏览器保存。静态路由、构建和夹具统一核对 **九个 Text 模块**：HTML、CSS 和七个客户端 JS。单独复制 `index.js` 会漏掉必需模块。

## 3. 实际验证结果

- Biome `check`、TypeScript `typecheck`、有效行数 `sizecheck` 均通过。
- 修改后聚焦验证 21 项通过；最终滚动锁修改后另跑 12 项聚焦通过，均 0 fail/skip。
- 完整 `rtk proxy pnpm test`：**202 pass / 0 fail / 0 skip**，约 85.1 秒；受测候选 `assetlibrary-p3-Etnywo`，原始 `tests.log` 保留。
- `pnpm audit --audit-level=low` 实际联网查询：`No known vulnerabilities found`。仅针对 pnpm 依赖，不代表延期原生风险通过。
- 普通构建使用不存在的 `WRANGLER_DOCKER_BIN` 哨兵，同时显式 `--containers-rollout none`；构建成功，没有隐式 Container 构建。

浏览器受测候选 `assetlibrary-p3-ZYnTAw`，使用隔离 session `assetlibrary-dist18`：

1. 实际生产 Worker 的无身份目录显示 503 门禁错误；owner 申请票据显示 409 门禁错误，无下载事件。
2. 合成 owner 从发布 ID/版本入口管理，授权 `user:bob` 为 active revision 1；主体/发布 ID 编辑立即使旧操作失效。
3. 明确假设准入后，合成 member 的下载资源库包含一项，但没有目录读成员身份；浏览器实际保存 798 字节双 PNG ZIP。
4. 落盘 SHA-256 为 `24771e8768f8eca739db42de9bd44d096e5613093238cc02be05b44378653345`，与 publication 一致。Object URL 创建/释放各一次，活动数量归零。
5. 临时运输层先传 16 字节再暂停：停止和清除身份都不保存部分包体；迟到结果不污染已清除视图。运输层改首字节导致 `DOWNLOAD_DIGEST_MISMATCH`，不创建额外 Blob URL 或下载。
6. 撤销确认后 revision 2，member 新下载返回 `404 NOT_FOUND` 且不保存；恢复授权 revision 3，资源库重新出现。旧票据不复活及 Range/HEAD 撤销语义由同次完整核心测试覆盖。
7. 下架确认后 publication 为 unlisted revision 2，owner 下载按钮禁用，后续公开目录/资源库为空、公开详情 404；最后返回生产模式仍拒绝准入。
8. 1280×900 和 390×844 的页面宽度等于 viewport，无横向溢出；200 字符主体/UUID/摘要可读。Escape 不改变授权或发布事实，焦点回到触发控件；窄屏确认框打开前后滚动位置均为 2243，背景滚动锁有效。

这轮浏览器发现并修复了两个实际缺陷：请求期间禁用触发按钮导致关闭对话框后焦点落到 BODY；窄屏只锁 main/aside 未锁文档滚动。焦点恢复不抢用户已移到其他控件的焦点，不聚焦已移除/仍禁用的节点；闭合对话框内的滞留焦点也可恢复。对应聚焦测试及浏览器复测通过。

## 4. 证据和候选交付

证据目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-distribution-web-20261005`。

- `browser-owner.json`、`browser-dialogs.json`、`browser-download.json`、`browser-layout.json`、`browser-revocation.json`：分阶段事实与明确的合成/假设准入范围。
- `member-art.zip` 与最终回执：实际保存字节的 size/SHA-256。
- `desktop-management.png`、`mobile-management.png`、`mobile-dialog.png`、`member-download-desktop.png`：真实宽窄布局和状态。
- `browser-server-report.json`、`browser-close.log`、`browser-closure.json`：仅关闭所属 browser/preview，释放 fixture，移除合成身份和含凭据的临时代码。
- `check.log`、`typecheck.log`、`sizecheck.log`、`audit.log` 和 `final-delivery.json`：最终检查、候选源码/产物身份与同字节证明。

最终 fresh 候选位置以 `final-delivery.json` 为准。交付前逐项核对其源码 SHA-256、全部受测运行产物和九个 Text 模块；浏览器临时代理、合成身份、测试库和密钥不进入候选。

有效行数：app 313、distribution 199、download 92、distribution-render 20、api 96、render 139、style 279，均小于 500；测试和构建脚本也通过 checker，无软上限例外。

## 5. 不能外推的结论与下一边界

正向浏览器分发由 **linshi-only loopback 测试代理**调用同一业务核心，明确假设部署准入；私有请求仍先验证实际 Worker 的外部签名身份。扫描事实与账号均为合成夹具，底层为真实本地 D1/R2。授权/撤销/下架走实际生产 Worker 路由，生产发布/目录/票据/下载门禁没有修改。代理最初把 Node Request 传给 Miniflare 导致 500，修正为 URL 和显式请求参数；这是测试工具修复，不是产品认证或门禁旁路。

本轮没有真实外部账号接入、生产成功发布/下载、云部署、提交或推送。P5 本地交互已实现验证，但其“用户真实闭环”生产退出条件、P6 及用户指定延期的安全/网络项仍开放。全计划目标保持 active；后续继续真实身份接入和获准的隔离云验收，不重做已闭合本地样本，不将本地证据当成云或安全准入。
