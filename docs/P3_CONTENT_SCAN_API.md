# P3.3b 复合 Art 内容扫描合同

## 范围与准入

新增 `art-zip-clamav-v1`，复用已有 upload → inspection → version → 独立审核流程。先完成 P3.3a 的完整 ZIP、规范 manifest、逐文件摘要和静态 PNG 验证，再对同一份 ZIP 字节调用内部扫描服务。两者成功才保存 `passed`。首期仍支持多文件归档，不退回单 PNG。

这是一份 upload 的单个复合任务，不是可叠加的任务集。旧 `art-zip-manifest-v1` 或 PNG 的通过事实不会升级为扫描通过；已有 upload 不可切换 policy、重置 budget，选择新策略必须使用新 upload 身份。

```http
POST /v1/uploads/{uploadId}/inspection
Content-Type: application/json

{"policy":"art-zip-clamav-v1"}
```

权限、租约、幂等和审计与原检查接口相同。当前没有客户端扫描回调、可配置远端 URL、自报结果或 provider 框架。

## 内部执行边界

主 Worker 通过命名 `SCANNER` service binding 调用独立 scanner Worker 的 `ScannerService`。scanner 默认外部 HTTP 入口始终 404，命名入口只代理固定 singleton Durable Object。原生 `cloudflare:workers` 只进入独立 bundle，主业务 bundle 保持原来的测试与运行边界。

当前本地 Container 候选使用固定 digest 的官方 ClamAV 1.5.4 Alpine 变体和同发行版 Node 24.18.1，固定 libxml2 2.13.9-r2、PCRE2 10.49-r0、nghttp2 1.70.0-r0，保留 APK/TLS 签名校验，不混用 glibc/musl 或伪造 ABI。实际 `clamscan` 仍链接 `libxml2.so.2`，完整 APK 清单与 Trivy 逐项一致，详见 [镜像修复](P3_SCANNER_IMAGE_REMEDIATION.md)。云中保留的是此前已验的 Debian/Node 22 镜像，尚未切换到此候选，旧云验收不自动覆盖新镜像。

构建时 `freshclam` 更新并测试官方签名库；运行时库文件属于 root、全体只读，以 `clamav` 用户扫描，不运行在线更新。Cloudflare 配置只允许一个 `standard-1` 实例，省略 scheduling policy 对应 `default`；此前云 API 确认 0.5 vCPU/4 GiB/8 GB。`enableInternet:false`，闲置 60 秒后停止。没有安装 Containers SDK 或新增 npm 依赖。

固定内部 `POST /scan` 接收 ZIP，不接受调用者文件路径。服务自行计算实际 size/SHA-256，与 expected headers 相同后才继续。固定容器内临时目录包含 `object.zip`，不把归档展开到宿主或执行上传内容。

扫描服务另外检查 ZIP 资源包络：最多 33 个条目、每项至多 1 MiB、总解压声明至多 8 MiB、有界膨胀比、完整无额外记录的 Stored/Deflate 布局。该检查不替代 Worker 的完整 Art 格式策略。实测 ClamAV 可能静默跳过超大 ZIP 条目，因此不能仅靠 `exit 0` 或 `--alert-exceeds-max` 宣称任意归档已完整扫描。

ClamAV 使用固定 archive/image 扫描和 encrypted/exceeds-max/broken-media 告警参数，扫描字节就是已验证的 ZIP。非 0/1 退出、错误/警告、输出越界、超时或取消，不返回 clean。AV 无命中不等于普遍无害：标准 EICAR 放进有效 PNG 像素并未命中，不能把该样本算作 PNG 内部检测证明；独立 ZIP 内 EICAR 命中与 Art 格式拒绝分别记录。

## 事实与时效

`inspection.result.scan` 保存：

```json
{
  "protocol": "neuro-clamav-v1",
  "verdict": "clean",
  "sha256": "<actual whole ZIP SHA-256>",
  "size": 798,
  "engineVersion": "1.5.4",
  "database": {
    "sha256": "<identity of the three actually loaded files>",
    "dailyVersion": 28143,
    "updatedAt": 1791095122000
  },
  "completedAt": 1791136939314,
  "expiresAt": 1791223339314
}
```

