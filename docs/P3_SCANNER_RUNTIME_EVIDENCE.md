# 扫描候选十场景的原始事实核验

日期：2026-10-05 UTC；代码版本 `0.3.0-dev.15`。
这是 P3 候选重新评估的缺陷修复，不是 P3 退出、生产准入或全部开发完成。

## 已复现的缺陷与修复

旧 `assessScannerRelease` 只要求十条案例记录，并检查其中两项 clean。
其余八条即使是占位、EICAR 未命中、预算错误或业务审核失败，也没有被重新核验。
旧单元夹具确实以八条 `case-*` 占位取得候选资格。修复前新回归为一通过、四失败，
均保留 `Missing expected exception.`；不能把这个问题描述成生产发布旁路，生产门禁原本也未开放。

`scripts/scanner-runtime-policy.mjs` 成为十场景事实核验的单一 owner：

- 十个已定义名称每个恰好一次，拒绝占位、重复、未知和缺失；断开恢复必须在中止之后。
- 三项正常扫描和 Stored/末项 Deflate 两项 EICAR 核对状态、正确 verdict、独立输入摘要/
  大小、协议/引擎、实际加载的三库身份及扫描期限。
- 展开超限必须是 `422 SCANNER_ZIP_BUDGET_INVALID`，不再以任意 503 当作预算通过。
- PNG 像素 EICAR 仍保存“不是检测证明”的边界；伪 PNG 必须由格式门禁拒绝且无 AV 调用。
- 实际双 PNG 检查结果必须绑定当前对象；版本必须经过独立批准，保存创建/审核/发布
  HTTP 状态、审核后与拒绝后的版本、实际审计事件。拒绝后版本不变且事件只能为 created/approved。
- 主动断开记录宿主 HTTP timer 是否真的触发，不把连接失败/超时折算成 ABORT 成功。
  恢复后检查临时目录和容器内 clamscan 进程均为空。

这些 JSON 是可编辑的本地原始证据，不是不可伪造的签名授权。现有 manifest/release
摘要链仍逐项校验；核验函数不提供云或发布开关。

## 生命周期和兼容边界

容器取证移入 `scripts/scanner-runtime-inspection.mjs`，由宿主通过 stdin 在独占
Linux 容器执行，不加入生产镜像；最多枚举 64 个进程，读取失败除 ENOENT 外均拒绝。
没有修改 ClamAV 参数、生产 scanner 代码、安装归档、数据库或活动云镜像。
fixture 销毁用嵌套 finally 保证容器清理仍被尝试；新增三项失败/正常收尾回归，清理错误仍报告失败。

旧 runtime 缺少独立输入摘要、审核/审计、实际中止及进程清理字段，必须被新门禁拒绝。
不得回填猜测事实或修改旧回执。当前开发期不维护旧候选证据兼容，真实新合同需重新运行。
本次主动中止加恢复和最终进程快照，仍不是每个时刻的完整进程调用图或所有清理路径的证明。

## 验证入口

```powershell
rtk proxy node --test tests/scanner-runtime-policy.test.mjs tests/scanner-release-policy.test.mjs tests/scanner-release-proof.test.mjs tests/scanner-native-policy.test.mjs tests/scanner-native-runtime.test.mjs
rtk pnpm test scanner-policy.test.mjs scanner-deadlines.test.mjs scanner-limits.test.mjs version-consistency.test.mjs version-reviews.test.mjs
rtk pnpm scanner:release <trivy.exe> <独占缓存目录> <native-build-directory>
rtk pnpm scanner:assess <新候选目录> <上一候选目录>
```

本轮证据入口：`../../linshi/assetlibrary-runtime-contract-20261005`。
新的 runtime、候选、完整镜像扫描、清理及最终身份以该目录回执为准；没有记录的检查不能算通过。

本轮已重新执行十项真实无网络 Docker/Worker/D1/R2 场景，运行候选为
`assetlibrary-p3-Wt6NEi`。受控 ClamAV 安装仍来自 `assetlibrary-native-build-cNs0V6`，
没有重编引擎；freshclam 实际将 daily **28143 更新至 28144**，main 63、bytecode 339
不变。运行镜像为 `sha256:bab59f9fa0d9c67b1c4ee013b83ab96d48f8c430b18aa05a51dd1c04c696178b`。
新的 JSON 保存完整 v2 事实，十项重新核验通过；临时目录/扫描进程为空、所属容器已回收。
43 项聚焦测试和 27 项邻近 binding 回归均零失败/零跳过。单元夹具仍为明确合成数据，
不能与上述真实 AV/binding 运行混淆。

交叉复核发现并补齐 fixture dispose 失败时跳过 scanner cleanup，以及版本 contentSafety
缺少复核的问题。其后的最终源码候选仅可在部署运行字节、受控安装和配置逐项一致时
复用此次新合同证据；实际生效的最终目录/完整镜像扫描结论保存在 `final-delivery.json`，
不把文档中间候选当作生产交付。签名更新发生在新独占本地候选，不是活动服务切换或回滚。

## 仍未完成

原生组件公告发现/风险归属、新受控镜像隔离云/资源和网络验收、实际签名切换回滚，
以及 P3 正向发布/下架、P4 授权下载、P5 最小用户入口、P6 真实身份与整套云业务。
本轮没有借关闭通用解析器、隐藏源码告警或放宽 `cloudValidated:false` 来补足安全证明。
