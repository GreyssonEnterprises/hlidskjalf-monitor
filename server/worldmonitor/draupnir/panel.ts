import type { Context } from 'hono';
import Redis from 'ioredis';
import { DraupnirPersistence } from './persistence.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const persistence = new DraupnirPersistence(redis);

export async function draupnirPanelHandler(c: Context): Promise<Response> {
  const category = c.req.query('category');
  const signals = category
    ? await persistence.getByCategory(category)
    : await persistence.getActive(50);
  return c.json({
    signals,
    categories: ['conflict', 'shipping', 'energy', 'disasters', 'sanctions', 'prediction-markets'],
    timestamp: new Date().toISOString(),
  });
}
