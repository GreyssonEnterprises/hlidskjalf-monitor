/**
 * Tests for server/worldmonitor/draupnir/pipeline.ts and formatter additions.
 *
 * Covers:
 *   - processEvent → returns null for non-classifiable events
 *   - processEvent → persists with score+actionability when classifiable
 *   - formatGeofenceTrigger → red/orange/yellow color tier mapping
 *   - formatDraupnirDigest → empty / non-empty cases
 *   - formatDailyBriefing → all sections + missing-section graceful behavior
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processEvent, type DraupnirPipelineDeps } from '../server/worldmonitor/draupnir/pipeline.ts';
import { SignalClassifier, type DraupnirSignal } from '../server/worldmonitor/draupnir/signal-classifier.ts';
import { RelevanceScorer } from '../server/worldmonitor/draupnir/relevance-scorer.ts';
import {
  formatGeofenceTrigger,
  formatDraupnirDigest,
  formatDailyBriefing,
} from '../server/worldmonitor/slack/formatter.ts';

// In-memory fake of the bits of DraupnirPersistence the pipeline calls.
class FakePersistence {
  saved: DraupnirSignal[] = [];
  async save(signal: DraupnirSignal): Promise<void> {
    this.saved.push(signal);
  }
}

function buildDeps(persistence: FakePersistence): DraupnirPipelineDeps {
  return {
    classifier: new SignalClassifier(),
    scorer: new RelevanceScorer(),
    // Trust-cast: pipeline only calls save().
    persistence: persistence as unknown as DraupnirPipelineDeps['persistence'],
  };
}

describe('processEvent — pipeline', () => {
  it('returns null when event matches no category', async () => {
    const fake = new FakePersistence();
    const result = await processEvent(
      { id: 'e1', title: 'cat photos', body: 'cute kittens', timestamp: Date.now() },
      buildDeps(fake),
    );
    assert.equal(result, null);
    assert.equal(fake.saved.length, 0);
  });

  it('persists a classified signal with score + actionability set', async () => {
    const fake = new FakePersistence();
    const result = await processEvent(
      {
        id: 'e2',
        title: 'Tanker blocked at Strait of Hormuz',
        body: 'Major shipping disruption underway',
        lat: 26.5,
        lon: 56.5,
        timestamp: Date.now(),
      },
      buildDeps(fake),
    );
    assert.ok(result, 'expected a signal');
    assert.equal(fake.saved.length, 1);
    assert.equal(fake.saved[0].id, 'e2');
    assert.ok(fake.saved[0].score >= 0 && fake.saved[0].score <= 100);
    assert.ok(['monitor', 'research', 'act'].includes(fake.saved[0].actionability));
  });
});

describe('formatGeofenceTrigger — emergency-tier color mapping', () => {
  const area = { id: 'a1', name: 'Home', lat: 47.0, lon: -122.0 };
  const rule = { id: 'r1', areaId: 'a1', action: 'alert' as const };
  const ev = {
    category: 'wildfire',
    lat: 47.05,
    lon: -122.05,
    timestamp: Date.UTC(2026, 4, 13, 18, 0, 0),
  };

  it('score >= 85 → red (#FF0000)', () => {
    const out = formatGeofenceTrigger(ev, rule, area, 92) as Array<{ color: string }>;
    assert.equal(out[0].color, '#FF0000');
  });
  it('score 60..84 → orange (#FFA500)', () => {
    const out = formatGeofenceTrigger(ev, rule, area, 70) as Array<{ color: string }>;
    assert.equal(out[0].color, '#FFA500');
  });
  it('score 30..59 → yellow (#FFD700)', () => {
    const out = formatGeofenceTrigger(ev, rule, area, 45) as Array<{ color: string }>;
    assert.equal(out[0].color, '#FFD700');
  });
  it('includes area name and threat score in header', () => {
    const out = formatGeofenceTrigger(ev, rule, area, 92) as Array<{
      color: string;
      blocks: Array<{ type: string; text?: { text: string }; fields?: Array<{ text: string }> }>;
    }>;
    const header = out[0].blocks.find(b => b.type === 'header');
    assert.ok(header?.text?.text.includes('Home'));
    const fieldsBlock = out[0].blocks.find(b => b.type === 'section' && b.fields);
    assert.ok(fieldsBlock?.fields?.some(f => f.text.includes('92')));
  });
});

describe('formatDraupnirDigest', () => {
  it('returns a "no signals" attachment when given empty array', () => {
    const out = formatDraupnirDigest([]) as Array<{ blocks: Array<{ text?: { text: string } }> }>;
    assert.equal(out.length, 1);
    assert.match(out[0].blocks[0].text!.text, /No signals/);
  });

  it('summarises top signals by score with category counts', () => {
    const signals = [
      { id: 'a', category: 'conflict', title: 'A', summary: '', score: 90, actionability: 'act' as const, sectorTags: [], timestamp: Date.now() },
      { id: 'b', category: 'shipping', title: 'B', summary: '', score: 50, actionability: 'research' as const, sectorTags: [], timestamp: Date.now() },
      { id: 'c', category: 'conflict', title: 'C', summary: '', score: 20, actionability: 'monitor' as const, sectorTags: [], timestamp: Date.now() },
    ];
    const out = formatDraupnirDigest(signals) as Array<{
      color: string;
      blocks: Array<{ type: string; text?: { text: string }; elements?: Array<{ text: string }> }>;
    }>;
    assert.equal(out[0].color, '#6600CC');
    const ctx = out[0].blocks.find(b => b.type === 'context');
    assert.ok(ctx?.elements?.[0].text.includes('conflict:2'));
    const list = out[0].blocks.find(b => b.type === 'section' && b.text?.text.includes('*90*'));
    assert.ok(list, 'top signal score 90 must appear in digest list');
  });
});

describe('formatDailyBriefing', () => {
  it('renders header + window even when all sections empty', () => {
    const out = formatDailyBriefing({
      windowStart: Date.UTC(2026, 4, 12, 13, 0, 0),
      windowEnd: Date.UTC(2026, 4, 13, 13, 0, 0),
    }) as Array<{ blocks: Array<{ type: string; text?: { text: string } }> }>;
    const header = out[0].blocks.find(b => b.type === 'header');
    assert.match(header!.text!.text, /Daily Briefing/);
  });

  it('includes correlation, circle0, and draupnir summary sections when provided', () => {
    const out = formatDailyBriefing({
      windowStart: Date.now() - 86_400_000,
      windowEnd: Date.now(),
      correlation: {
        totalSignals: 3,
        bySeverity: { high: 1, low: 2 },
        topSignals: [{ summary: 'Test sig', severity: 'high', theater: 'global' }],
      },
      circle0: {
        activeAreas: 2,
        activeThreats: 1,
        topThreats: [{ areaName: 'Home', score: 60, category: 'wildfire' }],
      },
      draupnir: {
        totalSignals: 5,
        byCategory: { conflict: 3, energy: 2 },
        topSignals: [{ title: 'Strike on refinery', score: 88, category: 'energy' }],
      },
    }) as Array<{ blocks: Array<{ type: string; text?: { text: string } }> }>;
    const sections = out[0].blocks.filter(b => b.type === 'section');
    const allText = sections.map(s => s.text?.text ?? '').join('\n');
    assert.match(allText, /Cross-source signals.*3/);
    assert.match(allText, /Circle 0.*2 area/);
    assert.match(allText, /Draupnir.*5 signal/);
    assert.match(allText, /Strike on refinery/);
  });
});
