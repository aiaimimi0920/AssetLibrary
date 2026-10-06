# 旧 AssetLibrary 归档说明

归档日期：2026-10-04。状态：用户明确回复“同意”后，已完成批准范围的本地归档与内容核验。

## 来源与用途

- 独立仓库原分支：`main`。
- 原源码提交：`a67b82c7a1cb05a662576fcb8fec68481eef35ac`。
- 原仓库 Git 历史、远端和配置保留在父目录 `.git`，没有重建仓库或提交本批改动。
- 这里保存旧 Rust/Axum、PostgreSQL、Web、Edge、客户端、协议、部署、构建、测试和开发文档，仅供必要时查阅。

旧计划、旧 ADR、旧测试与验收记录不再决定新项目的架构、流程或完成状态。当前入口是父目录的 [`DEVELOPMENT_PLAN.md`](../DEVELOPMENT_PLAN.md) 和 [`AGENTS.md`](../AGENTS.md)。

## 归档范围

按批准清单处理 36 个顶层旧入口：35 项直接移动；原 `.gitignore` 先逐字节保存在本目录，再替换为新的根忽略规则。移动前后都保留了秘密和缓存忽略保护。

包括旧源码、旧协议和 Schema、旧数据库脚本、旧构建和部署、旧 `.github`、旧文档，以及本地旧环境、缓存和运行产物。子树内部相对路径保持不变，不保证迁移目录后的旧命令可以直接启动。

特殊路径：

| 原路径 | 归档路径／当前处理 |
| --- | --- |
| `AGENTS.md` | `old/AGENTS.legacy.md`；本目录的新 `AGENTS.md` 仅规定历史参考边界 |
| `.gitignore` | `old/.gitignore` 保存原始字节；根目录使用新忽略规则 |
| `.gitattributes` | 原位保留，未改变 |
| `CLOUDFLARE_REBUILD_PLAN.md` | 转为父目录当前 `DEVELOPMENT_PLAN.md`，不是旧文件 |

旧 `README.md`、`CONTRIBUTING.md`、`DEVELOPMENT_PLAN.md` 和整个 `docs/` 均保存在本目录，不混入新文档入口。

## 内容核验

原仓库 681 个已跟踪文件已记录原路径、归档映射、大小和 SHA-256，并逐一核对：

- 680 个文件已归档，内容与归档前一致。
- 1 个 `.gitattributes` 原位保留，内容一致。
- 原 `.git/HEAD`、`.git/config` 和 `.git/index` 在归档脚本完成时未改变。

生成的 [`ARCHIVE_FILE_MANIFEST.json`](ARCHIVE_FILE_MANIFEST.json) 保存上述路径与内容清单，不含环境变量或凭据正文。它是归档证据数据，不应手工修改。

本地缓存和运行产物按目录边界及移动记录保全，没有递归计算全部缓存的摘要；已跟踪源码的内容核验不能冒充全部缓存校验。

完整操作清单、批准记录、逐步日志和核验结果位于：

```text
C:\Users\Public\nas_home\AI\GameEditor\linshi\
assetlibrary-cloudflare-rebuild-20261004-042221
```

## 本地状态与安全

`.env`、`.memsearch`、`.pnpm-store`、`target`、`test-results`、旧 `node_modules` 和 `release/evidence` 等保留在归档中，但它们不是待提交源码、新运行依赖或新发布证据。忽略规则继续保护秘密、缓存、基础设施状态和本地数据。

不要读取或输出凭据正文，不要把此目录作为部署上下文。新运行图、格式化、测试、依赖发现、索引和打包排除此目录；秘密保护不能因此关闭。

旧 CI 仅在本地移出根 `.github`。本批未提交、推送或改变远端设置，因此不能声称 GitHub 上的旧 workflow 或 required checks 已关闭。

## 恢复边界

若明确需要恢复历史文件，以操作日志和内容清单逐项处理，先检查原路径是否已被新工作占用。不要覆盖新文件，不使用 `git reset --hard`、`git clean` 或删除新源码来恢复。

工作区外的历史版本包、证据、远程数据库和 Cloudflare 资源未因本次归档移动、清空或部署。未来实际复用旧代码时，应按新项目规则重新审查和验证。
