# P3.3a 多文件 Art 归档包本地验收

日期：2026-10-04。范围为受限 ZIP 的打包、私有上传、可恢复检查、不可变版本绑定、独立审核及发布拒绝证明。用户已明确首期必须支持多文件 Art 归档包，本切片不以单张 PNG 替代该方向。不是完整 P3、全面恶意内容扫描或正向发布验收。

## 实际通过的检查与原始证据

- 新增包体相关 **22/22** 项通过（在完整 suite 中执行）；完整本地 suite **77/77**，包括既有 55 项回归。失败、取消、跳过均为 0。
- Biome 格式/lint、TypeScript、有效行数、活动文本 UTF-8 无 BOM 检查通过。
- 联网根依赖 `pnpm audit --audit-level=low` 返回 `No known vulnerabilities found`，本轮没有添加依赖或修改根锁文件。
- 四份 SQL 在全新的隔离库首次全部应用成功，第二次返回 `No migrations to apply!`；两次退出码均为 0，没有清空旧状态或调用远端迁移。
- 文档收尾后 fresh Wrangler dry-run 候选须按 `delivery-provenance.json` 核验：执行源码/配置/Schema 和 bundle 与已测身份完全一致，仅 Markdown 与 source map 的构建目录差异可单独记录。没有真实部署。

完整 suite 原始证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p3-SRHn0U`，含 manifest、bundle、build.log 和 tests.log。本次 suite 经过时间约 66.8 秒，不是 Worker CPU、峰值内存、计费或吞吐保证。

此前聚焦证据：`assetlibrary-p3-Tg9KY8` 的 20/20，以及文件竞争/属性补强后的 `assetlibrary-p3-0KHQNw` 的 7/7。这些存在重叠且源码身份并非最终身份，不累加为 27 个新增测试；最终结论以完整 77 项及身份核对为准。

SQL 证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p33-schema-20261004-100324`，含 migration-validation.log/json 和独立 state。日志中代理环境 WARNING 不代表迁移失败；四份迁移实际均成功，第二轮没有待应用项。receipt 记录每份 SQL 的 SHA-256。

## 可直接使用的示例包

实际执行 `rtk pnpm pack:art`，输入目录为 `C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p33-example-r3LgER`；输出目录为：

```text
C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-art-package-QVGHTS
  package.zip
  manifest.json
  package-receipt.json
  local-flow-receipt.json
```

该 Stored ZIP 有 2 张无害 PNG，799 字节，整个包 SHA-256 为 `7a618ff3b899ad2350492be5a0b1ab0b813364cca3395b2c3e9b69ae300547c2`。同一个包用完整 suite 的生产 bundle 和真实本地 D1/R2 完成上传、检查 passed、版本创建和独立批准，publish 返回 `409 REQUIRED_CONTENT_CHECK_UNAVAILABLE`。独立 local-flow receipt 不含 JWT 或私钥；测试只生成临时身份，结束关闭自己创建的 Miniflare。

示例包是本地可检查候选，不是已发布/已扫描的安全素材。输入 PNG 是测试夹具，不能把它当成产品素材质量验收。

## 安全、状态与资源边界证明

| 场景 | 实际结果 |
| --- | --- |
| 多 PNG 的 Stored 和 Deflate 包 | 真实 workerd 检查通过，包摘要与逐文件摘要分别绑定 |
| 两种 policy 串行/并发申请，及大 ZIP 请求默认 PNG policy | 不同策略 409，只有一个任务，不静默切换/重置次数或重复审计 |
| 32 张图片、结果 JSON 超过旧 2048 字节 | passed 结果完整持久保存并可创建版本；33 张图片拒绝 |
| 约 4 MiB、4 张近单文件上限 PNG，共 1MP | 本地通过；再加一张超总像素，在下一次 PNG 解压前拒绝 |
| 路径穿越、绝对/反斜线/冒号、设备名、非 ASCII、过深/过长 | 拒绝，不修正恶意路径，不写入文件系统 |
| 大小写重复或文件/目录祖先冲突 | 拒绝，即使清单自报合法也不允许歧义布局 |
| ZIP64、加密、descriptor、extra、comments、分卷 | 拒绝，不尝试降级解析 |
| 目录、symlink、特殊文件、执行/特权权限、危险 DOS 属性 | 拒绝，不执行包内内容 |
| local/central 字段不一致、重复或重叠 offset、孤立 record、前缀/尾部 | 拒绝，连续完整覆盖是准入条件 |
| CRC 错误、清单缺失/夹带/重复 key、BOM/非法 UTF-8/非规范 JSON | 产生 rejected 事实，不保存成功结果 |
| 清单顺序/path/size/mediaType/hash 不符、伪装 PNG 或坏 PNG CRC | 拒绝，扩展名和客户端清单不能代替实际内容核验 |
| raw-deflate 截断、合法流尾随字节、第二压缩流 | **真实 workerd 拒绝**，不是借头部损坏掩盖流消费问题 |
| 实际解包长/短于声明、伪造小声明的 2 MiB 输出、声明膨胀比/总字节超限 | 有界拒绝，不允许无限输出或声明炸弹 |
| 完成审计 ABORT | passed 与成功审计同批回滚，第二次执行恢复，原 policy/次数保留 |
| 持有旧对象时取消、过期租约恢复 | 只能 invalidated 或由新 token 结果获胜，旧执行者不能覆盖 passed |
| 独立批准后的 publish | 仍 409，上传仍隔离；取消立即使版本当前绑定失效 |

