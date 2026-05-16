/**
 * Auth disabled — single-user self-hosted deployment.
 * All functions are no-ops or return null/empty values.
 * Exported names match the original clerk.ts interface so callers compile unchanged.
 */

export async function initClerk(): Promise<void> {}

export function getClerk() {
  return null;
}

export function openSignIn(): void {}

export function openSignUp(): void {}

export function getClerkUserCreatedAt(): number | null {
  return null;
}

export async function signOut(): Promise<void> {}

export function clearClerkTokenCache(): void {}

export async function getClerkToken(): Promise<string | null> {
  return null;
}

export function getCurrentClerkUser(): null {
  return null;
}

export function subscribeClerk(_callback: () => void): () => void {
  return () => {};
}

export function mountUserButton(_el: HTMLDivElement): () => void {
  return () => {};
}
