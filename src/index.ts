import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';

interface WsValidationResponse {
  success: boolean;
  data?: {
    videoId: string;
    streamKey: string;
    rtmpUrl: string;
    isLive: boolean;
  };
  error?: string;
}

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3001);
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.videomanch.com';
const LIVE_INGEST_SHARED_SECRET = process.env.LIVE_INGEST_SHARED_SECRET || '';

const ENABLE_WS_INGEST = process.env.ENABLE_WS_INGEST !== 'false';
// When true, spawns MediaMTX as a child process for RTMP ingest + HLS output
const ENABLE_RTMP_SERVER = process.env.ENABLE_RTMP_SERVER === 'true';

const FFMPEG_BIN = process.env.FFMPEG_BIN || '/usr/bin/ffmpeg';
const MAX_MESSAGE_SIZE_BYTES = Number(process.env.MAX_MESSAGE_SIZE_BYTES || 4 * 1024 * 1024);

const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
// HLS served directly by MediaMTX on this port
const HLS_HTTP_PORT = Number(process.env.HLS_HTTP_PORT || 8888);
const RTMP_FORWARD_URL = process.env.RTMP_FORWARD_URL || '';

// MediaMTX binary path
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN || 'mediamtx';

if (!LIVE_INGEST_SHARED_SECRET) {
  throw new Error('LIVE_INGEST_SHARED_SECRET is required');
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── HLS proxy ─────────────────────────────────────────────────────────────────
// Railway only exposes one port (PORT). MediaMTX HLS runs on HLS_HTTP_PORT
// internally. This proxy forwards /live/* requests from the public domain to
// the internal MediaMTX HLS server so viewers can fetch playlists + segments.
app.use('/live', (req: Request, res: Response) => {
  if (!ENABLE_RTMP_SERVER) {
    res.status(503).end();
    return;
  }

  // req.url is relative to the /live mount point and preserves the query string
  const targetPath = `/live${req.url}`;
  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port: HLS_HTTP_PORT,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${HLS_HTTP_PORT}` },
    },
    (proxyRes: IncomingMessage) => {
      // Forward CORS headers so browsers can read HLS content cross-origin
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err: Error & { code?: string; syscall?: string }) => {
    log('HLS proxy error', { path: targetPath, message: err.message, code: err.code, syscall: err.syscall });
    if (!res.headersSent) res.status(502).end();
  });

  proxyReq.end();
});

app.get('/health', async (_req: Request, res: Response) => {
  let hlsReachable: boolean | null = null;
  let hlsStatus: string = 'not_checked';

  if (ENABLE_RTMP_SERVER) {
    hlsReachable = await new Promise<boolean>((resolve) => {
      const probe = http.request(
        { host: '127.0.0.1', port: HLS_HTTP_PORT, path: '/', method: 'GET', timeout: 2000 },
        () => resolve(true),
      );
      probe.on('error', () => resolve(false));
      probe.on('timeout', () => { probe.destroy(); resolve(false); });
      probe.end();
    });
    hlsStatus = hlsReachable ? 'reachable' : 'unreachable';
  }

  res.status(200).json({
    status: 'ok',
    service: 'video-manch-live-ingest',
    timestamp: new Date().toISOString(),
    modes: {
      wsIngest: ENABLE_WS_INGEST,
      rtmpServer: ENABLE_RTMP_SERVER,
    },
    ports: {
      http: PORT,
      rtmp: ENABLE_RTMP_SERVER ? RTMP_PORT : null,
      hls: ENABLE_RTMP_SERVER ? HLS_HTTP_PORT : null,
    },
    hls: {
      port: HLS_HTTP_PORT,
      status: hlsStatus,
    },
    activeStreams: clients.size,
  });
});

// ── Logging ───────────────────────────────────────────────────────────────────
const log = (message: string, meta?: Record<string, unknown>) => {
  const ts = new Date().toISOString();
  if (meta) {
    console.log(`[LIVE-INGEST][${ts}] ${message}`, meta);
    return;
  }
  console.log(`[LIVE-INGEST][${ts}] ${message}`);
};

// ── Backend API helpers ───────────────────────────────────────────────────────
const validateIngestKey = async (videoId: string, key: string): Promise<WsValidationResponse> => {
  const url = `${API_BASE_URL}/live/ingest/validate/${encodeURIComponent(videoId)}?key=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'x-live-ingest-secret': LIVE_INGEST_SHARED_SECRET },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    return { success: false, error: `validate failed: ${response.status} ${text}` };
  }

  return response.json() as Promise<WsValidationResponse>;
};

