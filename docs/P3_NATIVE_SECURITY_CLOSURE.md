# 原生安全复核补充：安装身份入口与 bzip2 已知机制

日期：2026-10-05 UTC；当前代码版本 `0.3.0-dev.14`。
本轮继续 P3.3h 之后的未决安全项，不改变整个 P0–P6 计划的退出条件。

## 完成的两项

1. 原生构建核验补用严格安装身份边界。先复现两个错误接受，再将 `.13` 已有算法
   提取为共享 owner，构建核验和候选运行/重新评估都不能用其他合法文件替代指定引擎。
   详见 [受控运行记录](P3_CONTROLLED_RUNTIME.md)。
2. 内置 NSIS bzip2 的 `CVE-2010-0405` 完成官方修复差异对应和 216 项原始解码器
   sanitizer 样本；run 上界保护在累积溢出及块写入前拒绝输入。
   详见 [压缩组件复核](P3_EMBEDDED_COMPRESSION_REVIEW.md)。

证据目录：`../../linshi/assetlibrary-native-closure-20261005-041557`（相对仓库根）。
`before-tests.log` 保留 12 通过/2 失败；`after-tests.log` 为 27 通过/0 失败/0 跳过。
`bzip2-source-proof.json` 绑定官方归档和三个实际编译输入；`bzip2-receipt.json` 绑定
探针/镜像/运行日志/清理。最终门禁及候选身份记录在同目录 `final-delivery.json`。

## 验证和复用边界

原生构建的冻结证据通过当前更严格的 `scanner:native-assess`，保留旧回执且不重新
写入通过结论。`scanner-native-installation.mjs` 是纯身份核验；Worker、scanner
服务、镜像配方、安装归档和数据库均不因这次修复变化。

最终 Worker dry-run 候选绑定当前活动源码；仅在运行产物逐项与已测候选相同后复用
十项真实 Worker/D1/R2/scanner 业务证据。源映射只允许其输出目录改变，Wrangler
生成说明只允许构建时间改变，不把工具或文档变化作为重编引擎的理由。

## 仍未完成

- 原生其他内置组件的完整公告发现和风险归属；分类包含显式未知，不是完整安全覆盖。
- 新受控镜像的隔离云/资源和网络边界验收、实际签名切换回滚。
- P3 正向发布/下架、P4 授权下载、P5 用户入口、P6 真实身份与完整云业务验收。

`supplyChainValidated`、`cloudValidated`、`publicationEligible` 和 `productionReady`
均未因此变为 true；没有自动豁免、活动镜像替换、云变更、提交或推送。
