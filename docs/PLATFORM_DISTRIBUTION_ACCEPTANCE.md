# 平台统一分发与更新验收

当前生产版本为 0.4.11，源码 a23e0f2f0dd02d03ec996a63969bd3f9bcaa0ca4。四类小包已完成真实双账号发布及消费者双版本实际运行；Art 使用原运行中的 Loom daemon，其余三类使用新 libaria2 daemon。原生桌面 UI 全路径、大包托管、Loom 自更新及正式组合源码发行仍未完成，不将四类小包通过外推为平台全部交付。下文早期批次的“未部署”仅描述当时状态。

## 0.4.11 恢复升级与独立验证（2026-10-17）

- SpringBok PR #100 的许可前失败恢复已上线；原任务 dc-84474230b8904fd78a90e2bb1b714681 保持目标源码、请求摘要、配置和实例不变，新派发运行 39044842767，未重跑旧运行 39035298532，也未删除原失败证据。
- 新运行成功，应用回执 deployed-unverified，backup-created、data-preserved、deployed-bindings 及四项应用检查均通过。旧源码 403 本次未重现；成功恢复不反向证明旧 403 的具体原因。
- 独立 verify 任务 dc-3a313238afb944b5a9ad40db3f390f8e / 运行 39045314836 返回 succeeded，四项检查通过。scanner-admission-verified 为历史检查名称，本次仍验证未扫描分发策略，不是病毒扫描通过。
- 2026-10-17T15:30:26Z 线上 healthz 返回上述 0.4.11 与完整 SHA；readyz 的身份、数据库、存储均 available，分发模式 unscanned-packages，malwareScanning=not_required。
- 证据：C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-sv10-recovery/assetlibrary-update-ui.txt、assetlibrary-verify-ui.txt、assetlibrary-live-health.json、assetlibrary-verified.png。SpringBok 控制面配置六项及绑定保持，独立 release-receipt.json 记录其版本，不与 AssetLibrary 版本混用。
- 随后真实发布者完成 MCP 1.0.0 发布：publication=0af9ca36-3f2c-46e9-9777-efda412536e0，消费者 e7b183d6-a81f-485a-9c89-32750b1346d0 的下载授权 active / revision 1。版本、摘要与已独立批准的旧包一致。
- 正确新版 1.1.1 已上传：upload=925b6a29-b023-424a-b028-b174fb063dfe，SHA-256=8703fe974ae00a22753d999f39347ab178d0d9f56eb8e19afeed39508c0e0d9c；inspection=62bbce19-8685-41b8-86ef-bc23270c4d82，passed / not_scanned。真实页面先选择新上传再查询检查，重绘后仍保留新上传，确认生产修复有效。
- 新 version=64ba4d34-0ab4-4e0b-958a-4f7e52d205d6，1.1.1 已由另一真实账号 e7b183d6-a81f-485a-9c89-32750b1346d0 独立批准，approved / revision 2，publicationEligible=true，publication=null；尚未发布，错误的 1.1.0 拒绝记录保持原样。证据在 linshi/assetlibrary-production-update-20261017/mcp-1.0.0-publication-grant.txt、mcp-1.1.1-upload-version.txt、mcp-1.1.1-review.txt 和 mcp-1.1.1-approved.png。
- 实际运行中的 Loom 原用户实例通过正常 refresh 恢复 666 账号，并从正式站点读取到 MCP 1.0.0 与既有 Art 的独立下载目录；记录为同目录 loom-consumer-library.json。当前进程仍是此前旧交付包，不把目录读回说成新 libaria2 二进制验收。
- 消费者下载安装、运行和新版切换仍待完成；不以部署恢复或发布授权替代四类包的业务验收。

## 生产更新与独立验证（2026-10-17）

