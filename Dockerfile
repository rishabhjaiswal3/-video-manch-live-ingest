ARG MEDIAMTX_VERSION=v1.9.3

# ── Build Node.js app ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Download static binaries (MediaMTX + FFmpeg) ──────────────────────────────
# Using static builds avoids apt-get dependency chains in the final image.
FROM debian:bookworm-slim AS downloader
ARG MEDIAMTX_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar xz-utils \
    && rm -rf /var/lib/apt/lists/*

# MediaMTX
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

# Static FFmpeg (johnvansickle.com) – single binary, zero runtime deps
RUN set -eux; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
      x86_64)  FF_ARCH=amd64 ;; \
      aarch64) FF_ARCH=arm64 ;; \
      armv7l)  FF_ARCH=armhf ;; \
      *)       FF_ARCH=amd64 ;; \
    esac; \
    curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${FF_ARCH}-static.tar.xz" \
      | tar xJ --strip-components=1 -C /usr/local/bin --wildcards '*/ffmpeg'; \
    chmod +x /usr/local/bin/ffmpeg

# ── Final image ───────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# curl – required by MediaMTX runOnReady/runOnNotReady hooks
# ca-certificates – needed for HTTPS requests in curl
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=downloader /usr/local/bin/mediamtx /usr/local/bin/mediamtx
COPY --from=downloader /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY mediamtx.yml ./mediamtx.yml

ENV NODE_ENV=production \
    FFMPEG_BIN=/usr/local/bin/ffmpeg \
    MEDIAMTX_BIN=/usr/local/bin/mediamtx \
    MEDIAMTX_CONFIG=/app/mediamtx.yml

# PORT 3001 – Node.js HTTP + WebSocket
# PORT 1935 – RTMP ingest (MediaMTX, when ENABLE_RTMP_SERVER=true)
# PORT 8888 – HLS output  (MediaMTX, when ENABLE_RTMP_SERVER=true)
EXPOSE 3001 1935 8888

CMD ["node", "dist/index.js"]
