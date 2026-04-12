import { Redis } from 'ioredis';

const LOCK_PREFIX = 'live:ingest:holder:';
const INSTANCE_ID =
  process.env.RAILWAY_REPLICA_ID?.trim() ||
  process.env.INSTANCE_ID?.trim() ||
  `pid-${process.pid}`;

const LOCK_TTL_SEC = Math.min(300, Math.max(30, Number.parseInt(process.env.LIVE_INGEST_LOCK_TTL_SEC || '90', 10) || 90));
const LOCK_REFRESH_MS = Math.min(120_000, Math.max(15_000, Number.parseInt(process.env.LIVE_INGEST_LOCK_REFRESH_MS || '', 10) || Math.round(LOCK_TTL_SEC * 400)));

let redisClient: Redis | null = null;

function getRedis(): Redis | null {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  if (!redisClient) {
    redisClient = new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true });
    redisClient.on('error', (err: Error) => {
      console.error('[LIVE-INGEST][Redis]', err.message);
    });
  }
  return redisClient;
}

export async function acquirePublisherLock(streamKey: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  const key = `${LOCK_PREFIX}${streamKey}`;
  const ok = await r.set(key, INSTANCE_ID, 'EX', LOCK_TTL_SEC, 'NX');
  return ok === 'OK';
}

export async function refreshPublisherLock(streamKey: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const key = `${LOCK_PREFIX}${streamKey}`;
  const v = await r.get(key);
  if (v === INSTANCE_ID) {
    await r.expire(key, LOCK_TTL_SEC);
  }
}

export async function releasePublisherLock(streamKey: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const key = `${LOCK_PREFIX}${streamKey}`;
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await r.eval(script, 1, key, INSTANCE_ID);
  } catch {
    /* ignore */
  }
}

export { LOCK_REFRESH_MS };
