import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { acquirePublisherLock, LOCK_REFRESH_MS, refreshPublisherLock, releasePublisherLock } from './redisLock.js';
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
// ── Low-latency HLS (MediaMTX) ────────────────────────────────────────────────
// Defaults align WebSocket→RTMP encoder GOP with segment length so each segment
// starts on a keyframe. Tune with HLS_SEGMENT_SEC / HLS_PART_DURATION / etc.
const HLS_VARIANT_RAW = (process.env.HLS_VARIANT || 'lowLatency').trim();
const HLS_VARIANT = HLS_VARIANT_RAW || 'lowLatency';
const HLS_IS_LOW_LATENCY = HLS_VARIANT.toLowerCase() === 'lowlatency';
const HLS_SEGMENT_DURATION = (process.env.HLS_SEGMENT_DURATION || '1s').trim();
const HLS_PART_DURATION = (process.env.HLS_PART_DURATION || '200ms').trim();
const HLS_SEGMENT_COUNT = (process.env.HLS_SEGMENT_COUNT || '8').trim();
/** Parsed segment length in seconds (for x264 -g / keyint_min when transcoding WebM) */
const HLS_SEGMENT_SEC = Math.min(4, Math.max(0.5, Number.parseFloat(process.env.HLS_SEGMENT_SEC || '') || 1));
const HLS_FPS = Math.min(60, Math.max(15, Number.parseInt(process.env.HLS_ENCODE_FPS || '30', 10) || 30));
/** Keyframe every segment at HLS_FPS — required for clean LL-HLS segment boundaries */
const HLS_GOP_FRAMES = Math.max(15, Math.round(HLS_FPS * HLS_SEGMENT_SEC));
const HLS_ALWAYS_REMUX = process.env.HLS_ALWAYS_REMUX !== 'false';
/** Outbound calls to watch-backend / Cloudflare — avoids hung sockets when API is slow */
const API_FETCH_TIMEOUT_MS = Math.min(120_000, Math.max(3_000, Number.parseInt(process.env.API_FETCH_TIMEOUT_MS || '15000', 10) || 15_000));
/** 0 = unlimited (default). Set e.g. 32–64 per instance for predictable RAM/CPU. */
const MAX_CONCURRENT_WS_STREAMS = Math.max(0, Number.parseInt(process.env.MAX_CONCURRENT_WS_STREAMS || '0', 10) || 0);
/** LL-HLS playlists can block on origin; keep below load balancer max */
const HLS_PROXY_ORIGIN_TIMEOUT_MS = Math.min(600_000, Math.max(30_000, Number.parseInt(process.env.HLS_PROXY_ORIGIN_TIMEOUT_MS || '180000', 10) || 180_000));
/** MediaMTX: must exceed LL-HLS part blocking interval (default 10s breaks blocking m3u8) */
const MEDIAMTX_READ_TIMEOUT = (process.env.MEDIAMTX_READ_TIMEOUT || '60s').trim();
const MEDIAMTX_WRITE_TIMEOUT = (process.env.MEDIAMTX_WRITE_TIMEOUT || '60s').trim();
const INGEST_EVENT_MAX_ATTEMPTS = Math.min(6, Math.max(1, Number.parseInt(process.env.INGEST_EVENT_MAX_ATTEMPTS || '3', 10) || 3));
/** Per-IP sliding window for WebSocket upgrade attempts (abuse throttle at origin). */
const WS_UPGRADE_RATE_PER_MINUTE_IP = Math.max(5, Number.parseInt(process.env.WS_UPGRADE_RATE_PER_MINUTE_IP || '40', 10) || 40);
// MediaMTX binary path
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN || 'mediamtx';
// ── Cloudflare Stream mode ────────────────────────────────────────────────────
// Set CF_STREAM_MODE=true to push RTMP to Cloudflare Stream instead of local
// MediaMTX. Cloudflare Stream handles transcoding + HLS delivery at CDN scale,
// supporting 1000+ simultaneous live streams without any FFmpeg farm.
//
// Required env vars when CF_STREAM_MODE=true:
//   CF_ACCOUNT_ID        — Cloudflare account ID
//   CF_STREAM_API_TOKEN  — API token with Stream:Edit permission
//
// Migration: just flip CF_STREAM_MODE=true in Railway env. Zero player changes.
const CF_STREAM_MODE = process.env.CF_STREAM_MODE === 'true';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_STREAM_API_TOKEN = process.env.CF_STREAM_API_TOKEN || '';
if (!LIVE_INGEST_SHARED_SECRET) {
    throw new Error('LIVE_INGEST_SHARED_SECRET is required');
}
if (CF_STREAM_MODE && (!CF_ACCOUNT_ID || !CF_STREAM_API_TOKEN)) {
    throw new Error('CF_ACCOUNT_ID and CF_STREAM_API_TOKEN are required when CF_STREAM_MODE=true');
}
// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
// ── HLS proxy ─────────────────────────────────────────────────────────────────
// Railway only exposes one port (PORT). MediaMTX HLS runs on HLS_HTTP_PORT
// internally. In production, the Cloudflare Worker (live-hls-worker) handles
// all viewer requests on live.videomanch.com and calls ingest.videomanch.com
// (this server) as the origin. This proxy serves those Worker→origin requests.
app.use('/live', (req, res) => {
    if (!ENABLE_RTMP_SERVER) {
        res.status(503).end();
        return;
    }
    // Serve the pre-generated gap.mp4 for #EXT-X-GAP placeholder requests from VHS
    if (req.url.endsWith('/gap.mp4') || req.url === '/gap.mp4') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        if (gapMp4Buffer) {
            res.status(200).send(gapMp4Buffer);
        }
        else {
            res.status(204).end();
        }
        return;
    }
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.status(204).end();
        return;
    }
    const targetPath = `/live${req.url}`;
    const headers = sanitizeProxyHeaders(req.headers);
    headers.host = `127.0.0.1:${HLS_HTTP_PORT}`;
    const proxyReq = http.request({
        host: '127.0.0.1',
        port: HLS_HTTP_PORT,
        path: targetPath,
        method: req.method,
        headers,
        timeout: HLS_PROXY_ORIGIN_TIMEOUT_MS,
    }, (proxyRes) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxyReq.on('timeout', () => {
        log('HLS proxy origin timeout', { path: targetPath, ms: HLS_PROXY_ORIGIN_TIMEOUT_MS });
        proxyReq.destroy();
        if (!res.headersSent)
            res.status(504).end();
    });
    proxyReq.on('error', (err) => {
        log('HLS proxy error', { path: targetPath, message: err.message, code: err.code, syscall: err.syscall });
        if (!res.headersSent)
            res.status(502).end();
    });
    req.on('aborted', () => proxyReq.destroy());
    res.on('close', () => {
        if (!res.writableEnded)
            proxyReq.destroy();
    });
    proxyReq.end();
});
app.get('/health', async (_req, res) => {
    let hlsReachable = null;
    let hlsStatus = 'not_checked';
    if (ENABLE_RTMP_SERVER) {
        hlsReachable = await probeHlsInternal();
        hlsStatus = hlsReachable ? 'reachable' : 'unreachable';
    }
    res.status(200).json({
        status: 'ok',
        service: 'video-manch-live-ingest',
        timestamp: new Date().toISOString(),
        modes: {
            wsIngest: ENABLE_WS_INGEST,
            rtmpServer: ENABLE_RTMP_SERVER,
            cfStreamMode: CF_STREAM_MODE,
        },
        ports: {
            http: PORT,
            rtmp: ENABLE_RTMP_SERVER ? RTMP_PORT : null,
            hls: ENABLE_RTMP_SERVER ? HLS_HTTP_PORT : null,
        },
        hls: {
            port: HLS_HTTP_PORT,
            status: hlsStatus,
            variant: ENABLE_RTMP_SERVER ? HLS_VARIANT : null,
            segmentDuration: ENABLE_RTMP_SERVER ? HLS_SEGMENT_DURATION : null,
            partDuration: ENABLE_RTMP_SERVER && HLS_IS_LOW_LATENCY ? HLS_PART_DURATION : null,
        },
        capacity: {
            activeWsIngests: clients.size,
            maxConcurrentWsIngests: MAX_CONCURRENT_WS_STREAMS || null,
        },
    });
});
// For orchestrators: fail readiness when MediaMTX HLS is required but down
app.get('/ready', async (_req, res) => {
    if (!ENABLE_RTMP_SERVER) {
        return res.status(200).json({ ready: true, reason: 'rtmp_server_disabled' });
    }
    const ok = await probeHlsInternal();
    if (!ok) {
        return res.status(503).json({ ready: false, reason: 'hls_origin_unreachable' });
    }
    return res.status(200).json({ ready: true, activeWsIngests: clients.size });
});
// Minimal Prometheus text for Railway / Grafana Agent scrapers
app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const lines = [
        '# HELP vm_live_ingest_active_ws Active browser WebSocket ingest publishers',
        '# TYPE vm_live_ingest_active_ws gauge',
        `vm_live_ingest_active_ws ${clients.size}`,
        '# HELP vm_live_ingest_cf_stream_mode 1 if CF_STREAM_MODE',
        '# TYPE vm_live_ingest_cf_stream_mode gauge',
        `vm_live_ingest_cf_stream_mode ${CF_STREAM_MODE ? 1 : 0}`,
        '# HELP vm_live_ingest_rtmp_enabled 1 if local MediaMTX RTMP+HLS is enabled',
        '# TYPE vm_live_ingest_rtmp_enabled gauge',
        `vm_live_ingest_rtmp_enabled ${ENABLE_RTMP_SERVER ? 1 : 0}`,
        '# HELP vm_live_ingest_ws_cap Configured max concurrent WS ingests (0 = unlimited)',
        '# TYPE vm_live_ingest_ws_cap gauge',
        `vm_live_ingest_ws_cap ${MAX_CONCURRENT_WS_STREAMS}`,
    ];
    res.status(200).send(`${lines.join('\n')}\n`);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithTimeout(url, init = {}) {
    const timeoutMs = init.timeoutMs ?? API_FETCH_TIMEOUT_MS;
    const { timeoutMs: _t, ...rest } = init;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        return await globalThis.fetch(url, { ...rest, signal: ac.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
/** Strip hop-by-hop headers so Node proxy → MediaMTX behaves predictably */
function sanitizeProxyHeaders(raw) {
    const out = { ...raw };
    const drop = ['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];
    for (const k of drop)
        delete out[k];
    return out;
}
async function probeHlsInternal() {
    return new Promise((resolve) => {
        const probe = http.request({ host: '127.0.0.1', port: HLS_HTTP_PORT, path: '/', method: 'GET', timeout: 2000 }, () => resolve(true));
        probe.on('error', () => resolve(false));
        probe.on('timeout', () => {
            probe.destroy();
            resolve(false);
        });
        probe.end();
    });
}
// ── Logging ───────────────────────────────────────────────────────────────────
const log = (message, meta) => {
    const ts = new Date().toISOString();
    if (meta) {
        console.log(`[LIVE-INGEST][${ts}] ${message}`, meta);
        return;
    }
    console.log(`[LIVE-INGEST][${ts}] ${message}`);
};
const wsUpgradeTimestampsByIp = new Map();
function allowWsUpgradeForIp(ip) {
    const now = Date.now();
    const windowMs = 60_000;
    const arr = (wsUpgradeTimestampsByIp.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= WS_UPGRADE_RATE_PER_MINUTE_IP) {
        return false;
    }
    arr.push(now);
    wsUpgradeTimestampsByIp.set(ip, arr);
    return true;
}
// ── Backend API helpers ───────────────────────────────────────────────────────
const validateIngestKey = async (videoId, key) => {
    const url = `${API_BASE_URL}/live/ingest/validate/${encodeURIComponent(videoId)}?key=${encodeURIComponent(key)}`;
    const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { 'x-live-ingest-secret': LIVE_INGEST_SHARED_SECRET },
    });
    if (!response.ok) {
        const text = await response.text().catch(() => 'unknown error');
        return { success: false, error: `validate failed: ${response.status} ${text}` };
    }
    return response.json();
};
const validateRtmpStreamKey = async (streamKey) => {
    const url = `${API_BASE_URL}/live/rtmp/validate/${encodeURIComponent(streamKey)}`;
    const response = await fetchWithTimeout(url, {
        headers: { 'x-live-ingest-secret': LIVE_INGEST_SHARED_SECRET },
    });
    if (!response.ok) {
        const text = await response.text().catch(() => 'unknown error');
        return { success: false, error: `${response.status} ${text}` };
    }
    return response.json();
};
const notifyIngestEvent = async (payload) => {
    const url = `${API_BASE_URL}/live/ingest/events`;
    const body = JSON.stringify(payload);
    let lastErr = null;
    for (let attempt = 1; attempt <= INGEST_EVENT_MAX_ATTEMPTS; attempt++) {
        try {
            const response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-live-ingest-secret': LIVE_INGEST_SHARED_SECRET,
                },
                body,
            });
            if (response.ok)
                return;
            const text = await response.text().catch(() => 'unknown error');
            lastErr = new Error(`ingest event failed: ${response.status} ${text}`);
        }
        catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
        }
        if (attempt < INGEST_EVENT_MAX_ATTEMPTS) {
            await sleep(400 * attempt);
        }
    }
    throw lastErr ?? new Error('ingest event failed');
};
const cfApiBase = () => `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream/live_inputs`;
const cfHeaders = () => ({
    'Authorization': `Bearer ${CF_STREAM_API_TOKEN}`,
    'Content-Type': 'application/json',
});
const createCfLiveInput = async (videoId) => {
    const response = await fetchWithTimeout(cfApiBase(), {
        method: 'POST',
        headers: cfHeaders(),
        timeoutMs: 45_000,
        body: JSON.stringify({
            meta: { name: `videomanch-${videoId}` },
            recording: { mode: 'automatic' }, // auto-record for VOD replay
            deleteRecordingAfterDays: 7, // keep 7 days then auto-delete
        }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => 'unknown');
        throw new Error(`CF Stream create live input failed: ${response.status} ${text}`);
    }
    const data = await response.json();
    const result = data?.result;
    if (!result?.uid || !result?.rtmps?.url || !result?.rtmps?.streamKey) {
        throw new Error(`CF Stream response missing fields: ${JSON.stringify(data)}`);
    }
    // Cloudflare Stream HLS URL: https://customer-<hash>.cloudflarestream.com/<uid>/manifest/video.m3u8
    const playbackUrl = `https://customer-${result.uid}.cloudflarestream.com/${result.uid}/manifest/video.m3u8`;
    return {
        uid: result.uid,
        rtmpsUrl: result.rtmps.url,
        rtmpsKey: result.rtmps.streamKey,
        playbackUrl: result.playback?.hls ?? playbackUrl,
    };
};
const deleteCfLiveInput = async (uid) => {
    const response = await fetchWithTimeout(`${cfApiBase()}/${uid}`, {
        method: 'DELETE',
        headers: cfHeaders(),
        timeoutMs: 20_000,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => 'unknown');
        log('CF Stream delete live input failed (non-fatal)', { uid, status: response.status, text });
    }
};
// ── MediaMTX webhook endpoints ────────────────────────────────────────────────
// These are called by MediaMTX (not by clients directly).
// POST /mediamtx/auth
// MediaMTX calls this before accepting any publisher.
// Body: { ip, user, password, path, protocol, id, action, query }
app.post('/mediamtx/auth', async (req, res) => {
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
    }
    catch (error) {
        log('MediaMTX auth: error during validation', { message: error?.message });
        return res.status(500).json({ error: 'auth check failed' });
    }
});
// POST /mediamtx/on-publish
// Called by MediaMTX runOnPublish hook when a stream starts.
// Body: { path, id }
app.post('/mediamtx/on-publish', async (req, res) => {
    try {
        const streamPath = String(req.body?.path || '');
        const streamKey = streamPath.split('/').pop() || '';
        log('MediaMTX on-publish', { streamPath, streamKey });
        const mtxId = String(req.body?.id || '');
        notifyIngestEvent({
            event: 'ingest_started',
            streamKey,
            source: 'rtmp',
            idempotencyKey: mtxId ? `rtmp:${streamKey}:${mtxId}:ingest_started` : undefined,
        }).catch((err) => {
            log('Failed to notify ingest_started', { streamKey, message: err?.message });
        });
        return res.status(200).end();
    }
    catch (error) {
        log('MediaMTX on-publish: error', { message: error?.message });
        return res.status(500).end();
    }
});
// POST /mediamtx/on-unpublish
// Called by MediaMTX runOnUnpublish hook when a stream ends.
// Body: { path, id }
app.post('/mediamtx/on-unpublish', async (req, res) => {
    try {
        const streamPath = String(req.body?.path || '');
        const streamKey = streamPath.split('/').pop() || '';
        log('MediaMTX on-unpublish', { streamPath, streamKey });
        const mtxId = String(req.body?.id || '');
        notifyIngestEvent({
            event: 'ingest_stopped',
            streamKey,
            source: 'rtmp',
            reason: 'publish_ended',
            idempotencyKey: mtxId ? `rtmp:${streamKey}:${mtxId}:ingest_stopped` : undefined,
        }).catch((err) => {
            log('Failed to notify ingest_stopped', { streamKey, message: err?.message });
        });
        return res.status(200).end();
    }
    catch (error) {
        log('MediaMTX on-unpublish: error', { message: error?.message });
        return res.status(500).end();
    }
});
// ── WebSocket ingest (browser) ────────────────────────────────────────────────
const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE_BYTES });
const clients = new Map();
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
// ── gap.mp4 ───────────────────────────────────────────────────────────────────
// Video.js VHS requests gap.mp4 when the playlist contains an #EXT-X-GAP tag
// (stream discontinuity). MediaMTX does not serve this file, causing 404 →
// playback stall. We generate a minimal silent fMP4 at startup with FFmpeg
// and serve it for any /live/*/gap.mp4 request.
let gapMp4Buffer = null;
const generateGapMp4 = () => {
    const tmpPath = path.join(os.tmpdir(), 'gap.mp4');
    const result = spawnSync(FFMPEG_BIN, [
        '-y',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-f', 'lavfi', '-i', 'color=black:size=2x2:rate=30',
        '-t', '0.034', // ~1 video frame @ 30fps
        '-c:a', 'aac', '-b:a', '32k',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        tmpPath,
    ], { encoding: 'buffer' });
    if (result.status !== 0) {
        log('gap.mp4 generation failed (non-fatal)', { stderr: result.stderr?.toString().slice(0, 200) });
        return;
    }
    try {
        gapMp4Buffer = fs.readFileSync(tmpPath);
        log('gap.mp4 generated', { bytes: gapMp4Buffer.length });
    }
    catch (err) {
        log('gap.mp4 read failed (non-fatal)', { message: err?.message });
    }
};
const startFfmpeg = (rtmpUrl, streamKey, container = 'webm') => {
    const target = `${rtmpUrl.replace(/\/$/, '')}/${streamKey}`;
    // MP4 from Safari/iOS is already H.264 — copy video stream (zero encode CPU).
    // WebM from Chrome/Firefox is VP8/VP9 — must transcode to H.264 for RTMP/FLV.
    const isH264Input = container === 'mp4';
    const videoArgs = isH264Input
        ? [
            '-c:v', 'copy', // passthrough — no CPU cost for video
        ]
        : [
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-threads', '2',
            '-r', String(HLS_FPS),
            '-vsync', 'cfr',
            // GOP aligned to MediaMTX hlsSegmentDuration (see HLS_SEGMENT_SEC)
            '-g', String(HLS_GOP_FRAMES),
            '-keyint_min', String(HLS_GOP_FRAMES),
            '-x264-params', 'scenecut=0',
            '-b:v', '1500k',
            '-maxrate', '2000k',
            '-bufsize', '4000k',
        ];
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-fflags', '+genpts+nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        '-err_detect', 'ignore_err',
        '-f', isH264Input ? 'mp4' : 'webm',
        '-i', 'pipe:0',
        ...videoArgs,
        '-c:a', 'aac',
        '-ar', '44100',
        '-b:a', '128k',
        '-threads', '2',
        '-f', 'flv',
        target,
    ];
    log('Starting ffmpeg process', {
        target,
        ffmpegBin: FFMPEG_BIN,
        container,
        h264Passthrough: isH264Input,
        gopFrames: isH264Input ? 'copy' : HLS_GOP_FRAMES,
        fps: isH264Input ? 'source' : HLS_FPS,
    });
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderrTail = [];
    proc.stdout.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text)
            log('ffmpeg stdout', { text });
    });
    proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (!text)
            return;
        stderrTail.push(text);
        if (stderrTail.length > 30)
            stderrTail.shift();
        log('ffmpeg stderr', { text });
    });
    proc.__stderrTail = stderrTail;
    return proc;
};
// Where FFmpeg should push: local MediaMTX RTMP when ENABLE_RTMP_SERVER,
// otherwise fall back to the URL returned by the backend API.
const resolveForwardRtmpUrl = (validatedRtmpUrl) => {
    if (RTMP_FORWARD_URL.trim())
        return RTMP_FORWARD_URL.trim();
    if (ENABLE_RTMP_SERVER)
        return `rtmp://127.0.0.1:${RTMP_PORT}/live`;
    return validatedRtmpUrl;
};
const closeClient = (ws, code, reason) => {
    const state = clients.get(ws);
    if (state) {
        clearInterval(state.pingTimer);
        if (state.lockRefreshTimer) {
            clearInterval(state.lockRefreshTimer);
        }
        releasePublisherLock(state.streamKey).catch(() => { });
        if (!state.ffmpeg.killed) {
            try {
                state.ffmpeg.stdin.end();
            }
            catch { /* ignore */ }
            setTimeout(() => {
                if (!state.ffmpeg.killed)
                    state.ffmpeg.kill('SIGKILL');
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
        if (MAX_CONCURRENT_WS_STREAMS > 0 && clients.size >= MAX_CONCURRENT_WS_STREAMS) {
            log('Upgrade rejected — at concurrent WebSocket ingest capacity', {
                cap: MAX_CONCURRENT_WS_STREAMS,
                active: clients.size,
            });
            socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
            socket.destroy();
            return;
        }
        if (!key) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        const clientIp = request.socket.remoteAddress || 'unknown';
        if (!allowWsUpgradeForIp(clientIp)) {
            log('Upgrade rejected — WS upgrade rate limit', { videoId, clientIp });
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
            socket.destroy();
            return;
        }
        log('Incoming ingest upgrade request', {
            videoId,
            hasKey: Boolean(key),
            origin: request.headers.origin || null,
            ip: clientIp,
        });
        const validation = await validateIngestKey(videoId, key);
        if (!validation.success || !validation.data || !validation.data.isLive) {
            log('Ingest validation failed', { videoId, error: validation.error || 'invalid key/state' });
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        const streamKeyForLock = validation.data.streamKey;
        if (!streamKeyForLock) {
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            socket.destroy();
            return;
        }
        const lockOk = await acquirePublisherLock(streamKeyForLock);
        if (!lockOk) {
            log('Upgrade rejected — publisher lock held (use sticky sessions, one replica, or wait for TTL)', {
                videoId,
                streamKey: streamKeyForLock,
            });
            socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
            socket.destroy();
            return;
        }
        wsServer.handleUpgrade(request, socket, head, (ws) => {
            wsServer.emit('connection', ws, request, validation.data, container);
        });
    }
    catch (error) {
        log('Upgrade handling failed', { message: error?.message, stack: error?.stack });
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
    }
});
wsServer.on('connection', async (ws, _request, validationData, container = 'webm') => {
    if (!validationData) {
        ws.close(1011, 'missing validation data');
        return;
    }
    const { videoId, streamKey, rtmpUrl } = validationData;
    const ingestSessionId = randomUUID();
    // Reject duplicate streams for the same videoId
    const existingClient = Array.from(clients.values()).find(c => c.videoId === videoId);
    if (existingClient) {
        log('Duplicate stream attempt rejected', { videoId });
        await releasePublisherLock(streamKey);
        ws.close(4009, 'stream_already_active');
        return;
    }
    // ── Cloudflare Stream mode ────────────────────────────────────────────────
    // Create a CF Live Input per stream. FFmpeg pushes to CF Stream's RTMPS
    // endpoint instead of local MediaMTX. CF handles transcoding + HLS delivery
    // at scale — supports 1000+ simultaneous streams without an FFmpeg farm.
    let cfLiveInputUid = null;
    let forwardRtmpUrl;
    let ffmpegStreamKey;
    if (CF_STREAM_MODE) {
        try {
            const liveInput = await createCfLiveInput(videoId);
            cfLiveInputUid = liveInput.uid;
            forwardRtmpUrl = liveInput.rtmpsUrl;
            ffmpegStreamKey = liveInput.rtmpsKey;
            log('CF Stream live input created', { videoId, uid: liveInput.uid, playbackUrl: liveInput.playbackUrl });
            // Tell the backend the CF Stream playback URL so viewers get the CF HLS URL
            notifyIngestEvent({
                event: 'ingest_started', videoId, streamKey, source: 'ws',
                reason: `cf_playback_url:${liveInput.playbackUrl}`,
                idempotencyKey: `${ingestSessionId}:ingest_started`,
            }).catch((error) => {
                log('Failed to notify ingest start (CF mode)', { videoId, message: error?.message });
            });
        }
        catch (error) {
            log('Failed to create CF Stream live input — closing connection', { videoId, message: error?.message });
            await releasePublisherLock(streamKey);
            ws.close(1011, 'cf_stream_init_failed');
            return;
        }
    }
    else {
        forwardRtmpUrl = resolveForwardRtmpUrl(rtmpUrl);
        ffmpegStreamKey = streamKey;
        notifyIngestEvent({
            event: 'ingest_started',
            videoId,
            streamKey,
            source: 'ws',
            idempotencyKey: `${ingestSessionId}:ingest_started`,
        }).catch((error) => {
            log('Failed to notify ingest start event', { videoId, streamKey, source: 'ws', message: error?.message });
        });
    }
    log('WebSocket connected', { videoId, forwardRtmpUrl, container, cfMode: CF_STREAM_MODE });
    const ffmpeg = startFfmpeg(forwardRtmpUrl, ffmpegStreamKey, container);
    ffmpeg.on('close', (code, signal) => {
        const recentStderr = ffmpeg.__stderrTail || [];
        log('ffmpeg process closed', { videoId, code, signal, recentStderr: recentStderr.slice(-8) });
        if (CF_STREAM_MODE && cfLiveInputUid) {
            deleteCfLiveInput(cfLiveInputUid).catch(() => { });
        }
        closeClient(ws, 1011, 'ffmpeg stopped');
    });
    ffmpeg.on('error', (error) => {
        log('ffmpeg process error', { videoId, message: error.message });
        closeClient(ws, 1011, 'ffmpeg error');
    });
    ffmpeg.stdin.on('error', (error) => {
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
    const lockRefreshTimer = setInterval(() => {
        refreshPublisherLock(streamKey).catch(() => { });
    }, LOCK_REFRESH_MS);
    clients.set(ws, { videoId, streamKey, ffmpeg, pingTimer, lockRefreshTimer });
    // ── Chunk timing diagnostics ──────────────────────────────────────────────
    // Logs every 30 chunks (~every 3s at 100ms MediaRecorder timeslice).
    // Watches for: large gaps between chunks (stalled MediaRecorder), tiny chunks
    // (MediaRecorder timeslice too small), backpressure on ffmpeg stdin.
    let chunkCount = 0;
    let lastChunkTime = Date.now();
    let totalBytes = 0;
    ws.on('message', (data, isBinary) => {
        const state = clients.get(ws);
        if (!state || !isBinary)
            return;
        if (!state.ffmpeg.stdin.writable || state.ffmpeg.stdin.destroyed || state.ffmpeg.stdin.writableEnded)
            return;
        try {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const now = Date.now();
            const gapMs = now - lastChunkTime;
            chunkCount++;
            totalBytes += chunk.length;
            lastChunkTime = now;
            // Log every 30 chunks: chunk interval, size, backpressure
            if (chunkCount % 30 === 0) {
                const backpressure = !state.ffmpeg.stdin.write(''); // dry-write to check buffer
                log('[DIAG] chunk stats', {
                    videoId,
                    chunkCount,
                    lastGapMs: gapMs,
                    chunkBytes: chunk.length,
                    avgBytesPerChunk: Math.round(totalBytes / chunkCount),
                    stdinBackpressure: backpressure,
                });
            }
            // Warn on large gaps (>500ms between chunks → MediaRecorder stalled)
            if (chunkCount > 1 && gapMs > 500) {
                log('[DIAG] large chunk gap — MediaRecorder may have stalled', {
                    videoId, gapMs, chunkCount,
                });
            }
            state.ffmpeg.stdin.write(chunk);
        }
        catch (error) {
            log('Failed to write media chunk to ffmpeg stdin', { videoId: state.videoId, message: error?.message });
            closeClient(ws, 1011, 'ffmpeg stdin write failed');
        }
    });
    ws.on('close', (code, reason) => {
        log('WebSocket disconnected', { videoId, code, reason: reason.toString() });
        if (CF_STREAM_MODE && cfLiveInputUid) {
            deleteCfLiveInput(cfLiveInputUid).catch(() => { });
        }
        notifyIngestEvent({
            event: 'ingest_stopped',
            videoId,
            streamKey,
            source: 'ws',
            reason: reason.toString() || `ws_close_${code}`,
            idempotencyKey: `${ingestSessionId}:ingest_stopped`,
        }).catch((error) => {
            log('Failed to notify ingest stop event', { videoId, streamKey, source: 'ws', message: error?.message });
        });
        closeClient(ws, 1000, 'client disconnected');
    });
    ws.on('error', (error) => {
        log('WebSocket error', { videoId, message: error.message });
        closeClient(ws, 1011, 'websocket error');
    });
});
// ── MediaMTX process ──────────────────────────────────────────────────────────
const spawnMediaMTX = (configPath, restartDelay = 3000, attempt = 1) => {
    const proc = spawn(MEDIAMTX_BIN, [configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PORT: String(PORT),
            RTMP_PORT: String(RTMP_PORT),
            HLS_HTTP_PORT: String(HLS_HTTP_PORT),
        },
    });
    proc.stdout.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text)
            log('[MEDIAMTX] ' + text);
    });
    proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text)
            log('[MEDIAMTX] ERR: ' + text);
    });
    proc.on('close', (code) => {
        log('MediaMTX process exited', { code, attempt });
        // Restart unless the exit was clean (code 0 = intentional shutdown)
        if (code !== 0) {
            const delay = Math.min(restartDelay * attempt, 30000);
            log(`MediaMTX restarting in ${delay}ms`, { attempt: attempt + 1 });
            setTimeout(() => spawnMediaMTX(configPath, restartDelay, attempt + 1), delay);
        }
    });
    proc.on('error', (err) => {
        log('MediaMTX process error', { message: err.message });
    });
};
const buildMediaMTXConfig = () => {
    const partBlock = HLS_IS_LOW_LATENCY ? `hlsPartDuration: ${HLS_PART_DURATION}\n` : '';
    const alwaysRemuxLine = HLS_ALWAYS_REMUX ? 'hlsAlwaysRemux: yes\n' : '';
    return `
logLevel: info
logDestinations: [stdout]
readTimeout: ${MEDIAMTX_READ_TIMEOUT}
writeTimeout: ${MEDIAMTX_WRITE_TIMEOUT}
writeQueueSize: 1024

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
${alwaysRemuxLine}hlsVariant: ${HLS_VARIANT}
hlsSegmentCount: ${HLS_SEGMENT_COUNT}
hlsSegmentDuration: ${HLS_SEGMENT_DURATION}
${partBlock}
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
};
const startMediaMTX = () => {
    if (!ENABLE_RTMP_SERVER)
        return;
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
    log('MediaMTX HLS tuning', {
        variant: HLS_VARIANT,
        segmentDuration: HLS_SEGMENT_DURATION,
        partDuration: HLS_IS_LOW_LATENCY ? HLS_PART_DURATION : 'n/a',
        segmentCount: HLS_SEGMENT_COUNT,
        alwaysRemux: HLS_ALWAYS_REMUX,
        wsFfmpegGopFrames: HLS_GOP_FRAMES,
        wsFfmpegFps: HLS_FPS,
    });
    spawnMediaMTX(resolvedConfig);
    log('MediaMTX started', { rtmpPort: RTMP_PORT, hlsHttpPort: HLS_HTTP_PORT });
};
// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    ensureFfmpegAvailable();
    generateGapMp4();
    startMediaMTX();
    log('Live ingest service started', {
        port: PORT,
        apiBaseUrl: API_BASE_URL,
        enableWsIngest: ENABLE_WS_INGEST,
        enableRtmpServer: ENABLE_RTMP_SERVER,
    });
});
