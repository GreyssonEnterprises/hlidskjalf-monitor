import { latLngToCell, gridDisk } from 'h3-js';
import Redis from 'ioredis';

const RESOLUTION = 5;

export class SpatialIndexService {
  constructor(private redis: Redis) {}

  async indexEvent(event: {
    id: string;
    lat: number;
    lon: number;
    type: string;
    timestamp: number;
    data: unknown;
  }): Promise<void> {
    const cell = latLngToCell(event.lat, event.lon, RESOLUTION);
    const key = `spatial:cell:${cell}`;
    await this.redis.zadd(
      key,
      event.timestamp,
      JSON.stringify({
        id: event.id,
        type: event.type,
        lat: event.lat,
        lon: event.lon,
        timestamp: event.timestamp,
      }),
    );
    await this.redis.expire(key, 86400 * 7); // 7 days TTL
  }

  async queryRadius(lat: number, lon: number, radiusKm: number): Promise<unknown[]> {
    const centerCell = latLngToCell(lat, lon, RESOLUTION);
    const rings = Math.ceil(radiusKm / 100) + 1;
    const cells = gridDisk(centerCell, rings);
    const results: unknown[] = [];
    for (const cell of cells) {
      const key = `spatial:cell:${cell}`;
      const items = await this.redis.zrangebyscore(key, Date.now() - 86400_000 * 7, '+inf');
      results.push(...items.map((i) => JSON.parse(i)));
    }
    return results;
  }

  async queryBbox(
    swLat: number,
    swLon: number,
    neLat: number,
    neLon: number,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    const latStep = (neLat - swLat) / 5;
    const lonStep = (neLon - swLon) / 5;
    const seen = new Set<string>();
    for (let lat = swLat; lat <= neLat; lat += latStep) {
      for (let lon = swLon; lon <= neLon; lon += lonStep) {
        const cell = latLngToCell(lat, lon, RESOLUTION);
        if (seen.has(cell)) continue;
        seen.add(cell);
        const items = await this.redis.zrangebyscore(
          `spatial:cell:${cell}`,
          Date.now() - 86400_000 * 7,
          '+inf',
        );
        results.push(...items.map((i: string) => JSON.parse(i)));
      }
    }
    return results;
  }
}
