# P1–P3.3b 本地开发与构建

## 活动工具链

只使用根 `package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml`。Node.js 22+，pnpm 固定 10.33.0。生产依赖只有 JWT 验证库 `jose`；Wrangler、Miniflare、Workers 类型、TypeScript 和 Biome 都是开发依赖。

Wrangler 及其 Miniflare/workerd 版本作为同一工具链保持一致。此次从 npm 官方 registry 核实版本；Wrangler 4.147.0 本身依赖 Miniflare `5.20261001.0-alpha`，直接测试使用相同版本，不能把工具链的 alpha 依赖描述为已完成云生产验收。pnpm 仅允许 esbuild/workerd 的必要安装脚本。

## 可执行命令

在 AssetLibrary 根目录使用 PowerShell：

```powershell
rtk pnpm install --frozen-lockfile --store-dir C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-pnpm-store
rtk pnpm check
rtk pnpm typecheck
rtk pnpm sizecheck
rtk pnpm audit
rtk pnpm test
rtk pnpm build
```

`check` 执行 Biome 格式和 lint，`format` 可修正活动源码格式。`sizecheck` 以语法 token 测量 TS/JS/JSON 有效行，并检查所有活动文本 UTF-8 无 BOM；当前没有超过 500 行的例外。

`test` 会先运行 Wrangler `deploy --dry-run`，然后用该 bundle 跑集成测试。每套 fixture 独立生成签名公钥，在 `linshi` 中建立测试 D1/R2，测试结束调用 `Miniflare.dispose()` 关闭自己拥有的运行时。测试故障注入只操作该隔离库和对象，不触及历史数据库或云资源。可以用 `rtk pnpm test upload-streams.test.mjs upload-recovery.test.mjs` 只执行指定测试；未知文件名失败关闭。

`build` 也只做 dry-run，不调用真实部署。当前输出到 `linshi/assetlibrary-p3-*` 的唯一目录，包含主业务及独立 scanner Worker bundle、四份 Schema、占位 D1/R2 binding/Cron/service binding 配置、Container Dockerfile/runtime、源码/锁文件/产物 SHA-256 manifest 和日志。manifest 标记 `P3.3b-local-candidate` 与 `cloudDeployed:false`，不是生产构建凭证。scanner dry-run 实际构建 Docker 镜像，因此要求运行中的 Docker；Wrangler 仅删除自己生成的临时镜像标签，保留本轮验证脚本的独立镜像，不执行 prune。

旧 P1、P2、P3.1 和失败运行目录原样保留，不覆盖为新证据。本地构建对子进程设置 `WRANGLER_HIDE_BANNER=true`，跳过固定版本工具不需要的异步 npm 版本探测，在线依赖安全 audit 不受影响。

## 手动本地 API

```powershell
rtk pnpm db:local
rtk pnpm dev
```

P3.3b 的本地 D1/R2 状态放在新 `../../linshi/assetlibrary-p33b-local`，空库支持三种明确 policy，不兼容旧开发 Schema。此前所有库均原样保留。`db:local` 可重复应用四份 Schema，不能把新 Worker 指向旧 Schema 来冒充升级。默认配置只有占位资源、Cron 和内部命名 binding，没有凭据、真实资源 ID 或在线路由。未配置身份时只有 `/healthz` 返回存活，业务 API 返回 503，这是失败关闭，不是测试登录入口。

需要手动操作业务 API 时，由使用者提供获准测试签发方的三个身份配置与短期 JWT，配置可放在 Git 已忽略的 `.dev.vars`。本轮不自动写入真实账号配置。API、权限和错误含义见 [P1_API.md](P1_API.md) 和 [P2_API.md](P2_API.md)。真实网络断连与云端限额仍需后续独立验收。

检查接口见 [P3_INSPECTIONS_API.md](P3_INSPECTIONS_API.md)。`rtk pnpm test inspections.test.mjs inspection-recovery.test.mjs` 执行当前检查与恢复测试。

版本和审核接口见 [P3_VERSIONS_API.md](P3_VERSIONS_API.md)。独立审核另需部署者配置 `REVIEWER_PRINCIPALS` 为合法 PrincipalRef 的 JSON 数组，且审核者不能是资源 owner；缺失或非法配置时审核写入失败关闭。本轮只在隔离测试中配置生成的测试主体，没有配置真实身份或允许发布的开关。聚焦测试命令为 `rtk pnpm test versions.test.mjs version-reviews.test.mjs version-consistency.test.mjs`。

多文件 Art 包入口见 [P3_ART_PACKAGE_API.md](P3_ART_PACKAGE_API.md)：`rtk pnpm pack:art <input-directory>` 从明确 recipe 生成唯一的 Stored ZIP 和摘要 receipt，输出到 `linshi/assetlibrary-art-package-*`。不自动上传、扫描、批准或发布，打包成功不是内容安全通过。聚焦命令为 `rtk pnpm test art-packages.test.mjs art-package-structure.test.mjs art-package-content.test.mjs art-package-recovery.test.mjs art-package-packer.test.mjs art-package-packer-races.test.mjs`。

复合扫描聚焦命令为 `rtk pnpm test scanner-policy.test.mjs scanner-deadlines.test.mjs scanner-limits.test.mjs`；`rtk pnpm test:scanner` 独立创建无网络、只读、随机命名且带 owner 标签的本地 Docker 服务，结束清理所属容器，保留镜像和日志。它使用标准无害 EICAR，不使用真实恶意软件。

`rtk pnpm scanner:dev` 是原生 Container 开发入口，但 Windows Wrangler 实测拒绝本地 Containers；现有 WSL 未接通 Docker。此入口不能宣称当前已手测就绪。双 Worker 原生启动需要可用 Linux Node/Docker 环境，使用 `wrangler dev --config wrangler.jsonc --config scanner/wrangler.jsonc --local`，不得改用 remote 或关闭 Containers 冒充通过。详细边界见 [扫描验收记录](P3_CONTENT_SCAN_VALIDATION.md)。

## 依赖和秘密边界

活动依赖安全扫描是根锁文件对应的 `pnpm audit --audit-level=low`，覆盖生产和开发依赖，任何公告返回非零。它只向 npm advisory 服务提交依赖信息，不上传业务源码或凭据。不扫描 old 的历史锁文件来冒充当前运行图，也不继承旧 OSV 的绿色结果。

`old/**` 不参与格式、lint、typecheck、测试、行数、打包或活动依赖扫描。`.gitignore` 继续保护当前和历史环境、私钥、缓存及本地数据。历史秘密保护不因活动源码排除而放宽；本地 audit 不替代全历史秘密扫描。远端 CI、Dependabot、required checks 和分支保护未修改，新的远端安全发布门禁需在提交/发布授权下独立落地。

安装、构建和本地测试不是云部署；开通 D1/R2、注入真实凭据、绑定域名和上线仍需要单独授权。
