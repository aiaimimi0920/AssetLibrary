# P3.3h 受控引擎的实际扫描服务与签名更新

本轮将 P3.3f 的真实安装归档接入 scanner 服务，复用已有真实业务验收，不停留在
clamscan 命令行 smoke。目标仍是完整 P0–P6；本切片不能代替 P3 发布/下架或后续阶段。

## 构建与重新核验

```powershell
rtk pnpm scanner:release <trivy.exe> <cache-directory> <native-build-directory>
rtk pnpm scanner:assess <controlled-runtime-candidate> <previous-candidate>
```

不传第三个参数时保留原官方候选行为；传入时先重新核验 native receipt、全部证据
摘要和构建身份，再把 `install.tar` 放入独占候选。候选使用单独的
`scanner/native-runtime.Dockerfile`，不改活动 `scanner/Dockerfile`。

构建在 freshclam 前安装受控产物；每次签名刷新有唯一 cache-bust 标签。五项运行
二进制必须匹配原安装清单，含 libfreshclam 和两个 UnRAR 库，不能混用官方旧引擎。
安装归档、native 来源摘要、配方、运行结果和清理均由 manifest/release 回执绑定。
重新评估也会检查运行二进制与安装摘要，而不是只信先前的 passed 文案。

### `.13` 运行身份绑定修复

复核发现旧检查允许某个引擎项上报另一个合法安装文件的路径/摘要；把所有五项均
报告为 clamscan 时，旧函数错误接受。本次先以回归测试复现，再改为从所要求的
安装项开始解析清单中的链接链，运行报告的 realpath 必须与期望终点完全一致，
之后才比较终点摘要。即使重新绑定报告文件摘要，UnRAR 也不能被 clamscan 身份替代。

解析限定当前安装配方实际使用的同目录文件链接，支持相对文件名或同目录规范绝对路径。
目录中间组件、`.`/`..`、路径逃逸、悬空、循环、非法类型、link/hash 混合记录均拒绝。
最多检查 16 个安装节点，避免长链无界执行；不把词法路径折叠冒充通用 POSIX realpath。
当前真实安装清单最多两跳，冻结运行证据在新检查下仍通过。

该修复作用于构建/验证工具，Worker、scanner 运行代码及镜像配方没有变化。
未将五项身份核对扩写为全部原生组件已安全，也未解除供应链、云或发布门禁。

### `.14` 补齐原生构建核验入口

继续复核发现 `assessNativeProof` 仍使用旧的“报告路径存在且摘要相同”检查，没有
复用 `.13` 的严格安装项解析。新增两个回归测试在旧实现上均报告
`Missing expected exception.`：合法 clamscan 身份可以替代其他引擎，报告的合法
终点也能掩盖悬空、循环或含中间目录的安装链接。

将既有严格算法提取到 `scripts/scanner-native-installation.mjs`，原生构建核验、
候选运行、发布重新评估共用同一入口；候选装配模块只负责复制和绑定材料。
未改变安装解析规则或运行代码。冻结的真实原生构建通过新检查，保留 1,438 个
源码文件、908 个原生输入及 36 个安装项的原结果，无需重编引擎。
本轮证据和限定结论见 [原生安全复核补充](P3_NATIVE_SECURITY_CLOSURE.md)。

## 已执行结果

2026-10-05 运行候选：`linshi/assetlibrary-p3-iIAqT0`。

镜像：`sha256:0a15d0fc6812ffaf6ba06b47ffa24a8e38bce6ea3a09d01e1052a14ff82fac0d`。
原生安装来源仍为 `assetlibrary-native-build-cNs0V6`，没有重编 C/C++/Rust 引擎。

- freshclam 确实将 daily **28136 更新到 28143**；main 63、bytecode 339 保持最新查询
  结果。这里是新独占镜像中的真实更新，不是活动云服务的切换或回滚。
- 十项真实本地场景通过：双 PNG Art ZIP、无 UTF-8 标志的 ASCII 路径、Stored EICAR、
  最后一个 Deflate 条目的 EICAR、展开超限拒绝、PNG 像素样本的检测边界、伪装 PNG
  格式拒绝、Worker/D1/R2 检查→版本→独立批准→发布拒绝、HTTP 断开及其后的恢复。
- 版本批准后 publish 仍为 `409 SCANNER_CLOUD_NOT_VALIDATED`，事件仅 created/approved。
- 完整镜像报告覆盖实际 49 个 APK 包，本轮报告没有漏洞条目。
- 五项受控运行二进制全部与安装结果相符；临时目录为空，所属容器已回收。
- 与此前 daily 28143 候选比较，时效和三库防倒退重新评估通过。不能据此宣称完成
  一次活动服务的版本切换、回滚或云验收。

`candidateEligible:true` 只表示这一候选通过既有镜像/时效/本地运行准入；
`publicationEligible:false`、`cloudValidated:false`、`productionReady:false` 不变。
原生 C/C++ 补充覆盖与 OneNote fork 风险仍需独立完成，不能被 APK 零告警替代。

## 整体目标的真实停点

P3 剩余：原生组件及 fork 风险复核、新镜像隔离云/资源边界验收、真实切换回滚，
然后实现必要条件满足后的发布/下架。P4 授权分发、P5 最小 Web 和 P6 全业务云验收
均仍属于总目标，未被本轮缩减或宣布完成。提交、推送、云变更和真实身份配置遵守
各自授权边界，不借“完成整个计划”绕过安全门禁。

调查入口：`docs/P3_NATIVE_COMPONENT_REVIEW.md`。最终当前源码候选可绑定本轮已冻结
运行证据，但必须逐项匹配 Worker、scanner 配方/代码和安装归档字节；不因文档和
重新评估检查变化重复运行已通过的同字节镜像场景。
