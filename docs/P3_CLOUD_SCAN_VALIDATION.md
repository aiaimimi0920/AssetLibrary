# P3.3b 隔离 Cloudflare 运行验收

验收日期：2026-10-04（本地时区）；远端及证据时间使用 UTC 2026-10-05。候选版本 `0.3.0-dev.6`。

## 结论与授权范围

用户明确提供独立 `aikey` 凭据目录并授权继续 Cloudflare 验收。本轮仅新建独占测试资源，实际完成云 native 扫描和多文件 Art 业务闭环，并关闭测试入口/cron。**这不是生产部署、完整安全准入或 P3 完成；`cloudValidated:false`、`publicationEligible:false` 及 `SCANNER_CLOUD_NOT_VALIDATED` 硬拒绝不变。**

账号级 token 通过 account token verify 核验 active；`/user/tokens/verify` 的 401 不能用于否定 account token。已有 Workers Paid/R2 Paid 和可用 Containers API，未升级套餐、修改 DNS、现有 Worker/数据库/对象或账号系统。Containers 可能按运行时间计费，不承诺免费。调用脚本从独立凭据库读取 API token 后仅注入子进程环境或请求内存，不复制进产品仓库、候选或报告。Wrangler/Docker 的短期 registry 登录及可能含认证信息的原始工具日志位于独占临时 HOME，不能宣称这些工具没有落盘认证状态；它们不读取展示、不打包。另行验证 manifest 使用的五分钟 pull-only 凭据仅在内存。合成身份不是实际账号服务。

## 独占资源与版本

| 资源 | 身份 |
| --- | --- |
| D1 | `al-db-val-tnjeik`，`15eadf9a-932d-4854-ae67-9f45a94e8075` |
| 私有 R2 | `al-quarantine-val-tnjeik` |
| scanner Worker | `al-scan-val-tnjeik`，验收/保留版本 `c0dd9708-aa89-4631-b632-30cce010d88a` |
| 主 Worker | `al-main-val-tnjeik`，业务验收版本 `340ca3f4-c467-435a-b58e-81abbcfb44aa` |
| 主 Worker 收尾版本 | `650335ed-807d-4756-8066-952b3f87dfb9`（关闭 HTTP/cron，业务代码未变） |
| 临时 probe | `al-probe-val-tnjeik`，验收版本 `fc9788e5-b9fd-4244-81cc-d0ff5b14cecd`；关闭版本 `dd763c55-85d1-433e-b44f-074c0f3f8d85` |
| Container application | `al-scan-val-tnjeik-artscanner`，`a036eb69-96a3-42ea-91c2-3c9e02ed5d26` |
| Registry manifest digest | `sha256:f7347b948af1a59aeb5ec078fb3e4aea0f2ab7676812ef3f2c07bc7b72922872` |
| 本地构建/扫描 image config ID | `sha256:4c3c7fcf2a593826658f757ba4ff71087ea93b5c779fb66e5cefc807cfc1f141` |

创建前逐项确认名字不存在；四份 migrations 只应用到新 D1。Registry manifest digest 与本地 image config ID 是不同对象，不要求相同。部署日志绑定本地镜像构建与成功 push 的 manifest；Cloudflare API 读回同一 manifest。另从 Registry 只读获取该 manifest，实际字节摘要相同，`manifest.config.digest` 等于 Trivy 已扫 image config ID，证据为 `cloud-registry-image-identity.json`。

正式 bundle/runtime 来自 `../../linshi/assetlibrary-p3-Z912Cn`。Cloudflare 上传前 Wrangler 会再次 bundle，因此不能将源输入 `.js` hash 直接当远端模块 hash。使用固定 Wrangler 对同一隔离配置 dry-run 生成上传模块，与云 `/content/v2` 实际读回模块逐字节摘要相同：

- scanner：`8d49c203aa9196cb99c3b2ae54ce94e40f3136ffcf450ab8ba1b963806f8bcfe`。
- main：`0f92f96f18d58bf77a36b5cc9937beeb88ab2a1840265042c00cb8c14fb28940`。

最终候选单独绑定当前源码、上述上传输入/云版本和证据；不将 dirty 本地候选伪装成干净提交或正式发布。

## 实际云运行

九项 native 场景全部通过：

1. 无 token 的 probe 返回 401。
2. probe 转发默认 scanner entrypoint 返回 404；API 另确认 scanner 的 workers.dev/preview 均未开放。
3. 798 字节双 PNG Art ZIP 返回 clean，整体 SHA-256 `24771e8768f8eca739db42de9bd44d096e5613093238cc02be05b44378653345`。
4. Stored ZIP 标准无害 EICAR 返回 infected；不将 PNG 像素 EICAR 的未命中当成检测覆盖证明。
5. 竞争主请求 clean。
6. 第二并发请求 503，没有隐藏扫描重试。
7. 1.5 秒 binding abort 返回 503；此前 running placement，随后 API `instances: []`。
8. 取消后下一包 clean，恢复 placement 与此前不同。
9. 最后一次请求后等待 70 秒，API `instances: []`；再请求 clean，placement 再次变化。

响应包含实际引擎 `1.5.4`、daily `28143`、三库联合摘要 `df9907d53ec52fadbab9fa2469952ea64f56fcaadf65a7dd8b64c81adee5a742` 及本次完成时间。具体样本 clean 不等于所有内容无害；并发场景不是容量/长期公平性承诺。

