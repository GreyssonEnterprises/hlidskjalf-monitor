/**
 * RPC: registerInterest — disabled in self-hosted deployment.
 *
 * Convex and Resend dependencies removed. Returns a stub 200 OK response so
 * the endpoint stays mounted and rate-limit policies remain active.
 *
 * Basic validation is preserved (honeypot, email format). No confirmation
 * email is sent. No Convex mutation is called.
 */

import type {
  ServerContext,
  RegisterInterestRequest,
  RegisterInterestResponse,
} from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';
import { checkScopedRateLimit } from '../../../_shared/rate-limit';
import { getClientIp } from '../../../_shared/turnstile';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_META_LENGTH = 100;

const DESKTOP_SOURCES = new Set<string>(['desktop-settings']);
const DESKTOP_RATE_SCOPE = '/api/leads/v1/register-interest#desktop';
const DESKTOP_RATE_LIMIT = 2;
const DESKTOP_RATE_WINDOW = '1 h' as const;

export async function registerInterest(
  ctx: ServerContext,
  req: RegisterInterestRequest,
): Promise<RegisterInterestResponse> {
  // Honeypot — silently accept but do nothing.
  if (req.website) {
    return { status: 'registered', referralCode: '', referralCount: 0, position: 0, emailSuppressed: false };
  }

  const ip = getClientIp(ctx.request);
  const isDesktopSource = typeof req.source === 'string' && DESKTOP_SOURCES.has(req.source);

  // Preserve desktop-source secondary rate cap (matches original handler logic).
  if (isDesktopSource) {
    const scoped = await checkScopedRateLimit(
      DESKTOP_RATE_SCOPE,
      DESKTOP_RATE_LIMIT,
      DESKTOP_RATE_WINDOW,
      ip,
    );
    if (!scoped.allowed) {
      throw new ValidationError([{ field: 'email', description: 'Too many requests' }]);
    }
  }

  const { email, source, appVersion } = req;
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    throw new ValidationError([{ field: 'email', description: 'Invalid email address' }]);
  }

  const safeSource = source ? source.slice(0, MAX_META_LENGTH) : 'unknown';
  const safeAppVersion = appVersion ? appVersion.slice(0, MAX_META_LENGTH) : 'unknown';

  // Self-hosted: log locally, skip Convex + Resend.
  console.log('[register-interest] self-hosted stub — interest recorded', {
    email: email.trim(),
    source: safeSource,
    appVersion: safeAppVersion,
  });

  return {
    status: 'registered',
    referralCode: '',
    referralCount: 0,
    position: 0,
    emailSuppressed: true,
  };
}
