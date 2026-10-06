FROM clamav/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0
# 官方同版本 Alpine 构建保留 libxml2.so.2 ABI，避免混装 Debian unstable 或自制兼容链接。
# Node 使用同一发行版维护的 musl 包，使二进制及动态依赖进入 APK 漏洞清单。
RUN apk add --no-cache nodejs=24.18.1-r0 libxml2=2.13.9-r2 \
    pcre2=10.49-r0 nghttp2-libs=1.70.0-r0
# 候选验证每次传入唯一值，使 freshclam 层不能复用；不在运行时开放网络更新。
ARG SCANNER_SIGNATURE_REFRESH=unmanaged
LABEL neuro.signature-refresh=$SCANNER_SIGNATURE_REFRESH
RUN node --version && freshclam --user=root --stdout --no-warnings && chown -R root:root /var/lib/clamav && chmod -R a=rX /var/lib/clamav
WORKDIR /app
COPY database.mjs process.mjs server.mjs limits.mjs ./
# 本服务运行 clamscan 而不是 clamd；原生 DO 使用 /healthz 探测。
HEALTHCHECK NONE
USER clamav
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.mjs"]
