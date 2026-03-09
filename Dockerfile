ARG MEDIAMTX_VERSION=1.9.3

# ── Static FFmpeg from official image (no download needed) ────────────────────
FROM mwader/static-ffmpeg:7.1.1 AS ffmpeg-source

# ── MediaMTX from official image (no download needed) ────────────────────────
FROM bluenviron/mediamtx:v1.9.3 AS mediamtx-source

# ── Build Node.js app ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Final image ───────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# curl – required by MediaMTX runOnReady/runOnNotReady hooks
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy static binaries from their source images
COPY --from=ffmpeg-source /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mediamtx-source /mediamtx /usr/local/bin/mediamtx

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
