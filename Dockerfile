FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS builder

WORKDIR /app

# better-sqlite3 is a native addon. Its install script downloads a prebuilt
# binary and, when that download fails or no prebuild matches the runtime,
# falls back to compiling from source with node-gyp — which needs
# python3/make/g++. Alpine ships none of them, so the fallback died and took
# the whole image build with it. main only stayed green because the GHA layer
# cache was warm; from a cold cache the published image was not reproducible.
# ~150MB in this stage, which is discarded — the production stage below adds
# the same toolchain as a --virtual group and deletes it in the same layer,
# so the shipped image carries none of it.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

# Build dashboard
# NOTE: uses `npm install` not `npm ci` — the Windows-generated lockfile prunes
# Linux-only @emnapi transitive deps that rolldown needs at build time
# (per memory/reference_rolldown_lockfile_trap.md).
# .claims.json feeds the dashboard's build-time defines (vite.config.ts reads
# ../.claims.json for __IRIS_RULE_COUNT__) — must be in the build context.
COPY .claims.json ./
COPY dashboard/ dashboard/
# `npm ci` (not `npm install`): installs exactly what dashboard/package-lock.json
# pins, integrity hashes included, so the image is reproducible and a drifted
# lockfile fails the build loudly instead of resolving to something else.
#
# This used `npm install` because a Windows-generated lockfile prunes the
# Linux-only @emnapi entries rolldown needs, which made `npm ci` fail here
# (reference_rolldown_lockfile_trap). Lockfiles are now regenerated on Linux,
# so that no longer applies — verified on Linux against the current lockfile:
# `npm ci` installs 420 packages (exit 0) and `npm run build` succeeds.
# Closes the Scorecard Pinned-Dependencies finding on this file.
RUN cd dashboard && npm ci && npm run build

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS production

RUN addgroup -g 1001 iris && adduser -u 1001 -G iris -s /bin/sh -D iris

WORKDIR /app
COPY package.json package-lock.json ./
# Same native-addon problem as the builder stage: better-sqlite3's install
# script falls back to a node-gyp source build whenever the prebuild download
# misses, and Alpine has no toolchain. Added as a --virtual group and removed
# inside the SAME RUN, so the layer diff nets to roughly zero and the shipped
# image stays slim while a cold-cache build still succeeds.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && apk del .build-deps

COPY --from=builder /app/dist dist/

RUN mkdir -p /data && chown iris:iris /data

USER iris

# Two settings here are load-bearing, and both were wrong — which is why
# every published image since 2026-03 exited 1 on `docker run`.
#
# PORTS MUST DIFFER. The MCP transport and the dashboard are two servers.
# `validatePortConfig` refuses to start when both are aimed at one port, and
# that check has been in the code since 2026-04-23 while this file kept
# pointing both at 3000. The container did not "mostly work": it failed fast,
# before any bind, with no partial function.
#
# HOSTS MUST BE 0.0.0.0 INSIDE THE CONTAINER. The process defaults to
# 127.0.0.1 — correct on a laptop, and 0.4.6 made it the default to close a
# real LAN-exposure bug. But 127.0.0.1 inside a container's own network
# namespace is unreachable from `-p`, so the loopback default silently turns
# every published port into a connection refused. The exposure control here
# is the container boundary plus whatever the operator publishes with `-p`,
# not the in-container bind address. The DNS-rebinding guard still applies,
# and the startup warning for binding beyond loopback without an API key
# still fires — which is exactly what an operator should see.
ENV IRIS_TRANSPORT=http \
    IRIS_PORT=3000 \
    IRIS_HOST=0.0.0.0 \
    IRIS_DB_PATH=/data/iris.db \
    IRIS_DASHBOARD=true \
    IRIS_DASHBOARD_PORT=6920 \
    IRIS_DASHBOARD_HOST=0.0.0.0

EXPOSE 3000 6920

VOLUME ["/data"]

# No --port/--dashboard-port flags baked in: the ENV above is the single
# source, so an operator overriding IRIS_DASHBOARD_PORT at `docker run` is
# not silently beaten by a CLI flag in the image (CLI wins over env in the
# config merge).
CMD ["node", "dist/index.js"]
