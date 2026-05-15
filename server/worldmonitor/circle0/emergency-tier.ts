export enum EmergencyTier {
  NONE = 'NONE',
  ADVISORY = 'ADVISORY',
  WARNING = 'WARNING',
  EMERGENCY = 'EMERGENCY',
}

/**
 * Map a 0-100 threat score to a human-readable emergency tier.
 *
 *   85-100  → EMERGENCY
 *   60-84   → WARNING
 *   30-59   → ADVISORY
 *   0-29    → NONE
 */
export function classifyEmergencyTier(score: number): EmergencyTier {
  if (score >= 85) return EmergencyTier.EMERGENCY;
  if (score >= 60) return EmergencyTier.WARNING;
  if (score >= 30) return EmergencyTier.ADVISORY;
  return EmergencyTier.NONE;
}
