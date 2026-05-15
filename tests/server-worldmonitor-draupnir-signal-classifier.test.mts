/**
 * Tests for server/worldmonitor/draupnir/signal-classifier.ts
 *
 * Covers:
 *  - classifySignalCategory routes known keywords to the expected category
 *  - getSectorTags returns non-empty tag list for every category
 *  - SignalClassifier.classify constructs a DraupnirSignal with correct
 *    category + sectorTags, or returns null for non-matching text
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifySignalCategory,
  getSectorTags,
  SignalClassifier,
  type SignalCategory,
} from '../server/worldmonitor/draupnir/signal-classifier.ts';

describe('classifySignalCategory — routing', () => {
  const cases: Array<[string, string, SignalCategory]> = [
    ['Air strike escalation', 'Two missiles hit at dawn', 'conflict'],
    ['Houthi blockade tightens', 'Tankers reroute around Bab el-Mandeb', 'shipping'],
    ['LNG pipeline rupture', 'Outage reported on the main line', 'energy'],
    ['Hurricane makes landfall', 'Widespread flood damage', 'disasters'],
    ['New OFAC sanctions imposed', 'Treasury added five entities to blacklist', 'sanctions'],
    ['Polymarket odds jump', 'Forecast probability now 78%', 'prediction-markets'],
  ];

  for (const [title, body, expected] of cases) {
    it(`routes "${title}" → ${expected}`, () => {
      assert.equal(classifySignalCategory(title, body), expected);
    });
  }

  it('returns null when no keywords match', () => {
    assert.equal(
      classifySignalCategory('Tea time at the office', 'biscuits were served'),
      null,
    );
  });
});

describe('getSectorTags', () => {
  const cats: SignalCategory[] = [
    'conflict',
    'shipping',
    'energy',
    'disasters',
    'sanctions',
    'prediction-markets',
  ];
  for (const cat of cats) {
    it(`returns non-empty tags for category ${cat}`, () => {
      const tags = getSectorTags(cat);
      assert.ok(Array.isArray(tags) && tags.length > 0, `no tags for ${cat}`);
    });
  }
});

describe('SignalClassifier.classify', () => {
  const classifier = new SignalClassifier();
  const ts = Date.now();

  it('produces a DraupnirSignal with matching category + sector tags', () => {
    const sig = classifier.classify({
      id: 'evt-1',
      title: 'Missile attack escalation',
      body: 'Reports of an airstrike',
      timestamp: ts,
    });
    assert.ok(sig, 'expected a signal, got null');
    assert.equal(sig.category, 'conflict');
    assert.deepEqual(sig.sectorTags, getSectorTags('conflict'));
    assert.equal(sig.id, 'evt-1');
    assert.equal(sig.timestamp, ts);
    assert.equal(sig.actionability, 'monitor');
    assert.equal(sig.score, 0);
  });

  it('truncates the summary to 200 chars', () => {
    const body = 'x'.repeat(500) + ' pipeline outage';
    const sig = classifier.classify({
      id: 'evt-2',
      title: 'Energy emergency',
      body,
      timestamp: ts,
    });
    assert.ok(sig);
    assert.equal(sig.summary.length, 200);
  });

  it('returns null when text matches no category', () => {
    const sig = classifier.classify({
      id: 'evt-3',
      title: 'Daily horoscope',
      body: 'Mercury aligns with Mars',
      timestamp: ts,
    });
    assert.equal(sig, null);
  });
});
