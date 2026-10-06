# P3.3c 签名更新候选与安全拒绝

后续状态：P3.3d 已修复本地镜像并通过完整 APK 候选门禁，见
[镜像修复与覆盖边界](P3_SCANNER_IMAGE_REMEDIATION.md)。本文的 `.7` 镜像和漏洞数量
保留为历史拒绝证据，不代表当前 `.8` 候选；仍没有生产发布或实际云切换。

`.15` 已收紧十场景重新评估合同，旧缺审核/中止/进程字段回执不能取得新候选资格。
升级说明及本轮证据见 [十场景原始事实核验](P3_SCANNER_RUNTIME_EVIDENCE.md)。

本轮范围：强制 freshclam 重新检查上游、验证不可变候选镜像、保存实际三库身份，
在选用或回滚前重新计算签名时效和完整漏洞门禁。不是生产准入开关，不自动部署、
切换、回滚、修改云 cron 或推送仓库。旧镜像、历史候选和数据保留。

生产激活有前置安全阻断：本轮对上一候选完整扫描发现没有修复版本的
HIGH/CRITICAL。禁止沿用 `--ignore-unfixed` 来制造绿色结果，不自动添加豁免。
本轮先交付真实新候选和拒绝证据；没有安全候选时不得进行实际云切换。

## 设计与验收条件

- 复用 `build`、真实十场景 `verifyScanner` 和所属容器清理，不另建扫描框架。
- 每次镜像验证传入随机 `SCANNER_SIGNATURE_REFRESH`，镜像 LABEL 必须一致；
  freshclam 在构建期联网并校验官方库，runtime 保持无网络和只读签名库。
- 更新检查可能返回“已经最新”；如版本没有变化必须记录，不能伪造新签名版本。
- 准备新候选时至少保留 12 小时签名寿命，已超过 36 小时的 daily 不可选用。
  runtime 48 小时停止接受、scan 最长 24 小时等现有规则不放宽。
- 选用和回滚都要求六小时内的完整 Trivy 证据和新鲜数据库；逐个 main/daily/
  bytecode 的签名版本、更新时间不得倒退。代码回滚不能回滚安全数据库。
- 固定 Trivy 版本和可执行文件摘要；完整记录所有严重性，HIGH、CRITICAL 和
  UNKNOWN 一律阻断，不因没有修复版本而隐藏。低等级仍保留，不声称零风险。
- 重新评估时校验 candidate manifest、runtime、cleanup 和完整报告摘要，
  重新计算准入而不信任先前的 `allowed` 布尔值。产物损坏、缺证、过期失败关闭。
- 所有生产准入仍为 false：未被包管理扫描覆盖的二进制、云资源/出站隔离与
  底层清理证明、正式发布/下架事务尚需独立完成。

## 周期与失败策略

预期至少每六小时检查更新并重新扫描；目前提供显式命令，不伪称已经安装自动
计划任务或远端 CI。更新或检查失败不改变正在运行的实例；旧版本仅在自身仍
新鲜并通过当前门禁时才具备保留资格，过期时停止新扫描，而不是继续出具 clean。
任何实际激活必须再绑定 Registry manifest 的 config digest 与同一受测镜像。

## 命令

在 AssetLibrary 根目录执行。工具只支持已核验的 Windows Trivy 0.75.0，固定
executable SHA-256：`3b4fcf6fec53c4c73c325cfd518c7264100695b19e6c59c6a777e4a67dc9f0e6`。
来源与 archive 校验见上一轮云验收文档；工具和缓存不加入源码仓库。

```powershell
rtk pnpm scanner:release <trivy.exe绝对路径> <Trivy缓存绝对路径>
rtk pnpm scanner:assess <新候选目录> [当前候选目录]
```

`scanner:release` 构建、执行原有十项真实验证并退出所属容器，再执行完整漏洞扫描，
写入 `scanner/release.json`。报告缺失或格式/工具出错退出非零；候选安全门禁拒绝时
脚本设置 exit 2，RTK/pnpm 外层可能归一化为 1。不能把非零改为成功。
`scanner:assess` 不执行部署、不启动容器，按当前时间重读并核对原始证据，再计算
准入；第二参数用于比较旧候选三库版本，不能绕过漏洞和时效要求。

