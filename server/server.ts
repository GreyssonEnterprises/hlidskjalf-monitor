import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import Redis from 'ioredis';

import { circle0PanelHandler, GeofenceEngine, wireSlackAlertCallback } from './worldmonitor/circle0/index.js';
import { draupnirPanelHandler } from './worldmonitor/draupnir/index.js';
import { spatialPanelHandler } from './worldmonitor/spatial/panel.js';
import { youtubePanelHandler } from './worldmonitor/youtube-osint/panel.js';
import { localIntelPanelHandler } from './worldmonitor/local-intel/panel.js';
import { registerWorldmonitorEventHooks } from './worldmonitor/register-event-hooks.js';

const app = new Hono();
const port = parseInt(process.env.PORT ?? '3000', 10);

// ---------------------------------------------------------------------------
// Worldmonitor panel routes (post-cloud rewrite — not in sebuf gateway)
// ---------------------------------------------------------------------------

app.get('/api/worldmonitor/circle0', circle0PanelHandler);
app.get('/api/worldmonitor/draupnir', draupnirPanelHandler);
app.get('/api/worldmonitor/spatial', spatialPanelHandler);
app.get('/api/worldmonitor/youtube-osint', youtubePanelHandler);
app.get('/api/worldmonitor/local-intel', localIntelPanelHandler);

// Circle 0 → Slack alerts wiring. The engine is a singleton; correlation
// engine consumers and the spatial query handler push events into it.
export const geofenceEngine = new GeofenceEngine();
wireSlackAlertCallback(geofenceEngine);

// ---------------------------------------------------------------------------
// Worldmonitor intelligence event-bus hooks (spatial / circle0 / local-intel).
// youtube-osint is poller-driven via scripts/seed-youtube-osint.mjs and does
// not register a push hook here. The shared geofence engine above is the
// single Slack-delivery backend; the circle0 hook in events.ts forwards events
// to it via evaluateEvent().
// ---------------------------------------------------------------------------
registerWorldmonitorEventHooks({ geofenceEngine });

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 2,
});

redis.on('error', (err: Error) => {
  console.warn('[server] Redis error:', err.message);
});

// ---------------------------------------------------------------------------
// /healthz — checks Redis, seed freshness, relay status
// ---------------------------------------------------------------------------

const CRITICAL_SEEDS = [
  'seed:aviation:last_run',
  'seed:conflict-intel:last_run',
  'seed:market-quotes:last_run',
  'seed:weather-alerts:last_run',
];

app.get('/healthz', async (c) => {
  const checks: Record<string, string> = {};

  // Redis ping
  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch (err) {
    checks.redis = `error: ${String(err)}`;
    return c.json({ ...checks, timestamp: new Date().toISOString() }, 503);
  }

  // Seed freshness
  const staleSeeds: string[] = [];
  const now = Date.now();
  for (const key of CRITICAL_SEEDS) {
    try {
      const val = await redis.get(key);
      if (!val || now - parseInt(val, 10) > 3_600_000) {
        staleSeeds.push(key);
      }
    } catch {
      staleSeeds.push(key);
    }
  }
  checks.staleSeeds = staleSeeds.length === 0 ? 'ok' : staleSeeds.join(',');

  // Relay status — Telegram MTProto relay was dropped in the Hermes-architecture
  // refactor (2026-05-14). Hermes posts to Slack on its own; no relay needed.
  // Reporting "n/a" instead of attempting an HTTP probe to a non-existent svc.
  checks.relay = 'n/a';

  const allOk = checks.redis === 'ok' && staleSeeds.length === 0;
  const status = { ...checks, timestamp: new Date().toISOString() };
  return c.json(status, allOk ? 200 : 207);
});

// ---------------------------------------------------------------------------
// API routes — mount gateway router
// ---------------------------------------------------------------------------

try {
  const gatewayModule = await import('./gateway.js');
  const gatewayRouter =
    (gatewayModule as { default?: unknown }).default ??
    (gatewayModule as { createDomainGateway?: unknown }).createDomainGateway;
  if (gatewayRouter) {
    app.route('/', gatewayRouter as unknown as Hono);
  } else {
    console.warn('[server] gateway router export not found');
  }
} catch (err) {
  console.warn('[server] gateway router not loaded:', String(err));
}

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

// ---------------------------------------------------------------------------
// Start — bind 0.0.0.0 for OCP container
// ---------------------------------------------------------------------------

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[server] listening on http://0.0.0.0:${info.port}`);
});
