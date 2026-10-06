# P3.3b 本地验收与隔离云证据入口

## 当前结论

复合扫描实现、独立 scanner Worker dry-run、真实 Docker ClamAV 服务及主业务版本/审核/发布拒绝流程已形成可复验切片。随后已完成 **Linux 本地原生 service binding → DO → Container 及真实主 Worker/D1/R2 业务链验证**，并修正实际 workerd 暴露的请求兼容缺陷。本轮另完成获准的隔离 Cloudflare 运行、资源配置读回、镜像可修复 HIGH 修复及入口/cron 关闭，详见 [独立云证据](P3_CLOUD_SCAN_VALIDATION.md)。生产资源/网络隔离、完整供应链和签名更新准入仍缺，P3.3 整体尚未完成，不把本地或云 passed 当作生产可发布。

先前完整回归 91/91 及最后 flags 聚焦 2/2 保留为基线证据，不冒充本次改动后的新全量结果。本次扫描策略/截止聚焦测试 13/13，测试 bundle 与最终候选相同，并由实际原生业务链补充平台证明；身份/旧签名/重放、三次 budget、无隐藏重试、流取消与迟到响应、75 秒截止、审计 ABORT、取消竞争、过期事实和 Schema 失败关闭均有对应测试。`MockTimers` 只用于 Node 宿主截止测试，没有进入生产配置。

实际 Docker 验证通过 `rtk pnpm test:scanner` 执行：创建随机命名、标签匹配的新容器，4 GiB、1 CPU、32 pids、只读根、无网络、去 capability、禁止提权，64 MiB 的 noexec/nosuid tmpfs。通过容器内 loopback HTTP 调用，无宿主公开端口。结束只移除所属临时容器，保留镜像和既有服务/数据。

## 实际扫描与结论边界

`scanner/runtime-validation.json` 保存十个场景及实际事实：

1. 双 PNG ZIP 返回 clean。
2. Stored ZIP 内标准无害 EICAR 命中。
3. Deflate ZIP 第 32 个条目中的 EICAR 命中，不能仅以外层 `Scanned files:1` 声称内部覆盖。
4. 9 MiB 解压条目在扫描器预算检查中拒绝，不依赖 AV 的静默跳过行为。
5. 符合 Art 格式的 32 PNG 包完成复合检查；其中 PNG 像素里的 EICAR 文本未命中，明确作为检测能力边界，而非阳性检测证据。
6. 把原文 EICAR 伪装为 `.png` 在格式阶段拒绝，扫描调用为零。
7. 真实 clean → 不可变版本 → 独立批准 → publish 409 `SCANNER_CLOUD_NOT_VALIDATED`。
8. 真实 HTTP 中断触发清理。
9. 中断后下一包仍可 clean；最终 `/tmp` 无扫描残留。
10. 没有 UTF-8 flag 的合法 ASCII ZIP 返回 clean，与主 Worker 的格式接纳范围一致。

运行中实际加载的四个 runtime 文件摘要与候选一致；事实包含引擎 1.5.4、daily 28143、实际三库联合摘要及时间。`runtime.log`、`image-build.log`、`cleanup.json` 和 retained image ID 一并记录。报告不包含上传内容、真实身份或云凭据。

## 发现并修正的问题

- Alpine APK 索引 TLS 失败：未关闭 TLS 校验，改为联网核实的官方 Debian ClamAV/Node digest 多阶段构建。
- 原镜像携带旧 daily：构建时通过 freshclam 更新并实际测试签名库；旧库不删除、不替换为当前验收证据。
- root 只读库目录最初不可读：明确 root 所有、所有用户只读/可遍历，并以 clamav 实测加载。
- CLD header 时间字段最初误用索引：用真实 `sigtool --info` 和实际 header 核对，读取第九字段 stime。
- 未响应 readiness、迟到 Response 和扫描预算吃满租约：独立截止、接管迟到 body、75 秒扫描调用；没有续租或重置 budget。
- 临时目录清理失败会留下 busy：清理后才返回事实，嵌套 finally 释放 owner 状态，失败关闭接纳。
- ClamAV 对超大条目无命中 exit 0：增加独立 ZIP 扫描资源预算，不能伪称 AV 告警已经覆盖。
- 官方镜像的 clamd healthcheck 不适用 clamscan 服务：移除继承的探测，原生入口明确使用 `/healthz`。
- 最终只读复核发现 ZIP flags 接纳不一致：扫描器预算 guard 同步支持 `0` 和 `0x800`，新增聚焦断言及真实扫描用例，避免错误拒绝合法 ASCII 包。
- 原生主 Worker 首次运行在请求构造时失败：workerd 不支持 `redirect: "error"`。改用 `manual`，现有非 2xx 检查拒绝并取消 3xx body，不跟随 Location；补充请求模式、单次调用、302 流取消和不保存 clean 的回归。旧候选先复现失败，修复后扫描策略/截止测试 13/13 通过，实际原生业务链也通过。

## 原生 Linux 链路与环境边界

已经实际运行 Wrangler 4.147.0 多 Worker 本地命名 binding 配置。它在 Container 准备阶段明确退出：

```text
Local development with containers is currently not supported on Windows. You should use WSL instead.
```

