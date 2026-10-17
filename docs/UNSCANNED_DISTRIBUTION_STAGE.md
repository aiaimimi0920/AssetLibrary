# 未扫描业务包分发阶段

## 2026-10-16 用户决定

暂停扫描器相关开发、研究及策略研究；扫描机制后续由用户自行完成。当前阶段明确允许用户上传和下载未经恶意代码扫描的业务包，包括正式服务，不局限于本地模拟。

这项决定取代旧计划中将扫描器验收作为生产发布和下载前置条件的要求，但不表示现有代码或线上门禁已经改变。历史扫描结果、研究文件和验收记录保留，不伪造 clean 或 cloudValidated，不将旧扫描策略重新解释为未扫描策略。

## 唯一阶段验收终点

1. A 使用真实账号上传“颜色迁移”Art 原生包至 AssetLibrary，完成必要的资源、版本、审核和发布操作。
2. B 使用不同的真实账号，在实际交付的 Loom 客户端中发现该包，获得下载权限，并下载和安装。
3. B 在 Loom 中使用该 Art，输入源图和参考图，实际生成可查看的处理结果。
4. 记录线上版本、桌面包身份、资源与版本 ID、包体 SHA-256 和运行结果；未扫描状态明确，不冒称经过安全检测。

只通过 API 测试、保存 ZIP、显示安装成功，或使用合成身份的本地联合测试，不满足此终点。

## 保留的业务边界

- 保留身份认证、主体隔离、独立审核、授权、撤销、下架、幂等及审计。
- 保留大小预算、ZIP 路径边界、格式与清单检查、原字节和摘要验证。
- 保留 Loom 的发布者签名、信任策略、框架依赖及运行完整性验证。允许未扫描不自动允许伪造发布者或使用测试密钥冒充正式信任。
- 保留现有数据和账号会话，不清空数据库、对象存储或用户桌面配置。
- 只推进完成此链路所需的 AssetLibrary 与 Loom 接线、打包和上线，不扩展为扫描器或其他服务重构。

## 本轮源码核查与待实施项

- `db/0009_loom_native_packages.sql` 中 `inspections` 和 `versions` 的 CHECK 限制策略白名单，原生包 passed 还必须包含 clean 扫描结果。
- 发布、目录、票据及内容读取均依赖扫描准入，不能只放开一个 HTTP 入口。
- Loom 前端 `cloudPackageInstall.ts` 和 daemon `asset_library/install.rs` 均匹配 `loom-{kind}-zip-clamav-v1`，必须与新格式策略同步。
- Loom 样例 `art-packages/samples/color-transfer` 的名称为“颜色迁移”，ID 为 `custom-1770131241684`，执行需要 process 框架及 Python。正式签名信任和实际运行环境尚待核验。
- 当前桌面交付尚不能据旧本地测试认定已包含新原生安装接线，需冻结对应源码后构建并验证。

实施采用独立的仅格式校验策略，扫描状态如实标记为未扫描；不借用 `clamav` 策略写入假扫描事实。扩展数据库 CHECK 涉及保数据表结构迁移，线上执行前须备份、验证既有数据与外键，并取得涉及替换旧表操作的明确批准。当前尚未执行迁移、发布代码或部署服务。

## 已获批准及本地实现

用户随后明确回复“同意”，已批准上述保数据迁移，不需要再次询问同一授权。

- `0010_unscanned_packages.sql` 增加四个独立格式策略，保留原策略、原记录及全部已有约束；新策略明确要求 `not_scanned` 且没有 `scan` 事实。
- 格式校验、版本审核、发布、目录、票据和流式下载已接通；未扫描票据使用五分钟期限，保留主体、授权 revision、下架与当前对象绑定。
- Web 增加未扫描策略选项；Loom 前端及 daemon 接受新原生策略，但保留原安装器的发布者签名、框架及权限验证。
- `/readyz` 和 SBA 独立验证同步使用 `unscanned-packages` 合同，不再将当前分发模式描述成等待 scanner 的全局阻断。
- 首轮聚焦 6 项通过；扩展至四个新增策略和业务/SBA 邻近后 53 项通过。证据分别为 `linshi/assetlibrary-p3-DSIkcb/tests.log` 和 `linshi/assetlibrary-p3-XL2tUK/tests.log`。
- Loom 安装后端聚焦 4 项通过、1 项真实签名 Art 测试因未提供独占材料而忽略；前端安装服务 3 项通过，TypeScript 与严格行数通过。忽略项不算实际 Art 使用成功。

