/**
 * Slack Block Kit message builder for hlidskjalf-monitor.
 *
 * Produces well-formed `attachments[]` payloads compatible with incoming
 * webhooks. Three flavours of structured message live here:
 *   - sendAlert  → formatGeofenceTrigger
 *   - sendBriefing → formatDailyBriefing
 *   - sendDraupnir → formatDraupnirDigest
 *
 * Plus the generic SlackMessage shape used by ad-hoc notifications.
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface SlackMessage {
  title: string;
  body: string;
  severity: Severity;
  location?: { lat: number; lon: number; label?: string };
  timestamp?: number;
  source?: string;
}

const SEVERITY_COLORS: Record<Severity, string> = {
  info: '#0066CC',
  warning: '#FFA500',
  critical: '#FF0000',
};

// Emergency-tier color mapping (Circle 0 geofence alerts)
const TIER_COLORS: Record<string, string> = {
  EMERGENCY: '#FF0000',
  WARNING: '#FFA500',
  ADVISORY: '#FFD700',
  NONE: '#999999',
};

function mapThumbnailUrl(lat: number, lon: number): string {
  // OSM static tile (slippy-map z/x/y format) — best-effort thumbnail.
  // For production use, swap in a static-map service that supports markers.
  const zoom = 6;
  const w = 300;
  const h = 200;
  return `https://tile.openstreetmap.org/${zoom}/${lat}/${lon}.png?marker=${lat},${lon}&width=${w}&height=${h}`;
}

// ---------------------------------------------------------------------------
// Generic SlackMessage formatter
// ---------------------------------------------------------------------------

export function formatSlackBlocks(msg: SlackMessage): object[] {
  const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
  const blocks: object[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${msg.title}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: msg.body.slice(0, 2900) } },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Source:* ${msg.source ?? 'hlidskjalf-monitor'}  |  *Time:* ${ts}` },
      ],
    },
  ];

  if (msg.location) {
    const { lat, lon, label } = msg.location;
    blocks.splice(1, 0, {
      type: 'image',
      image_url: mapThumbnailUrl(lat, lon),
      alt_text: label ?? `${lat},${lon}`,
      title: { type: 'plain_text', text: label ?? 'Location' },
    });
  }

  return [
    {
      color: SEVERITY_COLORS[msg.severity],
      blocks,
    },
  ];
}

export function buildSlackPayload(msg: SlackMessage): object {
  return { attachments: formatSlackBlocks(msg) };
}

// ---------------------------------------------------------------------------
// Circle 0 geofence trigger
// ---------------------------------------------------------------------------

export interface GeofenceEventLike {
  category: string;
  severity?: number;
  lat: number;
  lon: number;
  timestamp: number;
  summary?: string;
  source?: string;
  topContributingEvent?: { title: string; source: string };
}

export interface GeofenceRuleLike {
  id: string;
  areaId: string;
  action: 'alert' | 'warn' | 'log';
}

export interface GeofenceAreaLike {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/**
 * Build Block Kit payload for a Circle 0 geofence trigger.
 *
 * Emergency-tier color coding:
 *   EMERGENCY (score >= 85)  → red
 *   WARNING   (score 60-84)  → orange
 *   ADVISORY  (score 30-59)  → yellow
 */
export function formatGeofenceTrigger(
  event: GeofenceEventLike,
  rule: GeofenceRuleLike,
  area: GeofenceAreaLike,
  threatScore: number,
): object[] {
  const tier =
    threatScore >= 85 ? 'EMERGENCY' :
    threatScore >= 60 ? 'WARNING' :
    threatScore >= 30 ? 'ADVISORY' : 'NONE';

  const ts = new Date(event.timestamp).toISOString();
  const top = event.topContributingEvent
    ? `*${event.topContributingEvent.title}* _(${event.topContributingEvent.source})_`
    : (event.summary ?? event.category);

  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:rotating_light: ${tier} — ${area.name}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Area*\n${area.name}` },
        { type: 'mrkdwn', text: `*Threat Score*\n${threatScore}/100` },
        { type: 'mrkdwn', text: `*Category*\n${event.category}` },
        { type: 'mrkdwn', text: `*Rule*\n\`${rule.id}\`` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Top contributing event:*\n${top}` },
    },
    {
      type: 'image',
      image_url: mapThumbnailUrl(event.lat, event.lon),
      alt_text: `${event.lat},${event.lon}`,
      title: { type: 'plain_text', text: `${event.lat.toFixed(3)}, ${event.lon.toFixed(3)}` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Tier:* ${tier}  |  *Source:* ${event.source ?? 'circle0'}  |  *Time:* ${ts}` },
      ],
    },
  ];

  return [
    {
      color: TIER_COLORS[tier],
      blocks,
    },
  ];
}

