import type { Context } from 'hono';
import Redis from 'ioredis';
import { EnforcementDetector } from './enforcement-detector.js';
import { CrimeTrends } from './crime-trends.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const detector = new EnforcementDetector(redis);
const trends = new CrimeTrends(redis);

export async function localIntelPanelHandler(c: Context): Promise<Response> {
  const { neighborhood, days } = c.req.query();
  const enforcement = await detector.getRecentActivity(7);

  const crimeStats =
    neighborhood
      ? await trends.getStats(
          neighborhood,
          (days === '7' ? 7 : days === '90' ? 90 : 30) as 7 | 30 | 90,
        )
      : null;

  return c.json({
    enforcement,
    crimeStats,
    timestamp: new Date().toISOString(),
  });
}
