/**
 * RPC: submitContact — disabled in self-hosted deployment.
 *
 * Convex and Resend dependencies removed. Returns a 200 OK stub so the
 * endpoint stays mounted and rate-limit policies remain active without
 * requiring an active Convex backend or Resend account.
 *
 * Original validation logic is preserved so the endpoint rejects obviously
 * malformed requests (honeypot, missing fields) before accepting.
 */

import type {
  ServerContext,
  SubmitContactRequest,
  SubmitContactResponse,
} from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+(]?\d[\d\s()./-]{4,23}\d$/;
const MAX_FIELD = 500;
const MAX_MESSAGE = 2000;

export async function submitContact(
  _ctx: ServerContext,
  req: SubmitContactRequest,
): Promise<SubmitContactResponse> {
  // Honeypot — silently accept but do nothing.
  if (req.website) {
    return { status: 'sent', emailSent: false };
  }

  const { email, name, organization, phone } = req;

  if (!email || !EMAIL_RE.test(email)) {
    throw new ValidationError([{ field: 'email', description: 'Invalid email' }]);
  }
  if (!name || name.trim().length === 0) {
    throw new ValidationError([{ field: 'name', description: 'Name is required' }]);
  }
  if (!organization || organization.trim().length === 0) {
    throw new ValidationError([{ field: 'organization', description: 'Company is required' }]);
  }
  if (!phone || !PHONE_RE.test(phone.trim())) {
    throw new ValidationError([{ field: 'phone', description: 'Valid phone number is required' }]);
  }

  // Self-hosted: log submission locally, no Convex mutation, no Resend email.
  console.log('[submit-contact] self-hosted stub — submission received', {
    email: email.trim(),
    name: name.trim().slice(0, MAX_FIELD),
    organization: organization.trim().slice(0, MAX_FIELD),
    phone: phone.trim().slice(0, 30),
    message: req.message ? req.message.slice(0, MAX_MESSAGE) : undefined,
  });

  return { status: 'sent', emailSent: false };
}
