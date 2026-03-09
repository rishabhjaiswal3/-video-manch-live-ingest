import 'dotenv/config';
import express from 'express';
import http from 'http';
import { spawn, spawnSync } from 'node:child_process';
import { URL } from 'node:url';
import NodeMediaServer from 'node-media-server';
import { WebSocketServer } from 'ws';
const PORT = Number(process.env.PORT || 3001);
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.videomanch.com';
const LIVE_INGEST_SHARED_SECRET = process.env.LIVE_INGEST_SHARED_SECRET || '';
const ENABLE_WS_INGEST = process.env.ENABLE_WS_INGEST !== 'false';
const ENABLE_RTMP_SERVER = process.env.ENABLE_RTMP_SERVER === 'true';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const MAX_MESSAGE_SIZE_BYTES = Number(process.env.MAX_MESSAGE_SIZE_BYTES || 4 * 1024 * 1024);
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const HLS_HTTP_PORT = Number(process.env.HLS_HTTP_PORT || 8000);
const MEDIA_ROOT = process.env.MEDIA_ROOT || './media';
if (!LIVE_INGEST_SHARED_SECRET) {
    throw new Error('LIVE_INGEST_SHARED_SECRET is required');
}
const app = express();
app.get('/health', (_req, res) => {
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
            hlsHttp: ENABLE_RTMP_SERVER ? HLS_HTTP_PORT : null,
        },
    });
});
const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE_BYTES });
const clients = new Map();
const log = (message, meta) => {
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
const validateIngestKey = async (videoId, key) => {
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
    return response.json();
};
const validateRtmpStreamKey = async (streamKey) => {
    const url = `${API_BASE_URL}/live/rtmp/validate/${encodeURIComponent(streamKey)}`;
    const response = await fetch(url, {
        headers: {
            'x-live-ingest-secret': LIVE_INGEST_SHARED_SECRET,
        },
    });
    if (!response.ok) {
        const text = await response.text().catch(() => 'unknown error');
        return { success: false, error: `${response.status} ${text}` };
    }
    return response.json();
};
const startFfmpeg = (rtmpUrl, streamKey) => {
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
        // MediaRecorder (WebM/VP8|VP9) must be transcoded to H264 for RTMP/FLV output.
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '60',
        '-keyint_min',
        '60',
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
    proc.stdout.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text)
            log('ffmpeg stdout', { text });
    });
    proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text)
            log('ffmpeg stderr', { text });
    });
    return proc;
};
const closeClient = (ws, code, reason) => {
    const state = clients.get(ws);
    if (state) {
        clearInterval(state.pingTimer);
        if (!state.ffmpeg.killed) {
            try {
                state.ffmpeg.stdin.end();
            }
            catch {
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
server.on('upgrade', async (request, socket, head) => {
    if (!ENABLE_WS_INGEST) {
        socket.write('HTTP/1.1 503 Service Unavailable\\r\\n\\r\\n');
        socket.destroy();
        return;
    }
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
        wsServer.handleUpgrade(request, socket, head, (ws) => {
            wsServer.emit('connection', ws, request, validation.data);
        });
    }
    catch (error) {
        log('Upgrade handling failed', { message: error?.message, stack: error?.stack });
        socket.write('HTTP/1.1 500 Internal Server Error\\r\\n\\r\\n');
        socket.destroy();
    }
});
wsServer.on('connection', (ws, _request, validationData) => {
    if (!validationData) {
        ws.close(1011, 'missing validation data');
        return;
    }
    const { videoId, streamKey, rtmpUrl } = validationData;
    log('WebSocket connected', { videoId, rtmpUrl });
    const ffmpeg = startFfmpeg(rtmpUrl, streamKey);
    ffmpeg.on('close', (code, signal) => {
        log('ffmpeg process closed', { videoId, code, signal });
        closeClient(ws, 1011, 'ffmpeg stopped');
    });
    ffmpeg.on('error', (error) => {
        log('ffmpeg process error', { videoId, message: error.message });
        closeClient(ws, 1011, 'ffmpeg error');
    });
    ffmpeg.stdin.on('error', (error) => {
        log('ffmpeg stdin error', {
            videoId,
            message: error.message,
            code: error.code,
            syscall: error.syscall,
        });
        closeClient(ws, 1011, 'ffmpeg stdin error');
    });
    const pingTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.ping();
            return;
        }
        clearInterval(pingTimer);
    }, 15000);
    clients.set(ws, { videoId, streamKey, ffmpeg, pingTimer });
    ws.on('message', (data, isBinary) => {
        const state = clients.get(ws);
        if (!state)
            return;
        if (!isBinary)
            return;
        if (!state.ffmpeg.stdin.writable ||
            state.ffmpeg.stdin.destroyed ||
            state.ffmpeg.stdin.writableEnded) {
            return;
        }
        try {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            state.ffmpeg.stdin.write(chunk);
        }
        catch (error) {
            log('Failed to write media chunk to ffmpeg stdin', {
                videoId: state.videoId,
                message: error?.message,
            });
            closeClient(ws, 1011, 'ffmpeg stdin write failed');
        }
    });
    ws.on('close', (code, reason) => {
        log('WebSocket disconnected', {
            videoId,
            code,
            reason: reason.toString(),
        });
        closeClient(ws, 1000, 'client disconnected');
    });
    ws.on('error', (error) => {
        log('WebSocket error', { videoId, message: error.message });
        closeClient(ws, 1011, 'websocket error');
    });
});
const startRtmpServer = () => {
    if (!ENABLE_RTMP_SERVER)
        return;
    const config = {
        logType: 2,
        rtmp: {
            port: RTMP_PORT,
            chunk_size: 60000,
            gop_cache: true,
            ping: 30,
            ping_timeout: 60,
        },
        http: {
            port: HLS_HTTP_PORT,
            mediaroot: MEDIA_ROOT,
            allow_origin: '*',
        },
        trans: {
            ffmpeg: FFMPEG_BIN,
            tasks: [
                {
                    app: 'live',
                    hls: true,
                    hlsFlags: '[hls_time=2:hls_list_size=6:hls_flags=delete_segments]',
                    hlsKeep: false,
                },
            ],
        },
    };
    const nms = new NodeMediaServer(config);
    nms.on('prePublish', async (id, streamPath) => {
        try {
            const [, appName, streamKey] = streamPath.split('/');
            if (appName !== 'live' || !streamKey) {
                log('Rejecting RTMP publish - invalid stream path', { id, streamPath });
                nms.getSession(id)?.reject();
                return;
            }
            const validation = await validateRtmpStreamKey(streamKey);
            if (!validation.success) {
                log('Rejecting RTMP publish - stream validation failed', {
                    id,
                    streamPath,
                    error: validation.error || 'unknown',
                });
                nms.getSession(id)?.reject();
                return;
            }
            log('RTMP publish accepted', {
                id,
                streamPath,
                videoId: validation.data?.videoId,
                masterPlaylistUrl: validation.data?.masterPlaylistUrl,
            });
        }
        catch (error) {
            log('Rejecting RTMP publish - exception during validation', {
                id,
                streamPath,
                message: error?.message,
            });
            nms.getSession(id)?.reject();
        }
    });
    nms.on('donePublish', (id, streamPath) => {
        log('RTMP publish stopped', { id, streamPath });
    });
    nms.run();
    log('RTMP server started', {
        rtmpPort: RTMP_PORT,
        hlsHttpPort: HLS_HTTP_PORT,
        mediaRoot: MEDIA_ROOT,
    });
};
server.listen(PORT, '0.0.0.0', () => {
    ensureFfmpegAvailable();
    startRtmpServer();
    log('Live ingest service started', {
        port: PORT,
        apiBaseUrl: API_BASE_URL,
        enableWsIngest: ENABLE_WS_INGEST,
        enableRtmpServer: ENABLE_RTMP_SERVER,
    });
});
