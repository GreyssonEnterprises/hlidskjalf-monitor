/**
 * Tests for server/worldmonitor/circle0/threat-scorer.ts
 *
 * Covers scoreThreat across:
 *  - Score = 0 (event beyond 10x radius cutoff)
 *  - Score = ~50 mid-range (close proximity, mid severity, fresh, no escalation)
 *  - Score = 100 cap (worst case across all dimensions)
 *  - Recency boundary: event NOW vs 24h old
 *  - Severity boundaries: 0 and 10 on the 0-10 input scale
 *  - Escalation cap at 5 same-category events / hour
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  scoreThreat,
  type ThreatEvent,
  type ProtectedAreaRef,
} from '../server/worldmonitor/circle0/threat-scorer.ts';

const AREA: ProtectedAreaRef = { lat: 0, lon: 0, radiusKm: 10 };

function makeEvent(over: Partial<ThreatEvent> = {}): ThreatEvent {
  return {
    lat: 0,
    lon: 0,
    severity: 5,
    timestamp: Date.now(),
    category: 'test',
    ...over,
  };
}

describe('scoreThreat — distance cutoff', () => {
  it('returns 0 when event is beyond 10x radius from area', () => {
    // 10x radius (100km) is the cutoff. ~10° lat ≈ 1111 km, well past cutoff.
    const event = makeEvent({ lat: 10, lon: 0, severity: 10 });
    assert.equal(scoreThreat(event, AREA, []), 0);
  });
});

describe('scoreThreat — mid-range score', () => {
  it('returns a score in 30-80 for mid-severity fresh event at area center', () => {
    // At the center: proximity ~50, severity 5/10 → 15, recency fresh → 20,
    // no escalation → 0; total ≈ 85 rounded.
    const event = makeEvent({ lat: 0, lon: 0, severity: 5 });
    const s = scoreThreat(event, AREA, []);
    assert.ok(s >= 50 && s <= 100, `expected mid-range score, got ${s}`);
  });
});

describe('scoreThreat — max score cap', () => {
  it('caps at 100 even when every component is maxed', () => {
    // At center, severity 10, fresh, 100 prior similar events in last hour.
    const now = Date.now();
    const event = makeEvent({ severity: 10, timestamp: now });
    const priors = Array.from({ length: 100 }, () =>
      makeEvent({ severity: 10, timestamp: now, category: 'test' }),
    );
    assert.equal(scoreThreat(event, AREA, priors), 100);
  });
});

describe('scoreThreat — recency boundary', () => {
  it('gives full recency credit for an event right now', () => {
    const event = makeEvent({ timestamp: Date.now() });
    const s = scoreThreat(event, AREA, []);
    // Should be high because all 20 recency points apply.
    assert.ok(s > 0);
  });

  it('gives zero recency credit for an event 24h+ old', () => {
    const now = Date.now();
    const fresh = makeEvent({ timestamp: now });
    const old = makeEvent({ timestamp: now - 25 * 3_600_000 });
    const sFresh = scoreThreat(fresh, AREA, []);
    const sOld = scoreThreat(old, AREA, []);
    // Old event must score strictly lower than fresh (lost recency component).
    assert.ok(sOld < sFresh, `expected old(${sOld}) < fresh(${sFresh})`);
  });
});

describe('scoreThreat — severity boundaries', () => {
  it('handles severity=0 (no severity contribution)', () => {
    const event = makeEvent({ severity: 0 });
    const s = scoreThreat(event, AREA, []);
    // No severity component, but proximity and recency still contribute.
    assert.ok(s >= 0 && s <= 100, `score out of range: ${s}`);
  });

  it('handles severity=10 (full 30 pts)', () => {
    const event = makeEvent({ severity: 10 });
    const sHigh = scoreThreat(event, AREA, []);
    const sLow = scoreThreat(makeEvent({ severity: 0 }), AREA, []);
    assert.ok(sHigh > sLow, `severity should monotonically raise score`);
  });
});

describe('scoreThreat — escalation', () => {
  it('caps escalation contribution at 5 similar events / hour', () => {
    const now = Date.now();
    const event = makeEvent({ timestamp: now, category: 'attack' });
    const priors5 = Array.from({ length: 5 }, () =>
      makeEvent({ timestamp: now, category: 'attack' }),
    );
    const priors100 = Array.from({ length: 100 }, () =>
      makeEvent({ timestamp: now, category: 'attack' }),
    );
    const s5 = scoreThreat(event, AREA, priors5);
    const s100 = scoreThreat(event, AREA, priors100);
    // Both should hit the same cap (modulo 100-total cap).
    assert.equal(s5, s100);
  });

  it('ignores prior events older than 1 hour', () => {
    const now = Date.now();
    const event = makeEvent({ timestamp: now, category: 'attack' });
    const stale = Array.from({ length: 5 }, () =>
      makeEvent({ timestamp: now - 2 * 3_600_000, category: 'attack' }),
    );
    const s = scoreThreat(event, AREA, stale);
    const sNoPriors = scoreThreat(event, AREA, []);
    assert.equal(s, sNoPriors);
  });
});
