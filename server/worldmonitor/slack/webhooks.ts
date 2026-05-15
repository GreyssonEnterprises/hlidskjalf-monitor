/**
 * Slack sender API for hlidskjalf-monitor — NO-OP under the Hermes architecture.
 *
 * Decision (2026-05-14): the fork does NOT post to Slack directly. Hermes
 * (the existing autonomous agent at ~/.hermes/) is the unified Slack voice
 * for everything Bob says, including hlidskjalf-derived alerts. The fork's
 * job is to expose JSON endpoints under /api/worldmonitor/{circle0,draupnir,...}
 * which Hermes cron jobs poll, summarize, and post via chat.postMessage as Bob.
 *
 * These sender functions are preserved as no-ops so existing call sites
 * (circle0/geofencing.ts dispatchCallback, draupnir/persistence flushHourly,
 * scripts/run-{daily-briefing,draupnir-hourly-digest}.mjs) don't crash if
 * they're invoked. They log at debug level and return immediately.
 *
 * If you want the fork to post directly again, restore the webhook/chat-postMessage
 * implementation here. Search for "Hermes architecture" elsewhere to find the
 * other end of this contract (the cron-job entries that consume the JSON endpoints).
 */

import { buildSlackPayload, type SlackMessage } from './formatter.js';

// Suppress unused-import lint without losing the type re-export for callers.
void buildSlackPayload;

// ---------------------------------------------------------------------------
// Rate limiter (per-area, in-memory token bucket)
// ---------------------------------------------------------------------------

const channelLastSent = new Map<string, number>();
const ALERTS_COOLDOWN_MS = 5 * 60 * 1000;

function canSendAlert(areaId: string): boolean {
  const last = channelLastSent.get(`alerts:${areaId}`) ?? 0;
  return Date.now() - last > ALERTS_COOLDOWN_MS;
}

function markAlertSent(areaId: string): void {
  channelLastSent.set(`alerts:${areaId}`, Date.now());
}

// ---------------------------------------------------------------------------
// Public API — no-op senders. Signatures preserved for caller compatibility.
// Hermes consumes JSON endpoints and posts on its own; these never call out.
// ---------------------------------------------------------------------------

export async function sendAlert(
  _attachments: object[],
  opts: { areaId?: string } = {},
): Promise<void> {
  const areaId = opts.areaId ?? 'default';
  if (!canSendAlert(areaId)) return;
  markAlertSent(areaId);
  // No outbound call. Hermes polls /api/worldmonitor/circle0 and posts as Bob.
}

export async function sendBriefing(_attachments: object[]): Promise<void> {
  // No outbound call. Hermes polls /api/worldmonitor/briefing (daily) and posts.
}

export async function sendDraupnir(_attachments: object[]): Promise<void> {
  // No outbound call. Hermes polls /api/worldmonitor/draupnir (hourly) and posts.
}

/** @deprecated kept only so legacy callers compile; takes no action. */
export async function sendAlertMessage(_msg: SlackMessage, _areaId = 'default'): Promise<void> {}

/** @deprecated kept only so legacy callers compile; takes no action. */
export async function sendBriefingMessage(_msg: SlackMessage): Promise<void> {}
