# AssetLibrary 新版 CI

`.github/workflows/ci.yml` 仅验证当前 TypeScript Workers/D1/R2 项目，不执行 `old/` 的 Rust/Web/部署工作流，不申请 Cloudflare 凭据，不部署或修改云资源。触发条件为 `main` 推送、Pull Request 和手动运行；仓库权限仅为 `contents: read`，checkout 不持久化凭据。

`verify` 使用固定 Node 22.23.1、pnpm 10.33.0 和锁文件执行 `pnpm check`、`pnpm typecheck`、`pnpm sizecheck`、`pnpm test` 及 `pnpm audit --audit-level=low`。`pnpm test` 会先对主 Worker 和扫描 Worker 做 `wrangler deploy --dry-run --containers-rollout none`，再运行现有完整测试；不启动 Docker 或真实部署。依赖审计只覆盖当前活动锁文件，不能据此关闭 GitHub 针对整个仓库显示的历史告警。

首次云端 `verify` 暴露了 3 项原生工具测试对开发机 `rtk` 包装器的隐式依赖；命令现直接用固定 argv 和 `spawn` 启动，保留原有日志上限、超时及 Windows 所属进程树清理。Windows 和 Linux 的该组聚焦测试均已通过，不靠跳过测试补绿。

`secret_scan` 沿用旧策略已固定摘要的 Gitleaks 8.30.1，但不把归档旧债伪装成新代码失败：

- 扫描当前 Git 跟踪的全部活动文件，排除静态参考 `old/**`，不会扫描未纳入 Git 的本地凭据、缓存或运行数据。
- 扫描本次引入的提交差异，包括对 `old/**` 的新增修改，防止借归档目录绕过秘密检查。
- 报告只留在 Runner 临时目录且使用 `--redact=100`；发现内容直接失败，不上传原始秘密。

本地受控核验中，完整历史扫描发现 118 项旧记录（116 项旧加密测试夹具、2 项旧部署示例），因此**不能宣称历史无秘密告警**；当前活动跟踪文件快照和上一资源管理提交增量均为零发现。此策略不删除或篡改历史，也不放宽未来提交。[GitHub 运行 37448919866](https://github.com/aiaimimi0920/AssetLibrary/actions/runs/37448919866) 的 `verify` 和 `secret_scan` 已通过，所含完整测试、活动依赖审计和两项秘密检查均为 `success`。分支保护与 required checks 尚未核实；CI 通过不等于 P3–P6 生产验收。