// ---------------------------------------------------------------------------
// Draupnir hourly digest
// ---------------------------------------------------------------------------

export interface DraupnirSignalLike {
  id: string;
  category: string;
  title: string;
  summary: string;
  score: number;
  actionability: 'monitor' | 'research' | 'act';
  sectorTags: string[];
  timestamp: number;
}

export function formatDraupnirDigest(signals: DraupnirSignalLike[]): object[] {
  if (signals.length === 0) {
    return [{
      color: '#6600CC',
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: '*Draupnir Hourly Digest*\n_No signals in the last hour._' },
      }],
    }];
  }

  const sorted = [...signals].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 10);
  const byCat = new Map<string, number>();
  for (const s of signals) byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
  const catSummary = [...byCat.entries()]
    .map(([cat, n]) => `${cat}:${n}`)
    .join('  ·  ');

  const lines = top.map(s => {
    const icon = s.actionability === 'act' ? ':red_circle:' :
                 s.actionability === 'research' ? ':large_yellow_circle:' :
                 ':large_blue_circle:';
    return `${icon} *${s.score}* — _${s.category}_ — ${s.title.slice(0, 120)}`;
  });

  return [{
    color: '#6600CC',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:moneybag: Draupnir Digest — ${signals.length} signal(s)` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Categories:* ${catSummary}` }],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_${new Date().toISOString()}_` }],
      },
    ],
  }];
}

// ---------------------------------------------------------------------------
// Daily briefing
// ---------------------------------------------------------------------------

export interface DailyBriefingAggregate {
  windowStart: number;
  windowEnd: number;
  correlation?: {
    totalSignals: number;
    bySeverity?: Record<string, number>;
    topSignals?: Array<{ summary: string; severity?: string; theater?: string }>;
  };
  circle0?: {
    activeAreas: number;
    activeThreats: number;
    topThreats?: Array<{ areaName: string; score: number; category: string }>;
  };
  draupnir?: {
    totalSignals: number;
    byCategory?: Record<string, number>;
    topSignals?: Array<{ title: string; score: number; category: string }>;
  };
}

export function formatDailyBriefing(agg: DailyBriefingAggregate): object[] {
  const start = new Date(agg.windowStart).toISOString();
  const end = new Date(agg.windowEnd).toISOString();

  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':sunrise: Hlidskjalf Daily Briefing' },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Window: *${start}* → *${end}*` }],
    },
    { type: 'divider' },
  ];

  // Correlation summary
  if (agg.correlation) {
    const sev = agg.correlation.bySeverity ?? {};
    const sevLine = Object.entries(sev).map(([k, v]) => `${k}:${v}`).join('  ·  ') || '_none_';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Cross-source signals (24h):* ${agg.correlation.totalSignals}\n*By severity:* ${sevLine}`,
      },
    });
    if (agg.correlation.topSignals?.length) {
      const lines = agg.correlation.topSignals.slice(0, 5)
        .map(s => `• [${s.severity ?? '?'}] _${s.theater ?? 'global'}_ — ${s.summary.slice(0, 140)}`);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      });
    }
  }

  // Circle 0 state
  if (agg.circle0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Circle 0:* ${agg.circle0.activeAreas} area(s), ${agg.circle0.activeThreats} active threat(s) in 24h`,
      },
    });
    if (agg.circle0.topThreats?.length) {
      const lines = agg.circle0.topThreats.slice(0, 5)
        .map(t => `• *${t.score}* ${t.areaName} _(${t.category})_`);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      });
    }
  }

  // Draupnir top signals
  if (agg.draupnir) {
    blocks.push({ type: 'divider' });
    const cat = agg.draupnir.byCategory ?? {};
    const catLine = Object.entries(cat).map(([k, v]) => `${k}:${v}`).join('  ·  ') || '_none_';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draupnir (24h):* ${agg.draupnir.totalSignals} signal(s)\n*By category:* ${catLine}`,
      },
    });
    if (agg.draupnir.topSignals?.length) {
      const lines = agg.draupnir.topSignals.slice(0, 5)
        .map(s => `• *${s.score}* _${s.category}_ — ${s.title.slice(0, 120)}`);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      });
    }
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Generated ${new Date().toISOString()}` }],
  });

  return [{ color: '#0066CC', blocks }];
}