- 精确提交 CI 39028333994 的 verify、secret_scan 均通过；已发布 v0.4.10 Release，未部署失败的 v0.4.9 候选。
- 原实例 dc-b20cc87beb7b44c0aa5c73eec88a7292 保数据更新任务 dc-19e119d9a04c411c9481ef3c05936972 返回 deployed-unverified。七项检查均通过，包括 backup-created、data-preserved、deployed-bindings；D1 备份校验、0011 迁移、原记录和 R2 保全检查后部署。
- 独立 verify 任务 dc-8f432ad91f5946f098878286c634b3c6 返回 succeeded，release-identity、private-dependencies、naccount-login-configured、scanner-admission-verified 四项通过。最后一项为历史检查名称，此处验证未扫描分发策略，不代表病毒扫描通过。
- 2026-10-17T11:35:25Z 线上 /healthz 返回 0.4.10 及上述完整 SHA；/readyz 的 identity、database、storage 均 available，distribution 为 available / unscanned-packages / malwareScanning=not_required。
- 回执与截图：C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-v0410-update-ui.txt、assetlibrary-v0410-verify-ui.txt、assetlibrary-v0410-verified.png；独立 HTTP 读回：同目录 assetlibrary-v0410-live-health.json。
- 这些证据确认应用上线与依赖可用性，不代替真实双账号的四类上传、下载、安装及新版实际运行验收。

0.4.9 的精确提交 CI 39027794638 为 366 项通过、1 项失败：SBA 合同夹具仍写死 0.4.8。修正为读取当前 manifest，并增加错误版本拒绝断言；保留原失败标签，不重写标签，不部署失败候选。

2026-10-17 用户新定义：AssetLibrary 是整个平台官方发布和第三方 UGC 的统一分发、版本与更新托管服务，不限于美术素材。
本文件细化根开发计划的验收条件，不新建另一套开发计划。

## 完成标准

### 2026-10-18 Art 生产双版本实际图像处理

发布者 308008d6-2fad-4585-950a-b9861530cc22 在原资源 a66802da-1770-4e25-977d-5f3553ed72e6 上传 0.1.5；消费者 e7b183d6-a81f-485a-9c89-32750b1346d0 独立审核。格式策略 loom-art-zip-format-v1 通过，始终 not_scanned、cloudValidated=false。0.1.5 仅增加实际进程返回的 packageVersion 标记，图像算法未变，不冒称算法升级；包为 unsigned 验收包。

- 新 upload=acab6ead-9157-4b08-a345-ae9d07935ecd，inspection=69b2322e-e0f6-4c55-8f06-a16cb1c9c4ea，version=b2df7118-3c62-4a7a-a6dc-bcee2f593476。
- 新 publication=23146925-a79d-45a9-953a-35d371f45f27，published/revision 1，18670 bytes，SHA-256=67b07afc607b929c92c4d6832533bfe23291db38736664df3109743aff13c7de。
- 新版未授权时正常安装接口返回 asset_library_request_rejected；独立下载授权 active/revision 1 后成功。用户原实例经 /v1/asset-library/install 安装，未复制凭据或替换 daemon。
- 本轮先运行旧 0.1.4，再安装运行 0.1.5；两次均通过产品 /v1/tools/custom-1770131241684/execute 实际执行 Python 图像处理。新版返回 succeeded、packageVersion=0.1.5、8×8 PNG；输出 SHA-256=284f34afb15cea023e6e6b4f3b673d3afc2acb28e92eb0384388260a9b7a69cc，与算法未变的旧版一致。
- 新版安装目录 versions/0.1.5-6082eb19d61d，旧版两个目录均保留。此次使用原用户运行中的旧交付 daemon，不作为 Art 的新 libaria2 或原生窗口交互证明。

证据：C:/Users/Public/nas_home/AI/GameEditor/linshi/art-production-update-20261018，含原包来源/摘要、review-0.1.5.txt、production-0.1.5-grant.txt、art-0.1.5-install.json、两版 execution.json、新版 output.png 和 art-published.png。新包来自临时验收变体，没有修改仓库中的图像算法。

