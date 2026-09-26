FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

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

# Dashboard dependencies BEFORE the build: since 0.13.0 `npm run build` is
# one command that builds the dashboard, then the server — the
# artifact no longer depends on a second build step that CI remembers.
# .claims.json feeds the dashboard's build-time defines (vite.config.ts reads
# ../.claims.json for __IRIS_RULE_COUNT__) — must be in the build context.
# `npm ci` (not `npm install`): installs exactly what dashboard/package-lock.json
# pins, integrity hashes included, so the image is reproducible and a drifted
# lockfile fails the build loudly instead of resolving to something else.
# (This used `npm install` because a Windows-generated lockfile pruned the
# Linux-only @emnapi entries rolldown needs; lockfiles are regenerated on
# Linux now. Closes the Scorecard Pinned-Dependencies finding on this file.)
COPY .claims.json ./
COPY dashboard/ dashboard/
RUN cd dashboard && npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts/build-dashboard.mjs scripts/
COPY src/ src/
RUN npm run build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS production

# OCI image labels. The GHCR package page and `docker inspect`
# read these; until 0.15.0 the image carried none, so the package page had
# no description and no link back to the source. The static ones live here
# so a local build carries them too; version, revision and created are
# stamped by the release workflow (docker/build-push-action `labels:`),
# which knows the tag and the commit.
LABEL org.opencontainers.image.title="Iris"       org.opencontainers.image.description="Stop shipping agents on vibes. Score every agent output for quality, safety, and cost. MCP server, HTTP ingest and dashboard in one image."       org.opencontainers.image.source="https://github.com/iris-eval/mcp-server"       org.opencontainers.image.url="https://iris-eval.com"       org.opencontainers.image.documentation="https://github.com/iris-eval/mcp-server#readme"       org.opencontainers.image.vendor="iris-eval"       org.opencontainers.image.licenses="MIT"

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
# and since 0.13.0 a bind beyond loopback with no API key is REFUSED at boot
# (src/utils/bind-policy.ts): a bare `docker run` of this image stops with
# one sentence naming IRIS_API_KEY. Run it with `-e IRIS_API_KEY=...`, or
# `-e IRIS_ALLOW_UNAUTHENTICATED=1` to run open on purpose.
ENV IRIS_TRANSPORT=http \
    IRIS_PORT=3000 \
    IRIS_HOST=0.0.0.0 \
    IRIS_DB_PATH=/data/iris.db \
    IRIS_DASHBOARD=true \
    IRIS_DASHBOARD_PORT=6920 \
    IRIS_DASHBOARD_HOST=0.0.0.0

EXPOSE 3000 6920

VOLUME ["/data"]

# The container's own liveness: the MCP transport's /health is
# unauthenticated, rate-limit exempt, and the same contract the dashboard
# serves at /api/v1/health (src/health.ts) — 200 when storage, the rules
# store and the migrations all check out, 503 otherwise. Node's own fetch,
# so the probe needs no curl or wget in the image; the port is read from
# the same ENV the process reads, so an operator who overrides IRIS_PORT
# does not silently break the probe. `docker inspect` shows the state;
# compose and orchestrators gate on it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD node -e "fetch('http://127.0.0.1:' + (process.env.IRIS_PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# No --port/--dashboard-port flags baked in: the ENV above is the single
# source, so an operator overriding IRIS_DASHBOARD_PORT at `docker run` is
# not silently beaten by a CLI flag in the image (CLI wins over env in the
# config merge).
CMD ["node", "dist/index.js"]
