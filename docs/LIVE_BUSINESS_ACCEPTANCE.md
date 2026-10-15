# 2026-10-15 真实账号线上业务验收

## 范围与结论

实际 Edge 浏览器、真实 NAccount 登录、正式 `https://assetlibrary.aiaimimi.com`，运行版本
`0.4.4` / `acd3943e3a9e0f8fc29ecd9188bcc0387992d7ed`。不使用 trial、合成身份、模拟扫描或绕过门禁。
资源创建、改名、读取、刷新持久化、798 字节 Art ZIP 私有上传及检查申请通过；退出后的页面身份清除通过。
完整审核/发布/下载正向闭环未通过：当前审核者未配置、scanner 未绑定，生产准入仍拒绝。

## 实际证据

- 资源：`b0912fbb-48a2-43d4-bbf6-950effba3c0f`。
- 初始标题：`线上验收 Art 20261015-1720`；创建时间 `2026-10-15T17:19:08.198Z`，revision 1。
- 经确认弹窗改为 `线上验收 Art 20261015-1720 已改名`；revision 2，更新时间 `2026-10-15T17:19:41.564Z`。
- 刷新与重新登录后，仍读取同一资源 ID、改名及 revision 2。
- 上传：`8d3f92f0-9ba0-4b5b-97a0-2f40862dd7d3`；798 bytes，状态 quarantined。
- ZIP 含 manifest 和两张 68 字节 PNG；本地 SHA-256 与页面返回一致：
  `24771e8768f8eca739db42de9bd44d096e5613093238cc02be05b44378653345`。
- 检查：`5080fb3a-bda8-4816-8406-85aefbb2ddec`，策略 `art-zip-clamav-v1`。
  首次 queued / attempts 0；随后 queued / revision 3 / attempts 1，
  error 为 `INSPECTION_TEMPORARILY_UNAVAILABLE`，bindingCurrent true、publicationEligible false。
  这是实际观察到的快照，不是最终重试耗尽或 AV 通过。
- 刷新后上传 ID、隔离状态、大小、摘要保持；未通过检查时创建版本实际返回 `409 VERSION_BINDING_NOT_READY`，无版本创建成功。
- 公开目录实际返回 `503 SCANNER_CLOUD_NOT_VALIDATED`。
- 新会话读取审核待办实际返回 `503 REVIEWERS_NOT_CONFIGURED`；不能将其算作 reviewer 权限隔离验证。
- 点击退出登录后回到首页，身份为未连接、资源/上传视图清空、私有操作禁用；重新打开首页仍未登录。

## 未覆盖与保留项

- 首次读取审核待办曾得到 `401 UNAUTHENTICATED`；刷新后未登录，点击 NAccount 登录通过既有 SSO 自动回到同一账号。
  与短会话期限一致，但未抓取服务端过期原因，不将原因判定为已证实；401 后旧页面仍显示已登录，存在状态提示可改进项。
- 退出后直接在地址栏访问已知私有资源 URL，被 Edge 以 `ERR_BLOCKED_BY_CLIENT` 阻止。
  未取得该请求的服务器响应，不冒称旧 Cookie 重放拒绝或服务端撤销完整通过；没有提取 Cookie 来绕过浏览器。
- 未测试第二真实账号、目录成员隔离、账号级撤销、完整 Capability/应用包上传、取消/中断/续传和生产下载。
- 首次自动选文件因扩展未允许 file URL 失败，尚未上传；用户开启权限后完成正常选文件和上传。
- 测试资源、上传及检查事实保留，不关闭资源、不取消或删除上传，不修改任何旧资源、审核者名单或 scanner 配置。
- 截图：`linshi/assetlibrary-live-acceptance-20261015.png`、`linshi/assetlibrary-live-logout-20261015.png`。
  本轮只新增验收记录，不修改业务源码、不重新部署；平台独立 verify 仍另行记录。
