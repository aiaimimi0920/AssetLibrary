# P3.3f 受控 ClamAV 构建与安装身份

本切片只建立真实编译输入、编译产物和独占本地运行镜像之间的证据链，不开启发布、
下载或云部署。`scanner/Dockerfile` 仍为既有官方候选配方；受控引擎在单独镜像中验证，
不暗中替换当前 Worker 使用的扫描镜像。

## 可执行入口

```powershell
rtk pnpm scanner:native-build
rtk pnpm scanner:native-build <verified-cmake.apk>
rtk pnpm scanner:native-build <verified-cmake.apk> <git-object-cache>
rtk pnpm scanner:native-assess <native-build-directory>
```

首条命令生成独占 `../../linshi/assetlibrary-native-build-*`。在线材料阶段需要 Docker、
GitHub、Alpine APK 仓库和 Cargo 上游访问；第一次取得 Rust/GCC/LLVM 工具链较慢。
编译及证据收集阶段通过 Docker `RUN --network=none` 断网，Cargo 同时使用 `--frozen`。

恢复构建时 GitHub 取回连续两次报 `OpenSSL SSL_connect: SSL_ERROR_SYSCALL`，均未进入
编译。可以显式复用前次保留的 Git 对象仓库；工具仍在新目录 fetch 固定提交、验证
revision 并重新生成 tree/archive，记录缓存来源，不直接接受旧工作树或旧 passed
结果。本轮复用后 tree/archive 摘要与前次在线取回完全一致；没有关闭 TLS 验证。

首轮 Docker 内下载 `cmake-4.2.3-r0` 报 `I/O error`，材料安装 exit 1，未进入编译。
宿主从同一官方 URL 取回 23,946,975 字节，SHA256 为
`960e712886a5453c2c2573364ecc98c28fc7e081270396c5d9a69756caa102c8`；
用原固定基础镜像的 `apk verify` 离线验证签名得到 `OK`。因此命令预先有界取得该
固定 APK，再由 APK 正常验签安装，没有换镜像源或使用 `--allow-untrusted`。
可传入已有文件以复用同一材料，但同样强制长度/摘要匹配。其他 APK 使用独立
BuildKit 缓存，失败后保留已下载材料；这不是跳过包验签或生产漏洞扫描。

## 身份链与职责

1. 从固定官方提交 `fa59fca15872bb8a914ba4c68188bcc8a502cbdf` 取得 Git 对象和 archive。
   仓库为 Cisco-Talos/clamav；拒绝 source tree 内的符号链接、子模块、重复项和路径穿越。
2. 固定同版官方基础镜像 digest，保留 libxml2 ABI。在线准备实际使用的系统工具链，
   执行 `cargo vendor --locked`，保存全量 metadata、所有 vendor 字节摘要、APK 清单/
   数据库摘要，以及编译器、链接器、Rust/Cargo/CMake 可执行文件身份。
   材料阶段另导出不可变 OCI image ID，封存完整编译文件系统，包括编译器后端、
   Rust sysroot、系统链接输入和全部 vendor；不把七个入口文件摘要冒充整个工具链。
3. 保留默认 archive、UnRAR、内置 clammspack、Rust/image 和 bytecode interpreter。
   只关闭 clamonacc、示例、手册和测试构建；未以删掉解析能力来避开依赖。
4. 断网 CMake/Cargo 编译；从实际 Cargo compiler-artifact 消息记录编入包与静态库，
   从真实 `.o.d` 收集 C/C++ 源文件、头文件及生成输入的摘要，保留 compile commands、
   CMakeCache 和 install manifest。
5. 固定上游 `.gitattributes` 的 `export-ignore` 省略六个 Git 元数据文件，不能省略
   生产源码；CMake 生成的 `libnull.a` 单独记账。逐文件保存实际编译字节 SHA256 和
   raw Git blob；Windows archive 的 CRLF 转换仅在按字节移除 CRLF 中的 CR 后精确
   匹配 canonical Git blob 时接受，并明确标记转换，不把实际字节冒充原始 Git 字节。
   锁文件在编译前后不得变化。安装结果封存为 `install.tar`，
   清单记录文件摘要和符号链接。证据收集层与昂贵编译层分开，文案或收集器修改不会
   自动要求重编已缓存的引擎。
6. 运行镜像从独立运行基础层装配，不携带 GCC/Rust/Cargo/CMake。用唯一 owner 标签、
   无网络/只读/无额外 capabilities/4 GiB/1 CPU 的所属容器运行 clean 与 EICAR 样本。
   读回五项引擎二进制、`ldd` 动态链接解析清单/库摘要及运行 APK 清单，绑定到镜像
   config digest。`ldd` 不是对所有运行路径的动态加载追踪，不能外推为完整 runtime SBOM。
