# P5 Web 手动分段续传

更新日期：2026-10-06。版本：0.3.0-dev.27。仅本地业务验收，生产准入没有改变。

## 行为与生命周期

网页下载改为单页面、单包体的有界分段传输。每段最多 256 KiB，包体保持既有 8 MiB 上限，最多 32 段；不新增服务、Schema 或依赖。只有完整读完并核对过的段才提交到页面内存，部分收到的当前段直接丢弃。

网络失败、截断或服务器 5xx 时，只在已有完整段且次数未耗尽的条件下保留进度。页面显示真实 offset，并提供“继续下载”和“放弃未完成下载”。继续是显式用户操作，不自动重试；每次重新申请票据，每个 Range 请求仍经过服务器当前授权。最多三次手动尝试，每次整体最多 120 秒，超时即丢弃状态。

首段必须是 206 ZIP，Content-Range 与请求起止及总大小完全匹配，ETag 为有界强标识。有 Content-Length 时严格校验，没有声明时仍有界读取并核对段长度。后续段发送 If-Range 并核对原 ETag；200 回退、对象标识或协议变化、最终摘要失败均拒绝，不拼接不同对象。完整包体 SHA-256 匹配后才创建 Blob 并交浏览器保存，中性命名仍为 package-<versionId>.zip。

停止（包括没有活动请求时的待续传）、切换身份、放弃、授权失效、开始另一个下载都会清空未完成状态。epoch 与受控 AbortSignal 防止清除后的迟到响应写回。reader、timer、abort listener 在 finally 清理；票据不进入 URL、存储或回执。包体不写 LocalStorage、IndexedDB 或磁盘缓存，已完成的浏览器保存不等于安装或执行。

## 请求、页面与候选接线

前置切片 4452b12 为 withResponse 增加仅私有包体 GET 可用的受限 Range / If-Range，禁止任意 header 注入。原认证、同源、no-store、无 Cookie、redirect:error 和身份隔离保持。本轮增加 resume-download.client.js，复用票据申请和元数据校验，接入目录与 owner 下载操作。

固定静态模块由 10 个增至 11 个，Worker、构建白名单、test fixture 和 trial HTTP 白名单同步接线。新增控件复用已有 toolbar、button、状态与键盘行为，不引入另一套主题。

实际浏览器发现 trialPage 对 LF 字面量的严格匹配遇到 CRLF 格式化后拒绝。本轮在本地体验模板边界规范化 CRLF 为 LF，保留 replaceOnce 的精确一次匹配，不降低错误关闭要求；新增独立回归证明两种换行结果相同。首次工具写入的新文案编码异常已以直接 UTF-8 文件写入修复，不保留问号或 Unicode 转义。原有手测入口与数据保留。

## 本地验证证据

- 聚焦及直接邻近的 15 个测试文件：61 pass / 0 fail，原始日志在 ../../linshi/assetlibrary-download-resume-20261006/focused.log。
- 续传及模板聚焦 5 项另行通过，覆盖新票据与 Range/If-Range、截断不提交、授权/对象/协议/摘要拒绝、取消/身份/放弃、三次耗尽、并发、迟到响应、整轮超时与流/计时器清理、LF/CRLF 模板合同。
- 真实浏览器对实际本地 D1/R2 发布的 600419 字节应用包，仅在浏览器运输层注入第二段故障。页面保留 262144 字节；点击继续从 bytes=262144-524287 请求，携带 If-Range。保存 ZIP 的实际字节数和 SHA-256 与 publication 一致。
- 浏览器还验证放弃、停止和清除身份均使状态回到“没有未完成下载”，继续/放弃按钮禁用。四条 ERR_FAILED 为四次明确的运输故障注入，不是未解释的业务成功。
- 下载摘要：9dc7948f60f33a6ec8e0df1e3ddcd9fb0c9b82e5ec1fee5f828476bafddbe337。浏览器证据目录包含 browser-acceptance.json、resumed.zip 和 browser-controls.png。

完整测试单进程运行受现有 180 秒上限中断，不能把超时标为单次全套通过。修复后的运行已记录前 208 项通过且没有失败，随后仅补跑剩余 85 项，85 pass / 0 fail / 0 skip；两批合计覆盖当前 293 项。前段原始日志为 ../../linshi/assetlibrary-p3-IrU2Pv/tests.log，尾段原始日志为证据目录 tail.log。首轮 trial 模板失败和两次整体超时均保留，最终汇总与不可变候选见同目录 delivery.json。

## 边界

体验编号、AV 和部署准入仍为明确标识的本地模拟；ZIP/清单/摘要、业务授权、D1/R2 和下载字节真实执行。此切片不是实际账号、云续传、原生安全、网络边界或整套 P0–P6 生产退出证明。SCANNER_CLOUD_NOT_VALIDATED、cloudValidated:false 等生产阻断保持；没有云配置、云数据或兄弟仓库改动。
