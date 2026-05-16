export { loadProtectedAreas, saveProtectedArea, removeProtectedArea } from './areas.js';
export { scoreThreat } from './threat-scorer.js';
export { GeofenceEngine, wireSlackAlertCallback } from './geofencing.js';
export type { GeofenceRule, GeofenceCallback } from './geofencing.js';
export { classifyEmergencyTier, EmergencyTier } from './emergency-tier.js';
export { circle0PanelHandler } from './panel.js';