验收同时发现线上旧文案仍称“尚未开放生产发布或下载”“当前未准入”。本地已改为真实四类型、未扫描提示和中性发布操作；新增真实阻断/无阻断回归，不改授权或发布门禁。该文案修复尚未部署，不能以源码修改冒称线上已修复。

### 2026-10-18 Capability 生产双版本实际运行

真实发布者 308008d6-2fad-4585-950a-b9861530cc22 创建资源 ad778f57-7501-4d6c-9e1d-b55a1e8e5f99；另一账号 e7b183d6-a81f-485a-9c89-32750b1346d0 独立审核并消费。两版均为 loom-capability-zip-format-v1、not_scanned，没有恢复扫描器。

首包上传 6abb5ce9-62c2-4f8a-b6bc-fe0a10687dcb 被 ZIP_FILE_TYPE_UNSUPPORTED 拒绝：Windows 上 zip 9.0.4 默认使用 DOS 来源，但生成器同时写入 Unix 0o100644 权限。修复 Loom 测试包生成器，明确 system=Unix，并补充中央目录来源/权限回归；没有放宽服务端规则。现有签名包仅修正中央目录来源字节，逐文件证明解压后的签名和载荷字节不变；旧失败记录和原包保留。

| 版本 | version | publication | 包 SHA-256 |
| --- | --- | --- | --- |
| 1.0.0 | bcac50d1-c9b8-4a5c-8772-8cad70579b40 | 8086f5d7-7bd1-4ef0-b560-52292dc420b0 | a30f2168c816d8523aea8cd124c893c60e7f257e9440c8d1fd9dc61d4d506dc3 |
| 1.1.0 | 53e962e5-fbf0-4a58-9448-e88d241e60ea | b59a4ba0-a0f9-4c20-bad1-d2c740e74511 | 719ff60a0f8041cb221d992bdaf36bb5226c02ef80e4433e28f37bec277665ea |

B 在隔离数据根中的产品 daemon 经正式站点、真实身份和 libaria2 下载、验签并安装两版。发布者测试公钥仅进入该临时数据根，没有修改用户日常信任库。未经权限批准的启用/升级被拒绝；按各版 digest 明确批准后，通过 /v1/invoke 调用实际插件进程，两版分别返回 1.0.0、1.1.0，并生成 attachment.upsert 和 notice.show 业务结果。新版 activeDigest=e9947af3afe088dd2d8e0969e71dbff570251dab7a3b0f958eb52c0a2cbe20be，旧版 EXE 保留。

新版尚未取得独立下载授权时，安装请求返回 404 asset_library_request_rejected；授权 active/revision 1 后成功，旧版授权没有自动继承。新版未批准权限的升级返回 409，未误报成功。旧临时 access token 过期时返回 naccount_login_required，通过原用户实例正常 refresh 后更新加密测试副本再验收；没有调用副本 refresh/logout，没有撤销原用户会话。

生产发布/审核及 ZIP 修复证据位于 C:/Users/Public/nas_home/AI/GameEditor/linshi/capability-update-20261018-v3；两版安装、执行和拒绝回执位于 C:/Users/Public/nas_home/AI/GameEditor/linshi/loom-production-consumer-20261018/capability-*.json。生成器聚焦 Rust 测试 1 项通过，rustfmt、strict 行数和 diff 检查通过。本次修改只涉及测试包生成器，不需要重新构建已交付 daemon；不是原生桌面 UI 或 Hook 可视化渲染验收。

四类目标当前为 MCP、应用程序、Capability 的生产双版本实际运行通过；Art 已有单版实际图像处理，新版更新仍待完成。较大程序托管、Loom 自更新和正式组合源码发行仍未完成，不以本切片宣称全部交付。

### 2026-10-18 生产 MCP 双版本消费者实测

