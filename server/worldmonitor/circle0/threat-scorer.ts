export interface ThreatEvent {
  lat: number;
  lon: number;
  severity: number; // 0-10
  timestamp: number;
  category: string;
}

export interface ProtectedAreaRef {
  lat: number;
  lon: number;
  radiusKm: number;
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute a 0-100 threat score for an event relative to a protected area.
 *
 * Component breakdown:
 *   - Proximity  (0-50): scales from 50 at area boundary to 0 at 10x radius
 *   - Severity   (0-30): linear from the 0-10 severity field
 *   - Recency    (0-20): 20 for events < 1h old, decays to 0 at 24h
 *   - Escalation (0-20): up to 5 same-category events in the last hour
 */
export function scoreThreat(
  event: ThreatEvent,
  area: ProtectedAreaRef,
  priorEvents: ThreatEvent[],
): number {
  const distKm = haversineKm(event.lat, event.lon, area.lat, area.lon);
  if (distKm > area.radiusKm * 10) return 0;

  const proximityScore = Math.max(
    0,
    50 * (1 - distKm / (area.radiusKm * 10)),
  );

  const severityScore = (event.severity / 10) * 30;

  const ageH = (Date.now() - event.timestamp) / 3_600_000;
  const recencyScore = Math.max(0, 20 * (1 - ageH / 24));

  const recentSimilar = priorEvents.filter(
    (e) =>
      e.category === event.category &&
      Date.now() - e.timestamp < 3_600_000,
  ).length;
  const escalationScore = Math.min(20, recentSimilar * 4);

  return Math.min(
    100,
    Math.round(proximityScore + severityScore + recencyScore + escalationScore),
  );
}
