import Redis from 'ioredis';

export class CrimeTrends {
  constructor(private redis: Redis) {}

  /**
   * Record a single incident into the sorted-set bucket for
   * (neighborhood, category). A random suffix prevents score collisions
   * from deduplicating events at the same millisecond.
   */
  async recordIncident(
    category: string,
    neighborhood: string,
    timestamp: number,
  ): Promise<void> {
    const key = `crime-trends:${neighborhood}:${category}`;
    await this.redis.zadd(key, timestamp, `${timestamp}:${Math.random()}`);
    await this.redis.expire(key, 86400 * 90);
  }

  /**
   * Return per-category incident counts for a neighborhood over the
   * specified lookback window (7, 30, or 90 days).
   */
  async getStats(
    neighborhood: string,
    days: 7 | 30 | 90 = 30,
  ): Promise<Record<string, number>> {
    const since = Date.now() - days * 86400_000;
    const pattern = `crime-trends:${neighborhood}:*`;
    const keys = await this.redis.keys(pattern);
    const stats: Record<string, number> = {};
    for (const key of keys) {
      const category = key.split(':').pop() ?? 'unknown';
      const count = await this.redis.zcount(key, since, '+inf');
      stats[category] = count;
    }
    return stats;
  }
}
