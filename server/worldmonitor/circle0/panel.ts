import type { Context } from 'hono';
import { loadProtectedAreas } from './areas.js';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

export async function circle0PanelHandler(c: Context): Promise<Response> {
  const areas = loadProtectedAreas();
  const threats = await redis.zrangebyscore(
    'circle0:threats',
    Date.now() - 86400_000,
    '+inf',
  );
  return c.json({
    areas,
    activeThreats: threats.map((t) => JSON.parse(t)),
    timestamp: new Date().toISOString(),
  });
}
