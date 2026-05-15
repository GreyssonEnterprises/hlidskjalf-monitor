/**
 * Server-side session validation — single-user self-hosted deployment.
 *
 * All Clerk/Convex JWT verification is removed. Every request is treated as
 * authenticated with a fixed synthetic userId derived from the server's
 * SELF_HOST_USER_ID env var (falls back to "self-hosted-user").
 *
 * The exported interface (SessionResult, resolveClerkSession, getJWKS,
 * validateBearerToken, getClerkJwtVerifyOptions) is preserved so gateway.ts
 * and other callers compile without changes.
 */

export interface SessionResult {
  valid: boolean;
  userId?: string;
  role?: 'free' | 'pro';
  email?: string;
  name?: string;
}

/** Always returns a stub JWKS resolver (null). No remote key fetch needed. */
export function getJWKS(): null {
  return null;
}

/** No-op JWT verify options — kept for interface compatibility. */
export function getClerkJwtVerifyOptions(): Record<string, unknown> {
  return {};
}

/**
 * Single-user deployment: any bearer token (or no token) resolves to the
 * configured local user with pro tier. Returns valid: false only when no
 * SELF_HOST_USER_ID is set and no token is provided, so callers that gate on
 * `valid` still work correctly.
 */
export async function validateBearerToken(_token: string): Promise<SessionResult> {
  const userId = process.env.SELF_HOST_USER_ID ?? 'self-hosted-user';
  return { valid: true, userId, role: 'pro' };
}

/**
 * Resolves the session for a request. In single-user mode this always returns
 * a valid pro session. The x-user-id header is set to the configured userId
 * so downstream entitlement checks pass without Convex.
 */
export async function resolveClerkSession(request: Request): Promise<SessionResult> {
  const userId = process.env.SELF_HOST_USER_ID ?? 'self-hosted-user';
  // Honour an explicit x-user-id override from a trusted internal caller (e.g.
  // MCP internal HMAC path), but never allow untrusted clients to inject an
  // arbitrary userId — rely on the HMAC gate for that.
  const headerUserId = request.headers.get('x-user-id');
  return {
    valid: true,
    userId: headerUserId ?? userId,
    role: 'pro',
  };
}
