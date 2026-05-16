/**
 * User API key validation — single-user self-hosted deployment.
 *
 * Convex backend calls are removed. API keys are validated against the
 * SELF_HOST_API_KEY env var (if set). If not set, all wm_ keys are accepted
 * and mapped to the self-hosted userId.
 *
 * The exported interface (validateUserApiKey, invalidateApiKeyCache) is
 * preserved so gateway.ts and other callers compile without changes.
 */

import { deleteRedisKey } from './redis';

interface UserKeyResult {
  userId: string;
  keyId: string;
  name: string;
}

const CACHE_KEY_PREFIX = 'user-api-key:';

/** SHA-256 hex digest (Web Crypto API — works in Edge Runtime). */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a user-owned API key.
 *
 * Self-hosted mode: if SELF_HOST_API_KEY is set, only that key is accepted.
 * If not set, any key starting with "wm_" is accepted (open self-hosted).
 * Returns the self-hosted userId and a synthetic keyId on success.
 */
export async function validateUserApiKey(key: string): Promise<UserKeyResult | null> {
  if (!key || !key.startsWith('wm_')) return null;

  const configuredKey = process.env.SELF_HOST_API_KEY;
  if (configuredKey && key !== configuredKey) {
    return null;
  }

  const userId = process.env.SELF_HOST_USER_ID ?? 'self-hosted-user';
  const keyHash = await sha256Hex(key);

  return {
    userId,
    keyId: keyHash.slice(0, 16),
    name: 'self-hosted',
  };
}

/**
 * Delete the Redis cache entry for a specific API key hash.
 * No-op in self-hosted mode (no positive cache is written), but kept for
 * interface compatibility with callers that call this on key revocation.
 */
export async function invalidateApiKeyCache(keyHash: string): Promise<void> {
  await deleteRedisKey(`${CACHE_KEY_PREFIX}${keyHash}`);
}
