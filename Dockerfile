FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

# Build dashboard
COPY dashboard/ dashboard/
RUN cd dashboard && npm ci && npm run build

FROM node:20-alpine AS production

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
