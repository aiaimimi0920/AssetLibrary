# Web 手动续传：请求层前置切片

2026-10-06：本切片仅完成受限 Range 请求入口，尚未实现页面续传，不能作为 `.27` 功能发布或完整 P5 验收。

## 已实现

`withResponse` 只在私有 publication content GET、存在合法票据且无请求 body 时接受 `range`。每段最多 256 KiB，结束位置小于现有 8 MiB 包体预算；仅接受有起止位置的单段，不接受多段、开放区间、负数或不安全整数。

`ifRange` 必须配合合法 Range，接受有界的强 ETag；弱 ETag、换行注入和空 ETag 均在 fetch 前拒绝。不开放任意 header 注入，原认证、同源、redirect:error、omit Cookie、no-store 和请求取消生命周期保持。

## 本地证据

- `node --test tests/web-download-range.test.mjs tests/web-download.test.mjs tests/web-client.test.mjs`：13 pass，0 fail。
- 新增 3 项聚焦测试：受限请求 header；非法输入零 fetch；身份切换和停止取消迟到响应且不调用 consumer。
- `pnpm check`、`pnpm typecheck`、`pnpm sizecheck` 与 `git diff --check` 通过。首轮 sizecheck 报测试文件 UTF8_BOM，修正为 UTF-8 无 BOM 后通过。
- `pnpm build` 成功，独占候选：`../../linshi/assetlibrary-p3-jjGFKO`。这是请求层前置候选，不替代已有手测入口，也不是续传功能交付。

## 下一切片与退出条件

实现单页面、单 transfer、至多 32 个完整分段的内存状态；中断只保留已完整分段，不自动重试、不持久化票据或包体。用户继续时申请新票据，逐段核对 206、Content-Range、长度和 strong ETag，最终 SHA-256 通过才保存。停止、切换身份、放弃、授权失效或对象变更必须清空状态并拒绝迟到写回。

页面接线、分段状态机、真实浏览器中断/继续验收、新版本交付均未完成。正式账号、原生安全、网络边界及生产准入继续延期；没有云部署或云配置变化。