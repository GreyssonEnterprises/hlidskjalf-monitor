/**
 * Circle 0 geofence rule engine.
 *
 * Evaluates per-area, per-category event scores against configured rules and
 * dispatches callbacks when thresholds are crossed. The default `wireSlackAlertCallback()`
 * helper hooks the engine into the Slack alerts webhook channel.
 */

import type { ProtectedArea } from './areas.js';
import { sendAlert } from '../slack/webhooks.js';
import {
  formatGeofenceTrigger,
  type GeofenceEventLike,
} from '../slack/formatter.js';

export interface GeofenceRule {
  id: string;
  areaId: string;
  eventCategory: string;
  minScore: number;
  action: 'alert' | 'warn' | 'log';
  cooldownMs: number;
}

export type GeofenceCallback = (
  rule: GeofenceRule,
  area: ProtectedArea,
  score: number,
  event?: GeofenceEventLike,
) => void | Promise<void>;

export class GeofenceEngine {
  private rules: GeofenceRule[] = [];
  private lastFired = new Map<string, number>();
  private callbacks: GeofenceCallback[] = [];

  addRule(rule: GeofenceRule): void {
    this.rules.push(rule);
  }

  onTrigger(cb: GeofenceCallback): void {
    this.callbacks.push(cb);
  }

  /**
   * Score-only check (legacy signature). Prefer `evaluateEvent()` for new
   * callers — it carries event payload through to the alert dispatchers.
   */
  check(
    areaId: string,
    area: ProtectedArea,
    category: string,
    score: number,
  ): void {
    this.dispatch(areaId, area, category, score, undefined);
  }

  /**
   * Per-event evaluation. Carries the event payload through so alert dispatchers
   * (e.g. Slack) can include the top contributing event in the message.
   */
  evaluateEvent(
    area: ProtectedArea,
    event: GeofenceEventLike,
    score: number,
  ): void {
    this.dispatch(area.id, area, event.category, score, event);
  }

  private dispatch(
    areaId: string,
    area: ProtectedArea,
    category: string,
    score: number,
    event: GeofenceEventLike | undefined,
  ): void {
    for (const rule of this.rules) {
      if (rule.areaId !== areaId && rule.areaId !== '*') continue;
      if (rule.eventCategory !== category && rule.eventCategory !== '*') continue;
      if (score < rule.minScore) continue;

      const key = `${rule.id}:${areaId}`;
      const last = this.lastFired.get(key) ?? 0;
      if (Date.now() - last < rule.cooldownMs) continue;

      this.lastFired.set(key, Date.now());
      for (const cb of this.callbacks) {
        // Fire-and-forget; callbacks are responsible for their own error handling.
        try {
          const r = cb(rule, area, score, event);
          if (r && typeof (r as Promise<void>).catch === 'function') {
            (r as Promise<void>).catch(err =>
              console.warn(`[geofence] callback error: ${(err as Error).message}`));
          }
        } catch (err) {
          console.warn(`[geofence] callback throw: ${(err as Error).message}`);
        }
      }
    }
  }
}

/**
 * Wire the supplied engine to send Block Kit alerts to the Slack alerts webhook
 * for every triggered rule whose `action` is `alert`.
 *
 * Idempotent: safe to call once at server bootstrap.
 */
export function wireSlackAlertCallback(engine: GeofenceEngine): void {
  engine.onTrigger(async (rule, area, score, event) => {
    if (rule.action !== 'alert') return;
    if (!event) return;
    const attachments = formatGeofenceTrigger(
      event,
      { id: rule.id, areaId: rule.areaId, action: rule.action },
      { id: area.id, name: area.name, lat: area.lat, lon: area.lon },
      score,
    );
    await sendAlert(attachments, { areaId: area.id });
  });
}