新版 1.1.1 已由真实发布者发布，publication 为 a2ed9ada-d081-43ef-a6a0-7363fb0f1682；消费者 e7b183d6-a81f-485a-9c89-32750b1346d0 的独立下载授权 active / revision 1。此前错误 1.1.0 的拒绝记录保留。

在独立临时数据根启动源码绑定的新 daemon，使用真实消费者账号，访问正式站点；没有替换原运行中的旧 Loom。通过正常 /v1/asset-library/install 接口先安装 1.0.0，再安装 1.1.1，两次回执 downloadEngine=libaria2，包摘要分别与生产发布记录一致。随后通过 daemon MCP 调用接口执行各次安装路径的 version 工具，分别真实返回 1.0.0 和 1.1.1；更新后旧版文件仍存在。进程模块读回确认实际加载 loom_aria2.dll，摘要为 6f8b8cc51aca77af7c2275bca95933f815aac29faf5919e2dd06c49a7cefb732。

证据位于 C:/Users/Public/nas_home/AI/GameEditor/linshi/loom-production-consumer-20261018，含两份安装回执、两份执行回执和 mcp-production-evidence.json。本次不是合成账号，也不是仅下载 ZIP；但仍是 daemon 接口验收，不是原生桌面窗口交互验收。所有包仍标记 not_scanned，未恢复扫描器。

同批次已创建应用资源 8f08ba50-89ab-40c1-9cf0-06f6fd6fbca8，真实编译的文本整理 EXE 两版上传和格式检查通过，并由另一账号独立批准。1.0.0 version=b6df4345-fc8e-4979-8456-c8e6e422bfb3，1.1.0 version=6d3c3b10-151f-4655-9559-d14b0297abf2；发布及消费者执行以后续回执为准，不能把审核通过写成运行通过。

随后两版均正式发布并各自授予 B 账号下载：1.0.0 publication=d13481ac-2881-42d2-9b2d-cc48f0e41c41，1.1.0 publication=d848d2f5-baf6-4086-8c3b-b4c6b6eb3e9e。B 在上述新 daemon 中经 libaria2 下载、安装，然后实际运行各安装目录里的 TextNormalize.exe；同一输入 `  hello   world  `，旧版输出 `hello   world`，新版输出 `hello world`，退出码均 0。active.json 指向新版 1.1.0，旧版 EXE 保留；不是仅比较版本字符串，也不是 Loom 自更新。生产授权截图和审核回执位于 linshi/assetlibrary-production-update-20261018，安装与运行 JSON 位于 linshi/loom-production-consumer-20261018。

新客户端开发包 Loom-libaria2-complete-dev-20261018.zip 已补齐本次重建的 4 framework、2 MCP 和 7 Art，13 份模块摘要核对通过，独立解压后 47 个载荷文件逐项验摘要通过。桌面/daemon 仍为源码绑定 debug，正式发行、完整组合源码审查、大包托管和 Loom 自更新未完成；未放开 releaseApproved。

### 生产双账号验收发现与修复（2026-10-17，修复已随 0.4.11 上线）

真实发布者 308008d6-2fad-4585-950a-b9861530cc22 创建 MCP 资源 5eb3c60c-f522-4fa0-84b4-abe51c0a1d91，并上传两个 830 字节的 stdio 版本工具包。两次 loom-mcp-zip-format-v1 格式检查均 passed、not_scanned，未恢复扫描。

