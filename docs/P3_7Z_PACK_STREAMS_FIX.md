# 7z packed-stream 范围修补

2026-10-16 在完成 0.4.7 实际部署后复核扫描器，发现固定 ClamAV 1.5.4
源码缺少 [官方 PR #1825](https://github.com/Cisco-Talos/clamav/pull/1825)
中的 `CLAM-3065` 修补。该 PR 在核验时仍为 Open；本项目按精确字节回补，
不冒称它已经进入上游正式版本。

## 目标匹配与适用范围

受控构建 `linshi/assetlibrary-native-build-6JdoVZ/context/source.tar` 中
`libclamav/7z/7zIn.c` 的 canonical Git blob 为
`646c4a1a1c35484dcf186806689ed7b8fe6326b3`，与官方 patch 前像一致。
Windows CRLF 原字节 blob 为 `68aa1f2de1e1e15ea0bb9397fd6d1573f252dfa9`，
两种身份分别记录，不忽略内容差异。

原普通提取路径只验证首个 packed stream 存在，BCJ2 解码还会访问后续项。
新检查器在 `SzReadStreamsInfo` 结束时验证全部 folder 消耗的累计范围，
覆盖普通提取与 encoded-header 的共同解析入口。
外层 ZIP 的路径、大小和摘要限制没有禁止载荷内包含 7z；scanner 仍递归扫描归档，
因此不能用外层受限 ZIP 免除此项。此处是源码可达性分析，不是已复现利用成功。

## 最小实现与身份保护

- 保存原始官方 patch，固定提交 `364526c74f8fdb961326ae89a2ac19d291a521e4`，
  patch SHA256 `64ae95c9aed0bfd5ed4add6e5bf7b9df23be4573900c15a125527db42ad094db`。
- 在隔离 Docker 材料阶段断网核对完整前像、规范 CRLF、执行 `git apply --check`、
  应用补丁并核对完整后像，不修改旧 archive、旧镜像或旧回执。
- 补丁后 canonical blob `c58a7830679a4b6c30839e2864da3353fc752a9a`，实际 LF 字节
  SHA256 `abbeefd3cb30dd0becc6968f359e37db2e61e518596e81ce7140e14fa1331e2b`。
- 收集器记录上游、patch 与实际新源码身份；独立核验同时要求真实 `.o.d`
  编译依赖摘要一致。其他文件仍走原严格字节绑定，不允许未声明补丁。
- C 探针直接包含真实 `7zIn.c`，七项检查覆盖零 folder、单项超限、精确边界、
  累积超限、零 stream、UInt32 最大值及累加溢出边界。

## 当前验证边界

24 项源码/补丁/构建身份聚焦测试通过，完整本地测试 353/353 通过
（`linshi/assetlibrary-p3-nuQww9/tests.log`）；格式、TypeScript 与行数检查通过。
新引擎首轮在 `linshi/assetlibrary-native-build-FzMkt2` 完成断网编译。
随后补齐 sanitizer fail-fast 与 stdout/stderr 联合证据，在独占目录
`linshi/assetlibrary-native-build-v2E1Hc` 完成最终构建和独立重新核验；
镜像为 `sha256:7d1e281f7d77266ab3c18f43df194a2336ec4d24f76030ed01e815c2af96789c`。
七项真实 C 边界用例通过，ASan/UBSan 无诊断，clean/EICAR 与安装摘要核对通过；
所属探针容器已回收，镜像和旧证据保留。
最后的 fail-fast/日志核验增量另经 24 项聚焦测试，未冒充再次运行完整 353 项。
早期独立 C 探针因缺失 ClamAV 生成头文件无法编译，随后改为在真实 CMake
构建环境运行；未将早期尝试记录为通过。

七项检查器边界探针不等于畸形 7z 的普通提取/encoded-header 两路端到端回归，
也不能证明业务层会拒绝所有解析错误归档。完整镜像、签名、AV 业务与云隔离验证
仍须基于新引擎完成；不复用旧候选的通过结果，不改变生产拒绝门禁。
