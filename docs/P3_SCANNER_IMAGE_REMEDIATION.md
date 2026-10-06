# P3.3d 扫描镜像修复与覆盖边界

后续 P3.3e 已实现固定构建来源与 Cargo 源码依赖核验，证实官方 SBOM/材料仍有缺口，
见 [源码依赖核验](P3_SCANNER_SOURCE_AUDIT.md)。本文 APK 通过结论不扩展为供应链准入。

2026-10-05 UTC，版本 `0.3.0-dev.8`。本次完成官方同版本镜像变体切换、实际解析库
与 APK 漏洞覆盖门禁、本地验证及最终候选交付。没有生产发布、云端激活或实际回滚。

## 原因与最小修复

P3.3c Debian 镜像完整报告中的 237 个 package/advisory 条目属于旧镜像事实。
实际 `clamscan` 链接的 libxml2 基于 2.9.14；不能因版本字符串前缀或 Debian 的
`Minor issue` 备注把 Trivy CRITICAL 自动降级，也没有证明受限 Art 输入可利用它。

采用官方同版本 ClamAV 1.5.4 的 Alpine 变体，而不是混装 Debian unstable、自制
兼容链接或关闭 XML 检查。固定基础镜像 digest：

```text
sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0
```

固定发行版包：`nodejs=24.18.1-r0`、`libxml2=2.13.9-r2`、`pcre2=10.49-r0`、
`nghttp2-libs=1.70.0-r0`。Node 与依赖使用同发行版 musl，不再复制 glibc Node。
保留 APK 包元数据和签名验证；无 `apk del`、忽略漏洞或非可信仓库绕过。

2026-10-05 03:43 UTC 再次联网核对：

