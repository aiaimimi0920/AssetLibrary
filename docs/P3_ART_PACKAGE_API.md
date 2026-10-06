# P3.3a：多文件 Art 归档包检查

## 已确认方向、本轮范围与停止条件

用户明确首期必须支持含多文件的 Art 归档包，不以单张规范化 PNG 替代包体需求。本轮先交付 `art-zip-manifest-v1` 的受限 ZIP 检查和打包工具：生成包 → 私有上传 → 可恢复归档检查 → 版本绑定 → 独立审核。必要恶意内容扫描及正向发布/下架尚未实现，publish 仍失败关闭，不能将结构检查 passed 宣称为整套内容安全通过。

本切片只接收一个清单和多张静态 PNG，不能代表音频、模型、字体、脚本、应用或任意 ZIP 已获支持。后续扩大文件类型及首次允许发布前须另行确定并验收必要检查组合。

退出条件：真实本地 Worker/D1/R2 跑通该包闭环；恶意路径、归档歧义、声明大小、解压炸弹、CRC/摘要/清单不一致、总像素边界和取消/恢复竞争失败关闭；既有 PNG 和版本回归继续通过。

## 包体合同

ZIP 为单卷，使用 Stored(0) 或 Deflate(8)。`manifest.json` 必须为第一个本地文件和第一个中央目录条目；其余文件与清单一一对应，不能漏报或夹带。最多 33 个文件，其中 PNG 1–32 个。

- 输入和声明总解包字节均最多 8 MiB，清单最多 32 KiB，单 PNG 最多 1 MiB。
- PNG 使用已有 RGBA8、非交错、无附加元数据策略，所有图片总像素最多 1,048,576；在解码下一张之前检查剩余像素预算。
- 每个 Deflate 条目的声明膨胀比最多 100，4096 字节以内的条目豁免比值但仍受绝对大小限制；实际解压必须精确等于声明长度。
- 拒绝加密、ZIP64、分卷、data descriptor、extra fields、所有归档/条目注释、目录、符号链接、特殊文件、执行/特权权限和自解压前缀/尾部数据。文件属性只接受 DOS 或 Unix 来源；DOS 低位只允许 read-only/hidden/system/archive，Unix 文件类型只允许普通文件或未标识，不接受设备/volume 标志。
- 中央目录、本地头、文件顺序、偏移、方法、flags、时间、CRC、压缩和解包大小及名称必须一致，所有区间连续且不重叠。
- 路径只接受 ASCII 字母/数字开头的 1–64 字符组件，组件内可含 `.`、`_`、`-`；最多四级且总长最多 180。拒绝绝对路径、反斜线、冒号、空组件、尾随点、`.`/`..`、Windows 保留设备名，以及大小写折叠后的重复名称和文件/目录祖先冲突。

清单 UTF-8 无 BOM，严格 JSON 字段。包内必须是 `JSON.stringify` 的紧凑表示，可带一个尾部 LF；拒绝重复 key、额外空白及数字/转义的歧义表示。这不是 RFC 8785 的通用 JSON canonicalization。以下仅为便于阅读的展开示意，不能直接作为包内清单：

```json
{
  "schema": "neuro-art-package-v1",
  "files": [
    { "path": "sprites/hero.png", "size": 68, "sha256": "64位小写hex", "mediaType": "image/png" },
    { "path": "sprites/enemy.png", "size": 68, "sha256": "64位小写hex", "mediaType": "image/png" }
  ]
}
```

顺序须与 ZIP 中 PNG 顺序一致。大小和 SHA-256 核对实际解包字节，PNG CRC/结构/解压也独立检查；不信任扩展名或清单自报类型。不会向文件系统提取任何归档路径，也不会执行包内内容。

## 检查与版本 API

复用 `POST /v1/uploads/{id}/inspection`，JSON 为 `{ "policy": "art-zip-manifest-v1" }`。省略 policy 仍为既有单 PNG 策略；未知策略拒绝。一份上传仍只有一个不可重置任务，已有任务与请求 policy 不同返回 409，不能用重新申请绕过已消耗次数。

检查仍仅 owner，沿用最多三次执行、两分钟租约、失败退避和同批审计。通过结果包含包 schema、文件数量、总像素和各文件路径、字节数、摘要及 PNG 尺寸，不返回文件字节。版本绑定冻结这份 passed 检查的 id/revision/policy 和上传身份；人工批准及发布资格仍分开。

## 本地打包工具

使用调用者控制、打包期间保持不变的素材目录；该工具不是针对恶意本地文件系统的安全沙箱。输入只读取 recipe 明确列举的文件，不递归抓取目录：

```text
input-directory/
  art-package.json
  sprites/hero.png
  sprites/enemy.png
```

`art-package.json` 使用 UTF-8 无 BOM，内容为：

```json
{"files":["sprites/hero.png","sprites/enemy.png"]}
```

在 AssetLibrary 根目录运行：

```powershell
rtk pnpm pack:art <input-directory>
```

默认生成 Stored ZIP（PNG 已压缩，避免无收益的嵌套压缩），自动填写逐文件 SHA-256 和大小。唯一输出为 `linshi/assetlibrary-art-package-*/package.zip`、规范 `manifest.json` 和 `package-receipt.json`，不覆盖既有候选，不自动上传或批准。将 receipt 的整个包 size/sha256 用于现有上传预留，然后申请 ZIP policy。

工具拒绝直属链接/非普通文件、解析后出根路径，以及打开对象与原检查不一致、读取期间 size/mtime/ctime 变化；文件句柄在退出路径关闭。路径和预算规则与包合同一致。工具只浅查 PNG 头部和像素预算，坏 CRC、PNG 解压和全部内容仍由 Worker 检查；打包成功不等于结构/内容安全检查通过。

## 开发库与旧状态保留

当前尚无云库或生产部署，项目明确不兼容旧开发版本。本轮更新空库 `0003_inspections.sql` 和 `0004_versions.sql` 的明确策略约束，不创建兼容旧 Schema 的泛化迁移框架。手动 `dev`/`db:local` 使用新的 `../../linshi/assetlibrary-p33-local`，旧 `assetlibrary-p1-local` 及此前隔离测试库和候选完整保留，不清空、重置或覆盖它们。不要把新 Worker 指向旧开发库来冒充迁移成功。

## 外部依据与未验收边界

2026-10-04 联网核实 [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)、[OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)、[Cloudflare Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/) 和 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。官方运行时文档列出 deflate-raw 支持，但仍须在实际本地 workerd 实测。

OWASP 明确指出 ZIP 的攻击面多，建议可用时进行 antivirus/sandbox 校验。本轮结构与 PNG 检查不是恶意内容扫描，不据此解除发布门禁。普通 Worker 的 CPU/内存和原生解压内部缓冲仍需云端证据；本地经过时间不等于 CPU，不能承诺免费套餐可承载本策略。