const validateRtmpStreamKey = async (streamKey: string) => {
  const url = `${API_BASE_URL}/live/rtmp/validate/${encodeURIComponent(streamKey)}`;
  const response = await fetch(url, {
    headers: { 'x-live-ingest-secret': LIVE_INGEST_SHARED_SECRET },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    return { success: false, error: `${response.status} ${text}` };
  }

  return response.json() as Promise<{ success: boolean; data?: any; error?: string }>;
};

const notifyIngestEvent = async (payload: {
  event: 'ingest_started' | 'ingest_stopped';
  videoId?: string;
  streamKey?: string;
  source: 'ws' | 'rtmp';
  reason?: string;
}) => {
  const response = await fetch(`${API_BASE_URL}/live/ingest/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-live-ingest-secret': LIVE_INGEST_SHARED_SECRET,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    throw new Error(`ingest event failed: ${response.status} ${text}`);
  }
};

// ── MediaMTX webhook endpoints ────────────────────────────────────────────────
// These are called by MediaMTX (not by clients directly).

// POST /mediamtx/auth
// MediaMTX calls this before accepting any publisher.
// Body: { ip, user, password, path, protocol, id, action, query }
app.post('/mediamtx/auth', async (req: Request, res: Response) => {
  try {
    const { ip, path: streamPath, action } = req.body || {};

    // Allow all non-publish actions (e.g. HLS reads)
    if (action !== 'publish') {
      return res.status(200).end();
    }

    // Loopback connections are our own FFmpeg processes (WS ingest path) — always allow
    if (ip === '127.0.0.1' || ip === '::1') {
      log('MediaMTX auth: allowing loopback publisher', { ip, streamPath });
      return res.status(200).end();
    }

    // Extract stream key: path format is "live/<streamKey>"
    const streamKey = String(streamPath || '').split('/').pop() || '';
    if (!streamKey) {
      log('MediaMTX auth: rejected — missing stream key', { streamPath });
      return res.status(403).json({ error: 'missing stream key' });
    }

    const validation = await validateRtmpStreamKey(streamKey);
    if (!validation.success) {
      log('MediaMTX auth: rejected — invalid stream key', { streamKey, error: validation.error });
      return res.status(403).json({ error: 'invalid stream key' });
    }

    log('MediaMTX auth: allowed', { streamKey, videoId: validation.data?.videoId });
    return res.status(200).end();
  } catch (error: any) {
    log('MediaMTX auth: error during validation', { message: error?.message });
    return res.status(500).json({ error: 'auth check failed' });
  }
});

// POST /mediamtx/on-publish
// Called by MediaMTX runOnPublish hook when a stream starts.
// Body: { path, id }
app.post('/mediamtx/on-publish', async (req: Request, res: Response) => {
  try {
    const streamPath = String(req.body?.path || '');
    const streamKey = streamPath.split('/').pop() || '';

    log('MediaMTX on-publish', { streamPath, streamKey });

    notifyIngestEvent({ event: 'ingest_started', streamKey, source: 'rtmp' }).catch((err: any) => {
      log('Failed to notify ingest_started', { streamKey, message: err?.message });
    });

    return res.status(200).end();
  } catch (error: any) {
    log('MediaMTX on-publish: error', { message: error?.message });
    return res.status(500).end();
  }
});

// POST /mediamtx/on-unpublish
// Called by MediaMTX runOnUnpublish hook when a stream ends.
// Body: { path, id }
app.post('/mediamtx/on-unpublish', async (req: Request, res: Response) => {
  try {
    const streamPath = String(req.body?.path || '');
    const streamKey = streamPath.split('/').pop() || '';

    log('MediaMTX on-unpublish', { streamPath, streamKey });

    notifyIngestEvent({ event: 'ingest_stopped', streamKey, source: 'rtmp', reason: 'publish_ended' }).catch((err: any) => {
      log('Failed to notify ingest_stopped', { streamKey, message: err?.message });
    });

    return res.status(200).end();
  } catch (error: any) {
    log('MediaMTX on-unpublish: error', { message: error?.message });
    return res.status(500).end();
  }
});

// ── WebSocket ingest (browser) ────────────────────────────────────────────────
const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE_BYTES });

const clients = new Map<WebSocket, {
  videoId: string;
  streamKey: string;
  ffmpeg: ChildProcessWithoutNullStreams;
  pingTimer: NodeJS.Timeout;
}>();

const ensureFfmpegAvailable = () => {
  const check = spawnSync(FFMPEG_BIN, ['-version'], { encoding: 'utf8' });
  if (check.error) {
    throw new Error(`FFmpeg binary is not available: ${check.error.message}`);
  }
  if (check.status !== 0) {
    throw new Error(`FFmpeg check failed with status ${check.status}: ${check.stderr || check.stdout}`);
  }
  const firstLine = (check.stdout || '').split('\n')[0] || 'ffmpeg detected';
  log('FFmpeg detected', { ffmpegBin: FFMPEG_BIN, version: firstLine });
};

const startFfmpeg = (rtmpUrl: string, streamKey: string, container: 'webm' | 'mp4' = 'webm'): ChildProcessWithoutNullStreams => {
  const target = `${rtmpUrl.replace(/\/$/, '')}/${streamKey}`;

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
    '-f', container === 'mp4' ? 'mp4' : 'webm',
    '-i', 'pipe:0',
    // Transcode to H264/AAC for RTMP/FLV
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    // Force a keyframe exactly every 1 second (time-based, not frame-count-based).
    // This is critical for LL-HLS: MediaMTX places HLS part boundaries at IDR keyframes.
    // hlsPartDuration=1s must match this interval for stable part durations.
    '-force_key_frames', 'expr:gte(t,n_forced*1.0)',
    '-g', '30',
    '-keyint_min', '25',
    '-c:a', 'aac',
    '-ar', '44100',
    '-b:a', '128k',
    '-f', 'flv',
    target,
  ];

  log('Starting ffmpeg process', { target, ffmpegBin: FFMPEG_BIN });
  const proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrTail: string[] = [];

  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log('ffmpeg stdout', { text });
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    stderrTail.push(text);
    if (stderrTail.length > 30) stderrTail.shift();
    log('ffmpeg stderr', { text });
  });

  (proc as any).__stderrTail = stderrTail;
  return proc;
};

// Where FFmpeg should push: local MediaMTX RTMP when ENABLE_RTMP_SERVER,
// otherwise fall back to the URL returned by the backend API.
const resolveForwardRtmpUrl = (validatedRtmpUrl: string): string => {
  if (RTMP_FORWARD_URL.trim()) return RTMP_FORWARD_URL.trim();
  if (ENABLE_RTMP_SERVER) return `rtmp://127.0.0.1:${RTMP_PORT}/live`;
  return validatedRtmpUrl;
};

const closeClient = (ws: WebSocket, code: number, reason: string) => {
  const state = clients.get(ws);
  if (state) {
    clearInterval(state.pingTimer);

    if (!state.ffmpeg.killed) {
      try { state.ffmpeg.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => {
        if (!state.ffmpeg.killed) state.ffmpeg.kill('SIGKILL');
      }, 1500);
    }
  }

  clients.delete(ws);

  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
    ws.close(code, reason);
  }
};

server.on('upgrade', async (request: IncomingMessage, socket: Socket, head: Buffer) => {
  if (!ENABLE_WS_INGEST) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    const parsed = new URL(request.url || '', `http://${request.headers.host}`);
    const match = parsed.pathname.match(/^\/live\/ingest\/([a-zA-Z0-9-]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const videoId = match[1];
    const key = parsed.searchParams.get('key') || '';
    const container = parsed.searchParams.get('container') === 'mp4' ? 'mp4' : 'webm';

    if (!key) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    log('Incoming ingest upgrade request', {
      videoId,
      hasKey: Boolean(key),
      origin: request.headers.origin || null,
      ip: request.socket.remoteAddress || null,
    });

    const validation = await validateIngestKey(videoId, key);
    if (!validation.success || !validation.data || !validation.data.isLive) {
      log('Ingest validation failed', { videoId, error: validation.error || 'invalid key/state' });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wsServer.emit('connection', ws, request, validation.data, container);
    });
  } catch (error: any) {
    log('Upgrade handling failed', { message: error?.message, stack: error?.stack });
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
});

wsServer.on('connection', (ws: WebSocket, _request: IncomingMessage, validationData: WsValidationResponse['data'], container: 'webm' | 'mp4' = 'webm') => {
  if (!validationData) {
    ws.close(1011, 'missing validation data');
    return;
  }

  const { videoId, streamKey, rtmpUrl } = validationData;

  // Reject duplicate streams for the same videoId
  const existingClient = Array.from(clients.values()).find(c => c.videoId === videoId);
  if (existingClient) {
    log('Duplicate stream attempt rejected', { videoId });
    ws.close(4009, 'stream_already_active');
    return;
  }

  const forwardRtmpUrl = resolveForwardRtmpUrl(rtmpUrl);
  log('WebSocket connected', { videoId, validatedRtmpUrl: rtmpUrl, forwardRtmpUrl, container });

  notifyIngestEvent({ event: 'ingest_started', videoId, streamKey, source: 'ws' }).catch((error: any) => {
    log('Failed to notify ingest start event', { videoId, streamKey, source: 'ws', message: error?.message });
  });

  const ffmpeg = startFfmpeg(forwardRtmpUrl, streamKey, container);

  ffmpeg.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    const recentStderr = ((ffmpeg as any).__stderrTail as string[] | undefined) || [];
    log('ffmpeg process closed', { videoId, code, signal, recentStderr: recentStderr.slice(-8) });
    closeClient(ws, 1011, 'ffmpeg stopped');
  });

  ffmpeg.on('error', (error: Error) => {
    log('ffmpeg process error', { videoId, message: error.message });
    closeClient(ws, 1011, 'ffmpeg error');
  });

  ffmpeg.stdin.on('error', (error: NodeJS.ErrnoException) => {
    log('ffmpeg stdin error', { videoId, message: error.message, code: error.code, syscall: error.syscall });
    closeClient(ws, 1011, 'ffmpeg stdin error');
  });

  let lastPong = Date.now();
  ws.on('pong', () => { lastPong = Date.now(); });

  const pingTimer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(pingTimer);
      return;
    }
    if (Date.now() - lastPong > 45000) {
      log('WebSocket pong timeout — closing dead connection', { videoId });
      closeClient(ws, 1001, 'pong_timeout');
      return;
    }
    ws.ping();
  }, 15000);

  clients.set(ws, { videoId, streamKey, ffmpeg, pingTimer });

  ws.on('message', (data: RawData, isBinary: boolean) => {
    const state = clients.get(ws);
    if (!state || !isBinary) return;

    if (!state.ffmpeg.stdin.writable || state.ffmpeg.stdin.destroyed || state.ffmpeg.stdin.writableEnded) return;

    try {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      state.ffmpeg.stdin.write(chunk);
    } catch (error: any) {
      log('Failed to write media chunk to ffmpeg stdin', { videoId: state.videoId, message: error?.message });
      closeClient(ws, 1011, 'ffmpeg stdin write failed');
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    log('WebSocket disconnected', { videoId, code, reason: reason.toString() });
    notifyIngestEvent({ event: 'ingest_stopped', videoId, streamKey, source: 'ws', reason: reason.toString() || `ws_close_${code}` }).catch((error: any) => {
      log('Failed to notify ingest stop event', { videoId, streamKey, source: 'ws', message: error?.message });
    });
    closeClient(ws, 1000, 'client disconnected');
  });

  ws.on('error', (error: Error) => {
    log('WebSocket error', { videoId, message: error.message });
    closeClient(ws, 1011, 'websocket error');
  });
});

