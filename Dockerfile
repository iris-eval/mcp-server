FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS builder

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
COPY dashboard/ dashboard/
RUN cd dashboard && npm install && npm run build

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS production

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
