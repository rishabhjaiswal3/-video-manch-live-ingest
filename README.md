# VideoManch Live Ingest Service

WebSocket ingest service for browser live streaming.

## Endpoints

- `GET /health`
- `WS /live/ingest/:videoId?key=<streamKey>`

## How It Works

1. Client connects to `WS /live/ingest/:videoId?key=...`
2. Service validates key with backend `GET /live/ingest/validate/:videoId?key=...`
3. Service spawns `ffmpeg`, reads WebM chunks from WS, pushes RTMP to `${RTMP_INGEST_URL}/{streamKey}`

## Required Environment Variables

- `PORT` (Railway provides automatically)
- `API_BASE_URL` (e.g. `https://api.videomanch.com`)
- `LIVE_INGEST_SHARED_SECRET` (must match backend)
- `RTMP_INGEST_URL` (optional, defaults to `rtmp://live.videomanch.com/live`)
- `FFMPEG_BIN` (optional, defaults to `ffmpeg`)

## Railway Setup

1. Create a new Railway service from this folder.
2. Ensure ffmpeg is installed in runtime image.
3. Set env vars above.
4. Expose the service publicly.
5. Verify:
   - `https://<railway-domain>/health` -> `200`
6. Point Cloudflare `live.videomanch.com` to this Railway domain.

## Backend Requirement

Backend must expose:

- `GET /live/ingest/validate/:videoId?key=...`

with `x-live-ingest-secret` header verification.
