import Redis from 'ioredis';

const ENFORCEMENT_KEYWORDS = [
  'police',
  'law enforcement',
  'FBI',
  'ICE',
  'DEA',
  'ATF',
  'SWAT',
  'patrol',
  'arrest',
  'raid',
  'investigation',
  'checkpoint',
];

export interface EnforcementEvent {
  title: string;
  body: string;
  lat?: number;
  lon?: number;
  timestamp: number;
  source: string;
}

export class EnforcementDetector {
  constructor(private redis: Redis) {}

  /**
   * Detect enforcement activity in an event's text fields.
   * Matching events are stored in Redis sorted by timestamp.
   * Returns true if the event matched at least one keyword.
   */
  async detectFromEvent(event: EnforcementEvent): Promise<boolean> {
    const text = `${event.title} ${event.body}`.toLowerCase();
    const matched = ENFORCEMENT_KEYWORDS.some((kw) => text.includes(kw));
    if (matched) {
      await this.redis.zadd(
        'local-intel:enforcement',
        event.timestamp,
        JSON.stringify(event),
      );
      await this.redis.expire('local-intel:enforcement', 86400 * 30);
    }
    return matched;
  }

  async getRecentActivity(days = 7): Promise<unknown[]> {
    const since = Date.now() - days * 86400_000;
    const items = await this.redis.zrangebyscore(
      'local-intel:enforcement',
      since,
      '+inf',
    );
    return items.map((i) => JSON.parse(i));
  }
}