格式和常规业务路径在本地 workerd 中执行。确定性取消/租约竞争在 Node 宿主装配同一生产 bundle，D1/R2 仍是真实本地 binding；没有编入生产的故障或认证旁路。

## 打包工具审查与测试限制

工具拒绝真实直属 junction、父目录出根 junction 和非普通文件；两次成功打包输出不同目录且原包不被覆盖。它只浅检查 PNG 头部，坏 CRC 候选仍被 Worker 拒绝，未将打包成功冒充安全通过。

只读审查发现 `lstat/realpath → open` 的本地文件替换窗口，已通过 bigint dev/ino 比对实际打开对象补强，并检查读取后 size/mtimeNs/ctimeNs。确定性宿主文件 API 注入测试实际打开另一目录的文件，断言 **0 次 read、1 次 close**；读取过程中增大文件也拒绝且关闭句柄。该工具仍只用于调用者控制且打包期间不变的目录，不是恶意文件系统沙箱。

当前 Windows 创建真实文件 symlink 返回 `EPERM`，所以**真实文件 symlink 及真实链接竞争没有实测通过**；没有将该失败改成 skip 或隐瞒。真实 junction 与测试宿主注入覆盖了邻近边界，但不能冒充 file symlink 场景的独立运行证明。Worker 内部 ZIP symlink 属性拒绝已在真实 workerd 验证。

独立代理只读复核未发现剩余确定阻断问题，没有自行运行 suite；不把其源码审查描述成独立运行验收。

## 工程审查与有效行数

| 文件 | 本轮有效行数 |
| --- | ---: |
| `src/packages/zip.ts` | 177 |
| `src/packages/paths.ts` | 17 |
| `src/packages/art.ts` | 80 |
| `scripts/art-package-zip.mjs` | 56 |
| `scripts/pack-art.mjs` | 139 |
| `tests/art-package-fixture.mjs` | 87 |
| `tests/art-packages.test.mjs` | 131 |
| `tests/art-package-structure.test.mjs` | 146 |
| `tests/art-package-content.test.mjs` | 106 |
| `tests/art-package-recovery.test.mjs` | 104 |
| `tests/art-package-packer.test.mjs` | 99 |
| `tests/art-package-packer-races.test.mjs` | 82 |
| `src/inspections/object.ts` | 61 → 74 |
| `src/inspections/png.ts` | 96 → 97 |
| `src/inspections/records.ts` | 103 → 105 |
| `src/inspections/routes.ts` | 54 → 67 |
| `src/versions/create.ts` | 64 → 65 |
| `db/0003_inspections.sql` | 30 → 31 |
| `db/0004_versions.sql` | 41 → 42 |
| `scripts/build.mjs` | 91 → 91 |
| `package.json` | 31 → 32 |

没有新大文件、软上限例外或旧大文件增长。逐文件审查包括：输入/路径/清单上限，参数化 SQL，原任务及版本状态所有权，CAS/审计原子性，reader/timer/文件句柄清理，逐条而非全部解包常驻，有界集合，秘密脱敏，失败关闭及性能复杂度。解析最多 33 个条目，路径碰撞最多有界二次比较，不引入新外部服务或生产依赖。

## 未验收与下一项

本轮只支持一个清单加 1–32 张受限静态 PNG；音频、模型、字体、脚本、Capability/应用及任意 ZIP 不在支持范围。ZIP 结构、CRC、SHA-256、PNG 格式和人工批准不是全面恶意内容扫描。

下一项仍为 P3.3 必要内容安全检查的可执行方案与运行限制证明，随后才可完成实际发布/下架；不能以本轮通过开放 format-only 对象。普通 Cloudflare Worker 的真实 CPU/内存峰值、免费套餐承载、账号接入、网络故障、费用和生产部署仍未验收。本地经过时间不等于 CPU 消耗。

没有提交、推送、使用真实凭据、开通付费资源或云部署。旧数据库、历史候选和归档原样保留，674 个已获批历史 tracked 删除标记未重置，未修改 Neuro 根源码或兄弟仓库。最终独立仓库状态、空白检查和所属进程清理见交付核对；无需运行旧 Cargo/Web 工具来证明当前实现。