本轮实时读回正式站点仍为 `0.4.7` / `1d8a19fb9af220081d4fc8bcc9bc1b5511f5a5f6`，分发仍是旧扫描门禁。SpringBok 现有服务实例与旧独立 verify 可读。尚未提交、推送或部署本次源码，未修改线上数据库，也未更新运行中的桌面程序。

后续完整本地回归 362 项通过、0 失败、0 跳过，日志 `linshi/assetlibrary-p3-F5Sk4J/tests.log`。Biome、TypeScript、有效行数、依赖审计及 diff 检查通过。准备版本 `0.4.8`；该版本号准备不等于已部署。

## 发布及当前部署停点

本次 33 个文件已独立提交并推送 `a11999ade90b775cb72c33105320e9e5ec9918c5`，远端 main 读回一致，GitHub Release `v0.4.8` 已发布。原有扫描器研究 dirty 文件没有进入该提交。

从此提交创建的独立干净副本 `linshi/assetlibrary-v048-release-a11999a` 以原锁文件安装依赖，再通过四个未扫描策略、两项迁移及三项 SBA 合同，共 9 项；证据 `linshi/assetlibrary-p3-7Dqa6e/tests.log`。离线依赖缓存最初不完整，随后正常固定锁安装成功，没有升级依赖。

SpringBok 升级表单实际请求返回 `Failed to fetch`；刷新明确转到 Cloudflare Access 登录页，确认旧会话已过期，已请用户在原标签页重新登录。没有发起部署任务、没有执行线上 `0010`，不得绕开 Access 或用重复提交猜测结果。用户完成登录后，按原实例升级至固定 `v0.4.8`，再独立 verify、交付新 Loom 桌面包并完成真实 Art 使用验收。

## 登录恢复后的实际交付

用户确认重新登录后，已在原实例 `dc-b20cc87beb7b44c0aa5c73eec88a7292` 完成升级，不重复申请已批准的迁移。

- update：`dc-e878d41cad994dcbbee08452f9774e92`，GitHub run `38993209031`；版本 `0.4.8`、源码 `a11999ade90b775cb72c33105320e9e5ec9918c5`。回执 `deployed-unverified`，备份创建、数据保留、部署绑定等七项通过。
- 独立 verify：`dc-9f5cde1f553b4884ac468a06e74285bb`，run `38993797217`；回执 `succeeded`，四项通过。检查 ID `scanner-admission-verified` 是沿用的历史名称，本版本核对未扫描分发模式，并不表示扫描器验收通过。
- 实时 `/healthz` 与固定版本及 SHA 一致；`/readyz` 的身份、数据库、存储均 available，分发为 `available / unscanned-packages / malwareScanning:not_required`。
- Loom 新桌面包：`linshi/loom-unscanned-20261016-r1/package/manual-20261016-unscanned-native-art-r1/Loom.exe`。完整重编译，未复用旧 EXE；1,713 个源码文件构建前后摘要一致，50 项包完整性通过。源码快照保留现有 dirty，未覆盖运行中的客户端或配置。
- 包内 `packages/arts/custom-1770131241684.zip` 为颜色迁移原生包，18,647 字节，SHA-256 `f8622ef9b0478dda1aad28de344911bd61b4360a84ca275befba24ce64eee546`。真实结构预检通过，证据 `linshi/assetlibrary-loom-preflight-mryzPF/receipt.json`。
- 新包 daemon 与 process 框架在独立临时状态中实际安装并执行颜色迁移，8×8 输入生成 314 字节 PNG；输出摘要 `284f34afb15cea023e6e6b4f3b673d3afc2acb28e92eb0384388260a9b7a69cc`，与输入不同。证据 `linshi/loom-unscanned-20261016-r1/color-art-runtime/execution.json`；测试进程已退出。