- 1.0.0 上传 204fca65-aade-4ea8-9abe-9afd4b94c027，SHA-256 8cc78fd5db04f8d91592e607c9036f6cd90dea514028e57ca82c1a4a3c339fbd；版本 f1d924b6-801e-4c7b-a92e-cf894f3145ec 已由另一真实账号 e7b183d6-a81f-485a-9c89-32750b1346d0 独立批准，尚未发布。
- 1.1.0 包上传 e3ca335d-cfd3-4eaa-9656-94a46ca88c75，SHA-256 e4c2bb435e8d38019d06b911db7e602a769311b7f646c35dacdf7f17d0e8d8d0。检查未完成时创建版本收到 409 VERSION_BINDING_NOT_READY，未绕过检查。
- 后续查询检查触发工作区重绘，上传选择静默退回第一项；错误版本 d5fb39a7-986e-4710-97dc-6e53e95b2868 的 1.1.0 标签实际绑定旧包。独立审核核对摘要发现问题，已拒绝，publication=null；不得发布或将其记为更新通过。记录和包体保留，后续使用新的版本标签及匹配的新包，不能重写不可变版本。
- 修复 render.client.js：同资源重绘保留明确选中的上传；当前候选消失时清空选择，不自动改绑其他包；切换资源或清除身份不带入旧选择。新增回归先在旧实现复现 old !== new，修复后通过。扩展检查发现旧 DOM 测试夹具缺 dataset，补齐真实元素属性后五文件 23 项全部通过；Biome、类型、行数、diff 检查及 Worker 构建通过。
- 证据目录：C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-production-update-20261017，包含 packages.json、mcp-upload-ui.txt、两份审核回执、mcp-review.png、web-selection-tests-fixed.log；构建为 linshi/assetlibrary-p3-jRpMCa。

修复已发布并部署为 0.4.11，独立验证与后续首版发布、新版上传进展见上文；消费者下载或新版实际执行仍未完成。本次没有将本地 libaria2 运行结果替代生产双账号验收。

Art、Capability、MCP、应用程序各至少一个真实可使用包，分别完成：

1. 发布者 A 上传旧版，经既有业务审核发布，消费者 B 获得下载权限。
2. B 下载并核对不可变包摘要，在实际消费者中安装或接入并产生可观察结果。
3. A 在同一资源下上传、发布新版；B 发现目标版本、下载、安装或切换，再实际使用。
4. 记录旧版/新版 ID、版本和摘要、运行结果；证明运行的是新版而不只是下载了新版 ZIP。
5. 下载失败或权限撤销不能误报更新成功，旧版票据不能用于新版。

应用程序必须是实际可运行程序，不用一个只有 version.txt 的归档冒充应用更新。
Loom 自身更新和较大程序托管属于平台目标；当前 8 MiB/32 载荷封装上限不能据此宣称支持 Loom 完整安装包。

暂停病毒/恶意代码扫描开发和研究；分发结果明确 not_scanned，不伪造 clean/cloudValidated。
摘要、类型、身份、权限、发布者信任和消费者安装/执行约束仍各自生效。

## 本次已实现的资源库增量（已随 0.4.10 上线）

- 新增独立 mcp 资源类型，走既有上传、检查、版本、审核、发布、授权、票据和流式下载。
- mcp-zip-format-v1 使用软件封装；loom-mcp-zip-format-v1 接受原字节 mcp.server.json 原生包。
- 原生 MCP 首期为 stdio，入口须在归档内；平台只验证有界归档与类型标记，不执行载荷、不代替宿主清单和签名验证。
- Web 新增 MCP 类型及两种明确策略；pack:software 支持 MCP，输出格式策略而非推荐已暂停的扫描策略。
- GET /v1/catalog 和 GET /v1/me/library 新增可选 resourceId UUID 筛选；保留 limit/after 分页及每次授权检查。
- 该筛选返回同一资源的发布版本，不将 UUID 顺序或发布时间冒充 SemVer 顺序；更新目标选择及实际激活由消费者负责。
- 授权仍绑定 publication。旧版授权不会自动授予新版；更新下载必须使用新版独立票据。

## 迁移与兼容性

0011_mcp_packages.sql 扩展 resources、inspections、versions 的 CHECK 合同，在单一事务中复制、替换并重建索引。
旧列、旧策略和业务记录保留；不修改已上线迁移。独占 linshi 测试后，经用户明确授权执行生产迁移，保全结果见上文。
上线顺序为备份并核对原库、应用新增迁移、验证保全和外键、部署支持新类型的 Worker，最后开放 MCP 上传。
旧代码不识别 MCP，不允许混用旧实例处理新类型写入。回退应用时保留新增记录和包体，不逆向缩表或删除新数据。
迁移失败回滚和重复执行保全沿用 populated 数据库测试；旧版本/票据/审核/审计逐行核对。

