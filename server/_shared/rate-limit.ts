/**
 * Rate limiting using ioredis with a sliding window algorithm.
 * Replaces the prior Upstash ratelimit + Upstash Redis stack with direct ioredis calls.
 *
 * Sliding window: ZADD/ZREMRANGEBYSCORE/ZCARD pattern.
 * Fail-open: Redis errors allow the request through (consistent with original behavior).
 */

import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

redis.on('error', (err: Error) => {
  // Log but don't crash — all rate limit functions fail-open on Redis errors.
  console.warn('[rate-limit] Redis error:', err.message);
});

// ---------------------------------------------------------------------------
// Duration type (compatible with original Upstash ratelimit Duration strings)
// ---------------------------------------------------------------------------

export type Duration = `${number} s` | `${number} m` | `${number} h` | `${number} d`;

function durationToMs(window: Duration): number {
  const [num, unit] = window.split(' ');
  const n = parseInt(num ?? '0', 10);
  switch (unit) {
    case 's': return n * 1_000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: return n * 1_000;
  }
}

// ---------------------------------------------------------------------------
// Core sliding window implementation
// ---------------------------------------------------------------------------

interface SlidingWindowResult {
  success: boolean;
  limit: number;
  reset: number;
}

async function slidingWindow(
  key: string,
  limit: number,
  windowMs: number,
): Promise<SlidingWindowResult> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const windowSeconds = Math.ceil(windowMs / 1000);
  // Unique member: timestamp + process.hrtime for sub-ms uniqueness without shell calls.
  const [sec, ns] = process.hrtime();
  const member = `${now}:${sec}:${ns}`;

  const pipeline = redis.pipeline();
  pipeline.zadd(key, now, member);
  pipeline.zremrangebyscore(key, '-inf', windowStart);
  pipeline.zcard(key);
  pipeline.expire(key, windowSeconds + 1);

  const results = await pipeline.exec();
  // results[2] is ZCARD — [error, count]
  const count = (results?.[2]?.[1] as number) ?? 0;

  const reset = now + windowMs;
  const success = count <= limit;

  // If over limit, remove the member we just added (don't count this request).
  if (!success) {
    await redis.zrem(key, member).catch(() => {});
  }

  return { success, limit, reset };
}

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

function getClientIp(request: Request): string {
  // With Cloudflare proxy → Vercel, x-real-ip is the CF edge IP (shared across users).
  // cf-connecting-ip is the actual client IP set by Cloudflare — prefer it.
  // x-forwarded-for is client-settable and MUST NOT be trusted for rate limiting.
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

// ---------------------------------------------------------------------------
// 429 response builder
// ---------------------------------------------------------------------------

function tooManyRequestsResponse(
  limit: number,
  reset: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(reset),
      'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
      ...corsHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Global IP rate limit (600 req / 60 s)
// ---------------------------------------------------------------------------

const GLOBAL_LIMIT = 600;
const GLOBAL_WINDOW: Duration = '60 s';

export async function checkRateLimit(
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const ip = getClientIp(request);
  try {
    const { success, limit, reset } = await slidingWindow(
      `rl:${ip}`,
      GLOBAL_LIMIT,
      durationToMs(GLOBAL_WINDOW),
    );
    if (!success) {
      return tooManyRequestsResponse(limit, reset, corsHeaders);
    }
    return null;
  } catch {
    // Fail-open on Redis errors.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-endpoint rate policies
// ---------------------------------------------------------------------------

interface EndpointRatePolicy {
  limit: number;
  window: Duration;
}

// Exported so scripts/enforce-rate-limit-policies.mjs can import it directly
// (#3278) instead of regex-parsing this file. Internal callers should keep
// using checkEndpointRateLimit / hasEndpointRatePolicy below — the export is
// for tooling, not new runtime callers.
export const ENDPOINT_RATE_POLICIES: Record<string, EndpointRatePolicy> = {
  '/api/news/v1/summarize-article-cache': { limit: 3000, window: '60 s' },
  '/api/intelligence/v1/classify-event': { limit: 600, window: '60 s' },
  // Legacy /api/sanctions-entity-search rate limit was 30/min per IP. Preserve
  // that budget now that LookupSanctionEntity proxies OpenSanctions live.
  '/api/sanctions/v1/lookup-sanction-entity': { limit: 30, window: '60 s' },
  // Lead capture: preserve the 3/hr and 5/hr budgets from legacy api/contact.js
  // and api/register-interest.js. Lower limits than normal IP rate limit since
  // these were originally hitting Convex + Resend per request.
  '/api/leads/v1/submit-contact': { limit: 3, window: '1 h' },
  '/api/leads/v1/register-interest': { limit: 5, window: '1 h' },
  // Scenario engine: legacy /api/scenario/v1/run capped at 10 jobs/min/IP via
  // inline Upstash INCR. Gateway now enforces the same budget with per-IP
  // keying in checkEndpointRateLimit.
  '/api/scenario/v1/run-scenario': { limit: 10, window: '60 s' },
  // Live tanker map (Energy Atlas): one user with 6 chokepoints × 1 call/min
  // = 6 req/min/IP base load. 60/min headroom covers tab refreshes + zoom
  // pans within a single user without flagging legitimate traffic.
  '/api/maritime/v1/get-vessel-snapshot': { limit: 60, window: '60 s' },
};

export function hasEndpointRatePolicy(pathname: string): boolean {
  return pathname in ENDPOINT_RATE_POLICIES;
}

export async function checkEndpointRateLimit(
  request: Request,
  pathname: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const policy = ENDPOINT_RATE_POLICIES[pathname];
  if (!policy) return null;

  const ip = getClientIp(request);
  try {
    const { success, limit, reset } = await slidingWindow(
      `rl:ep:${pathname}:${ip}`,
      policy.limit,
      durationToMs(policy.window),
    );
    if (!success) {
      return tooManyRequestsResponse(limit, reset, corsHeaders);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-handler scoped rate limits
//
// Handlers that need a per-subscope cap in addition to the gateway-level
// endpoint policy use this helper. Gateway's checkEndpointRateLimit still runs
// first — this is a second stage.
// ---------------------------------------------------------------------------

export interface ScopedRateLimitResult {
  allowed: boolean;
  limit: number;
  reset: number;
}

/**
 * Returns whether the request is under the scoped budget. `scope` is an
 * opaque namespace (e.g. `${pathname}#desktop`); `identifier` is usually the
 * client IP but can be any stable caller identifier. Fail-open on Redis errors
 * to stay consistent with checkRateLimit / checkEndpointRateLimit semantics.
 */
export async function checkScopedRateLimit(
  scope: string,
  limit: number,
  window: Duration,
  identifier: string,
): Promise<ScopedRateLimitResult> {
  try {
    const result = await slidingWindow(
      `rl:scope:${scope}:${identifier}`,
      limit,
      durationToMs(window),
    );
    return { allowed: result.success, limit: result.limit, reset: result.reset };
  } catch {
    return { allowed: true, limit, reset: 0 };
  }
}
