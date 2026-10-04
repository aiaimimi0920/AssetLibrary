# 开发期静态质量报告

PR、main、每周定期与手动 Development Quality Reports 检查 Rust formatting、ESLint、OpenAPI lint、源码规模和 OpenTofu formatting，独立上传各自完整原始日志、原退出码、JSON 与摘要。合法 findings 不阻断开发；安装、工具执行、解析、未知诊断、空扫描、不完整或陈旧报告、上传故障仍失败。没有 continue-on-error。

原 CI 中功能测试、lint glob 覆盖契约、typecheck、生成 API client、浏览器测试、基础设施 init/validate 和其他策略保持严格。源码扫描保留既有根目录、扩展名、忽略目录与 700 行阈值，并拒绝缺根、空根、符号链接和读取失败。

被复用的 CI 默认 strict-quality=true；显式 source_ref、manual CI 与 tags 同样严格。发布 workflow 不改，仍使用同提交的严格质量与安全门槛。只有 strict 模式可以生成、上传及回读 quality-evidence；开发报告不冒充可发布质量证明。不能将报告成功解释为发现项已修复。

聚焦回归：python scripts/test_development_quality.py -v 与 python scripts/test_asset_quality.py -v。SourceSize 原命令仍对超标 exit 1；执行故障 exit 2；仅显式 JSON 报告可由开发 runner 分类。OpenTofu 只有格式差异 exit 3 可作 findings；Redocly 要求完整 JSON、匹配退出与计数、已知完成日志。
