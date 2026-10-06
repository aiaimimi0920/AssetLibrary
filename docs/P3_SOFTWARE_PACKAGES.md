# Capability / 应用包：受限包体与授权分发

## 本轮范围与退出条件

从 `0.3.0-dev.25` 接续资源库侧的 Capability 和应用包字节闭环：本地打包 → 私有上传 → 真实 ZIP/清单/逐文件摘要检查 → 内部扫描调用 → 不可变版本 → 独立审核 → 假设部署准入的本地授权下载、续传和撤销。

当前版本为 `0.3.0-dev.26`。正式账号、原生组件安全风险、网络边界和生产准入继续延期，生产拒绝门禁保持不变。只修改 AssetLibrary，不修改 Loom、Hook 或 Neuro 根仓库，不部署云资源。

## 明确合同

- 资源类型为 `capability` 或 `application`，检查分别使用 `capability-zip-clamav-v1` / `application-zip-clamav-v1`；类型、任务策略和包内 `kind` 必须一致。
- 包头使用 `manifest.json`，schema 为 `neuro-software-package-v1`，包含 `schema`、`kind`、`files` 三个字段。每个文件只包含 `path`、`size`、`sha256`。清单采用 UTF-8 无 BOM 的紧凑 JSON，可带一个尾部 LF；与 Art 同样拒绝重复键和歧义表示。
- 清单与其余 ZIP 条目顺序一一对应，逐个解包核对 CRC、实际大小和 SHA-256；不按扩展名推断安全，不执行、加载或向文件系统展开上传内容。
- 复用受限 ZIP 的连续布局、安全路径、碰撞拒绝、Stored/Deflate、无链接/特殊文件/执行权限/加密/ZIP64 等规则。清单最多 32 KiB，1–32 个非空载荷，每个最多 1 MiB，输入和总解包字节各最多 8 MiB，声明膨胀比最多 100（小于等于 4096 字节的条目仍受绝对大小限制）。
- 这是小型软件载荷的资源库传输封装，不是 Loom 的 `capability.manifest.json` 安装协议。宿主清单、签名等可以作为原字节载荷被绑定，但不会因此取得签名有效、可安装、运行兼容或普遍无害结论。超过当前预算的真实大型应用包仍不支持。
- 本轮不增加扫描器预算、不改变原生运行镜像或安全证明。内部 AV 不可用、拒绝或事实失效均不能保存通过结果；本地演练使用明确标识的合成 AV，不当作新文件类型已完成原生扫描验收。

示意清单（包内必须使用紧凑 JSON，不直接复制展开格式）：

```json
{
  "schema": "neuro-software-package-v1",
  "kind": "capability",
  "files": [
    { "path": "runtime/main.js", "size": 42, "sha256": "64位小写hex" }
  ]
}
```

## 打包与新开发库

在调用者控制的输入目录保存 UTF-8 无 BOM 的 `software-package.json`，显式列出普通文件（recipe 可格式化）：

```json
{
  "kind": "capability",
  "files": ["runtime/main.js", "data/seed.bin"]
}
```

应用包使用 `"kind": "application"`。随后执行：

```powershell
rtk proxy pnpm pack:software C:/path/to/input-directory
```

输出到 `../../linshi/assetlibrary-software-package-*` 的唯一目录，包含 `package.zip`、严格紧凑的 `manifest.json` 和 `package-receipt.json`（类型、策略、长度、SHA-256、文件数）。不会覆盖先前候选，也不会上传。Art 和软件 packer 共用有界普通文件读取，核对 realpath/文件身份/读取前后大小及时间，所有路径均关闭文件句柄。单个文件一致不等于多个源文件的原子快照，输入目录须由调用者控制且打包期间保持稳定。

`dev` 和 `db:local` 改用 `../../linshi/assetlibrary-software-local-v1`。本轮修改新建库 `0003/0004` 的 CHECK 合同；不重放已使用的迁移、不重建已有数据库。`pnpm trial` 每次生成新的独占状态。未来更新现有云部署前须单独设计并授权 Schema 转换，不能只部署新 Worker 或声称历史库已兼容。

## 验证范围

1. 两种类型经真实 Worker/D1/R2 的私有上传、检查、版本和独立审核；错误类型/策略/清单、坏摘要、越界及取消失败关闭，旧 Art 规则不放宽。
2. 假设准入的业务核心和回环本地体验验证同包下载字节、Range、授权撤销、下架及非 owner 权限；普通生产候选保持拒绝。
3. Web 能选择三类资源、自动约束匹配的检查策略，并在真实浏览器中完成两种新包的可见路径。
4. 格式、类型、行数、相关测试、候选摘要和独立 Git 状态检查；只对已验证代码按恢复的用户授权提交推送。

现有开发库、云 D1/R2、原候选和手测进程保留。本轮仅更新新开发库的建表合同；不把新 Worker 直接指向旧 Schema，既有云库升级须另行设计和授权。

## 最终本地收尾（2026-10-06）

恢复会话 `01a11127-5e37-79a1-aaac-6ba8b7ac5d2a` 后完成最后的下载命名修复：浏览器保存与 Worker 的 Content-Disposition 均使用 `package-<versionId>.zip`，不再将 Capability / 应用包标为 Art。新增回归验证非法版本拒绝、成功/失败点击后的链接与对象 URL 回收，以及 Art 和两种软件包的响应头。

最终 `pnpm check`、`pnpm typecheck`、`pnpm sizecheck`、`git diff --check` 和 `pnpm build` 通过；完整 `pnpm test` 为 281 pass / 0 fail / 0 skip。原会话真实页面已完成两种软件包的上传、独立审核、发布、授权与实际下载，并验证撤销确认取消不生效、确认撤销和下架后从普通用户资源库移除。本轮不将原页面证据冒充命名修复后的浏览器重测；命名修复由聚焦与完整自动化回归证明。

所有活动文件通过仓库有效行数 checker；新增模块最大为 233 行（软件包验证测试），本轮修改文件最大为 393 行（Web 编排），没有新增 501–700 行例外。临时证据位于 `../../linshi/assetlibrary-software-packages-20261006/`，最终回执为 `final-delivery.json`。不删除历史数据，不迁移旧库、不更新云环境；本地体验仍为虚构身份、合成 AV 和假设部署准入。