7. 容器回收后才签发 `receipt.json`；所有冻结上下文、证明、日志和清理证据摘要进入
   回执。`scanner:native-assess` 重新检查原始文件，不以旧 passed 文案代替当前验证。

源码完整性复核不等于独立发布签名验证或可复现构建。APK 工具链的具体解析版本和
二进制身份是本轮材料事实，不宣称不同日期重建一定得到同一镜像；尚未加入材料
镜像的独立签名、离线镜像仓库及供应链证书。

## 有界性与清理

外部命令不经 shell 拼接，日志最多 32 MiB，普通命令 90 秒，断网构建客户端最长
40 分钟，容器内配置/编译/安装步骤另由 30 分钟 `timeout` 约束，Cargo wrapper
为 25 分钟。完整默认 Rust 构建已实测接近 19 分钟，不能以过小预算制造失败。
BusyBox `timeout` 直接作为 PID 1 时曾未按期终止，因此编译层使用
`/sbin/tini -g -- timeout -s KILL 1800`；同一基础镜像的一秒超时实测约 1.7 秒退出
137，未执行后续命令、所属测试容器无残留。Windows 超时仅
终止本次已知 PID 的客户端进程树；BuildKit daemon 独立
于这些 PID，因此失败或取消后还应核查对应 build 状态，不能声称进程树终止就等于
后台 build 已停止，也不能为了清理而停止其他人的 Docker daemon。

只回收名字、owner 标签及 image ID 均匹配的本轮容器；不删除镜像、既有容器、
数据库、对象或历史证据。探测创建前先记录清理责任，失败时也检查所属容器是否存在。
失败写入 `failure.json`，不生成成功回执。新构建不会安装定时任务或调用 Cloudflare。

## 验收与剩余门禁

首次完整编译的断网配置/构建/安装层用时 831.8 秒，Rust release 为 12 分 12 秒；
输入和安装证明已导出。随后 1 GiB 探针的两次 clamscan 均返回 null，容器检查明确
记录 `OOMKilled:true`，因此未产生成功回执。探针预算修正为现有 scanner 本地验收
同样使用的 4 GiB，保留进程退出信号、错误码、耗时和最终 OOM 状态，复用已通过的
编译层重新验证，不将 OOM 误判为安全 clean。

固定基础镜像自带 daily 28136（2026-09-27），本轮探针保留其超过七天的原始警告，
不把检测到 EICAR 当作签名时效通过；活动候选的 daily 28143 没有被该旧库替换。

2026-10-05 的最终本地回执为（相对 AssetLibrary 根目录）：
`../../linshi/assetlibrary-native-build-cNs0V6/receipt.json`。

| 项目 | 实测结果 |
| --- | --- |
| 固定 Git tree | 1,438 文件；实际导出 1,432；仅省略 6 个 Git 元数据文件 |
| Windows archive 转换 | 1,144 文件有 CRLF 转换；实际字节与 canonical Git blob 双重记账 |
| Cargo 解析 / 实际编译包 | 291 / 244 |
| C/C++ 实际输入 / 安装文件及链接 | 908 / 36 |
| clean | exit 0，`stdin: OK`，18,145 ms |
| EICAR | exit 1，`Eicar-Test-Signature FOUND`，21,180 ms |
| 退出信号 / 进程错误 / OOM | 均无，4 GiB 上限，所属容器已回收 |

运行镜像：`sha256:4cf20de0adc8e5613939f7db7b8d1addf4ee34ed1989a7d07a448a89917613d1`。
完整材料镜像：`sha256:97a1a72b2615ce0d1a58c62729ce780e7f6929e1970c327ef6589e0cc3dc5e25`。
实际安装归档 SHA256：`5ca3021221dda3dd8ba30f46dc3d13eb029e063aa4f06ae04893dadb85bdc953`。
回执只有在样本和二进制身份通过、所属容器回收后生成；失败目录及旧镜像全部保留。

最终门禁和 `.10` Worker 候选交付索引位于
`../../linshi/assetlibrary-native-build-resume-20261005/final-delivery.json`。
新候选的 `native-build-binding.json` 绑定 Worker manifest 和 native receipt 摘要，
不表示活动扫描镜像已经替换。仅在当前运行文件与 `.9` 摘要一致时复用原运行证据。

即使构建身份通过，以下状态仍始终为 false：

```text
supplyChainValidated
cloudValidationEligible
publicationEligible
productionReady
```

必须继续完成原生组件漏洞归属/复核、新镜像的完整漏洞报告、新引擎 Art ZIP/扫描
协议回归、新镜像隔离云验证、签名实际切换/回滚及生产沙箱边界。P3.3e 的 Cargo
源码报告不隐藏、不因受控编译而自动豁免。原 `SCANNER_CLOUD_NOT_VALIDATED` 门禁不变。
