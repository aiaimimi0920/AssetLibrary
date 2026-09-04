ARG RUST_IMAGE=rust@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

FROM ${RUST_IMAGE} AS build
WORKDIR /src
ARG PACKAGE
ARG BINARY
ARG SOURCE_COMMIT
ARG SOURCE_URL
RUN case "${PACKAGE}:${BINARY}" in \
      assetlibrary-api:assetlibrary-api|\
      assetlibrary-scanner-worker:assetlibrary-scanner-worker|\
      assetlibrary-outbox-worker:assetlibrary-outbox-worker|\
      assetlibrary-indexer-worker:assetlibrary-indexer-worker|\
      assetlibrary-cleanup-worker:assetlibrary-cleanup-worker) ;; \
      *) echo "unsupported package/binary pair" >&2; exit 1 ;; \
    esac && \
    test "${#SOURCE_COMMIT}" -eq 40 && \
    case "${SOURCE_COMMIT}" in *[!0-9a-f]*) exit 1 ;; esac && \
    case "${SOURCE_URL}" in https://*) ;; *) exit 1 ;; esac
COPY . .
RUN cargo build --locked --release --package "${PACKAGE}" --bin "${BINARY}" && \
    cp "target/release/${BINARY}" /tmp/assetlibrary-service

FROM ${RUNTIME_IMAGE} AS runtime
ARG SOURCE_COMMIT
ARG SOURCE_URL
ARG VERSION
LABEL org.opencontainers.image.title="Neuro AssetLibrary service" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.source="${SOURCE_URL}"
WORKDIR /app
COPY --from=build /tmp/assetlibrary-service /app/service
USER nonroot:nonroot
ENTRYPOINT ["/app/service"]