回执是本地可复验的摘要链，不是独立签名或不可伪造的发布授权。真实云切换仍须
受控部署、Registry 关联和运行验证，不能直接信任可编辑的 JSON 布尔值。

## 本轮真实结果

2026-10-05 UTC，版本 `0.3.0-dev.7`；原始运行候选：
`../../linshi/assetlibrary-p3-bbkIac`。只改构建/检查工具和文档，未修改业务
Worker、scanner 扫描逻辑或原先已经关闭的云环境。

- 唯一 refresh nonce：`60dbde43-97f2-4e95-9ba7-131c367ebced`；镜像：
  `sha256:7219a7622ea0c85eb7f29c3cbfcecbc8d17c1a8d0e584fc7d89ff598c6393bdd`。
- build log 中 apt/Node COPY 复用缓存，freshclam 的 RUN 实际执行 27 秒，从基础
  daily 28137 更新到官方 28143，`Database test passed.`；没有复用该 RUN 缓存。
  main 63、bytecode 339 已最新。最终三库摘要与上一候选相同，明确不声称发现了
  比上一候选更新的签名，只证明这次真的查询、更新和验证了上游。
- 真实无网络 Docker 十场景通过，清理后 `/tmp` 为空、所属容器已回收、镜像保留。
  200 个既有容器 ID 集合与启动前一致，没有本轮新容器残留；未测量其全部运行状态。
- 11 项聚焦测试通过，覆盖签名时间/版本倒退、过期构建/报告/漏洞库、未修复
  漏洞、UNKNOWN、缺证、篡改、产物和清理身份；没有实际执行云切换或回滚。
- 完整 Trivy 输出 237 个 package/advisory 条目，123 个独立公告：CRITICAL 1、
  HIGH 55、MEDIUM 75、LOW 104、UNKNOWN 2。命令没有 `--ignore-unfixed`，
  明确空配置/ignorefile，移除继承的 TRIVY_* 环境过滤，保留完整原始报告。
- 新候选及重复评估均返回 `UNRESOLVED_IMAGE_VULNERABILITIES`。这是预期的安全
  拒绝，不是十场景功能测试失败；更不是“已完成安全发布周期”。

## P3.3c 当时的阻断与后续工作

CRITICAL 条目为 libxml2 的 `CVE-2026-6653`。本轮联网访问
[Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-6653)，它将
当前 trixie `2.12.7+dfsg+really2.9.14-2.1+deb13u3` 标为 vulnerable，同时备注
`no-dsa (Minor issue)`；Trivy 采用 CRITICAL。两种分级如实并列，不自动降级。
官方记录把 unstable 的 `2.14.5+dfsg-0.1` 列为修复版本，不因此将 unstable
软件包直接混装到当前镜像。实际 `ldd clamscan` 包含 `libxml2.so.2`，说明它不是
仅有包管理元数据的孤立条目；尚未证明受限 Art PNG/ZIP 能触发该 XML 缺陷。

优先对真实加载的 libxml2/其他解析库做兼容安全修复，再削减不需要的发行版工具
和审查剩余公告；不能通过删掉 SBOM/包元数据、扩大扫描忽略或伪造不可达性消除
报告。独立 Node/ClamAV 二进制也没有被当前 OS 报告完全覆盖。

没有满足完整候选门禁的镜像前，不做实际更新/回滚；其后还须补齐云资源/出站/
底层清理证明及发布/下架事务。未安装定时刷新任务、未提交、推送或开放发布。

补充证据：`../../linshi/assetlibrary-scanner-cycle-20261005/evidence/` 内的
`cycle-result.json`、`actual-clamscan-libraries.txt`、官方 Debian/ClamAV/Docker
文档响应。官方 ClamAV 站点首次 403 后改取官方 GitHub 文档，未关闭 TLS。
容器清理比较首次 PowerShell 表达式产生嵌套数组，后来使用 Node 原始 JSON
数组正确复核；不是丢失容器。两次代理审查均因上游 503 未执行，不算独立审查。
