ARG NODE_IMAGE=node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate && \
    pnpm install --frozen-lockfile

FROM dependencies AS build
ARG SOURCE_COMMIT
ARG SOURCE_URL
RUN test "${#SOURCE_COMMIT}" -eq 40 && \
    case "${SOURCE_COMMIT}" in *[!0-9a-f]*) exit 1 ;; esac && \
    case "${SOURCE_URL}" in https://*) ;; *) exit 1 ;; esac
COPY apps/web/ ./
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_COMMIT
ARG SOURCE_URL
ARG VERSION
LABEL org.opencontainers.image.title="Neuro AssetLibrary web" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.source="${SOURCE_URL}"
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --chown=node:node --from=build /app/.next/standalone ./
COPY --chown=node:node --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