上述实际运行使用隔离本地默认信任策略，不使用真实 A/B 账号，也没有走线上下载。未签名包不等于正式可信签名；没有变更用户信任库。最终双账号上传、独立审核、授权、Loom 下载并实际使用仍待人工验收。正式页面仍有少量旧“尚未开放”说明，不能据旧说明否定上述实际服务状态，也不能把 readiness 当成业务终点。

## 2026-10-17 新桌面实际切换

桌面控制成功读取 Loom。发现仍运行旧 `manual-20261016-live-refresh-fix-r2`，窗口显示空白。关闭按钮坐标失败，随后 Alt+F4 未终止进程（配置启用了关闭到托盘）；按精确旧包路径停止桌面和 daemon，没有删除任何文件或登录配置。启动新 `manual-20261016-unscanned-native-art-r1` 后，首个工具调用因尚未出现窗口返回超时，随后窗口与进程均确认正常。

新桌面与 daemon 实际路径都指向 unscanned-native-art-r1。真实设置页面显示保留的 NAccount 账号 `vmjcv666@gmail.com`，无需重新登录。实际点击“读取可下载内容”，请求由“正在处理…”结束为“暂无可下载内容”，按钮恢复，未出现旧 scanner 分发阻断错误。这证明新客户端和真实账号的正式下载目录读取，不证明已下载、安装或运行线上发布包。旧包和用户配置保持保留，新客户端继续运行。下一步仍是另一真实账号上传、独立审核与发布授权，然后用当前下载账号完成安装和实际使用。

## 2026-10-17 真实双账号业务链路验收

已通过真实 Edge 页面使用 111 账号上传、666 账号独立审核，再由 111 发布并授予 666 下载权限。复用原空资源并改名为“颜色迁移 Art”，没有重复创建资源或删除历史数据。

- owner：`308008d6-2fad-4585-950a-b9861530cc22`；审核者及下载者：`e7b183d6-a81f-485a-9c89-32750b1346d0`。
- resource：`a66802da-1770-4e25-977d-5f3553ed72e6`，revision 2。
- upload：`d605be31-b78c-43c8-8951-b1058698a1e7`；inspection：`222772bb-44ab-473c-95c5-fcbec17f676a`，`loom-art-zip-format-v1 / passed / not_scanned`。
- version：`658314e9-e9f0-4c32-b284-5b9fe2056fb9`，`0.1.4 / approved / revision 2`。
- publication：`99406bbd-98da-4e6c-9d67-295b82ba68a4`，`published / revision 1`；下载授权为 `active / revision 1`。
- 包体仍为 18,647 字节，SHA-256 `f8622ef9b0478dda1aad28de344911bd61b4360a84ca275befba24ce64eee546`；未进行恶意代码或病毒检测，未伪造 clean 或 cloudValidated。

本轮原生桌面控制未开放。启动已交付 Loom 后，通过其现有回环服务接口操作真实用户实例，不使用隔离模拟身份。初次目录读取因旧访问令牌返回 `naccount_login_required`，正常调用 refresh 后保留 666 身份并成功读取上述发布。随后 `/v1/asset-library/install` 从正式站点重新申请票据、下载并安装；下载磁盘文件摘要独立核对一致，安装回执 `trustStatus: unsigned`，未修改信任策略。调用实际 `/v1/tools/custom-1770131241684/execute`，输入源图和参考图，返回 `succeeded`，生成 314 字节 PNG，摘要 `284f34afb15cea023e6e6b4f3b673d3afc2acb28e92eb0384388260a9b7a69cc`，与源图不同。

证据目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/assetlibrary-live-acceptance-20261017`，包含 `acceptance-evidence.json`、`loom-cloud-install.json`、`loom-execution.json`、输入/输出 PNG 和 `publication-and-grant.jpg`。实时线上仍为 `0.4.8 / a11999ade90b775cb72c33105320e9e5ec9918c5`，readiness 确认未扫描分发可用。

结论：真实 A 上传、独立审核、发布授权、真实 B 经 Loom 服务下载、安装、运行的业务链路通过；Loom 原生界面的点击、刷新和结果展示尚未重新验收，不能把服务接口通过写成完整桌面交互通过。页面仍有旧“当前未准入”等误导文案，本轮未修改产品源码，也未新增提交或部署。
