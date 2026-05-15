/**
 * Event bus for the worldmonitor intelligence modules.
 *
 * The seed → Redis → panel pipeline is the canonical write path: cron seeds
 * write events into the same Redis zsets the panels read from. This event bus
 * is the in-process complement: any handler that emits an event in real time
 * (RPC handler, webhook receiver, ingestor) can call `emitEvent()` to fan it
 * out to the spatial / circle0 / local-intel / draupnir hooks without
 * re-implementing the per-module Redis writes.
 *
 * Hooks registered here run sequentially with `Promise.allSettled` so a slow
 * or failing hook can't block the others. All hooks are best-effort — emit
 * call-sites should never `await` for correctness, only for visibility.
 *
 * Wiring lives in `register-event-hooks.ts` (called once at server startup).
 */
import type Redis from 'ioredis';

export interface WorldEvent {
  /** Unique within-source id — e.g. `reddit-icewatch-abc123`, `gdelt-789` */
  id: string;
  /** Free-form source label — `reddit`, `gdelt`, `adsb-jamming`, `local-news-rss` */
  source: string;
  /** Free-form category — `enforcement`, `protest`, `gps-degradation`, etc. */
  category: string;
  /** Display title (≤ 200 chars) */
  title: string;
  /** Optional body / description text */
  body?: string;
  /** Severity: `info` < `watch` < `warning` < `critical` */
  severity?: 'info' | 'watch' | 'warning' | 'critical';
  /** Latitude — required for spatial / circle0 hooks to fire */
  lat?: number;
  /** Longitude — required for spatial / circle0 hooks to fire */
  lon?: number;
  /** Unix epoch ms — defaults to Date.now() at emit time */
  timestamp?: number;
  /** Optional raw payload for downstream consumers */
  data?: unknown;
}

export type EventHook = (event: WorldEvent) => Promise<void> | void;

const hooks: EventHook[] = [];

/**
 * Register a callback that fires for every emitted event.
 * Hooks should be idempotent — events may replay during seed catchup or restart.
 */
export function registerEventHook(hook: EventHook): void {
  hooks.push(hook);
}

/**
 * Emit an event to every registered hook. Hooks run in parallel via
 * `Promise.allSettled`; rejections are logged but do not propagate.
 */
export async function emitEvent(event: WorldEvent): Promise<void> {
  const enriched: WorldEvent = {
    ...event,
    timestamp: event.timestamp ?? Date.now(),
  };
  const results = await Promise.allSettled(hooks.map((h) => h(enriched)));
  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn('[events] hook rejected:', r.reason?.message ?? r.reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Hook factories — registered by register-event-hooks.ts at server startup.
// ---------------------------------------------------------------------------

/**
 * Spatial-index hook: writes events into the same `spatial:cell:*` zset the
 * SpatialIndexService panel reads from. Skips events without lat/lon.
 */
export function makeSpatialHook(redis: Redis): EventHook {
  return async (event) => {
    if (event.lat == null || event.lon == null) return;
    // Lazy import to avoid pulling h3-js into modules that don't need it.
    const { SpatialIndexService } = await import('./spatial/h3-index.js');
    const svc = new SpatialIndexService(redis);
    await svc.indexEvent({
      id: event.id,
      lat: event.lat,
      lon: event.lon,
      type: `${event.source}:${event.category}`,
      timestamp: event.timestamp ?? Date.now(),
      data: event.data ?? event,
    });
  };
}

/**
 * Circle0 hook: persists high-severity events into `circle0:threats` AND
 * forwards them to the shared GeofenceEngine (when supplied) so the engine's
 * registered Slack-delivery callback fires for every protected area within
 * range.
 *
 * Severity → score mapping uses the same scale Slack formatters expect:
 * `watch=40, warning=70, critical=90`. `info` events are skipped entirely.
 */
export function makeCircle0Hook(
  redis: Redis,
  geofenceEngine?: import('./circle0/geofencing.js').GeofenceEngine,
): EventHook {
  return async (event) => {
    if (event.lat == null || event.lon == null) return;
    if (event.severity === 'info' || event.severity === undefined) return;

    const ts = event.timestamp ?? Date.now();

    // 1. Persist to the threats zset for the panel's read path
    await redis.zadd(
      'circle0:threats',
      ts,
      JSON.stringify({
        source: event.source,
        category: event.category,
        severity: event.severity,
        lat: event.lat,
        lon: event.lon,
        title: event.title,
        timestamp: ts,
      }),
    );
    await redis.expire('circle0:threats', 86400 * 7);

    // 2. Drive the geofence engine — it owns the rule eval + Slack callback.
    if (!geofenceEngine) return;
    const score =
      event.severity === 'critical' ? 90 :
      event.severity === 'warning' ? 70 :
      40;
    const severityNum =
      event.severity === 'critical' ? 3 :
      event.severity === 'warning' ? 2 :
      1;
    const { loadProtectedAreas } = await import('./circle0/areas.js');
    for (const area of loadProtectedAreas()) {
      geofenceEngine.evaluateEvent(
        area,
        {
          category: event.category,
          severity: severityNum,
          lat: event.lat,
          lon: event.lon,
          timestamp: ts,
          source: event.source,
          summary: event.title,
          topContributingEvent: { title: event.title, source: event.source },
        },
        score,
      );
    }
  };
}

/**
 * Local-intel hook: routes events through the EnforcementDetector keyword
 * matcher. Matching events end up in `local-intel:enforcement` and surface
 * via the local-intel panel.
 */
export function makeLocalIntelHook(redis: Redis): EventHook {
  return async (event) => {
    const { EnforcementDetector } = await import('./local-intel/enforcement-detector.js');
    const detector = new EnforcementDetector(redis);
    await detector.detectFromEvent({
      title: event.title,
      body: event.body ?? '',
      lat: event.lat,
      lon: event.lon,
      timestamp: event.timestamp ?? Date.now(),
      source: event.source,
    });
  };
}

/**
 * Draupnir hook: pushes every emitted event through the Draupnir investment-
 * signal pipeline. Events that match a Draupnir category (conflict / shipping
 * / energy / disasters / sanctions / prediction-markets) get scored, persisted
 * with TTL, and added to the current-hour digest buffer for the top-of-hour
 * Slack flush. Non-matching events are silently dropped by the classifier.
 *
 * The pipeline + persistence are constructed lazily so this hook adds zero
 * cost on processes that never emit (e.g. cron-only containers).
 */
export function makeDraupnirHook(redis: Redis): EventHook {
  let pipelinePromise: Promise<{
    processEvent: typeof import('./draupnir/pipeline.js').processEvent;
    deps: import('./draupnir/pipeline.js').DraupnirPipelineDeps;
  }> | null = null;

  async function getPipeline() {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const [{ DraupnirPersistence }, { createDraupnirPipeline, processEvent }] = await Promise.all([
          import('./draupnir/persistence.js'),
          import('./draupnir/pipeline.js'),
        ]);
        const persistence = new DraupnirPersistence(redis);
        const deps = createDraupnirPipeline(persistence);
        return { processEvent, deps };
      })();
    }
    return pipelinePromise;
  }

  return async (event) => {
    const { processEvent, deps } = await getPipeline();
    await processEvent(
      {
        id: event.id,
        title: event.title,
        body: event.body ?? '',
        lat: event.lat,
        lon: event.lon,
        timestamp: event.timestamp ?? Date.now(),
      },
      deps,
    );
  };
}
