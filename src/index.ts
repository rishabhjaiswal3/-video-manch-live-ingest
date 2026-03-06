import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';

interface ValidationResponse {
  success: boolean;
  data?: {
    videoId: string;
    streamKey: string;
    rtmpUrl: string;
    isLive: boolean;
  };
  error?: string;
}

const PORT = Number(process.env.PORT || 3001);
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.videomanch.com';
const LIVE_INGEST_SHARED_SECRET = process.env.LIVE_INGEST_SHARED_SECRET || '';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const MAX_MESSAGE_SIZE_BYTES = Number(process.env.MAX_MESSAGE_SIZE_BYTES || 4 * 1024 * 1024);

if (!LIVE_INGEST_SHARED_SECRET) {
  throw new Error('LIVE_INGEST_SHARED_SECRET is required');
}

const app = express();

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'video-manch-live-ingest',
    timestamp: new Date().toISOString(),
  });
});

const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE_BYTES });

const clients = new Map<WebSocket, {
  videoId: string;
  streamKey: string;
  ffmpeg: ChildProcessWithoutNullStreams;
  pingTimer: NodeJS.Timeout;
}>();

const log = (message: string, meta?: Record<string, unknown>) => {
  const ts = new Date().toISOString();
  if (meta) {
    console.log(`[LIVE-INGEST][${ts}] ${message}`, meta);
    return;
  }
  console.log(`[LIVE-INGEST][${ts}] ${message}`);
};

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

const validateIngestKey = async (videoId: string, key: string): Promise<ValidationResponse> => {
  const url = `${API_BASE_URL}/live/ingest/validate/${encodeURIComponent(videoId)}?key=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-live-ingest-secret': LIVE_INGEST_SHARED_SECRET,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    return { success: false, error: `validate failed: ${response.status} ${text}` };
  }

  return response.json() as Promise<ValidationResponse>;
};

const startFfmpeg = (rtmpUrl: string, streamKey: string): ChildProcessWithoutNullStreams => {
  const target = `${rtmpUrl.replace(/\/$/, '')}/${streamKey}`;

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-fflags',
    '+genpts',
    '-f',
    'webm',
    '-i',
    'pipe:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-b:a',
    '128k',
    '-f',
    'flv',
    target,
  ];

  log('Starting ffmpeg process', { target, ffmpegBin: FFMPEG_BIN });
  const proc = spawn(FFMPEG_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log('ffmpeg stdout', { text });
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log('ffmpeg stderr', { text });
  });

  return proc;
};

const closeClient = (ws: WebSocket, code: number, reason: string) => {
  const state = clients.get(ws);
  if (state) {
    clearInterval(state.pingTimer);

    if (!state.ffmpeg.killed) {
      try {
        state.ffmpeg.stdin.end();
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (!state.ffmpeg.killed) {
          state.ffmpeg.kill('SIGKILL');
        }
      }, 1500);
    }
  }

  clients.delete(ws);

  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
    ws.close(code, reason);
  }
};

server.on('upgrade', async (request: IncomingMessage, socket: Socket, head: Buffer) => {
  try {
    const parsed = new URL(request.url || '', `http://${request.headers.host}`);
    const match = parsed.pathname.match(/^\/live\/ingest\/([a-zA-Z0-9-]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\\r\\n\\r\\n');
      socket.destroy();
      return;
    }

    const videoId = match[1];
    const key = parsed.searchParams.get('key') || '';

    if (!key) {
      socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
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
      socket.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wsServer.emit('connection', ws, request, validation.data);
    });
  } catch (error: any) {
    log('Upgrade handling failed', { message: error?.message, stack: error?.stack });
    socket.write('HTTP/1.1 500 Internal Server Error\\r\\n\\r\\n');
    socket.destroy();
  }
});

wsServer.on('connection', (ws: WebSocket, _request: IncomingMessage, validationData: ValidationResponse['data']) => {
  if (!validationData) {
    ws.close(1011, 'missing validation data');
    return;
  }

  const { videoId, streamKey, rtmpUrl } = validationData;
  log('WebSocket connected', { videoId, rtmpUrl });

  const ffmpeg = startFfmpeg(rtmpUrl, streamKey);

  ffmpeg.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    log('ffmpeg process closed', { videoId, code, signal });
    closeClient(ws, 1011, 'ffmpeg stopped');
  });

  ffmpeg.on('error', (error: Error) => {
    log('ffmpeg process error', { videoId, message: error.message });
    closeClient(ws, 1011, 'ffmpeg error');
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
      return;
    }
    clearInterval(pingTimer);
  }, 15000);

  clients.set(ws, { videoId, streamKey, ffmpeg, pingTimer });

  ws.on('message', (data: RawData, isBinary: boolean) => {
    const state = clients.get(ws);
    if (!state) return;

    if (!isBinary) {
      // Ignore text frames from browser extensions/clients.
      return;
    }

    if (!state.ffmpeg.stdin.writable) {
      return;
    }

    try {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      state.ffmpeg.stdin.write(chunk);
    } catch (error: any) {
      log('Failed to write media chunk to ffmpeg stdin', {
        videoId: state.videoId,
        message: error?.message,
      });
      closeClient(ws, 1011, 'ffmpeg stdin write failed');
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    log('WebSocket disconnected', {
      videoId,
      code,
      reason: reason.toString(),
    });
    closeClient(ws, 1000, 'client disconnected');
  });

  ws.on('error', (error: Error) => {
    log('WebSocket error', { videoId, message: error.message });
    closeClient(ws, 1011, 'websocket error');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  ensureFfmpegAvailable();
  log('Live ingest service started', {
    port: PORT,
    apiBaseUrl: API_BASE_URL,
  });
});
