# Loom 原生包闭环

## 目标和当前边界

用户要求的是在 Loom 中发现托管资源、下载、安装并实际执行 Capability / Art Node，不是只保存 ZIP。
本文件从根 `DEVELOPMENT_PLAN.md` 进入，不替代唯一开发计划。当前仍未完成生产闭环。

2026-10-16 已实现平台侧独立原生格式检查和策略，保留旧软件/PNG 素材格式的原语义。
新增策略 `loom-art-zip-clamav-v1`、`loom-capability-zip-clamav-v1` 必须经过同一个真实 AV 调用入口；
Web 上传策略已分别增加“Loom Art Node + ClamAV”和“Loom 能力包 + ClamAV”，旧策略和默认选择保留。
格式检查不会赋予签名信任、安装资格、权限或发布资格。
本地业务测试使用真实 Worker/D1/R2，但 AV 响应和账号是明确的测试夹具，不能算真实扫描或正式发布。

## 原生包合同

- Capability 根清单为 `capability.manifest.json`；Art Node 为 `manifest.json` 和 `art.runtime.json`。
- 不给原包添加平台清单，不重新序列化 JSON，不重排或重压缩上传字节。
- 根类型标记不得混装，保留大小写碰撞、穿越、链接、非标准分隔符等拒绝规则。
- 清单可位于 ZIP 中任意位置，允许原始 JSON 排版；本层只核验容器和类型标记，不代替 Loom 的完整清单和签名验证。
- 保留整包/解包总量 8 MiB、单载荷 1 MiB、根清单 32 KiB、2–33 条目等现有预算。
- Art Node 本切片只接受 `framework_art`；不把工作流 Art 或 PNG 素材自动升级为此类型。
- 安装须由 Loom 复用原有安装器验证签名、发布者、版本和框架；能力权限批准/启用必须与下载安装分开。

## 预检入口

```powershell
node scripts/preflight-loom-package.mjs art C:/path/to/art.zip
node scripts/preflight-loom-package.mjs capability C:/path/to/capability.zip
```

输出至独占 `linshi/assetlibrary-loom-preflight-*`，保留原字节 `package.zip`、SHA-256、文件结构和回执。
该命令不上传、不执行、不授信；回执明确 `scanned/signatureVerified/productionEligible/hostInstallVerified=false`。

## 增量迁移与回滚边界

`0009_loom_native_packages.sql` 在一个事务内复制并替换两个受 CHECK 限制的表，保持列、主键、旧检查条件及索引。
没有修改已上线的 `0003/0004`。当前引用无 `ON DELETE CASCADE`；迁移使用延迟外键检查并恢复检查。
实现遵守 [D1 外键合同](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)；不能跨事务拆开执行。

本地测试先应用 `0001–0008`，建立真实检查、独立审核、发布、成员和票据后：

1. 在迁移末尾注入错误，验证整个事务回滚且所有业务表逐行不变。
2. 正常迁移后逐行比对全部业务表，检查外键和三个重建索引。
3. 重复执行迁移，再次证明事实不变。

尚未迁移任何共享开发库或生产库。生产执行前必须备份并核对数据，取得针对实际线上变更的批准。
迁移扩展后回退应用代码不应删除新类型数据；旧代码不支持新策略，因此不能把回退旧 Worker 当作完整功能回滚。
不要通过逆向缩表丢弃新类型记录。平台级完整恢复方案和线上应用顺序仍需在部署阶段验证。

## 真实包证据

旧 Loom 交付包中的 `custom-image-blend-script.zip` 含反斜杠条目，首次预检拒绝 `ZIP_PATH_INVALID`。
修复位于 Loom 的 `scripts/NativePackageArchive.ps1` 和 `Build-LoomSampleArtPackages.ps1`：
由打包端生成 `/` 路径，保留签名覆盖的文件字节，不让平台容忍歧义路径。

真实样例重新打包后通过结构预检；另用 linshi 内独立测试密钥签名，解压后由现有 `loom-plugin validate` 验证为 Trusted。
这里的信任仅存在隔离测试信任库，不代表正式发布者或当前桌面已信任，也没有修改用户真实信任库。
首次试验使用不匹配 publisher 被正确拒绝，随后改用清单原有 publisher 在隔离信任库重验。

证据目录（相对 `C:/Users/Public/nas_home/AI/GameEditor/linshi`）：

- `assetlibrary-loom-preflight-ChUIzm`：旧包拒绝回执。
- `assetlibrary-loom-preflight-lS3XoS`：实际样例新包结构预检。
- `loom-native-signed-613c6ee3fb4a4564bb054be73af22be4`：隔离签名及解压验证材料；测试私钥不得上传或包含在发布包中。
- `assetlibrary-loom-preflight-3hZwtz`：隔离签名 Art 原字节预检回执。
- `assetlibrary-p3-doPsHf/tests.log`：21 项格式、旧软件/素材及 populated 迁移聚焦回归。
- `assetlibrary-p3-CcWUMM/tests.log`：两类原生业务通过；首轮迁移测试读取 D1 内部元数据被拒绝，已排除内部表后重验通过。
- `assetlibrary-p3-1LDc7T/tests.log`：平台完整本地测试 343 项通过（Web 新策略选项加入前）。
- `assetlibrary-p3-H9MN14/tests.log`：最终 Web 策略、反斜杠拒绝及两类原生业务 12 项聚焦通过。

本轮 TypeScript 类型检查、变更文件 Biome 和两仓库 diff 检查通过；Loom 严格有效行数及依赖安全合同通过。
没有变更依赖或锁文件，本轮没有重跑真实 OSV 扫描；没有重新打包或切换当前桌面 EXE。

## 剩余验收，不能提前标为完成

2026-10-16 后续进展：Loom 已接通管理端下载安装和桌面原生包按钮，复用原安装器而非内置包信任旁路。
两类真实签名包在独占 Worker/D1/R2 上完成上传、合成 AV、独立测试主体审核、发布和授权后，
由 Loom 实际 HTTP 下载、验签安装；Capability 显式批准后真实进程命令成功，Art Node 真实框架执行输出 PNG。
各自撤销/下架后的新下载与安装拒绝，共 6 项联合通过。
最终证据 `linshi/assetlibrary-local-trial-1bhBHn/loom-integration.json` 明确 `nativeFlowPassed:true`、
`syntheticIdentity:true`、`syntheticAV:true`、`hypotheticalDeploymentAdmission:true`、`cloudVerified:false`。
这些结果是本地联合闭环，不是正式账号/真实 AV/生产闭环。实现细节见 Loom `docs/ASSETLIBRARY_NATIVE_INSTALL.md`。

1. Web 新策略的真实浏览器上传检查（选项及传输合同已实现并通过聚焦测试，尚无此增量的视觉/操作验收）。
2. 新桌面包交付及原生 UI 点击验收；本地 daemon 的下载安装和两类真实运行已通过，但当前用户桌面尚未更新为该增量。
3. 当前有效扫描镜像和签名、必要安全/网络验收、同版本云证据与正式 scanner binding。
4. 独立真实审核者配置和审核，正式发布与授权下载；不可自审或伪造审核主体。
5. 线上增量迁移和服务部署，保数据与回滚材料；实际桌面下载、验签、安装、使用及撤销/失败路径。

不得把本地合成扫描、结构预检或隔离信任成功外推为以上任一步骤完成。