## 验收状态

资源库本地测试采用真实 Worker/D1/R2 和明确的合成账号，不冒充线上双账号或宿主执行。
已补四类同资源双版本分发测试，覆盖两版原字节下载、更新独立授权、有界分页、票据跨版本拒绝和撤销后不可发现。
这些测试包仅用于分发验证，不是四类业务使用验收样例。

既有真实 Art 首次下载/安装/执行证据见 UNSCANNED_DISTRIBUTION_STAGE.md。
新增代码生产部署与独立验证已完成；四类线上真实消费者旧版到新版运行仍未完成。MCP 和便携应用的本地消费者进展见下文。
总验收保持未完成，不以局部测试通过替代用户提出的四类全流程标准。

2026-10-17 本地验证记录（目录均位于 C:/Users/Public/nas_home/AI/GameEditor/linshi）：

- assetlibrary-p3-T68oj0/tests.log：13 项通过，覆盖六种未扫描策略、三项 populated 迁移及四类双版本分发。
- assetlibrary-p3-BMnuVn/tests.log：1 项通过，包含原生 MCP 清单/入口/混装六种拒绝场景。
- assetlibrary-p3-MeVDKI/tests.log：24 项邻近回归通过，包含原生归档、下载授权、Web 和打包器。
- assetlibrary-p3-2oTvd7/tests.log：新增 MCP Web/打包器断言后 15 项通过，和上一批有重叠，不累加为独立测试总数。
- TypeScript 类型检查、17 个变更代码/测试文件的 Biome 检查、源码行数检查及 git diff --check 通过。

未运行真实病毒扫描、容器研究、完整依赖漏洞重扫或桌面 UI 验收；未改依赖和锁文件；未提交、推送、生产迁移或部署。

## MCP 消费端续进

2026-10-17 已接通 Loom 的 MCP 云包安装选择与宿主安装器，并修复 MCP 更新后配置保存失败时 active.json 未回滚的问题。
冲突不再删除候选包家族的历史版本。新调用基于新版配置建立 stdio 会话，不承诺升级瞬间终止正在执行的旧调用。

新增可复验命令（在 AssetLibrary 仓库运行，临时目录及 CARGO_TARGET_DIR 放 linshi）：

```powershell
rtk proxy node scripts/verify-loom-mcp-update.mjs C:/Users/Public/nas_home/AI/GameEditor/Neuro/Loom
```

已实际通过两版同资源上传、格式检查、独立 trial 审核、另一主体授权、Loom HTTP 下载、宿主安装和真实 stdio 工具调用，结果分别为 1.0.0、1.1.0。
证据位于 `C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-ZjqZfM/mcp-update-evidence.json`。
真实部分为服务、传输、包体和宿主进程；身份为合成 trial 主体，扫描未执行，生产未部署。
MCP 本地联合闭环通过不替代四类生产目标；真实双账号最终验收仍开放。

## 便携应用消费端续进

2026-10-17 新增 Windows x86_64 小型便携应用安装。沿用 application-zip-format-v1 软件封装，载荷包含 application.json（schemaVersion、version、platform、entry）及真实 EXE。宿主核对文件清单、大小、摘要、平台和发布版本；按资源 UUID 隔离目录，使用独占版本目录和原子 active.json 切换，保留旧版本，不自动执行程序。

当前封装没有应用签名合同，明确标记 unsigned 并执行宿主已有信任策略；RequireTrusted 等拒绝策略不会被绕过。归档损坏、版本不匹配和信任拒绝测试均验证原活动记录不变。该实现不是 Loom 自身升级器，不支持当前单文件 1 MiB、整包 8 MiB 上限以外的完整桌面安装包。