数据库摘要由实际 main/daily/bytecode 文件的名称、版本、header 时间及各自内容 SHA-256 构成，不使用固定假摘要。daily 最多 48 小时；扫描最多有效 24 小时，并不得超过签名库时间加 48 小时。客户端严格校验响应形状、UTF-8、4096 字节响应上限、引擎、身份和时间；完成时间必须属于本次调用，不能重放旧 clean。

`infected` 是终态 `rejected / SCANNER_CONTENT_REJECTED`。服务不可用、坏响应、身份不符或不完整扫描走原有有界重试，不保存通过事实。格式/解压预算不合格在调用扫描前终态拒绝。

版本响应增加 `contentSafety.scan`、`scanCurrent`、`cloudValidated:false`。过期不会改写历史 inspection passed 或审核批准；当前准入独立重算。畸形历史扫描事实失败关闭，不造成历史批准查询异常。

## 生命周期与发布硬门禁

两分钟租约、最多三次领取和原子完成审计不变。R2 读取最多 30 秒；内部调用最多 75 秒；DO readiness 共 10 秒且每次探测最多 1 秒；DO 总调用 70 秒；扫描服务输入及执行共 60 秒；ClamAV 子进程最多 45 秒。预算为格式验证和 D1 提交留出余量，不续租或扩大 attempts。

取消会终止并等待自己创建的 ClamAV 进程，删除自己的容器内临时目录后才返回结果。cleanup 失败不发送 clean，并停止接纳新请求。超时的本地等待负责取消晚到响应，不假定跨 binding 取消已经自动终止远端工作。独立 scanner Worker 自身也设置截止。

当前 publish 始终拒绝，没有 bypass 或开关：

- 旧格式-only policy：`REQUIRED_CONTENT_CHECK_UNAVAILABLE`。
- 新复合 clean 且当前有效：`SCANNER_CLOUD_NOT_VALIDATED`。
- 新扫描过期或绑定/事实失效：`CONTENT_SCAN_EXPIRED_OR_INVALIDATED`，或先返回既有绑定失效错误。

本地 Docker HTTP + Node 宿主装配不是原生 DO/Container 链路验收。Linux 本地及获准隔离云的 binding、取消/并发/闲置回收和主 Worker/D1/R2 业务链已分别实测通过。扫描请求使用 workerd 支持的 `redirect: "manual"`，非 2xx 响应取消并拒绝，不跟随 Location。云资源配置和本次取消后空实例不证明资源极限、所有底层进程/临时文件清理、全协议出站隔离或沙箱逃逸安全。供应链筛选范围、签名更新发布周期及发布/下架事务仍有未完成项，生产 `cloudValidated:false` 不变。Wrangler 本地额外权限/动态端口也不能视作生产沙箱。本轮没有升级套餐或改变既有资源，隔离云测试入口和 cron 已关闭，详见 [云验收](P3_CLOUD_SCAN_VALIDATION.md)。

P3.3c 候选构建额外使用唯一 `SCANNER_SIGNATURE_REFRESH` 使 freshclam 层不复用缓存；
完整漏洞报告、签名/报告时效和防签名版本倒退用于候选重新评估。命令与实际安全拒绝见
[签名更新候选](P3_SCANNER_RELEASE.md)。它不提供生产准入开关，也没有自动更新运行容器。

## 已核实的官方资料

2026-10-04 联网核实并保存响应：

- [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)：原生 start/TCP port/inactivity API。
- [原生 API 迁移指南](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/)：新应用不必引入 SDK。
- [Wrangler 配置](https://developers.cloudflare.com/containers/wrangler-configuration/)及 [限制](https://developers.cloudflare.com/containers/platform-details/limits/)：Container 定义与实例限制。
- [ClamAV 官方 Docker 文档](https://github.com/Cisco-Talos/clamav-documentation/blob/main/src/manual/Installing/Docker.md)及扫描/配置文档：官方镜像、签名更新与扫描参数。

完整本地证据入口见 [P3.3b 验收记录](P3_CONTENT_SCAN_VALIDATION.md)。以上时间与版本为本轮事实，不是永久额度或永不过期的安全保证。
