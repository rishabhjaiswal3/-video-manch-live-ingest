ARG MEDIAMTX_VERSION=v1.9.3

# ── Build Node.js app ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Download MediaMTX binary ──────────────────────────────────────────────────
FROM debian:bookworm-slim AS mediamtx-downloader
ARG MEDIAMTX_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
      x86_64)  MTX_ARCH=amd64 ;; \
      aarch64) MTX_ARCH=arm64v8 ;; \
      armv7l)  MTX_ARCH=armv7 ;; \
      *)       MTX_ARCH=amd64 ;; \
    esac; \
    curl -fsSL \
      "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_${MTX_ARCH}.tar.gz" \
      | tar xz -C /usr/local/bin mediamtx; \
    chmod +x /usr/local/bin/mediamtx

# ── Final image ───────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# ffmpeg – for WebM→H264 transcoding
# curl   – required by MediaMTX runOnPublish/runOnUnpublish hooks
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=mediamtx-downloader /usr/local/bin/mediamtx /usr/local/bin/mediamtx

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY mediamtx.yml ./mediamtx.yml

ENV NODE_ENV=production \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    MEDIAMTX_BIN=/usr/local/bin/mediamtx \
    MEDIAMTX_CONFIG=/app/mediamtx.yml

# PORT 3001 – Node.js HTTP + WebSocket
# PORT 1935 – RTMP ingest (MediaMTX, when ENABLE_RTMP_SERVER=true)
# PORT 8888 – HLS output  (MediaMTX, when ENABLE_RTMP_SERVER=true)
EXPOSE 3001 1935 8888

CMD ["node", "dist/index.js"]