// ── MediaMTX process ──────────────────────────────────────────────────────────
const spawnMediaMTX = (configPath: string, restartDelay = 3000, attempt = 1) => {
  const proc = spawn(MEDIAMTX_BIN, [configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      RTMP_PORT: String(RTMP_PORT),
      HLS_HTTP_PORT: String(HLS_HTTP_PORT),
    },
  });

  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log('[MEDIAMTX] ' + text);
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log('[MEDIAMTX] ERR: ' + text);
  });

  proc.on('close', (code: number | null) => {
    log('MediaMTX process exited', { code, attempt });
    // Restart unless the exit was clean (code 0 = intentional shutdown)
    if (code !== 0) {
      const delay = Math.min(restartDelay * attempt, 30000);
      log(`MediaMTX restarting in ${delay}ms`, { attempt: attempt + 1 });
      setTimeout(() => spawnMediaMTX(configPath, restartDelay, attempt + 1), delay);
    }
  });

  proc.on('error', (err: Error) => {
    log('MediaMTX process error', { message: err.message });
  });
};

const buildMediaMTXConfig = (): string => `
logLevel: info
logDestinations: [stdout]

authMethod: http
authHTTPAddress: http://127.0.0.1:${PORT}/mediamtx/auth
authHTTPExclude:
  - action: read
  - action: playback
  - action: api
  - action: metrics
  - action: pprof

rtsp: no
webrtc: no
srt: no

rtmp: yes
rtmpAddress: :${RTMP_PORT}

hls: yes
hlsAddress: :${HLS_HTTP_PORT}
hlsAllowOrigin: "*"
hlsSegmentCount: 7
hlsSegmentDuration: 2s
hlsPartDuration: 1s

paths:
  "~^live/":
    runOnReady: >
      curl -sf -X POST "http://127.0.0.1:${PORT}/mediamtx/on-publish"
      -H "Content-Type: application/json"
      -d "{\\"path\\":\\"$MTX_PATH\\",\\"id\\":\\"$MTX_ID\\"}"
    runOnReadyRestart: no
    runOnNotReady: >
      curl -sf -X POST "http://127.0.0.1:${PORT}/mediamtx/on-unpublish"
      -H "Content-Type: application/json"
      -d "{\\"path\\":\\"$MTX_PATH\\",\\"id\\":\\"$MTX_ID\\"}"
`.trimStart();

