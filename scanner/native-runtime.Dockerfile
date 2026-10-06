FROM clamav/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0
RUN apk add --no-cache nodejs=24.18.1-r0 libxml2=2.13.9-r2 pcre2=10.49-r0 nghttp2-libs=1.70.0-r0 \
    libcrypto3=3.5.9-r0 libssl3=3.5.9-r0
# 只接受已经核验并绑定到 native receipt 的完整安装归档；不用官方预编译引擎冒充受控产物。
ADD install.tar /
ARG SCANNER_SIGNATURE_REFRESH=unmanaged
LABEL neuro.signature-refresh=$SCANNER_SIGNATURE_REFRESH
RUN node --version && freshclam --user=root --stdout --no-warnings && chown -R root:root /var/lib/clamav && chmod -R a=rX /var/lib/clamav
WORKDIR /app
COPY database.mjs process.mjs server.mjs limits.mjs ./
HEALTHCHECK NONE
USER clamav
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.mjs"]
