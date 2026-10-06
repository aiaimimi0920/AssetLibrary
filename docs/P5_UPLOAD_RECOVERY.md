# P5：上传终态恢复

## 范围与实际缺陷

2026-10-05 UTC，版本 0.3.0-dev.21。本轮只修复 Web 上传意图的释放条件，不修改 D1/R2 状态机、扫描/发布门禁或身份接入。原生组件安全风险和网络边界验收仍按用户要求延期。

修复前使用真实 .20 Worker、Miniflare/D1/R2 和浏览器复现：预约成功后，临时测试代理让一次 PUT 返回 503；实际后台定时维护将无对象的 pending 置为 expired。刷新列表后再次上传同一个 798 字节 ZIP，预约仍重放旧键和旧 ID，PUT 返回 410。列表有 expired，但客户端只在完整成功或显式取消时释放键。

临时预览服务的一次退出另有 ERR_CONNECTION_REFUSED 记录；确认旧句柄/端口失效后重新运行复现，不把环境退出算作业务缺陷。此前笼统预计的 409 已由实际响应更正为 410。

## 实现合同

- api.client.js 的最多 32 个未决条目保存 key 和可选服务器 subject；对外 operationKey 返回形状保持不变。
- 预约响应成功后绑定 upload.id；fingerprint 与当前 key 必须匹配，已有不同 ID 不重绑定。
- 完整成功仅删除同一个 operation.key，旧完成响应不能删除新意图。
- confirmUploadClosed 只接受 cancelled、expired、rejected、missing；scope、size、sha256 和已绑定 ID 都对应当前条目时才释放。
- 上传列表的首页/下一页和取消响应都使用同一个终态确认函数。没有从浏览器状态假定服务器已回滚。
- pending、quarantined、未知状态、错 ID/摘要/资源或未绑定预约都保留键。列表中历史同文件终态不能清除新 pending 的未知写入身份。
- 预约响应丢失时不猜测对应 ID；用户显式重试取得预约 ID，再刷新其真实终态。没有增加自动重试、存储凭据或跨页持久化。

没有新增依赖、通用重试框架或生产测试路由。测试代理/合成身份/故障控制只在 linshi，不在候选的生产运行图。

## 验证

新增 tests/web-upload-recovery.test.mjs 的 8 项先红后绿：四种终态、非终态/错关联保留、旧终态与新 pending、未知预约响应及旧 operation/身份隔离。既有 API 测试继续覆盖身份 generation、停止请求和最多 32 个未决键。以下 8 文件共 33 pass / 0 fail / 0 skip：

~~~powershell
rtk proxy pnpm test web-upload-recovery.test.mjs web-client.test.mjs web.test.mjs web-focus.test.mjs web-download.test.mjs web-distribution.test.mjs uploads.test.mjs upload-recovery.test.mjs
~~~

Biome、typecheck、有效行数及本次联网 pnpm audit 通过；没有重跑完整 suite、宽窄屏矩阵或延期原生安全审计。

真实浏览器使用同一 .21 受测候选、合成外部身份、798 字节双 PNG ZIP、实际本地 D1/R2，验证：

1. 实际 cron 确认 expired 后，刷新并显式重传取得新键/新 ID。
2. 旧 expired 与新 pending 同页刷新后，显式重试仍使用新 pending 的同键/同 ID。
3. 显式取消后，同文件取得新 ID，PUT/complete/inspection 成功。
4. 注入 21 条同摘要历史终态以强制分页；首页未读到当前 ID 时不猜测释放，重试仍被 410 拒绝。下一页读到匹配终态后再重传，取得新 ID 并完成。
5. 7 次明确预约请求产生 5 个 ID；两次重复均对应用户明确点击，不存在自动重试。两份成功包通过后台 art-zip-manifest-v1 格式检查，不冒充 ClamAV。
6. 凭据输入清空；目录仍 503 SCANNER_CLOUD_NOT_VALIDATED，生产门禁未改变。控制台的四次 503 和一次 410 都与明确注入/未读到终态的测试请求逐项对应。

本轮证据目录：linshi/assetlibrary-web-terminal-recovery-20261005，包含 before-receipt.json、after-receipt.json、快照、截图及 tests-red.log。截图已保存；本轮未做新的视觉布局验收。测试代理的包体有界缓冲仅用于 798 字节样本，不当作生产流式证明。

## 增量行数与审查

| 文件 | 修改前有效行 | 修改后有效行 |
| --- | ---: | ---: |
| src/web/api.client.js | 96 | 108 |
| src/web/upload.client.js | 32 | 48 |
| src/web/app.client.js | 313 | 313 |
| tests/web-client-fixture.mjs | 12 | 19 |
| tests/web-client.test.mjs | 71 | 71 |
| tests/web-upload-recovery.test.mjs | 新增 | 164 |
| scripts/build.mjs | 138 | 138 |

逐文件复核：关联只从经过身份/generation/取消保护的同源 API 响应进入；释放不发请求、取消对象或改变服务端准入。集合仍最多 32，列表仍有界，不增加后台计时器、DOM 注入或凭据存储。File 写入/下载生命周期未改；测试恢复 fetch，全局假接口不进入生产包。构建 stage 更新为 P5-upload-terminal-recovery-candidate，仍显式 --containers-rollout none，不调用 Docker。

## 未完成项与下一停点

本地修复不等于 P5/P6 或整个 P0–P6 完成。下一本地切片：完整 dispose 旧 Miniflare/workerd，再从同一持久目录打开同候选，证明 R2 已写/D1 pending 和过期检查租约的恢复、attempts 不重置、幂等/审计唯一与字节保持。现有 setOptions 或同实例下一次 cron 不作为这项证明。

真实外部身份合同、另行获准的同包 Cloudflare 验收及生产闭环仍待完成。没有提交、推送、云变更、Docker 构建或数据清空；延期安全项不标绿。
