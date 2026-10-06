# 原生组件与 OneNote fork 风险复核工作记录

状态：原生组件调查进行中；OneNote 已完成限定入口的技术复核和动态保护探针。
不是已完成的 SBOM、自动漏洞豁免或生产准入。
固定 ClamAV revision 为 `fa59fca15872bb8a914ba4c68188bcc8a502cbdf`。
本轮实际 `.o.d` 输入共 908 个，其中 `/src/` 614 个，C/C++ 实现文件 311 个。

## 已识别的真实内置来源

下列路径相对固定 ClamAV 源码，均有实际编译输入支持；版本头只证明来源线索，
不代表 fork 等同于该上游未经修改的发行版。

| 范围 | 版本/来源证据 | 不能省略的边界 |
| --- | --- | --- |
| `libclammspack/` | README:1、configure.ac:4 为 0.11alpha | ClamAV 有非标准/损坏 CAB 解析扩展 |
| `libclamunrar/` | version.hpp:1–6 为 6.24 | NEWS.md:79–85 记载已回补 CVE-2025-8088；不能仅凭旧版本头断言未修复 |
| `libclamav/7z/` | 7zVersion.h 为 SDK 9.20 | SDK 不等同于完整 7-Zip 产品 |
| `libclamav/nsis/bzlib.c` | 头部声明 modified bzip2 1.0.4 | 与系统 libbz2 是独立实例；620–628 有 selector 边界检查，但尚未完成完整补丁证明 |
| `libclamav/nsis/` zlib | nsis_zlib.h 为 1.1.3，Nullsoft 修改 | 不是系统 zlib，NSIS 精确发行版未确认 |
| `libclamav/inflate64.c` | modified zlib 1.2.3，InfoZip 派生 | 与 NSIS zlib、系统 zlib 分开记账 |
| `libclamav/yara_*` | yara_clam.h 2.1.0；lexer/grammar 来源 3.1.0 | 混合来源，不能伪造单一精确 YARA 版本 |
| `libclamav/regex/` 及部分 libc 片段 | OpenBSD/BSD/Henry Spencer/Berkeley 声明 | 精确上游 release/commit 未确认 |
| `libclamav/lzw/` | Sam Leffler/SGI，Cisco 修改 | 不直接套用任意 libtiff 版本 |
| `libclamav/png.c` | pngcheck 派生 | 不是 libpng 包，基版本未确认 |
| `libclamav/swf.c` | Flasm 派生 | 基版本未确认 |
| `libclamav/textdet.c` | file(1) ascmagic 派生 | 不等同于完整 libmagic 某版本 |

还需覆盖 getopt、AES、tar、BIFF 灵感代码，以及 UnRAR 内部 BLAKE2/PPM/AES 来源。
不能用三项手写组件或 generic PURL 声称这些代码已经被漏洞扫描器识别。
下一步应以全部实际输入为全集分类，未分类、混合来源和版本未知保留为显式缺口；
来源身份与用于发现公告的候选 alias 分开。系统 APK 与 Rust 清单继续独立维护。

2026-10-05 已完成 614 项实际输入的逐项初步分类和原始字节核对，记录为
`linshi/assetlibrary-native-advisories-20261005/native-input-coverage-v3.json`。
此前未分类的 335 项分为：305 项有 ClamAV 主体维护/版权声明、9 项明确第三方关联、
9 项外部算法/思想/参考边界、12 项作者或生成器已知但来源/许可仍需补核。
“已分类”包含显式未知类别，不等于来源或漏洞覆盖完整；没有把无第三方声明当作无第三方代码。

新增遗漏包括 Deflate64 和 bzip2 的关联头文件、LZMA 接口、以及
`libfreshclam_internal.c` 内的 libowfat、MIT UUID 和 curl 示例片段；同一文件允许多个来源。
已知压缩组件的限定公告/补丁核验见 [内置压缩代码复核](P3_EMBEDDED_COMPRESSION_REVIEW.md)。

## OneNote 的进一步实证

2026-10-05 联网读取 [上游官方公告](https://github.com/msiemens/onenote.rs/security/advisories/GHSA-4j5m-wc25-pvh7)。
问题位于 `Parser::parse_notebook` 的目录遍历；公告把单节内存解析列为替代调用方式。
不能因此假设 Cisco fork 与原上游实现完全相同。

为检查实际 fork，从已绑定的材料镜像读取其 vendor 目录，未启动该取证容器；取出
后立即按 owner/image 验证并回收。**125 个文件全部与构建时 vendor 摘要一致**。
证据目录为 `linshi/assetlibrary-onenote-review-20261005`，其中 `extraction-proof.json`
记录全部文件摘要。

实际 fork 的 `src/onenote/mod.rs`：

- 43–77 行的 `parse_notebook` 保留目录拼接/读取逻辑。
- 83–98 行的 `parse_section_buffer` 从内存解析，检查 section schema GUID，再调用
  section 解析；文件名用于元数据/错误信息，不经过目录遍历分支。
- 104–124 行的 `parse_section` 和 126–155 行的 section-group 才包含文件/目录读取。
- fork 的其他源码中，`parse_notebook` 调用出现在自身 group 路径及 CLI bin；本次
  编译记录中的 onenote target 为 library，不包含该 CLI。

ClamAV 的 `libclamav_rust/src/scanners.rs:101–147` 从 fmap 获取字节，再调用
`OneNote::from_bytes`；`onenote.rs:109–157` 调用 `parse_section_buffer`，不是
`parse_notebook`。附件字节传给 `magic_scan`。fork 的 `section.rs:65–85` 只将名称
用于显示名称回退，section 路径不进入 notebook 的目录遍历分支。

### 限定入口的动态保护验证

证据：`linshi/assetlibrary-onenote-boundary-20261005/receipt.json`、
`disposition.json`。使用既有固定材料镜像离线编译独立 Rust 探针，不修改第三方源码，
不重新编译或切换生产 ClamAV。探针镜像中的 125 个 vendor 文件全部与原构建摘要一致；
ClamAV 两个入口源码文件和 Cargo.lock 也与原生构建证据一致，实际构建目标只有库、
没有 `onenote-parse` CLI。

在无网络、只读、非 root、无 capabilities 的独占容器内，四项检查通过：

1. 安装附加 seccomp 过滤器前，真实 section 和 notebook 的文件 API 都可以读取夹具。
2. 禁止文件打开及所列路径查询 syscall 后，两种文件 API 均被内核以 EPERM 拒绝。
3. 相同 section 字节通过内存 API 解析成功；四种名称包含 `../` 和绝对路径，页面内容
   保持一致，只有显示名称按原实现改变。首次探针把显示名称也要求相等，断言失败；
   修正测试为分别核对页面内容和显示名称，没有修改 fork 或放松 syscall 拒绝。
4. 真实 TOC 字节经内存 section API 返回 `Not a section file`，未进入 notebook 遍历。

再次联网读取官方 GitHub 公告，确认漏洞边界仍是 `Parser::parse_notebook`，公告列出
section API 作为替代。结合固定源码调用链、编译目标和上述运行证明，本次技术结论为：
**该漏洞的 notebook 遍历函数不被当前已复核的 ClamAV 集成入口调用。**

这是固定入口对 `GHSA-4j5m-wc25-pvh7` 的限定结论，不是任意输入安全证明。
动态探针是同源码独立二进制，不是对生产 clamscan 的完整动态调用图证明；源码、
vendor、feature、target 或集成入口变化都需要重审。原始漏洞记录和既有风险回执保留，
没有自动生成豁免、改变发布门禁或宣称全部供应链通过。探针所属容器已回收。
