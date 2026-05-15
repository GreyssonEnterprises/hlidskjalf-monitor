/**
 * Draupnir signal persistence + hourly batch buffer.
 *
 * Persists per-signal records under `draupnir:signal:<id>` (TTL 7d), maintains
 * a sorted-set index of active signals, and rolls hourly digests into
 * `draupnir:digest:<YYYY-MM-DD-HH>` for cron-driven flushing.
 *
 * The in-memory `hourlyBuffer` is a process-local view of the current hour's
 * signals, used by `flushHourly()` to build a Slack digest. Survives restart
 * via the `draupnir:digest:<hour>` Redis key (rebuilt on boot if needed).
 */

import Redis from 'ioredis';
import type { DraupnirSignal } from './signal-classifier.js';

// 7-day TTL on individual signal records (per task brief).
const SIGNAL_TTL_SECONDS = 7 * 24 * 3600;
// Digest-key TTL: keep two days so the post-hour cron can still read it.
const DIGEST_TTL_SECONDS = 48 * 3600;

const ACTIVE_INDEX_KEY = 'draupnir:signals:active';

function hourBucket(ts: number = Date.now()): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}`;
}

export class DraupnirPersistence {
  /** In-memory current-hour buffer; flushed by `flushHourly()`. */
  private hourlyBuffer: DraupnirSignal[] = [];
  private currentBucket: string = hourBucket();

  constructor(private redis: Redis) {}

  /** Persist a signal and append it to the current-hour buffer + Redis digest. */
  async save(signal: DraupnirSignal): Promise<void> {
    const key = `draupnir:signal:${signal.id}`;
    await this.redis.set(key, JSON.stringify(signal), 'EX', SIGNAL_TTL_SECONDS);
    await this.redis.zadd(ACTIVE_INDEX_KEY, signal.timestamp, signal.id);
    // Trim index to last 1000 signals.
    await this.redis.zremrangebyrank(ACTIVE_INDEX_KEY, 0, -1001);

    // Buffer for hourly flush.
    const bucket = hourBucket(signal.timestamp);
    if (bucket !== this.currentBucket) {
      // Hour rolled over — start a fresh buffer (the prior bucket is in Redis).
      this.hourlyBuffer = [];
      this.currentBucket = bucket;
    }
    this.hourlyBuffer.push(signal);

    // Mirror into the Redis hourly digest list (so a different process's flush
    // can still see signals captured here).
    const digestKey = `draupnir:digest:${bucket}`;
    await this.redis.rpush(digestKey, JSON.stringify(signal));
    await this.redis.expire(digestKey, DIGEST_TTL_SECONDS);
  }

  async getActive(limit = 50): Promise<DraupnirSignal[]> {
    const ids = await this.redis.zrevrange(ACTIVE_INDEX_KEY, 0, limit - 1);
    const signals: DraupnirSignal[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(`draupnir:signal:${id}`);
      if (raw) signals.push(JSON.parse(raw) as DraupnirSignal);
    }
    return signals;
  }

  async getByCategory(category: string, limit = 20): Promise<DraupnirSignal[]> {
    const all = await this.getActive(200);
    return all.filter(s => s.category === category).slice(0, limit);
  }

  /**
   * Drain the previous hour's buffer (or a specific bucket) into a list of
   * signals suitable for `formatDraupnirDigest()`. Pulls from the in-memory
   * buffer first, then merges anything added by other processes via Redis.
   */
  async flushHourly(bucket?: string): Promise<DraupnirSignal[]> {
    // Default: previous hour bucket (so the top-of-hour cron flushes the hour
    // that just ended, not the one that just started).
    const target = bucket ?? hourBucket(Date.now() - 60 * 60 * 1000);

    // Pull whatever is in Redis for that bucket.
    const digestKey = `draupnir:digest:${target}`;
    const raw = await this.redis.lrange(digestKey, 0, -1);
    const fromRedis = raw.map(r => JSON.parse(r) as DraupnirSignal);

    // De-dupe by signal id (Redis may contain entries also held in
    // `hourlyBuffer` since `save()` writes both).
    const seen = new Set<string>();
    const merged: DraupnirSignal[] = [];
    for (const s of fromRedis) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      merged.push(s);
    }
    if (target === this.currentBucket) {
      for (const s of this.hourlyBuffer) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        merged.push(s);
      }
      this.hourlyBuffer = [];
    }

    // Clear the digest key now that it's been read out.
    await this.redis.del(digestKey);

    return merged;
  }

  /** Clear the in-memory buffer (test helper). */
  resetBuffer(): void {
    this.hourlyBuffer = [];
    this.currentBucket = hourBucket();
  }
}
