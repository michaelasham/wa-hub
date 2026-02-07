/**
 * Auth helpers that work in Edge runtime (middleware).
 * Uses Web Crypto API for HMAC.
 */

export function isAuthEnabled(): boolean {
  return !!(process.env.DASHBOARD_PASSWORD && process.env.DASHBOARD_PASSWORD.length > 0);
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifySessionCookie(cookieValue: string): Promise<boolean> {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) return false;
  const i = cookieValue.lastIndexOf('.');
  if (i === -1) return false;
  const payload = cookieValue.slice(0, i);
  const expectedSig = cookieValue.slice(i + 1);
  const actualSig = await hmacSha256(secret, payload);
  if (expectedSig.length !== actualSig.length) return false;
  let match = 0;
  for (let j = 0; j < expectedSig.length; j++) {
    match |= expectedSig.charCodeAt(j) ^ actualSig.charCodeAt(j);
  }
  if (match !== 0) return false;
  const ts = parseInt(payload.split('-')[0], 10);
  if (isNaN(ts)) return false;
  const maxAge = 24 * 60 * 60 * 1000; // 24h
  if (Date.now() - ts > maxAge) return false;
  return true;
}
