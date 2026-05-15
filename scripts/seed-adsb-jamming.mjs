#!/usr/bin/env node
/**
 * ADS-B → GPS jamming derivation.
 *
 * Ported from hlidskjalf/src/ingestors/jamming.ts. Pulls aircraft NACp
 * (Navigation Accuracy Category - Position) from adsb.fi for known GPS
 * jamming hotspots, aggregates degraded reports (NACp < 7) into H3 cells,
 * and writes JammingZone records into Redis.
 *
 * SUPERSEDES the legacy gpsjam.org consumer (scripts/fetch-gpsjam.mjs is
 * deprecated and remains only for backwards compatibility — do not extend it).
 *
 * Env: REDIS_URL (default: redis://localhost:6379)
 */

import Redis from 'ioredis';
import { latLngToCell } from 'h3-js';

const USER_AGENT = 'Hlidskjalf/0.1 (OSINT research tool)';

/** Known GPS jamming hotspots (centre lat/lon + search radius in nautical miles) */
const JAMMING_HOTSPOTS = [
  { name: 'Eastern Mediterranean', lat: 34.0,    lon: 33.0,    distNm: 150 },
  { name: 'Black Sea',             lat: 43.0,    lon: 35.0,    distNm: 200 },
  { name: 'Kaliningrad Exclave',   lat: 54.7,    lon: 20.5,    distNm: 150 },
  { name: 'Eastern Ukraine',       lat: 48.0,    lon: 37.0,    distNm: 150 },
  { name: 'Red Sea',               lat: 18.0,    lon: 38.0,    distNm: 200 },
  { name: 'Strait of Hormuz',      lat: 26.5667, lon: 56.2500, distNm: 150 },
  { name: 'Persian Gulf',          lat: 26.0,    lon: 52.0,    distNm: 200 },
];

const MAX_NACP = 11;
const NACP_DEGRADATION_THRESHOLD = 7;
const H3_RESOLUTION = 4;

function calculateIntensity(avgNACp) {
  const clamped = Math.max(0, Math.min(MAX_NACP, avgNACp));
  return 1 - clamped / MAX_NACP;
}

function parseAircraft(data) {
  const list = data?.ac;
  if (!Array.isArray(list)) return [];
  const reports = [];
  for (const ac of list) {
    if (ac?.lat == null || ac?.lon == null) continue;
    // Prefer nac_p (direct GPS accuracy) over nic (integrity containment)
    const nacp = ac.nac_p != null ? ac.nac_p : ac.nic;
    if (nacp == null) continue;
    reports.push({ lat: ac.lat, lon: ac.lon, nacp });
  }
  return reports;
}

async function fetchHotspot(hotspot) {
  const url = `https://opendata.adsb.fi/api/v3/lat/${hotspot.lat}/lon/${hotspot.lon}/dist/${hotspot.distNm}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`adsb.fi ${hotspot.name}: HTTP ${resp.status}`);
  const data = await resp.json();
  return parseAircraft(data);
}

function aggregateZones(reports) {
  const degraded = reports.filter((r) => r.nacp < NACP_DEGRADATION_THRESHOLD);
  if (degraded.length === 0) return [];

  const cellMap = new Map();
  for (const r of degraded) {
    const h3 = latLngToCell(r.lat, r.lon, H3_RESOLUTION);
    const existing = cellMap.get(h3);
    if (existing) {
      existing.totalNACp += r.nacp;
      existing.count++;
    } else {
      cellMap.set(h3, { totalNACp: r.nacp, count: 1, lat: r.lat, lon: r.lon });
    }
  }

  const now = Date.now();
  const zones = [];
  for (const [h3Index, { totalNACp, count, lat, lon }] of cellMap) {
    zones.push({
      h3Index,
      resolution: H3_RESOLUTION,
      lat,
      lon,
      intensity: calculateIntensity(totalNACp / count),
      sourceCount: count,
      timestamp: now,
    });
  }
  return zones;
}

async function main() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();

  const allReports = [];
  for (const hotspot of JAMMING_HOTSPOTS) {
    try {
      const reports = await fetchHotspot(hotspot);
      console.log(`  ${hotspot.name}: ${reports.length} aircraft`);
      allReports.push(...reports);
      // Per-hotspot delay to avoid adsb.fi rate limits
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.warn(`  ${hotspot.name}: ${err.message}`);
    }
  }

  const zones = aggregateZones(allReports);
  const now = Date.now();
  const zoneTtl = 86400; // 1 day rolling window

  // 1. Canonical jamming snapshot (consumed by intelligence/list-gps-interference)
  await redis.set(
    'intelligence:gps-jamming:v1',
    JSON.stringify({
      zones,
      hotspots: JAMMING_HOTSPOTS.map((h) => ({ name: h.name, lat: h.lat, lon: h.lon })),
      fetchedAt: new Date(now).toISOString(),
    }),
    'EX',
    zoneTtl,
  );

  // 2. Per-zone spatial entries (spatial panel + circle0 geofence read)
  for (const zone of zones) {
    const key = `spatial:cell:${zone.h3Index}`;
    await redis.zadd(
      key,
      zone.timestamp,
      JSON.stringify({
        id: `jamming-${zone.h3Index}`,
        type: 'gps-jamming',
        lat: zone.lat,
        lon: zone.lon,
        timestamp: zone.timestamp,
        intensity: zone.intensity,
      }),
    );
    await redis.expire(key, zoneTtl * 7);

    // High-intensity zones get a circle0 threat entry
    if (zone.intensity >= 0.5) {
      await redis.zadd(
        'circle0:threats',
        zone.timestamp,
        JSON.stringify({
          source: 'adsb-jamming',
          category: 'gps-degradation',
          severity: zone.intensity >= 0.75 ? 'warning' : 'watch',
          lat: zone.lat,
          lon: zone.lon,
          h3: zone.h3Index,
          intensity: zone.intensity,
          timestamp: zone.timestamp,
        }),
      );
    }
  }
  await redis.expire('circle0:threats', 86400 * 7);

  await redis.set('seed:adsb-jamming:last_run', String(now), 'EX', 86400);

  console.log(
    `adsb-jamming: ${zones.length} jamming zones from ${allReports.length} aircraft across ${JAMMING_HOTSPOTS.length} hotspots`,
  );
  await redis.quit();
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
