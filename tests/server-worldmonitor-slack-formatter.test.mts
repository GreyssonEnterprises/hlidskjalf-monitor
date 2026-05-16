/**
 * Tests for server/worldmonitor/slack/formatter.ts
 *
 * NOTE: the task-list referenced `formatGeofenceTrigger`, `formatDailyBriefing`,
 * and `formatDraupnirDigest`. The actual module currently exports
 * `formatSlackBlocks` and `buildSlackPayload` (generic Slack payload builders
 * used by webhooks.ts for all three message types). These tests cover the
 * real API and the three usage modes (geofence-style critical alert, daily
 * briefing-style info, Draupnir digest-style warning).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatSlackBlocks,
  buildSlackPayload,
  type SlackMessage,
} from '../server/worldmonitor/slack/formatter.ts';

interface AttachmentBlock {
  color: string;
  blocks: Array<{
    type: string;
    text?: { type: string; text: string };
    elements?: Array<{ type: string; text: string }>;
    image_url?: string;
    title?: { type: string; text: string };
  }>;
}

function asAttachment(out: unknown): AttachmentBlock {
  assert.ok(Array.isArray(out), 'formatSlackBlocks must return an array');
  assert.equal(out.length, 1);
  return out[0] as AttachmentBlock;
}

describe('formatSlackBlocks — geofence trigger (critical alert)', () => {
  it('produces valid Block Kit JSON with red color + location image', () => {
    const msg: SlackMessage = {
      title: 'Geofence triggered: Tacoma Port',
      body: 'Vessel ABC123 entered the protected zone',
      severity: 'critical',
      location: { lat: 47.27, lon: -122.41, label: 'Tacoma Port' },
      timestamp: Date.UTC(2026, 4, 13, 12, 0, 0),
      source: 'circle0',
    };
    const out = formatSlackBlocks(msg);
    const att = asAttachment(out);
    assert.equal(att.color, '#FF0000', 'critical severity must map to red');

    // First section = title, then image block (because location is set), then body, then context.
    assert.equal(att.blocks.length, 4);
    assert.equal(att.blocks[0].type, 'section');
    assert.match(att.blocks[0].text!.text, /Geofence triggered/);
    assert.equal(att.blocks[1].type, 'image');
    assert.ok(att.blocks[1].image_url!.startsWith('https://'));
    assert.equal(att.blocks[2].type, 'section');
    assert.match(att.blocks[2].text!.text, /Vessel ABC123/);
    assert.equal(att.blocks[3].type, 'context');
    assert.match(att.blocks[3].elements![0].text, /circle0/);
  });
});

describe('formatSlackBlocks — daily briefing (info)', () => {
  it('produces valid Block Kit JSON with blue color and no image when no location', () => {
    const msg: SlackMessage = {
      title: 'Daily Briefing — 2026-05-13',
      body: 'Top story: ...',
      severity: 'info',
      source: 'daily-briefing',
    };
    const out = formatSlackBlocks(msg);
    const att = asAttachment(out);
    assert.equal(att.color, '#0066CC');
    // No image inserted — title + body + context only.
    assert.equal(att.blocks.length, 3);
    assert.ok(att.blocks.every((b) => b.type !== 'image'));
  });
});

describe('formatSlackBlocks — Draupnir digest (warning)', () => {
  it('produces orange warning attachment and includes source attribution', () => {
    const msg: SlackMessage = {
      title: 'Draupnir digest',
      body: 'Three high-confidence signals in shipping sector',
      severity: 'warning',
      source: 'draupnir',
    };
    const out = formatSlackBlocks(msg);
    const att = asAttachment(out);
    assert.equal(att.color, '#FFA500');
    const ctx = att.blocks.find((b) => b.type === 'context');
    assert.ok(ctx, 'context block must be present');
    assert.match(ctx.elements![0].text, /draupnir/);
  });
});

describe('formatSlackBlocks — body truncation', () => {
  it('truncates body to 2900 chars to stay under Slack section limit', () => {
    const msg: SlackMessage = {
      title: 't',
      body: 'x'.repeat(5000),
      severity: 'info',
    };
    const out = formatSlackBlocks(msg);
    const att = asAttachment(out);
    const bodyBlock = att.blocks.find(
      (b) =>
        b.type === 'section' &&
        b.text?.text.startsWith('x') &&
        b.text.text.length <= 2900,
    );
    assert.ok(bodyBlock, 'body section must be truncated to ≤2900 chars');
    assert.equal(bodyBlock!.text!.text.length, 2900);
  });
});

describe('buildSlackPayload', () => {
  it('wraps formatSlackBlocks output in `attachments`', () => {
    const msg: SlackMessage = {
      title: 'Heads up',
      body: 'Something happened',
      severity: 'info',
    };
    const payload = buildSlackPayload(msg) as { attachments: unknown[] };
    assert.ok(Array.isArray(payload.attachments));
    assert.equal(payload.attachments.length, 1);
    // Payload must be JSON-serializable (Slack webhook contract).
    assert.doesNotThrow(() => JSON.stringify(payload));
  });
});
