import type { DraupnirSignal, SignalCategory } from './signal-classifier.js';

// Key infrastructure lat/lon points for proximity scoring
const INFRASTRUCTURE_POINTS = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, weight: 10 },
  { name: 'Suez Canal', lat: 30.5, lon: 32.3, weight: 10 },
  { name: 'Strait of Malacca', lat: 1.5, lon: 103.8, weight: 9 },
  { name: 'Panama Canal', lat: 9.1, lon: -79.7, weight: 9 },
  { name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, weight: 8 },
  { name: 'Rotterdam Port', lat: 51.9, lon: 4.5, weight: 7 },
  { name: 'Singapore Port', lat: 1.3, lon: 103.8, weight: 7 },
  { name: 'Houston Ship Channel', lat: 29.7, lon: -95.0, weight: 7 },
];

const CATEGORY_WEIGHTS: Record<SignalCategory, number> = {
  conflict: 1.0,
  energy: 0.9,
  shipping: 0.85,
  sanctions: 0.8,
  disasters: 0.75,
  'prediction-markets': 0.7,
};

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export class RelevanceScorer {
  score(signal: DraupnirSignal, priorSignals: DraupnirSignal[] = []): number {
    let score = 0;

    // Proximity to key infrastructure (0-30 pts)
    if (signal.lat !== undefined && signal.lon !== undefined) {
      let proximityScore = 0;
      for (const pt of INFRASTRUCTURE_POINTS) {
        const dist = haversineKm(signal.lat, signal.lon, pt.lat, pt.lon);
        if (dist < 500) {
          proximityScore = Math.max(proximityScore, pt.weight * (1 - dist / 500));
        }
      }
      score += Math.min(30, proximityScore * 3);
    }

    // Category weight (0-30 pts)
    score += 30 * (CATEGORY_WEIGHTS[signal.category] ?? 0.5);

    // Escalation velocity: more recent similar signals = higher score (0-20 pts)
    const recentSimilar = priorSignals.filter(s =>
      s.category === signal.category &&
      Date.now() - s.timestamp < 3_600_000
    ).length;
    score += Math.min(20, recentSimilar * 5);

    // Time decay: newer events score higher (0-20 pts)
    const ageH = (Date.now() - signal.timestamp) / 3_600_000;
    score += Math.max(0, 20 * (1 - ageH / 48));

    return Math.min(100, Math.round(score));
  }
}
