import crypto from 'crypto';

/**
 * Verify wa-hub webhook signature (HMAC-SHA256)
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string
): boolean {
  if (!secret) return false;
  if (!signature) return false;
  try {
    const hmac = crypto.createHmac('sha256', secret);
    const expected = hmac.update(rawBody).digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}
