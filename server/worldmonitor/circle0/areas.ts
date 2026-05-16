import { readFileSync, writeFileSync } from 'fs';

export interface ProtectedArea {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
  type: 'home' | 'school' | 'workplace' | 'custom';
  schoolHours?: { start: string; end: string; days: number[] };
}

const CONFIG_PATH =
  process.env.CIRCLE0_CONFIG_PATH ?? '/app/config/circle0.json';

export function loadProtectedAreas(): ProtectedArea[] {
  try {
    const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return data.protectedAreas ?? [];
  } catch {
    return [];
  }
}

export function saveProtectedArea(area: ProtectedArea): void {
  const areas = loadProtectedAreas();
  const idx = areas.findIndex((a) => a.id === area.id);
  if (idx >= 0) areas[idx] = area;
  else areas.push(area);
  writeFileSync(CONFIG_PATH, JSON.stringify({ protectedAreas: areas }, null, 2));
}

export function removeProtectedArea(id: string): void {
  const areas = loadProtectedAreas().filter((a) => a.id !== id);
  writeFileSync(CONFIG_PATH, JSON.stringify({ protectedAreas: areas }, null, 2));
}
