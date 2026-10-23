# 访客商店、统一主题与请求预算

日期：2026-10-23。状态：本地实现与验证通过，0.4.14 发布进行中，尚未上线。

## 页面与权限

- `/` 为公开资产商店，`/workspace` 保留上传、格式检查、独立审核、发布、授权和管理工作台。
- 访客可浏览公开目录和当前详情；我的下载资源库、票据与包体仍要求当前身份及独立下载授权。
- 搜索提交、刷新及下一页均由用户显式触发。目录不自动轮询，不自动扫完空页，不添加静态示例资产。
- 卡片和详情保留真实类型、版本、大小、SHA-256 和 `not_scanned` 提示；不伪造官方认证、缩略图或扫描通过。
- 下载复用原分段、票据、长度/SHA-256 和最多三次手动尝试合同。停止、身份失效和页面离开清理请求与保留字节。
- 原本地 `pnpm trial` 根入口继续是虚构编号工作台，不将合成登录注入正式商店或持久化 Bearer。

## API 增量

`GET /v1/catalog` 与 `GET /v1/me/library` 在既有 `resourceId/after/limit` 之外接受：

| 参数 | 合同 |
| --- | --- |
| `kind` | `art/capability/mcp/application` 之一；可省略，不可重复 |
| `q` | 1–100 字符；trim 后非空，不可重复；名称子串匹配 |

搜索采用参数化 `instr(lower(title), lower(?))`，`%`、`_` 不是通配符，SQL 片段不执行。
SQLite `lower()` 的大小写折叠范围不扩展为 Unicode 搜索引擎。每页最多扫描原预算，当前失效候选仍占预算，
空 `items` 不表示没有下一页；`nextAfter` 仍指向最后扫描项。私库过滤不扩大授权。

## 请求优化及保留边界

- session 与 logout 纳入 AbortController、10 秒超时、响应清理和身份 generation 保护；并发退出共享一次请求，失败后仅手动重试。
- 商店离开/停止会使尚未应用的初始化 session 失效，迟到结果不得恢复身份。
- JWKS 冷启动和强刷并发合并，成功缓存 5 分钟，未知 kid 的刷新间隔至少 30 秒；失败刷新也消耗冷却预算。
- 新 kid 在冷却窗口内可能暂被拒绝，窗口结束后可重新读取。有效旧 key 不等待其他未知 kid 的刷新，缓存过期仍失败关闭。
- 每次私有令牌验证仍在线调用 userinfo，保留停用/securityVersion/即时撤销语义，不增加跨请求身份缓存。
- `/auth/login?returnTo=workspace` 只接受固定标记；其他、重复和未知参数拒绝，不创建事务。旧加密纯 verifier 事务在原五分钟窗口内仍能完成。
- 不删除维护 cron、晚到上传 PUT 补偿或部署锁释放，不恢复扫描器研究。

## SpringBok 打包与主题

Worker Text 模块从 11 个增至 14 个，增加商店 HTML/CSS/JS；构建与 Worker fixture 均强制覆盖。
`.sba/cloudflare.py` 继续从实际 manifest 的 `modules` 发布全部模块，无平行部署器或 Schema 迁移。
原 `.sba/native_client.py`、默认 Loom 客户端 binding、数据保全和部署回执合同未改。
SpringBok 服务页仅周期查询活动实例，完整列表在初始化、用户操作后和恢复可见时读取；终态后停止。
三个独立项目使用同一 Neuro 黄/绿/中性色语义，不引入跨站运行时样式依赖。NAccount 组织显式 branding 仍保留。

## 本地验证

- `pnpm check`、`pnpm typecheck`、`pnpm sizecheck`、`git diff --check`；依赖联网 `pnpm audit --audit-level=low` 无已知漏洞。
- 完整 suite：395 项中 394 通过、0 失败、1 个需指定完整 Loom 包的专用测试跳过。构建证据 `linshi/assetlibrary-p3-OS0BXI/`。
- 此后补充并发冷启动 JWKS 和升级前事务兼容两项，最终相关五个测试文件的 12 项聚焦回归全通过；最终构建 `linshi/assetlibrary-p3-CcSMdw/` 并重跑真实商店浏览器通过，不把分批结果冒称又跑了一次完整 suite。
- 新增真实 Worker/D1 筛选、分页、字面搜索/注入、私库权限；真实 NAccount provider 夹具验证固定回跳、冷却/失败恢复、并发 JWKS 和旧事务兼容。
- 客户端真实模块验证并发退出、取消、身份代际、商店初始化和无隐式私库/轮询。
- Chrome + 实际 Worker/D1/R2：匿名、搜索/类型、空态/503、详情、1440/960/760/390/320 宽度、合成 session 下授权 ZIP 原字节比对、401 清理和停止初始化通过。
- 浏览器脚本与截图在 `linshi/asset-store-ui-20261023/`；使用隔离合成身份，不是生产登录、真实业务或线上费用验收。

用户已明确授权保存三个独立仓库成果、生成 NAccount 定制补丁并通过发布门禁，再通过 SpringBok 原实例保数据升级及独立 verify。
线上基线经只读探针核对为 0.4.13 / `1661458c7ab38304aa2bd203641faff9609292eb`；保留原配置、D1/R2、Loom binding 和未扫描分发。不把本地页面通过称作线上已统一。
