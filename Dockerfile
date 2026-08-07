FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

WORKDIR /app
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

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS production

RUN addgroup -g 1001 iris && adduser -u 1001 -G iris -s /bin/sh -D iris

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist dist/

RUN mkdir -p /data && chown iris:iris /data

USER iris

ENV IRIS_TRANSPORT=http \
    IRIS_PORT=3000 \
    IRIS_DB_PATH=/data/iris.db \
    IRIS_DASHBOARD=true \
    IRIS_DASHBOARD_PORT=3000

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "dist/index.js", "--transport", "http", "--port", "3000", "--dashboard"]
