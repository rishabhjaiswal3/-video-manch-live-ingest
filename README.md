# VideoManch Live Ingest Service

Single service repo that can run:

- Browser WebSocket ingest (`/live/ingest/:videoId?key=...`)
- Optional RTMP server (`rtmp://<host>:1935/live/<streamKey>`) with key validation

## Endpoints

- `GET /health`
- `WS /live/ingest/:videoId?key=<streamKey>` (when `ENABLE_WS_INGEST=true`)

## Modes

Use env toggles:

- `ENABLE_WS_INGEST` (default: `true`)
- `ENABLE_RTMP_SERVER` (default: `false`)

If `ENABLE_RTMP_SERVER=true`, service also starts:

- RTMP port `RTMP_PORT` (default `1935`)
- local HLS HTTP `HLS_HTTP_PORT` (default `8000`)

## Required Environment Variables

- `PORT` (Railway public HTTP port, health + WS upgrade)
- `API_BASE_URL` (e.g. `https://api.videomanch.com`)
- `LIVE_INGEST_SHARED_SECRET` (must match backend)
- `FFMPEG_BIN` (optional, default `ffmpeg`)

Optional RTMP mode variables:

- `RTMP_PORT` (default `1935`)
- `HLS_HTTP_PORT` (default `8000`)
- `MEDIA_ROOT` (default `./media`)

## Backend Requirements

- `GET /live/ingest/validate/:videoId?key=...`
- `GET /live/rtmp/validate/:streamKey`
- `POST /live/ingest/events`

Both must validate `x-live-ingest-secret`.

## Deployment Suggestion

- `ingest.videomanch.com` service:
  - `ENABLE_WS_INGEST=true`
  - `ENABLE_RTMP_SERVER=false`

- `live.videomanch.com` service (same repo, separate deployment):
  - `ENABLE_WS_INGEST=false`
  - `ENABLE_RTMP_SERVER=true`