```powershell
rtk proxy node scripts/verify-loom-mcp-update.mjs C:/Users/Public/nas_home/AI/GameEditor/Neuro/Loom application
```

实际通过隔离 Worker/D1/R2 的同资源双版本上传、格式检查、独立审核、另一主体授权及 Loom HTTP 下载、安装、EXE 运行。TextNormalize 1.0.0 将输入 `  alpha  beta  ` 变为 `alpha  beta`，1.1.0 变为 `alpha beta`，并验证旧程序仍存在。
证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-IFfvbt/application-update-evidence.json`。身份仍为 trial 合成主体，未执行病毒扫描，未生产部署。

本轮聚焦回归：Loom cloud_install 8 项通过、1 项要求真实签名 Art 环境的测试跳过；桌面安装服务 4 项通过，TypeScript 和前端构建通过。前端构建不等于生成或替换正在运行的 Loom.exe，也不等于桌面 UI 人工验收。

## Capability 双版本实际执行

2026-10-17 已实际通过真实本地 Worker/D1/R2、独立 trial 发布/审核/下载主体、libaria2 下载、签名检查、安装与权限批准，再启动两版 Capability 进程。进程输出分别为 1.0.0、1.1.0，包摘要不同；新摘要未经批准时拒绝启用或升级。第二版走宿主 upgrade 路径，不以清单版本替代进程运行证据。

证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-hktmyS/capability-update-evidence.json`，含两版发布 ID、包摘要、下载回执及实际执行结果。`cloudVerified=false`、`syntheticIdentity=true`、`malwareScanning=not_performed`；不等于真实账号生产验收或桌面交互通过。

可复验入口为 `scripts/verify-loom-mcp-update.mjs <Loom绝对路径> capability`；先显式运行 Loom 的 ignored 测试 `cloud_generate_capability_update_fixture`，将新建隔离目录传入 `LOOM_CLOUD_SIGNED_FIXTURE_ROOT`。规范打包器重新封装生成目录中的签名原字节，不放宽 ZIP 属性校验。

本轮上线前聚焦回归 29 项通过，包含 populated 迁移失败回滚及重复执行保全、四类双版本分发、MCP 原生包、未扫描策略和 Web/打包器；日志 `C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-p3-uOePmJ/tests.log`。

## libaria2 下载引擎联合验证

2026-10-17 按用户要求将 Loom 下载执行改为进程内 libaria2 DLL，不再启动 aria2c.exe。固定 DLL 的应用和 MCP 两版实际下载、安装及执行重新通过，证据明确记录 downloadEngine=libaria2：

- 应用：C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-OiQLLJ/application-update-evidence.json。
- MCP：C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-YZs9rJ/mcp-update-evidence.json。

两份证据均保留 cloudVerified=false、syntheticIdentity=true、malwareScanning=not_performed。没有恢复病毒扫描，也未执行生产迁移或部署。原生引擎另有真实分段、进度、暂停/继续、取消及卸载测试；暂停/继续尚未接入客户端 UI。DLL 约 2.09 MB，仅引擎文件比此前 EXE 约小 63%，不代表整个安装包或实际下载速度的改进幅度。

实现、构建与未完成发行项见 Loom/docs/ARIA2_DOWNLOAD_ENGINE.md；未交付新桌面程序，四类线上完整更新验收仍未完成。

2026-10-17 后续批次已生成非正式 Loom debug 验收包并接通下载控制，详情见 Loom/docs/LIBARIA2_DELIVERY_VALIDATION.md。依赖迁移后的最新实际 libaria2 联合验证仍通过：应用证据为 C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-00u87n/application-update-evidence.json，MCP 证据为 C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-local-trial-S2UGH1/mcp-update-evidence.json。两者仍为 syntheticIdentity=true、cloudVerified=false、malwareScanning=not_performed，不替代线上四类最终验收。
