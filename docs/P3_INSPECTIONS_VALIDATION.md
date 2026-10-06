# P3.1 本地验收记录

日期：2026-10-04。范围：受限 PNG Art 内容检查及其可恢复任务；P3 整体仍未完成。

## 通过的检查

- Biome 格式/lint、TypeScript、有效行数与 UTF-8 无 BOM 检查通过。
- 本轮联网 `pnpm audit` 返回 `No known vulnerabilities found`；没有新增依赖或改动根锁文件。
- 完整本地 workerd/D1/R2 suite **38/38** 通过，失败、取消、跳过均为 0：P1/P2 的 26 项回归，以及 P3.1 的 12 项检查与恢复验证。
- 三份 SQL 在新隔离库 `linshi/assetlibrary-p3-schema-20261004-075309` 首次应用成功；第二次返回 `No migrations to apply!`，没有重置旧本地状态。
- Wrangler dry-run 构建成功，没有真正部署；最终候选采用文档收尾后的新目录，并核对源码、Schema、配置及已测 bundle 身份。

完整 suite 的原始证据目录：

```text
C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p3-Pgw6VR
  manifest.json
  build.log
  tests.log
```

最终交付目录以构建输出和交付报告为准；`delivery-provenance.json` 记录 fresh 候选与上述已测 bundle/运行源码的匹配，不把其他版本的测试日志冒充当前证据。

## 真实闭环和失败证明

同一 PNG 经 owner 创建资源、预留、R2 上传与完成后，POST inspection 产生 queued 记录；本地原生 scheduled 调用生产检查管线，GET 返回 passed、实际读回 SHA-256、尺寸和解码字节数。对象仍是 quarantined，`publicationEligible` 为 false，发布和下载路径仍为 404。

聚焦证明：

| 场景 | 实际结果 |
| --- | --- |
| 成员/无关主体、无效 JWT、伪造状态 | 拒绝，不能写检查事实 |
| 尚未完成、超过 1 MiB、非 Art | 准入失败，不启动不支持的检查 |
| 并发排队/重复请求 | 一份任务、一次创建事件，不重置终态或尝试次数 |
| PNG 错误 CRC/结构、额外元数据、IEND 尾部、65 chunks | rejected，无结果或发布资格 |
| 非 PNG、过大尺寸、非法 filter、短解码、解压炸弹 | rejected，未将格式失败当作服务重试 |
| 无效/截断 zlib、压缩流尾部额外字节 | rejected；原生本地 DecompressionStream 行为实测 |
| 任意字节边界拆分 IDAT | 有效静态 PNG 检查通过 |
| 近 1 MiB 不易压缩输入、1,048,576 像素 | 在本地普通 Worker 完成；记录 elapsedMs，不冒充 CPU/峰值内存测量 |
| R2 缺失/被替换 | rejected，旧对象身份不能通过 |
| 排队/完成审计 ABORT | D1 整批回滚，不保留幽灵任务或 passed；恢复后安全重试 |
| 检查持有旧对象时上传取消 | invalidated，不写成功事件 |
| 租约到期后重新执行 | 新 token 隔离旧执行者，不覆盖新结果或重复审计 |
| 第三次执行中断后取消/删除 | 到期回收优先 invalidated，次数不重置 |
| R2 临时故障 | 最多三次，终态 failed 后重复 POST 不再执行 |
| 四份到期任务 | 第一轮仅三份，第二轮继续，不展开无界并发 |

基础闭环、格式和解压检查在本地 workerd/D1/R2 中执行。竞争及存储故障测试在 Node 宿主装配原始 bundle 和真实本地 binding；只修改测试隔离库或对象，不注入生产路由。租约测试只前移到期时间，不重置已经消耗的次数或伪造成功审计。

## 发现与修复

独立只读审查发现第三次 running 中断后的租约回收会直接记录 failed，未优先检查上传取消/资源删除。已把同一事务的绑定判断纳入领取和耗尽路径；取消及删除两条竞争回归均通过。

最初两次构建已输出 `--dry-run: exiting now.`，但 CLI 仍未及时退出，不能算构建通过。诊断捕获残留 TLS 句柄；安装版 Wrangler 的 banner 会启动异步 npm 版本检查。仅对固定锁文件的本地构建设置 `WRANGLER_HIDE_BANNER=true` 后，fresh dry-run 正常退出。版本检查与真正安全审计不同，在线 audit 仍独立执行。构建日志现在记录 status/signal/errorCode；失败目录 `assetlibrary-p3-VHCWNN` 和 `assetlibrary-p3-4VcRRx` 保留，不覆盖成成功证据。

## 逐文件工程核验

| 文件 | 有效代码行 |
| --- | ---: |
| `src/inspections/png.ts` | 96 |
| `src/inspections/object.ts` | 61 |
| `src/inspections/records.ts` | 103 |
| `src/inspections/routes.ts` | 54 |
| `src/inspections/tasks.ts` | 70 |
| `src/inspections/runner.ts` | 45 |
| `db/0003_inspections.sql` | 30 |
| `tests/inspection-fixture.mjs` | 63 |
| `tests/inspections.test.mjs` | 193 |
| `tests/inspection-recovery.test.mjs` | 243 |
| `src/index.ts` | 27 → 33，只有路由/定时接线 |
| `src/uploads/records.ts` | 107 → 108，增加资源 kind 上下文 |
| `scripts/build.mjs` | 86 → 91，阶段身份及退出诊断 |

没有新大文件、旧大文件增长或 501–700 行例外。主线程逐文件审查权限、参数化 SQL、快照/租约/CAS、错误脱敏、输入与解码有界、reader/timer 和测试运行时清理。独立代理只读审查，不把它未运行的测试当作运行通过。

## 尚未验收

P3 的必要恶意内容/归档检查、审核、版本绑定、发布和下架尚未完成。本策略不是最终包格式决定，不将格式 passed 自动升级为全面内容安全通过。

没有真实 Cloudflare、账号接入、云 R2 配置、网络中断或 CPU/内存峰值证据。原生解压内部缓冲不由 JS 输出计数器完全控制；本地上限案例通过不承诺免费套餐限额、长期容量、费用或无需更强隔离。支持范围扩大前必须重新验证这些边界。

记录保留、上线限流、完整历史秘密扫描、远端 CI/分支保护未落地或修改。没有提交、推送、开通服务、真实凭据使用或云部署；已有归档和未提交工作保留。下一项是 P3.2 审核、版本与对象绑定及发布门禁，不是 P4 下载。
