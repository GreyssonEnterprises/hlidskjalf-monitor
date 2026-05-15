/**
 * Entitlement enforcement — single-user self-hosted deployment.
 *
 * All Convex and premium/pro gating is removed. Every caller is treated as
 * entitled to all tiers. The exported interface is preserved so gateway.ts
 * and other callers compile without changes.
 */

import { getCachedJson, setCachedJson } from './redis';

// ---------------------------------------------------------------------------
// Types (kept for interface compatibility)
// ---------------------------------------------------------------------------

interface CachedEntitlements {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
    mcpAccess?: boolean;
  };
  validUntil: number;
}

// ---------------------------------------------------------------------------
// Endpoint-to-tier map (preserved for tooling compatibility)
// ---------------------------------------------------------------------------

const ENDPOINT_ENTITLEMENTS: Record<string, number> = {
  '/api/market/v1/analyze-stock': 1,
  '/api/market/v1/get-stock-analysis-history': 1,
  '/api/market/v1/backtest-stock': 1,
  '/api/market/v1/list-stored-stock-backtests': 1,
};

// Synthetic entitlement object returned for every user in self-hosted mode.
const SELF_HOST_ENTITLEMENTS: CachedEntitlements = {
  planKey: 'self-hosted',
  features: {
    tier: 99,
    apiAccess: true,
    apiRateLimit: 1_000_000,
    maxDashboards: 1_000,
    prioritySupport: true,
    exportFormats: ['csv', 'json', 'geojson', 'xlsx'],
    mcpAccess: true,
  },
  validUntil: Date.now() + 365 * 24 * 3_600_000,
};

/**
 * Returns the minimum tier required for a given endpoint pathname.
 * Returns null if the endpoint is unrestricted (not in the map).
 */
export function getRequiredTier(pathname: string): number | null {
  return ENDPOINT_ENTITLEMENTS[pathname] ?? null;
}

/**
 * Always returns the self-hosted entitlement object (all features unlocked).
 * The userId parameter is accepted for interface compatibility but ignored.
 * getCachedJson / setCachedJson calls are skipped — no Redis round-trip needed.
 */
export async function getEntitlements(_userId: string): Promise<CachedEntitlements | null> {
  return SELF_HOST_ENTITLEMENTS;
}

// Re-export for callers that import directly (e.g. tests that bypass gateway).
export { getCachedJson, setCachedJson };

/**
 * Always allows the request. In self-hosted mode every user has tier 99,
 * which is above every configured ENDPOINT_ENTITLEMENTS threshold.
 * Returns null (allowed) unconditionally.
 */
export async function checkEntitlement(
  _request: Request,
  _pathname: string,
  _corsHeaders: Record<string, string>,
): Promise<Response | null> {
  return null;
}
