# 活动工具链 sharp 安全修复

日期：2026-10-06。该工作只调整当前活动依赖，不进入 old/，不恢复此前延期的 ClamAV 原生组件或网络安全调查。

## 新发现与最小改动

本轮 fresh pnpm audit 检出 HIGH：miniflare → sharp 0.35.4，报告为 GHSA-wq5f-xc86-pv6w / CVE-2026-96889，建议修复版本 >=0.35.5。这是当次 registry 审计结果；上一轮无告警不能证明此刻仍无告警。

公开 npm registry 查询显示当前 miniflare 5.20261001.0-alpha 仍精确依赖 sharp 0.35.4，wrangler 4.147.0 也经 miniflare 引入它。没有为此升级其他顶层工具。pnpm-workspace.yaml 仅新增 miniflare>sharp 的 0.35.5 覆写，锁文件对应 sharp 0.35.5 与 libvips 1.3.4 的跨平台包一起更新。

## 运行目录保护

根仓库 pnpm install --frozen-lockfile 提示 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY；没有设置 CI=true 或 confirmModulesPurge=false 强制清空现有 node_modules。已有手测服务及依赖目录保留，不能声称它们已安装修复版本。

在 linshi/assetlibrary-sharp-fix-20261006/checkout 复制活动跟踪文件（排除 old/），以新锁执行独占安装和验证。该目录不是新 Git 仓库，不代替独立 AssetLibrary 的提交。首次 registry tarball 请求 ECONNRESET 后 pnpm 自行重试成功；没有重新启动已有业务进程。

## 验证和局限

- frozen-lockfile 安装成功；活动依赖 audit 无已知漏洞。
- biome、TypeScript 和本地有效行数门禁通过。
- 实际加载依赖为 sharp 0.35.5 / rsvg 2.63.2；无害 2×2 SVG 转 PNG 得到有效 PNG 签名与 95 字节输出。只证明补丁安装与最小兼容，不使用恶意样本或声称完整图像解码安全。
- 全部 63 个当前测试文件按排序分为两批：32 文件 153 pass、31 文件 143 pass，共 296 pass / 0 fail / 0 skip；避免 Windows 单次 180 秒限制。原始证据见 linshi 中 tests-0.log / tests-1.log 和 delivery.json，不把分批结果称为单次全套通过。
- 生产源码、Schema、账号合同、scanner 镜像和云配置没有改变；SCANNER_CLOUD_NOT_VALIDATED 门禁保留。

本轮推送前已观察到 GitHub 报告 4 条 HIGH，但未取得各条告警归属。新活动 lock 审计通过不能直接证明 GitHub 的归档或其他清单告警已经关闭。既有 trial 仍用旧依赖进程；只用于已标识的回环合成业务手测，不作为新锁的安装或安全证明。
