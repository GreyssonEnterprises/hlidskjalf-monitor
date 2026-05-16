/**
 * Wires the worldmonitor event bus to the intelligence module hooks.
 *
 * Called once at server startup (from server.ts). Idempotent — guarded by
 * a module-level boolean so repeat calls during hot-reload are no-ops.
 *
 * Registers four hooks (in order):
 *   1. spatial      — `SpatialIndexService.indexEvent` into `spatial:cell:*`
 *   2. circle0      — persists `circle0:threats` zset AND drives the shared
 *                     `GeofenceEngine.evaluateEvent` so the wired Slack
 *                     callback fires for every protected area in range
 *   3. local-intel  — `EnforcementDetector.detectFromEvent` keyword match
 *                     into `local-intel:enforcement`
 *   4. draupnir     — investment-signal pipeline (classify / score /
 *                     actionability / persist + hourly digest buffer)
 *
 * The youtube-osint module is poller-driven (cron seeds the registry every
 * 20 min via scripts/seed-youtube-osint.mjs), so it doesn't register a
 * push-style event hook here.
 */
import Redis from 'ioredis';
import type { GeofenceEngine } from './circle0/geofencing.js';
import {
  registerEventHook,
  makeSpatialHook,
  makeCircle0Hook,
  makeLocalIntelHook,
  makeDraupnirHook,
} from './events.js';

let registered = false;

export interface WorldmonitorEventHookOptions {
  /** Optional shared Redis client (defaults to a new one against REDIS_URL). */
  redis?: Redis;
  /**
   * Optional shared GeofenceEngine instance — the circle0 hook will call
   * `evaluateEvent` on this engine for every emitted event so the existing
   * Slack-delivery callback (wired via `wireSlackAlertCallback` in server.ts)
   * fires off the same engine the spatial-query handler uses.
   */
  geofenceEngine?: GeofenceEngine;
}

export function registerWorldmonitorEventHooks(
  opts: WorldmonitorEventHookOptions = {},
): void {
  if (registered) return;
  const r = opts.redis ?? new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  registerEventHook(makeSpatialHook(r));
  registerEventHook(makeCircle0Hook(r, opts.geofenceEngine));
  registerEventHook(makeLocalIntelHook(r));
  registerEventHook(makeDraupnirHook(r));
  registered = true;
  console.log('[worldmonitor] event hooks registered: spatial, circle0, local-intel, draupnir');
}