const startMediaMTX = () => {
  if (!ENABLE_RTMP_SERVER) return;

  const check = spawnSync(MEDIAMTX_BIN, ['--version'], { encoding: 'utf8' });
  if (check.error) {
    throw new Error(`MediaMTX binary not found at "${MEDIAMTX_BIN}": ${check.error.message}`);
  }
  const version = (check.stdout || check.stderr || '').split('\n')[0].trim();

  // Write resolved config (with actual port values) to a temp file.
  // MediaMTX v1.9.x does not substitute $VAR in YAML values at runtime.
  const resolvedConfig = path.join(os.tmpdir(), 'mediamtx-resolved.yml');
  fs.writeFileSync(resolvedConfig, buildMediaMTXConfig(), 'utf8');

  log('MediaMTX detected', { bin: MEDIAMTX_BIN, version, config: resolvedConfig });
  spawnMediaMTX(resolvedConfig);
  log('MediaMTX started', { rtmpPort: RTMP_PORT, hlsHttpPort: HLS_HTTP_PORT });
};

// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  ensureFfmpegAvailable();
  startMediaMTX();
  log('Live ingest service started', {
    port: PORT,
    apiBaseUrl: API_BASE_URL,
    enableWsIngest: ENABLE_WS_INGEST,
    enableRtmpServer: ENABLE_RTMP_SERVER,
  });
});