云 API 确认 `default` scheduling policy、`max_instances:1`，配置 0.5 vCPU、4096 MiB、8000 MB disk，private network、IPv4/IPv6 none、firecracker runtime。省略 policy 默认 default，不适用 durable_object policy 的 lite 默认结论。这些是配置事实，不是峰值测量、限额攻击、禁止全部出站或逃逸测试。

原始增量 JSON 会在每步/失败时保存，文件存在不代表完成。独立 completion checker 要求全部九项、取消/idle 前明确 running、之后严格空实例及不同 restart placement，不将未知状态作为已停止。最终 `cloud-native-completion.json` 记录 completed/passed 和输入 JSON 摘要。

## 正式主 Worker + D1/R2 闭环

通过正常 API 共 15 次业务/审计调用（含状态轮询），没有生产测试后门、手写 passed、重置 attempts 或调用本地 `__scheduled`：

创建 Art 草稿 → 预留上传 → R2 私有上传 → complete → 排队 `art-zip-clamav-v1` → 等待已配置的一分钟正式云 cron → 双 PNG 格式及同字节 AV passed → 创建不可变版本 → 合成非 owner reviewer 批准 → publish 返回 409 `SCANNER_CLOUD_NOT_VALIDATED` → 读取仍 approved/不可发布。

probe 的参数化 D1 查询仅见 owner `created`、reviewer `approved` 两个事件，没有发布事件。收尾后 D1 API 只读再确认 upload quarantined、inspection passed/attempts=1、version approved/events=2。脚本没有主动执行 scheduled，部署/API 证据确认真实 cron 配置；未收集唯一 scheduled event ID，不以静态标签伪造事件身份。

首次业务调用 401 源于测试夹具一小时 JWT 违反产品 900 秒期限且已超 maxTokenAge。使用新合成 RSA 公钥和 900 秒 JWT 后通过，私钥不持久化，产品鉴权未放宽。初始 401、网络部署失败和 Node fetch/代理夹具错误均保留，不隐去或计入成功样本。

## 镜像漏洞发现、修复与筛选边界

联网下载官方 Trivy `0.75.0`，按 GitHub release digest/checksums 核验 Windows archive SHA-256：`4e43bd71a30f51aee39525f60f2b47043af77eb8df8fe082aae4372b69c6660f`。

旧镜像扫描发现七条 HIGH、三个 CVE、四个 Debian package：`CVE-2026-103111`（PCRE2）、`CVE-2026-75804`/`CVE-2026-84782`（OpenSSL）。Dockerfile 保留官方基础 digest，固定升级 `libpcre2-8-0=10.46-1~deb13u3`，以及 `libssl3t64`/`openssl`/`openssl-provider-legacy=3.5.7-1~deb13u3`，不关闭 apt 签名或 TLS。

修复后重新构建，真实无网络 Docker 十场景通过。Trivy 使用 `--severity HIGH,CRITICAL --ignore-unfixed --exit-code 42`，修复后 exit 0 且该筛选范围 `findings:[]`；隔离部署 wrapper 检查这份报告才部署。**不是零漏洞报告或完整永久 CI 门禁**：未修复/低等级、独立 Node/ClamAV 二进制及未来公告仍需独立复核。没有新增 npm 依赖或改变锁文件。

## 入口关闭与数据保留

验收完成后仅重新部署自己新建的 main/probe：workers.dev false、preview false、crons 空；probe expiry 设为过去时间。scanner 本来就没有公开入口/cron。API readback 确认三者 enabled/previews_enabled 均 false、schedules 均空；main/probe 外部请求实际返回 404；scanner API 当前 instances 空。D1、R2、镜像和证据保留，无清空/删除云数据。

cron 配置传播可能延迟，未声称所有地域在同一时刻已停止投递；收尾时无 queued/running 测试任务，已确认实例空。配置/数据保留证据在 `cloud-metadata-after-close.json`、`cloud-final-state.json`。

## 证据与下一项

证据根：`../../linshi/assetlibrary-cloud-TNjEIk/evidence/`。核心文件：

- `cloud-native-validation.json`、`cloud-native-completion.json`、`cloud-business-validation.json`。
- `cloud-metadata-before-close.json`、`cloud-upload-byte-identity.json`、`cloud-metadata-after-close.json`、`cloud-closed-byte-identity.json`、`cloud-registry-image-identity.json`、`cloud-final-state.json`。关闭版本的主/scanner 模块也已读回并确认与验收模块相同。
- `deploy-artifact-identity.json`、`scanner-deploy.log`、`main-identity-deploy.log`、`main-close.log`、`probe-close.log`、`db-migrations.log`。
- 修复前/后 `scanner-image-*-vulnerabilities*.json`、官方文档/Trivy release/checksums 快照。

不打包 `test-access.json`、Wrangler/Docker 认证目录或原始认证 debug 日志。只读交叉核验已指出增量 JSON 完成判定和未知状态风险，本轮用独立严格 completion proof 收敛，没有重复已通过的样本。

下一项是生产签名更新发布/回滚周期、镜像剩余供应链审查、云资源极限及全协议出站隔离/进程清理证明；随后才能决定生产扫描准入并实现发布/下架事务。当前没有公开目录、下载、真实账号接入、生产发布、提交或推送。
