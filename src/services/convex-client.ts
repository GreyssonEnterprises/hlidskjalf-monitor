/**
 * Self-hosted no-op stub for the former Convex frontend client.
 *
 * The original module wrapped the Clerk JS SDK + Convex browser client to
 * drive authenticated subscriptions and per-user mutations. Self-hosted
 * operation has no auth provider and no remote DB — auth/entitlements are
 * short-circuited in
 * server/_shared/{entitlement-check,user-api-key}.ts. Every public function
 * here returns the unauthenticated/null path so callers degrade gracefully.
 */

// Opaque placeholder type so call sites that read `ConvexClient | null`
// still typecheck without pulling in the convex/browser package.
export type ConvexClient = Record<string, never>;
type ConvexApi = Record<string, never>;

export async function getConvexClient(): Promise<ConvexClient | null> {
  return null;
}

export async function waitForConvexAuth(_timeoutMs = 10_000): Promise<boolean> {
  return false;
}

export async function getConvexApi(): Promise<ConvexApi | null> {
  return null;
}
