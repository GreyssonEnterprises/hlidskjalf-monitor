/**
 * Tests for server/worldmonitor/circle0/emergency-tier.ts
 *
 * Covers classifyEmergencyTier boundaries:
 *   0..29   → NONE
 *   30..59  → ADVISORY
 *   60..84  → WARNING
 *   85..100 → EMERGENCY
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyEmergencyTier,
  EmergencyTier,
} from '../server/worldmonitor/circle0/emergency-tier.ts';

describe('classifyEmergencyTier — boundaries', () => {
  it('score 0 → NONE', () => {
    assert.equal(classifyEmergencyTier(0), EmergencyTier.NONE);
  });

  it('score 29 → NONE (upper edge)', () => {
    assert.equal(classifyEmergencyTier(29), EmergencyTier.NONE);
  });

  it('score 30 → ADVISORY (lower edge)', () => {
    assert.equal(classifyEmergencyTier(30), EmergencyTier.ADVISORY);
  });

  it('score 59 → ADVISORY (upper edge)', () => {
    assert.equal(classifyEmergencyTier(59), EmergencyTier.ADVISORY);
  });

  it('score 60 → WARNING (lower edge)', () => {
    assert.equal(classifyEmergencyTier(60), EmergencyTier.WARNING);
  });

  it('score 84 → WARNING (upper edge)', () => {
    assert.equal(classifyEmergencyTier(84), EmergencyTier.WARNING);
  });

  it('score 85 → EMERGENCY (lower edge)', () => {
    assert.equal(classifyEmergencyTier(85), EmergencyTier.EMERGENCY);
  });

  it('score 100 → EMERGENCY (upper edge)', () => {
    assert.equal(classifyEmergencyTier(100), EmergencyTier.EMERGENCY);
  });
});

describe('classifyEmergencyTier — out-of-range tolerance', () => {
  it('negative scores fall to NONE', () => {
    assert.equal(classifyEmergencyTier(-5), EmergencyTier.NONE);
  });

  it('scores above 100 still classify as EMERGENCY', () => {
    assert.equal(classifyEmergencyTier(150), EmergencyTier.EMERGENCY);
  });
});
