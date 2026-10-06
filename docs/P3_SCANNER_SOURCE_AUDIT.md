# P3.3e 上游来源与源码依赖核验

2026-10-05 UTC，版本 `0.3.0-dev.9`。本轮完成可重复的公开上游来源/源码依赖核验，
没有修改扫描镜像、输入策略、资源预算、业务 Worker 或云资源。不是完整运行二进制
SBOM 交付，不能据此开放云验收或生产发布。

## 可执行入口与真实链路

```powershell
rtk pnpm scanner:source-audit <scanner候选目录> <trivy.exe绝对路径> <Trivy缓存目录>
```

候选须有 `scanner/release.json`，原始文件完整且仍通过 APK/签名/时效检查。命令：

1. 复核原候选，读取固定 digest 的官方 ClamAV 基础镜像；不信可变 tag。
2. 从 registry 查询附带 OCI provenance，经 wrapper 的 material digest 追到实际
   compiler image；两份记录必须同为 Cisco 官方仓库、同一完整 Git revision。
3. 从该固定提交下载 Cargo.lock，并与 GitHub Contents API 返回的内容和 Git blob
   SHA-1 双重匹配，另记 SHA-256；不只信版本号、文件名或 source 标签。
4. 只扫描独占目录中的该锁文件，固定 Trivy 0.75.0 及其可执行文件摘要，空配置/
   ignorefile，移除继承 TRIVY_* 过滤，保留所有严重性与未修复项。
5. 扫描报告必须与锁文件全部包名/版本逐项匹配，并保留 registry、Git 提交和
   workspace 身份；缺包、重复、模糊来源、过期报告/漏洞库均失败关闭。
6. 生成独占 `linshi/assetlibrary-source-audit-*` 回执，绑定候选镜像、源码、命令和
   所有证据摘要；不覆盖旧候选，不执行上游源码或安装包。

供应链覆盖未证明时 exit 2，外层 pnpm/RTK 可能归一化为 1。这与命令执行错误分开：
完整回执中有具体 blockers，不把“生成了报告”称为准入成功。该源码工具本身无授予
运行二进制准入的分支；即使补上组件名称，也不能代替真实构建/运行材料验证。

## 本轮联网核验事实

已查询的官方镜像链：

```text
wrapper: sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0
compiler: sha256:7769870154c74ce31b0047dd8771e81f7c4269278bc005782e9e419e4922c73d
source: https://github.com/Cisco-Talos/clamav.git
revision: fa59fca15872bb8a914ba4c68188bcc8a502cbdf
Cargo.lock Git blob: 61c7f8a0f2890afd5736f80adc1543bb91db0c52
Cargo.lock SHA256: 4d1d83e531d18e793f348db5a4baa6ec8c5d14345a285eb6959fcd4af12e1e28
```

固定提交是官方 ClamAV 1.5.4 release-prep 合并。registry 关联来源不是本轮完成了
独立发布签名验证或可复现构建；工具明确 `independentSignatureVerified:false`。

官方镜像 SBOM 是 SPDX 2.3，含 42 个包，但没有 ClamAV/clammspack 组件条目；
compiler provenance 的 `completeness.materials` 为 false。不能将这份文件的存在
当作原生引擎覆盖完整，也不能直接使用基础镜像旧 SBOM 替代应用镜像的 49 个 APK。

源码锁文件共 **291 个包**：288 个 registry、2 个固定 Git、1 个 workspace。全部与
Trivy 包清单匹配。补充报告：UNKNOWN/HIGH/CRITICAL 0，MEDIUM 1、LOW 1。

| 公告 | 包及来源 | 结果边界 |
| --- | --- | --- |
| `CVE-2026-46671` | `onenote_parser 0.3.1`，Cisco Git fork `29c08532252b917543ff268284f926f30876bb79` | 原始 MEDIUM 保留；不能把同名 crates.io 修复版本直接套到 fork 或声称已证实可利用 |
| `GHSA-cq8v-f236-94qc` | registry `rand 0.9.2` | 原始 LOW 保留；涉及自定义 logger 与 `rand::rng()` 的条件，未做完整运行可达性证明 |

已联网核对 [OneNote 官方公告](https://github.com/msiemens/onenote.rs/security/advisories/GHSA-4j5m-wc25-pvh7)
及修复：问题涉及 `Parser::parse_notebook` 解析 `.onetoc2` 后访问目录外文件。固定
ClamAV 提交的 `libclamav_rust/src/onenote.rs:109-157` 调用的是
`parse_section_buffer`，这也是公告列出的替代接口。该单一调用点证据不等于整个
最终二进制不存在其他调用，更不生成漏洞豁免或删除报告。

Alpine 3.24 的发行版 ClamAV 包当前为 1.4.6，而不是现用 1.5.4。本轮没有为了让
ClamAV 出现在 APK 清单中暗中降级引擎，也没有给官方二进制伪造包管理元数据。

## 检查与资源边界

新增 8 项聚焦覆盖完整清单、来源/提交漂移、内容和 Git blob 篡改、过期/隐藏结果、
Git fork 告警归属、源码不能授予运行准入、非预期网络位置、错误/超限响应主动取消。
工具不启动容器；网络请求限公开 GitHub 主机、HTTPS、无重定向、无本机凭据，
响应最多 2 MiB/45 秒；registry 输出最多 8 MiB/90 秒，Trivy 有独立超时和日志。

新增模块当前有效行：source-audit 109、source-policy 136、source-tools 116；测试
以最终 checker 为准，均低于 250 行。源码检索/构建白名单不包含 `old/`，上游锁文件
只保存在证据目录，既不是 AssetLibrary 的新 Cargo 工作区，也不触发旧 Rust 流程。

调查材料和最终交付索引：`../../linshi/assetlibrary-supply-chain-20261005T0353Z`。
正式命令生成的完整回执位于其打印的 `assetlibrary-source-audit-*`，最终随包保留。
最终 Worker 候选需复核运行模块与 `.8` 相同后才复用十项 Docker 证据；不重复镜像
构建或旧云样本，最终检查数量和路径见 `final-delivery.json`。

## 当前真正的下一步

本轮已将“非 APK 覆盖未知”收敛到三个可观察缺口：

```text
SOURCE_SCAN_NOT_RUNTIME_DEPENDENCY_PROOF
NATIVE_COMPONENTS_MISSING_FROM_UPSTREAM_SBOM
UPSTREAM_BUILD_MATERIALS_INCOMPLETE
```

下一步应受控构建同版 ClamAV：固定并记录实际编译输入/锁文件解析和 Git 依赖，
将 C/C++、vendored 及静态 Rust 依赖与最终 ELF/镜像摘要绑定，执行相应漏洞检查，
而不是继续对同一 APK 报告做重复证明或手写一份未验证 SBOM。验证通过后再进入
新镜像隔离云验收、签名切换/回滚及云沙箱边界证明。

`supplyChainValidated:false`、`cloudValidationEligible:false`、`publicationEligible:false`、
`productionReady:false`。业务 `SCANNER_CLOUD_NOT_VALIDATED` 硬门禁不变。没有提交、
推送、生产发布、云激活、自动更新或清空数据；整项 P3 仍未完成。
