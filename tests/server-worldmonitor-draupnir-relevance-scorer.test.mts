/**
 * Tests for server/worldmonitor/draupnir/relevance-scorer.ts
 *
 * Covers RelevanceScorer.score across:
 *  - High-relevance signal (near Strait of Hormuz, conflict, fresh) → high score
 *  - Low-relevance signal (no geo, low-weight category, old) → low score
 *  - Score bounded to [0, 100]
 *  - Category weight monotonicity
 *  - Escalation contribution caps at 4 similar prior signals
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RelevanceScorer } from '../server/worldmonitor/draupnir/relevance-scorer.ts';
import type { DraupnirSignal } from '../server/worldmonitor/draupnir/signal-classifier.ts';

function makeSignal(over: Partial<DraupnirSignal> = {}): DraupnirSignal {
  return {
    id: 'sig-1',
    category: 'prediction-markets',
    title: 'baseline',
    summary: 'baseline body',
    lat: undefined,
    lon: undefined,
    score: 0,
    actionability: 'monitor',
    sectorTags: [],
    timestamp: Date.now(),
    sourceEvent: {},
    ...over,
  };
}

const scorer = new RelevanceScorer();

describe('RelevanceScorer.score — high relevance', () => {
  it('returns a high score for a fresh conflict signal at Strait of Hormuz', () => {
    const sig = makeSignal({
      category: 'conflict',
      lat: 26.5,
      lon: 56.5,
      timestamp: Date.now(),
    });
    const s = scorer.score(sig, []);
    assert.ok(s >= 60, `expected ≥60 for high-relevance signal, got ${s}`);
  });
});

describe('RelevanceScorer.score — low relevance', () => {
  it('returns a low-ish score for an old prediction-markets signal with no geo', () => {
    const old = Date.now() - 96 * 3_600_000; // 96h old, past 48h decay window
    const sig = makeSignal({
      category: 'prediction-markets',
      timestamp: old,
      lat: undefined,
      lon: undefined,
    });
    const s = scorer.score(sig, []);
    assert.ok(s <= 35, `expected ≤35 for low-relevance signal, got ${s}`);
  });
});

describe('RelevanceScorer.score — bounds', () => {
  it('never exceeds 100', () => {
    const now = Date.now();
    const sig = makeSignal({
      category: 'conflict',
      lat: 26.5,
      lon: 56.5,
      timestamp: now,
    });
    const priors = Array.from({ length: 50 }, (_, i) =>
      makeSignal({ id: `p-${i}`, category: 'conflict', timestamp: now }),
    );
    const s = scorer.score(sig, priors);
    assert.ok(s <= 100, `score out of bounds: ${s}`);
  });

  it('returns 0 or more for a fully degenerate signal', () => {
    const sig = makeSignal({
      category: 'prediction-markets',
      timestamp: Date.now() - 365 * 24 * 3_600_000,
    });
    const s = scorer.score(sig, []);
    assert.ok(s >= 0);
  });
});

describe('RelevanceScorer.score — category weight monotonicity', () => {
  it('weights conflict higher than prediction-markets all else equal', () => {
    const now = Date.now();
    const baseline = { lat: 0, lon: 0, timestamp: now } as const;
    const sConflict = scorer.score(makeSignal({ ...baseline, category: 'conflict' }), []);
    const sPM = scorer.score(makeSignal({ ...baseline, category: 'prediction-markets' }), []);
    assert.ok(
      sConflict > sPM,
      `conflict(${sConflict}) should outweigh prediction-markets(${sPM})`,
    );
  });
});

describe('RelevanceScorer.score — escalation cap', () => {
  it('caps escalation contribution at 4 similar prior signals (20 pts)', () => {
    const now = Date.now();
    const sig = makeSignal({ category: 'conflict', timestamp: now });
    const priors4 = Array.from({ length: 4 }, (_, i) =>
      makeSignal({ id: `p-${i}`, category: 'conflict', timestamp: now }),
    );
    const priors10 = Array.from({ length: 10 }, (_, i) =>
      makeSignal({ id: `p-${i}`, category: 'conflict', timestamp: now }),
    );
    const s4 = scorer.score(sig, priors4);
    const s10 = scorer.score(sig, priors10);
    assert.equal(s4, s10);
  });
});
