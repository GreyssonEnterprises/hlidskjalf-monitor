import type { Context } from 'hono';
import { SpatialIndexService } from './h3-index.js';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const svc = new SpatialIndexService(redis);

export async function spatialPanelHandler(c: Context): Promise<Response> {
  const { lat, lon, radius, swLat, swLon, neLat, neLon } = c.req.query();
  let results: unknown[];
  if (lat && lon && radius) {
    results = await svc.queryRadius(
      parseFloat(lat),
      parseFloat(lon),
      parseFloat(radius),
    );
  } else if (swLat && swLon && neLat && neLon) {
    results = await svc.queryBbox(
      parseFloat(swLat),
      parseFloat(swLon),
      parseFloat(neLat),
      parseFloat(neLon),
    );
  } else {
    return c.json(
      { error: 'Provide lat/lon/radius or swLat/swLon/neLat/neLon' },
      400,
    );
  }
  return c.json({ type: 'FeatureCollection', features: results });
}
