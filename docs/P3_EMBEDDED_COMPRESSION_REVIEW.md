# 内置压缩代码的限定漏洞机制复核

状态：2026-10-05 对固定 ClamAV revision
`fa59fca15872bb8a914ba4c68188bcc8a502cbdf` 的部分已知漏洞逐项核验。
不是全量 CVE 覆盖、任意畸形流安全证明或生产准入；系统 APK zlib/bzip2 与下列内置实例分开。

证据目录：`linshi/assetlibrary-native-advisories-20261005`。其中保存联网读取的 NVD
记录、八份上游/FreeBSD 补丁及下载摘要、固定源码摘要与 `patch-verification.json`。
补丁通过 HTTPS 取得，未声称完成 PGP 签名验证。后续已补充本文记录的限定动态探针，
不是所有压缩器或全部畸形输入均已验证。

## bzip2 1.0.4 modified

范围是 `libclamav/nsis/bzlib.c`、`bzlib_private.h`、`nsis_bzlib.h`，不是系统 libbz2。

| 公告 | 证据与技术结论 |
| --- | --- |
| CVE-2019-12900 | [FreeBSD 公告](https://security.FreeBSD.org/advisories/FreeBSD-SA-19:18.bzip2.asc)及其[补丁](https://security.FreeBSD.org/patches/SA-19:18/bzip2.patch)增加 selector 数量上界。`bzlib.c:620–621` 包含相同检查，且位于 selector 数组写入之前；`NEWS.md:4179–4186` 明确 ClamAV 0.101.4 修复了本内置实例。对应补丁机制已存在，不因 1.0.4 版本头误报未修复。 |
| CVE-2016-3189 | 同一官方公告和补丁把缺陷定位到 `bzip2recover` 的 `outFile` use-after-free；指定内置文件集不包含这个恢复工具。结论仅限此内置实例，不外推系统软件包或所有 bzip2 解析路径。 |
| CVE-2010-0405 | 已从 [bzip2 官方归档](https://sourceware.org/pub/bzip2/)取得 1.0.5/1.0.6，CHANGES 明确关联该 CVE；两个版本的 `decompress.c` 差异增加 run 累积上界及两项表范围检查。当前 `bzlib.c:715–724,825–845` 含相同修复机制；下述 216 项原始解码器动态样本通过。关闭该限定机制的未决项，不把 1.0.4 版本头视为未修复或全部组件安全。 |

### bzip2 run 累积边界的动态验证

证据：`linshi/assetlibrary-native-closure-20261005-041557/bzip2-source-proof.json`、
`bzip2-receipt.json`。三个原始源码/头文件与受控构建的实际输入摘要逐项匹配；
完整解码实现未改写，项目头适配仅提供有界 malloc 和原样 `UNUSEDPARAM` 宏。
首次编译因适配头遗漏该宏失败，补齐后通过；第三方状态机的 fallthrough warning
原样保留，没有修改解码器或关闭 sanitizer。

使用既有材料镜像断网编译，在无网络、只读、非 root、无 capabilities、512 MiB/
1 CPU/16 PID/40 秒限制的独占容器执行 AddressSanitizer 和 UndefinedBehaviorSanitizer，
并启用泄漏检查。真实 NSIS 字节流经公开解码 API，覆盖 fast/small 两种模式及整块/
逐字节输入：8 项正常输入输出匹配、32 项块长度限制拒绝、176 项 run 溢出保护拒绝。
22–32 个连续 RUNA/RUNB 的四种排列在 `N=2097152` 且任何块写入之前失败关闭；
保存态、零输出和 End 清理均有断言，没有 sanitizer 报告或 OOM，所属容器已回收。

这是固定源码的完整解码器独立测试，不是生产 clamscan 二进制或整个 NSIS 容器解析链
的动态证明；未枚举全部输入，也不为其他压缩组件或公告生成自动豁免。

## NSIS zlib 1.1.3 modified 与 Deflate64

NSIS 的实现入口为 `nsis/infblock.c` 中 `nsis_inflate`；Deflate64 为
`inflate64.c`，与 `inflate64_priv.h`、`inffixed64.h` 一并审查。
它们不是完整的上游 zlib 发行包，下面的“不适用”只针对具体漏洞函数或机制。

| 公告 | 本地源码证据 | 限定结论 |
| --- | --- | --- |
| CVE-2005-2096 | `inflate64.c:935–943` 为 `left > 0 && (type == CODES || max != 1)`，与 [FreeBSD 修复](https://security.FreeBSD.org/patches/SA-05:16/zlib.patch)匹配 | Deflate64 含对应不完整 Huffman 树修复；不代表所有树组合已验证 |
| CVE-2016-9840 | `inflate64.c:986–1001,1022–1028` 使用 `match` 和索引减法，没有 `base/extra -= 257`；与[作者补丁](https://github.com/madler/zlib/commit/6a043145ca6e9c55184013841a67b2fef87e44c0)匹配 | Deflate64 含对应修复；NSIS 为不同的 `huft_build` 实现 |
| CVE-2002-0059 | `nsis_zlib.h:136,150–151` 将 `t_blens`、`hufts`、`window` 内嵌；没有原动态 `blens` 释放链；`inflate64.c:808–817` 为独立 state/window 清理 | 指定实现没有原版 1.1.3 的 `blens` 双重释放路径；不是宣称版本已升级 |
| CVE-2016-9841 | `inflate64.c:619–624` 的 `inflate_fast` 调用整段被注释；NSIS 没有该实现或调用 | 不进入[该补丁](https://github.com/madler/zlib/commit/9aaec95e82117c1cb0f9624264c3618fc380cecb)对应的 fast-path |
| CVE-2016-9842 | 指定内置文件集没有 `inflateMark` | 不存在[负数左移补丁](https://github.com/madler/zlib/commit/e54e1299404101a5a9d0cf5e45512b543967f958)对应函数 |
| CVE-2016-9843 | 指定内置文件集没有 `crc32_big` | 不存在[指针预减补丁](https://github.com/madler/zlib/commit/d1d577490c15a0c6862473d7576352a9f18ef811)对应函数 |
| CVE-2018-25032 | 两份实现只有解压路径，没有 deflate/trees 压缩实现 | 不存在[压缩端缓冲区补丁](https://github.com/madler/zlib/commit/5c44459c3b28a9bd3283aaceab7c615f8020c531)对应路径 |
| CVE-2022-37434 | 没有 `inflateGetHeader` 或 `state->head->extra` 的 gzip extra-field 输出逻辑 | 不存在[该修复](https://github.com/madler/zlib/commit/eff308af425b67093bab25f80f1ae950166bece1)对应接口/路径 |
| CVE-2005-1849 | `inflate64_priv.h:83–84,193` 使用修复后 `ENOUGH=2048`、`MAXD=592` 和 `codes[ENOUGH]`；`inflate64.c:1014–1016,1081–1084` 有容量检查 | 对应常量修复及下述当前参数表空间上界验证已完成；不扩写为整个解压器安全 |

### Deflate64 表空间边界的后续验证

`inflate64_priv.h:60–61` 定义 `PKZIP_BUG_WORKAROUND`，使
`inflate64.c:518–523` 的 `nlen > 286 || ndist > 30` 检查被预处理跳过。
因此不能直接套用标准 Deflate 的 286/30 个符号上限。本轮按实际位字段证明：

- `inflate64.c:511–517` 的最大值为 `nlen=288`、`ndist=32`、`ncode=19`。
- `inflate64_priv.h:191–193` 的 `lens[320]` 容纳 288+32；`work[288]` 被三个建表
  调用分别使用，不要求把长度和距离符号数相加。
- `inflate64.c:863–878` 的长度基表 31 项覆盖符号 257–287，距离基表为 32 项；
  `CODELENS` 的字面长度小于 16，重复项复制已有长度或零，最大码长为 15。
- 建表参数实际为 LENS root=9、DISTS root=6；CODES root=7、最大码长为 7。
  `state->next = state->codes` 在长度/距离表建立前重置，CODES 表不与它们累加。

联网取得 zlib v1.3.1 对应固定提交 `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf`
的 `examples/enough.c`，检查其算法范围后，以既有材料镜像离线编译并实际运行：

| 参数 | 枚举范围 | 最大表项数 |
| --- | --- | --- |
| `288 9 15` | 2–288 个符号的全部有效完整前缀码，15 位长度限制 | 854 |
| `32 6 15` | 2–32 个符号的全部有效完整前缀码，15 位长度限制 | 594 |
| `19 7 7` | 2–19 个符号的全部有效完整前缀码，7 位长度限制 | 128 |

工具只枚举码长分布，不需要逐项枚举符号排列；排列不改变该二级表布局的空间消耗。
最大组合为 **854+594=1448 < 2048**。`MAXD=592` 确实小于距离最大值 594，
但当前长度实际最大值远低于 `ENOUGH-MAXD=1456`，因此没有导致当前数组不足。
不能将此处的 592 当成 Deflate64 的精确距离上界；参数或算法变化需要重做证明。

进一步从固定源码逐字节提取实际 `inflate_table` 函数，不修改算法，以 GNU99 编译
独立探针。16 组全部最大值向量分别得到 854/594；连续建立两表得到 1448。
12 项零符号、单符号、不完整与过度订阅树检查符合当前函数合同。表前后、work 前后
及未使用表尾的哨兵均保持原值。初次使用编译器默认语言标准时，旧式函数声明触发
`-Werror`；改用支持原源码的 `-std=gnu99` 后仍保留 `-Wall -Wextra -Werror`，未改源码。

证据：`linshi/assetlibrary-deflate64-boundary-20261005/receipt.json`、
`direct-receipt.json`、`extraction.json` 和三份枚举日志。所有探针无网络、只读、非 root，
有内存/CPU/PID/超时限制，所属容器均回收。独立函数探针未使用 sanitizer，也不是对
生产 clamscan 的完整解压链测试；它关闭的是当前建表参数的容量疑点。

此外仍需完整公告发现范围、其他实际内置组件及当前调用图的补充核验。本文没有改变
`supplyChainValidated`、`cloudValidated` 或发布门禁，也没有隐去原始告警。