现有 Ubuntu WSL 有 Linux Docker CLI，但没有可用的 Docker daemon socket，也没有可用的 Linux Node。未修改 Docker Desktop 集成设置、未安装系统工具、未切换远端部署、未关闭 Containers 来制造假通过。

随后在 `../../linshi/assetlibrary-native-1y2pFo` 使用固定官方 Node Linux 镜像、Wrangler 4.147.0、已有 Linux Docker CLI/Buildx 和本机 Docker daemon 完成实际运行。仅挂载该新临时目录及 Docker socket；HOME/认证/状态独立，不挂载仓库、真实凭据或历史数据，不调整系统 WSL/Docker Desktop 设置。首次 CLI 缺少 Buildx 的 `unknown flag: --load` 通过复制已有插件解决，不降低构建要求。

原生 probe 的八个场景通过：默认 scanner binding 404；命名 binding 的双 PNG ZIP clean；ZIP 内标准无害 EICAR infected；并发主请求 clean、第二请求 503；1.5 秒绑定取消返回 503；取消后下一包 clean；闲置 65 秒后容器已回收，再次请求重新启动并 clean。快照在取消前看见 ClamAV 进程，取消后容器不存在；不是仅取消客户端等待。没有用普通 Docker HTTP 或关闭 Containers 替代原生绑定。

真实主 Worker 使用正式 bundle 和新的本地 D1/R2 binding，四份 Schema 应用到新的 `/work/state`；仅注入临时测试身份公钥及独立 reviewer。通过正常 API 和 Wrangler 本地 scheduled 入口完成 11 次业务调用：创建 → 上传/完成 → 复合检查 passed → 不可变版本 → 独立批准 → publish 409 `SCANNER_CLOUD_NOT_VALIDATED` → 读取仍 approved/不可发布。没有生产测试入口；首次失败及 attempts 历史保留，没有重置 budget。

必须单独保留以下限制：

- 原生本地 scanner 为 `clamav` 用户，但 Docker inspect 的 Memory/NanoCpus 为 0、pids 未限制、根文件系统可写；配置 `standard-1` 不证明本地应用云资源限额。先前无网络 Docker 验证的资源限制不能嫁接到本次 native 运行。
- Docker inspect 显示本地 scanner 被工具赋予 SYS_ADMIN、`/dev/fuse` 和 `apparmor:unconfined`；网络代理 sidecar 另有 NET_ADMIN，并临时映射 `0.0.0.0` 的动态 Docker 端口。主业务仅监听 runner loopback，但不能声称整套本地开发工具没有额外权限或宿主映射端口。此工具运行只处理可信无害夹具，不是生产沙箱验收。
- 配对 HTTPS 探测中 runner 可访问 example.com（200），scanner 的域名解析被拒绝（ENOTFOUND）。这仅是该探测的出站拒绝事实，不等于验证所有 IP/协议的禁止出站或云网络隔离。
- 实际 native scanner 四个 runtime 文件摘要匹配候选，完成后 `/tmp` 为空。idle 回收发生过一次测试外 Docker exec 期间（exit 137），因此 exec 不被当成保持容器活跃的业务请求。
- 镜像加入本轮唯一 LABEL，只为隔离 Wrangler 按 ancestor 删除的本地 cleanup；业务字节不变。结束保存原始日志/资源快照，仅回收自己创建的 runner；scanner/sidecar 已由原生 idle 回收。启动前 200 个既有容器的 ID、镜像与运行状态全部保留，没有新容器残留，镜像保留。关闭旧 dev 进程时出现过 esbuild deadlock 日志，不隐去，清理结果另行核验。

证据入口是该目录 `evidence/` 下的 `native-validation.json`、`native-business-validation.json`、`native-business-initial-failure.json`、`native-runtime-files-egress.json`、`full-runtime.log`、`new-containers.json` 和 `cleanup.json`；候选 receipt 单独绑定运行 bundle/源码/证据摘要。这些是此前 Linux 本地事实；本轮获准隔离云使用新的独占目录和资源，不将两种运行环境的安全结论混用，发布硬门禁不变。

## 数据、供应链与授权

新的四份 Schema 在 `../../linshi/assetlibrary-p33b-local` 应用；第二次应用确认无待处理迁移。P3.3a 及更早状态完整保留，不迁移或清空。

此前执行 formatter、TypeScript、活动行数 checker、13 项聚焦回归及实际原生业务验证。本轮 Dockerfile 修复后重新运行真实 Docker 十项场景、Trivy 筛选及云运行；13 项聚焦结果按源码/bundle hash 匹配复用。先前完整回归和联网 npm audit 保留为基线，锁文件未变化，不声称本轮重新运行全量测试或 npm audit。Trivy 仅覆盖存在修复版本的 HIGH/CRITICAL，未修复/低等级和独立 Node/ClamAV 二进制仍需复核，不代表零漏洞；生产签名更新策略仍缺。

此前 Linux 本地批次未提交、推送或云变更；本轮依据新的明确授权读取独立凭据并完成隔离云部署/验收，未升级已有 Paid 套餐，结束关闭新测试入口及 cron。没有提交、推送、生产部署、成功 published、公开目录、下载或实际下架。旧归档和他人服务不作为本轮新实现证明，也未被清理。
