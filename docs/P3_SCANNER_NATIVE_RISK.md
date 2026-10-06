# P3.3g 受控镜像漏洞与实际编译包关联

本切片在 P3.3f 的同一镜像和不可变构建证明上继续核验，不重编引擎、不启动新扫描
容器、不切换活动镜像或云资源。它缩小漏洞归属的不确定范围，不授予生产安全准入。

## 命令

```powershell
rtk pnpm scanner:native-risk <native-directory> <canonical-Cargo.lock> <trivy.exe> <cache>
rtk pnpm scanner:native-risk --assess <native-directory> <risk-directory>
```

首条命令生成独占 `linshi/assetlibrary-native-risk-*`，重新验证 native receipt 全部
摘要和构建身份，并将待扫描锁文件绑定到实际源码的 Git blob。Trivy 可执行文件按
固定 SHA256 验证；不继承环境中的 Trivy 过滤设置，不使用忽略未修复项或严重性过滤。
完整镜像报告和完整 Cargo 报告分别保存扫描命令、工具身份、漏洞数据库及原始日志。

第二条命令读取现有原始证据并重新评估。报告限六小时、数据库限一天；已生成的
`risk-receipt.json` 不覆盖，文件摘要、原 native receipt 和评估必须一致。未取得
供应链资格时命令保持非零退出，不把有完整报告等同于生产通过；执行或证据错误
另行抛错，也不会写出成功评估回执。回执是本地摘要绑定，不是独立签名证明。

## 实际结果（2026-10-05）

原生构建证据：`assetlibrary-native-build-cNs0V6`。
风险证据：`assetlibrary-native-risk-zuTdIW/risk-receipt.json`。
以上目录均位于 `C:/Users/Public/nas_home/AI/GameEditor/linshi`。

受测镜像：`sha256:4cf20de0adc8e5613939f7db7b8d1addf4ee34ed1989a7d07a448a89917613d1`。

- 完整镜像报告覆盖实际全部 **49 个 APK 包**，逐项匹配名称和版本，所有严重性为零。
  镜像报告只有 Alpine 包结果，不能据此声称静态 Rust、ClamAV、UnRAR 或 clammspack
  都已获得漏洞覆盖。
- 完整锁文件报告覆盖 **291 个 Cargo 包**，精确匹配构建 metadata 中的名称、版本和
  来源；实际 Cargo compiler-artifact 中有 **244 个包**。
- `CVE-2026-46671` / MEDIUM：`onenote_parser 0.3.1` **实际编译**，关联 Cisco Git fork
  `29c08532252b917543ff268284f926f30876bb79`、target、features 以及 `.rlib/.rmeta` 摘要。
  不把同名 registry 的 `1.1.1` 修复版本直接套到该 fork，也不把实际编译自动解释为
  漏洞可达。原 P3.3e 的调用点调查仍只是局部证据。
- `GHSA-cq8v-f236-94qc` / LOW：`rand 0.9.2` 在锁文件中，但**不在本次实际编译包中**。
  原告警完整保留，状态仍为 `review-required`，不是自动豁免或整镜像不受影响声明。

两项告警的 `runtimeAffected` 均为 `not-established`。关联使用完整来源与实际
package ID，不以同名同版本替代 Git commit 校验；没有编译的条目也不删除。

## 保护与后续

新增八项聚焦测试覆盖实际产物关联、未编译告警保留、APK 空/漏/重复/漂移、Git
来源漂移、未知或空编译记录、镜像身份/源码清单漂移、HIGH 保留和零告警不得提权。
抽出的 `assessCargoScan` 保持原 P3.3e 行为，原八项回归在提取前后均通过。

仍需完成原生 C/C++ 组件漏洞覆盖、OneNote fork 调用可达性/修复复核、签名时效、
新引擎 Art ZIP/协议回归及新镜像隔离云验收。daily 28136 的旧库警告未被清除。
`supplyChainValidated`、`cloudValidationEligible`、`publicationEligible`、
`productionReady` 均保持 false；`SCANNER_CLOUD_NOT_VALIDATED` 门禁不变。

本轮 `.11` 是风险核验工具候选，活动运行字节未变；不为文档或审计逻辑变化重复
执行旧 Docker/云样本。最终门禁、源码/产物摘要及候选绑定保存在独立交付回执，
不向已冻结的 native/risk 证据目录追加未绑定文件。交付索引为
`linshi/assetlibrary-native-risk-delivery-20261005/final-delivery.json`。未提交、推送或部署。
