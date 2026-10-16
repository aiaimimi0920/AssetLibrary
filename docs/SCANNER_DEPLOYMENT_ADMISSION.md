# Scanner 部署准入与当前交付停点

2026-10-16：恢复 Session `01a143c7-7a48-7143-8642-9636e998e245` 的 scanner 验收、
部署绑定和正式分发任务。本轮补齐并验证已有准入实现，尚未部署或开放线上分发。
用户在原会话已授权继续这些工作；不是重新等待一般开发授权。

## 已实现的准入合同

- `src/scanner/deployment-release.json` 随应用版本携带严格结构的验收记录，目前仍为
  `release: null`。请求、业务数据库或任意布尔环境变量不能创建验收资格。
- 记录绑定目标账号、应用 Worker/origin、scanner service/Worker version、DO namespace、
  Container application、镜像身份、签名库身份和三类证据摘要。
- 运行时要求 scanner binding 存在、release ID 和正式 origin 匹配，记录期限不超过一天；
  签名时效单独限制。历史 clean 不升级，只允许同一签名库且在验收后完成的扫描。
- `.sba/scanner_release.py` 在部署流程中核验远端 Worker 100% 版本、namespace、
  Container 镜像 digest 和资源限制；首次激活还限制在验收后六小时。
  这不是运行时持续监控，部署后的外部漂移仍需要独立核查。
- 发布、目录、票据、GET/HEAD/Range 下载使用当前准入。票据到期时间不超过准入期限；
  下载在取得 R2 对象前后重查授权，撤销/下架/绑定失效仍拒绝。

本轮复现并修复发布时效竞争：入口通过后等待 D1 时，准入可能过期。现在发布核心
再次检查扫描与准入，并在 INSERT 执行时用 D1 时间限制准入期限。
真实 D1 延迟回归确认过期后既不写 publication，也不写成功事件。
SBA 的六小时激活测试也已修正：使用仍有效的记录，分别验证边界及边界后一毫秒，
避免被较短的普通过期时间提前截断。

上述正向业务测试使用合成身份/扫描及测试验收记录，不是实际云端批准。
验收记录的真实证据生成和审核、云端绑定及部署后漂移验证不能被结构校验替代。

### 后续代码修复：部署等待期间的时效竞争

远端核验开始时有效的记录，可能在读取 scanner 配置、版本和 Container 后失效；
也可能在主 Worker 上传包组装期间越过六小时首次激活窗口。
现在远端核验结束及 Worker `PUT` 发出之前，均重查同一份已核验记录的有效期和激活窗口，
不使用另一份记录替换原身份。未配置准入记录时仍保持原来的阻断式部署行为。

`tests/sba_scanner_release_checks.py` 增加四个可控时钟回归：远端读取、包体读取分别跨过
记录到期点和首次激活窗口。修改前实际复现 `invalid release accepted`，修改后全部拒绝，
仅发生三次模拟只读调用，没有 Worker 上传或其他写操作；原六小时边界正向测试仍通过。
`node --test tests/sba-contract.test.mjs` 三组合同测试通过。测试不请求 Cloudflare，
不证明网络请求发出后绝不会跨过期限；实际运行时仍由版本内记录独立限制分发。

## 本轮实际证据

所有目录相对 `C:/Users/Public/nas_home/AI/GameEditor/linshi`。

| 证据 | 结果与位置 |
| --- | --- |
| 新受控原生构建 | `assetlibrary-native-build-6JdoVZ/receipt.json`；本轮重新核验记录文件摘要全部匹配，镜像仍存在 |
| 原风险报告 | `assetlibrary-native-risk-8NMqLp/risk-receipt.json`；保留 OneNote、rand 和旧运行镜像 zlib 告警，不改写历史 |
| 最终本地完整测试 | `assetlibrary-p3-rWYrlj/tests.log`；335 passed、0 failed、0 skipped |
| 新受控运行候选 | `assetlibrary-p3-1CeH2k/scanner/release.json`；候选资格通过，不是生产资格 |
| 真实运行场景 | 同目录 `runtime-validation.json`；`scanner-runtime-cases-v2` 十项通过 |
| 镜像全量扫描 | 同目录 `vulnerabilities.json`；49 个 APK 包逐项匹配，全部严重性计数为 0，无忽略未修复项 |
| 清理回执 | 同目录 `cleanup.json`；所属容器已回收，镜像保留；本轮另读回无该测试容器 |

受控候选镜像：
`sha256:4a07ff328bb5467db6b8f55ab36ce3ccbbcb22fed1f77d29fd31618c40efb4a9`。
签名 daily 为 `28155`，签名库摘要为
`031a3fd1abdb2517f73cc8bc7171e58886eadc844c560973e36fbf972576e910`。
其准入候选有效期是回执中的有限窗口，后续必须重新评估时效，不能永久复用绿色结果。

修复前普通 `scanner/Dockerfile` 已包含 `zlib=1.3.2-r1`，但真正用于受控引擎的
`scanner/native-runtime.Dockerfile` 遗漏。本轮补齐并实际构建验证；原始构建镜像不被覆盖。
本次镜像扫描不等于内置 C/C++ 或 Cargo 全部风险关闭。

首轮 `assetlibrary-p3-ZmWe2L` 在业务夹具创建资源时返回 `401`，未生成成功回执；
独立延迟探针未复现，后续完整重跑通过。该偶发失败根因尚未证实，不写成已修复，
也未为通过测试放宽生产认证。失败日志保留在 `assetlibrary-resume-20261016-release.log`。

格式检查、类型检查、源码行数、活动依赖审计及 `git diff --check` 均通过。
新增本文及 README 链接在候选冻结后完成，因此候选 manifest 绑定的是冻结时源码，
不冒称其包含随后新增的文档。

## 尚未完成，下一阶段继续这里

1. 将新构建材料中的 OneNote fork、内置 C/C++ 风险与实际安装身份形成完整、可复验的结论。
   旧技术说明不替代新证据，不能仅因 APK 报告为零生成 `nativeReview` 批准摘要。
2. 对满足安全条件的精确候选执行新云端隔离/网络/资源及业务验收，记录不可变镜像、
   Worker version、namespace、Container application 和签名库的实际对应关系。
3. 基于真实证据生成受控 release 记录，经 SpringBok 保数据升级；独立读回绑定、
   平台 verify、线上发布/授权/撤销/下架及 Loom 下载与摘要校验。
4. 处理首轮原生验证的偶发 401，若复发先保存签发和校验时钟等脱敏事实再诊断，不能盲目重试掩盖。

本轮联网实读正式 `/healthz`、`/readyz`：仍为 `0.4.6` /
`84d29682e03c27e81a50a414019e97094e89f353`，私有依赖 ready，
分发 `SCANNER_CLOUD_NOT_VALIDATED`。没有提交、推送或云变更；没有修改 Loom 或其他兄弟仓库。
最终“正式平台发布并由 Loom 在线下载”的交付目标仍未完成。
