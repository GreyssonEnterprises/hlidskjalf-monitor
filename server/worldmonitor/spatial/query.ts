import type { SpatialIndexService } from './h3-index.js';

export interface SpatialQuery {
  type: 'radius' | 'bbox';
  lat?: number;
  lon?: number;
  radiusKm?: number;
  swLat?: number;
  swLon?: number;
  neLat?: number;
  neLon?: number;
}

export async function querySpatial(
  svc: SpatialIndexService,
  q: SpatialQuery,
): Promise<unknown[]> {
  if (
    q.type === 'radius' &&
    q.lat !== undefined &&
    q.lon !== undefined &&
    q.radiusKm !== undefined
  ) {
    return svc.queryRadius(q.lat, q.lon, q.radiusKm);
  }
  if (
    q.type === 'bbox' &&
    q.swLat !== undefined &&
    q.swLon !== undefined &&
    q.neLat !== undefined &&
    q.neLon !== undefined
  ) {
    return svc.queryBbox(q.swLat, q.swLon, q.neLat, q.neLon);
  }
  return [];
}