- [Debian 官方 CVE 记录](https://security-tracker.debian.org/tracker/CVE-2026-6653)
  仍将旧 trixie 包标为 vulnerable，并注明上游修复已包含于 v2.11.0。
- [Alpine 3.24 官方安全库](https://secdb.alpinelinux.org/v3.24/main.json)
  包含上述 libxml2、PCRE2、nghttp2、Node 修复包记录。

这是通过替换发行版/组件消除旧运行图风险，不声称逐项给 237 个 Debian 条目回补补丁。
新镜像 `ldd clamscan` 确认仍加载 `/usr/lib/libxml2.so.2`，无 missing/relocation 错误。

## 防止空报告误放行

新增 `scripts/scanner-image-environment.mjs`，只对本轮所属的只读、无网络容器执行
固定无 shell 命令，读取 OS、Node、全部 APK、实际二进制 SHA-256 和链接库。

完整 Trivy 保留所有严重性和未修复项，新增 `--list-all-pkgs`；必须识别 Alpine
3.24.2，且报告中的全部包名/版本与容器内 APK 清单逐项一致。缺包、空清单、重复包、
版本/OS 漂移、过期发行版、实际链接失败均拒绝，不以零漏洞条目代替覆盖证明。
HIGH/CRITICAL/UNKNOWN 阻断规则、空 ignorefile、清空 TRIVY_* 环境过滤保持不变。

## 真实结果与证据身份

原始受测候选：`../../linshi/assetlibrary-p3-1t3XED`。
原始检查与上游资料：`../../linshi/assetlibrary-libxml2-20261004-200241`。
恢复及最终交付索引：`../../linshi/assetlibrary-p33d-resume-20261005T0342Z`。

```text
imageId: sha256:eb16d133b33f3e20e1c7f2be074f3e884085403cf73a69285823f306de20fb78
signatureRefresh: 2e8f2059-7040-4b2a-9f43-3ff7ce92ed61
dailyVersion: 28143
```

- 完整 Trivy 0.75.0 报告覆盖实际全部 **49 个 APK 包**，本次各严重性条目均为 0。
  不是只筛可修复项，不等于没有未知漏洞或所有二进制都已覆盖。
- 原始真实无网络 Docker **10 场景通过**，包括双 PNG ZIP、Stored/Deflate EICAR、
  解包上限、格式先行拒绝、断开后恢复及真实 Worker/D1/R2 版本批准后发布拒绝。
- 有效 PNG 像素中嵌入 EICAR 未被该签名识别，仍保留为能力限制；不能称该场景证明
  PNG 内部恶意内容检测。输入格式和资源预算没有放宽。
- 原始 **30 项聚焦通过**。首次直接调用漏设 `ASSETLIBRARY_BUNDLE` 的失败记录保留；
  使用正确已构建 bundle 后 exit 0、30/30。最终验证绑定真实 bundle，不掩盖首次错误。
- 恢复前逐项验证 **114 个源码文件、22 个原候选产物**与原运行记录一致，镜像仍在；
  **200 个既有容器 ID** 完全一致，没有所属容器残留，不启动重复 Docker 构建或扫描。
- 签名刷新实际执行，但版本仍为 28143。Alpine 基础及更新路径产生的 CLD 字节摘要与
  旧候选可能不同；不能将摘要变化称为新签名版本，也没有实际签名发布/回滚。

最终 Worker dry-run 构建单独交付并核验当前源码，运行模块/Dockerfile 必须与原受测
候选字节一致才复用 Docker/漏洞证据。最终路径、检查日志和全部摘要见恢复目录的
`final-delivery.json`，随包 `delivery-provenance.json` 与 `delivery-verification.json`。

## 逐文件审查与行数

本次镜像切片新增环境模块 93 有效行、测试 105 行、夹具 28 行；相关修改后
`scanner-local.mjs` 166、`scanner-release-policy.mjs` 130、`scanner-release-tools.mjs`
67、`verify-scanner.mjs` 184、release-policy 测试 179 行。无新增超标模块。
恢复收尾只同步文档，不新增业务行为；formatter、typecheck、行数和两仓库
`git diff --check` 以最终回执为准。

安全审查确认：固定 digest/包版本、保留包管理可信验证和元数据；运行时非 root，
签名只读，更新仅构建期联网；环境探测无动态 shell，清单和实际镜像身份相互绑定。
本轮没有修改输入解析、并发、取消或资源预算。只读子代理因上游 503 未执行，
不能声称独立代理审查通过，源码与回执由主代理核验。

## 尚未关闭的生产边界

`candidateEligible:true` 只允许进入后续验收；六小时构建/报告、24 小时漏洞库与
签名寿命门禁仍在，不能永久复用历史绿色结果。原候选最早到期时间为
**2026-10-05 09:12:25.753 UTC**，到期后实际激活前必须重新构建/扫描和评估。

1. **ClamAV 非 APK 二进制供应链**：官方镜像自行编译的 ClamAV/libclamav 不是 APK
   管理的包。记录其真实 SHA-256、版本和上游来源不等于完成全部漏洞/SBOM 覆盖。
   发行版 Node 已纳入 APK，但不能声称 OS 包扫描覆盖所有内嵌依赖或零日风险。
2. **新镜像隔离云验收**：云里保留的旧 Debian 镜像及旧九场景证据没有改动；不得将
   旧云结果外推为新 Alpine 镜像已验证，Registry manifest/config 关联仍须重做。
3. **签名实际切换/回滚**：未安装自动更新任务，未运行真实切换/回滚，不能退回旧漏洞
   镜像来制造回滚通过。候选时效和逐库防倒退门禁不能绕过。
4. **云资源/出站/底层清理与发布事务**：仍需补充证明并实现成功发布/下架；生产
   `SCANNER_CLOUD_NOT_VALIDATED` 保持硬拒绝，未开放下载。

当前 `cloudValidated:false`、`publicationEligible:false`、`productionReady:false`。
没有提交/推送、外部资源变更、套餐升级、DNS 修改或删除历史数据/镜像。
