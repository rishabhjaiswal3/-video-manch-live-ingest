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
- HLS is also served by this service on `GET /live/*` via `PORT` (recommended public endpoint)

## Required Environment Variables

- `PORT` (Railway public HTTP port, health + WS upgrade)
- `API_BASE_URL` (e.g. `https://api.videomanch.com`)
- `LIVE_INGEST_SHARED_SECRET` (must match backend)
- `FFMPEG_BIN` (optional, default `ffmpeg`)
  - Recommended in containers: `FFMPEG_BIN=/usr/bin/ffmpeg`

Optional RTMP mode variables:

- `RTMP_PORT` (default `1935`)
- `HLS_HTTP_PORT` (default `8888` in code; README historically said `8000` — check your deploy)
- `MEDIA_ROOT` (default `./media`)

### Low-latency HLS (when `ENABLE_RTMP_SERVER=true`)

MediaMTX emits **Low-Latency HLS** by default so **video-manch-player** (embedded in **video-manch-watch**) can use Hls.js `lowLatencyMode` with shorter startup delay. Requires a MediaMTX build that supports `hlsVariant: lowLatency` (v1.x current).

| Variable | Default | Purpose |
|----------|---------|---------|
| `HLS_VARIANT` | `lowLatency` | Set `mpegts` or `fmp4` if you need wider device support (no partial segments). |
| `HLS_SEGMENT_DURATION` | `1s` | MediaMTX segment target; must align with encoder keyframes for WebM ingest. |
| `HLS_PART_DURATION` | `200ms` | LL-HLS part size (only when variant is `lowLatency`). |
| `HLS_SEGMENT_COUNT` | `8` | Playlist depth / DVR window. |
| `HLS_ALWAYS_REMUX` | `true` | Start muxing before first viewer (faster first frame). Set `false` to save CPU when idle. |
| `HLS_SEGMENT_SEC` | `1` | Numeric seconds for FFmpeg `-g` / `-keyint_min` (browser WebM→RTMP path). Keep in sync with `HLS_SEGMENT_DURATION`. |
| `HLS_ENCODE_FPS` | `30` | Output FPS for WebM transcoding path (must match GOP math). |

**Browser ingest:** FFmpeg uses GOP = `HLS_ENCODE_FPS * HLS_SEGMENT_SEC` so each segment starts on a keyframe. If you change `HLS_SEGMENT_DURATION` to `2s`, set `HLS_SEGMENT_SEC=2` and restart.

**OBS / hardware RTMP:** Video is often `copy` through FFmpeg when using Safari `container=mp4`; keyframe interval is controlled at the encoder (OBS “Keyframe interval” ≈ segment duration).

### Reliability, proxy, and API calls

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_FETCH_TIMEOUT_MS` | `15000` | Timeout for validate / ingest-events / CF API (avoids stuck sockets). |
| `INGEST_EVENT_MAX_ATTEMPTS` | `3` | Retries for `POST /live/ingest/events` with backoff (state sync to watch-backend). |
| `HLS_PROXY_ORIGIN_TIMEOUT_MS` | `180000` | Max time for a single MediaMTX subrequest (LL-HLS playlists can block). |
| `MEDIAMTX_READ_TIMEOUT` | `60s` | MediaMTX global read timeout — **must** exceed LL-HLS blocking playlist wait (default 10s breaks live). |
| `MEDIAMTX_WRITE_TIMEOUT` | `60s` | MediaMTX write timeout. |
| `MAX_CONCURRENT_WS_STREAMS` | `0` | Cap browser-ingest WebSockets per process (`0` = unlimited). Set e.g. `48` for predictable RAM on small VMs. |

### Health checks for orchestration

- `GET /health` — always 200; includes `hls.status` and `capacity.activeWsIngests`.
- `GET /ready` — **503** if `ENABLE_RTMP_SERVER=true` and MediaMTX HLS port is unreachable (use for Kubernetes/Railway health).

### Scaling beyond one instance (you must still do this in infra)

1. **Ingest:** One active **WebSocket** publisher per `videoId` is enforced in code. Horizontal scale = many instances, **sticky routing** or **one stream key → one instance** (Redis coordination not in this repo).
2. **Viewers:** Use **video-manch-live-hls-worker** (Cloudflare) in front of origin; increase origin RAM/CPU or enable **CF_STREAM_MODE** for CDN-native live.
3. **OBS RTMP:** Put **MediaMTX** (or this service with `ENABLE_RTMP_SERVER`) behind TCP load balancer; each publisher still lands on one node.
4. **Database / API:** watch-backend must stay fast on `/live/*` validate and events (rate limits, indexes on `streamKey`).

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
