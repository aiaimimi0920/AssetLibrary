FROM clamav/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0 AS materials
USER root
COPY cmake.apk /opt/materials/cmake.apk
# 在线阶段仅取得材料；安装后的工具链和 vendor 字节均进入输入清单。
RUN --mount=type=cache,id=assetlibrary-native-apk-v3.24-amd64,target=/var/cache/apk,sharing=locked \
    apk verify /opt/materials/cmake.apk && apk add --cache-dir /var/cache/apk \
    nodejs=24.18.1-r0 libxml2=2.13.9-r2 pcre2=10.49-r0 nghttp2-libs=1.70.0-r0 \
    bsd-compat-headers /opt/materials/cmake.apk g++ libtool linux-headers make musl-fts-dev \
    bzip2-dev check-dev curl-dev json-c-dev libmilter-dev libxml2-dev ncurses-dev \
    openssl-dev pcre2-dev zlib-dev python3 cargo rust git
ADD source.tar /src/
COPY source-tree.json /opt/native/source-tree.json
WORKDIR /src
RUN mkdir -p /src/.cargo /evidence && cargo vendor --locked --versioned-dirs /src/.cargo/vendor > /src/.cargo/config.toml \
    && cargo metadata --frozen --format-version 1 > /evidence/cargo-metadata.json

FROM materials AS compiled
ENV CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=2
COPY --chmod=755 cargo-record.mjs /opt/native/
# 编译和安装完全断网；保留默认扫描能力，仅关闭不影响 clamscan 的文档、示例和测试构建。
RUN --network=none /sbin/tini -g -- timeout -s KILL 1800 sh -c 'cmake -S /src -B /build -D CMAKE_BUILD_TYPE=Release \
    -D CMAKE_INSTALL_PREFIX=/usr -D CMAKE_INSTALL_LIBDIR=/usr/lib \
    -D APP_CONFIG_DIRECTORY=/etc/clamav -D DATABASE_DIRECTORY=/var/lib/clamav \
    -D ENABLE_CLAMONACC=OFF -D ENABLE_EXAMPLES=OFF -D ENABLE_MILTER=ON \
    -D ENABLE_MAN_PAGES=OFF -D ENABLE_TESTS=OFF -D ENABLE_STATIC_LIB=OFF \
    -D ENABLE_JSON_SHARED=ON -D CMAKE_EXPORT_COMPILE_COMMANDS=ON \
    -D cargo_EXECUTABLE=/opt/native/cargo-record.mjs \
    && cmake --build /build --parallel 2 \
    && DESTDIR=/install cmake --install /build'
# 证明收集独立于昂贵编译层；它逐字节核对原源码和锁文件，不修改任何编译材料。
COPY collect.mjs source-exports.mjs /opt/native/
RUN --network=none node /opt/native/collect.mjs inputs && node /opt/native/collect.mjs outputs

FROM scratch AS proof
COPY --from=compiled /evidence/ /evidence/

FROM clamav/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0 AS runtime
USER root
RUN apk add --no-cache nodejs=24.18.1-r0 libxml2=2.13.9-r2 pcre2=10.49-r0 nghttp2-libs=1.70.0-r0 \
    libcrypto3=3.5.9-r0 libssl3=3.5.9-r0
# 用本轮真实安装结果覆盖官方预编译引擎；不将原镜像二进制冒充本轮构建。
COPY --from=compiled /install/ /
COPY runtime-probe.mjs /opt/native/runtime-probe.mjs
USER clamav
ENTRYPOINT ["clamscan"]
